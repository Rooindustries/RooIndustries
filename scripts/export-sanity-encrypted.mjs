#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createClient } from "@sanity/client";
import migrationTargetSafety from "../src/server/supabase/migrationTargetSafety.cjs";
import {
  defaultExportRoot,
  deleteExportPassphrase,
  encryptTarDirectory,
  loadPrivateExportEnvironment,
  parseExportArguments,
  stableExportJson,
  storeExportPassphrase,
  uniqueExportOutputPath,
  verifyEncryptedTarArchive,
} from "./lib/encrypted-export.mjs";

const { assertTourneyCutoverSanityTarget, computeTourneyCutoverSanityTargetFingerprint } =
  migrationTargetSafety;
const SHA1 = /^[0-9a-f]{40}$/;
const account = process.env.USER || "serviroo";

const readEnv = (env, ...keys) =>
  keys.map((key) => String(env[key] || "").trim()).find(Boolean) || "";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const sanityTarget = (env) => ({
  projectId: readEnv(env, "SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID"),
  dataset: readEnv(env, "SANITY_PRIVATE_DATASET", "SANITY_DATASET") || "production",
});

const assetUrl = ({ asset, projectId, dataset }) => {
  let parsed;
  try {
    parsed = new URL(String(asset.url || ""));
  } catch {
    parsed = null;
  }
  const segments = parsed?.pathname.split("/").filter(Boolean) || [];
  if (
    !parsed || parsed.protocol !== "https:" || parsed.hostname !== "cdn.sanity.io" ||
    parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash ||
    !["images", "files"].includes(segments[0]) ||
    segments[1] !== projectId || segments[2] !== dataset || segments.length !== 4
  ) {
    throw new Error("A Sanity export asset URL is invalid.");
  }
  return parsed.toString();
};

const collectAssetReferences = (value, references = new Set()) => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectAssetReferences(entry, references));
    return references;
  }
  if (!value || typeof value !== "object") return references;
  const reference = String(value._ref || "");
  if (/^(?:image|file)-/.test(reference)) references.add(reference);
  Object.values(value).forEach((entry) => collectAssetReferences(entry, references));
  return references;
};

export const validateSanityExportDocuments = ({ documents, projectId, dataset }) => {
  if (!Array.isArray(documents)) throw new Error("Sanity export documents are invalid.");
  const ids = new Set();
  const normalized = documents.map((document) => {
    if (
      !document || typeof document !== "object" || Array.isArray(document) ||
      !String(document._id || "").trim() || !String(document._type || "").trim() ||
      ids.has(document._id)
    ) {
      throw new Error("Sanity export documents are invalid.");
    }
    ids.add(document._id);
    return document;
  }).sort((left, right) => String(left._id).localeCompare(String(right._id)));
  const assets = normalized.filter((document) =>
    ["sanity.imageAsset", "sanity.fileAsset"].includes(document._type)
  ).map((asset) => {
    const size = Number(asset.size);
    const extension = String(asset.extension || "").trim().toLowerCase();
    const sha1 = String(asset.sha1hash || "").trim().toLowerCase();
    if (
      !Number.isSafeInteger(size) || size < 0 || !SHA1.test(sha1) ||
      !/^[a-z0-9]{1,16}$/.test(extension) || !String(asset.mimeType || "").trim()
    ) {
      throw new Error("Sanity export asset metadata is incomplete.");
    }
    return {
      document: asset,
      id: asset._id,
      extension,
      expectedBytes: size,
      expectedSha1: sha1,
      mimeType: String(asset.mimeType).trim().toLowerCase(),
      url: assetUrl({ asset, projectId, dataset }),
    };
  });
  const assetIds = new Set(assets.map((asset) => asset.id));
  const missing = [...collectAssetReferences(normalized)].filter((id) => !assetIds.has(id));
  if (missing.length > 0) throw new Error("Sanity export references a missing asset.");
  return { assets, documents: normalized };
};

const downloadAsset = async ({ asset, directory, fetchImpl }) => {
  const response = await fetchImpl(asset.url, {
    headers: { "Accept-Encoding": "identity" },
    redirect: "follow",
    signal: AbortSignal.timeout(60 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error("A Sanity asset could not be downloaded.");
  assetUrl({
    asset: { url: response.url || asset.url },
    projectId: new URL(asset.url).pathname.split("/")[2],
    dataset: new URL(asset.url).pathname.split("/")[3],
  });
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared !== asset.expectedBytes) {
    throw new Error("A Sanity asset size changed during export.");
  }
  const relativePath = `assets/${sha256(asset.id).slice(0, 40)}.${asset.extension}`;
  const outputPath = path.join(directory, relativePath);
  const sha1 = crypto.createHash("sha1");
  const sha256Hash = crypto.createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > asset.expectedBytes) {
        callback(new Error("A Sanity asset exceeds its declared size."));
        return;
      }
      sha1.update(chunk);
      sha256Hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    verifier,
    fs.createWriteStream(outputPath, { flags: "wx", mode: 0o600 })
  );
  const sourceSha1 = sha1.digest("hex");
  const archiveSha256 = sha256Hash.digest("hex");
  if (bytes !== asset.expectedBytes || sourceSha1 !== asset.expectedSha1) {
    await fsPromises.unlink(outputPath).catch(() => {});
    throw new Error("A Sanity asset failed checksum verification.");
  }
  return {
    id: asset.id,
    sourceUrl: asset.url,
    mimeType: asset.mimeType,
    byteSize: bytes,
    sourceSha1,
    archiveSha256,
    relativePath,
  };
};

export const downloadSanityExportAssets = async ({
  assets,
  directory,
  fetchImpl = fetch,
  concurrency = 3,
}) => {
  await fsPromises.mkdir(path.join(directory, "assets"), { recursive: false, mode: 0o700 });
  const results = new Array(assets.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < assets.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await downloadAsset({
        asset: assets[index],
        directory,
        fetchImpl,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), assets.length || 1) }, worker)
  );
  return results.sort((left, right) => left.id.localeCompare(right.id));
};

export const assertSanityExportCapacity = ({ assetBytes, staging, outputRoot }) => {
  const stagingStats = fs.statSync(staging);
  const outputStats = fs.statSync(outputRoot);
  const freeBytes = (location) => {
    const stats = fs.statfsSync(location);
    return Number(stats.bavail) * Number(stats.bsize);
  };
  const overhead = 1024 * 1024 * 1024;
  if (stagingStats.dev === outputStats.dev) {
    if (freeBytes(staging) < assetBytes * 2 + overhead) {
      throw new Error("The Sanity export requires more free disk space.");
    }
    return;
  }
  if (
    freeBytes(staging) < assetBytes + overhead / 2 ||
    freeBytes(outputRoot) < assetBytes + overhead / 2
  ) {
    throw new Error("The Sanity export requires more free disk space.");
  }
};

export const fetchAllSanityDocuments = async (client) => {
  const documents = [];
  let after = "";
  for (let page = 0; page < 100000; page += 1) {
    const batch = await client.fetch(
      `*[_id > $after] | order(_id asc)[0...500]`,
      { after },
      { cache: "no-store" }
    );
    if (!Array.isArray(batch)) throw new Error("Sanity export pagination failed.");
    if (batch.length === 0) return documents;
    const ids = batch.map((document) => String(document?._id || ""));
    if (
      ids.some((id, index) => !id || id <= (index === 0 ? after : ids[index - 1]))
    ) {
      throw new Error("Sanity export pagination returned unstable document order.");
    }
    documents.push(...batch);
    after = ids.at(-1);
    if (batch.length < 500) return documents;
  }
  throw new Error("Sanity export pagination exceeded its safety limit.");
};

const hashFile = async (filePath) => {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest("hex");
};

export const runSanityEncryptedExport = async ({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = fetch,
  outputRoot = defaultExportRoot,
} = {}) => {
  const args = parseExportArguments(argv);
  loadPrivateExportEnvironment({
    envPath: args.envPath,
    prefixes: ["SANITY_", "NEXT_PUBLIC_SANITY_", "TOURNEY_CUTOVER_"],
    env,
  });
  const target = sanityTarget(env);
  const expectedFingerprint = readEnv(
    env,
    "SANITY_EXPORT_EXPECTED_FINGERPRINT",
    "TOURNEY_CUTOVER_EXPECTED_SANITY_FINGERPRINT"
  );
  const targetIdentity = assertTourneyCutoverSanityTarget({
    ...target,
    expectedFingerprint: args.printTargetFingerprint
      ? computeTourneyCutoverSanityTargetFingerprint(target)
      : expectedFingerprint,
  });
  if (args.printTargetFingerprint) {
    return { SANITY_EXPORT_EXPECTED_FINGERPRINT: targetIdentity.fingerprint };
  }
  const token = readEnv(
    env,
    "SANITY_PRIVATE_READ_TOKEN",
    "SANITY_READ_TOKEN",
    "SANITY_PRIVATE_WRITE_TOKEN",
    "SANITY_WRITE_TOKEN"
  );
  if (!token) throw new Error("Sanity read credentials are required.");
  const client = createClient({
    ...target,
    apiVersion: readEnv(env, "SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") ||
      "2023-10-01",
    token,
    useCdn: false,
    perspective: "raw",
  });
  const exportedAt = new Date().toISOString();
  const staging = await fsPromises.mkdtemp(path.join(os.tmpdir(), "roo-sanity-export-"));
  await fsPromises.chmod(staging, 0o700);
  const passphrase = crypto.randomBytes(48).toString("base64url");
  const stamp = exportedAt.replace(/[^0-9A-Za-z]/g, "");
  const service = `RooIndustries-Sanity-Snapshot-${stamp}-${crypto.randomBytes(6).toString("hex")}`;
  const outputPath = uniqueExportOutputPath({
    prefix: "Sanity complete pre-cutover export",
    extension: "tar.gz.enc",
    root: outputRoot,
    now: new Date(exportedAt),
  });
  let completed = false;
  try {
    const source = validateSanityExportDocuments({
      documents: await fetchAllSanityDocuments(client),
      ...target,
    });
    assertSanityExportCapacity({
      assetBytes: source.assets.reduce((sum, asset) => sum + asset.expectedBytes, 0),
      staging,
      outputRoot: path.dirname(outputPath),
    });
    const documentText = stableExportJson(source.documents);
    await fsPromises.writeFile(
      path.join(staging, "documents.json"),
      documentText,
      { flag: "wx", mode: 0o600 }
    );
    const assets = await downloadSanityExportAssets({
      assets: source.assets,
      directory: staging,
      fetchImpl,
    });
    const manifest = {
      format: "roo-sanity-complete-export-v2",
      projectId: target.projectId,
      dataset: target.dataset,
      targetFingerprint: targetIdentity.fingerprint,
      exportedAt,
      documentCount: source.documents.length,
      documentSha256: sha256(documentText),
      assetCount: assets.length,
      assetBytes: assets.reduce((sum, asset) => sum + asset.byteSize, 0),
      assets,
    };
    await fsPromises.writeFile(
      path.join(staging, "manifest.json"),
      stableExportJson(manifest),
      { flag: "wx", mode: 0o600 }
    );
    const encrypted = await encryptTarDirectory({
      directory: staging,
      outputPath,
      passphrase,
    });
    const expectedEntries = [
      "",
      "assets",
      "documents.json",
      "manifest.json",
      ...assets.map((asset) => asset.relativePath),
    ];
    const verified = await verifyEncryptedTarArchive({
      inputPath: outputPath,
      passphrase,
      expectedEntries,
    });
    if (
      verified.plaintextSha256 !== encrypted.plaintextSha256 ||
      verified.plaintextBytes !== encrypted.plaintextBytes
    ) {
      throw new Error("The encrypted Sanity archive failed exact verification.");
    }
    await storeExportPassphrase({ service, passphrase, account });
    completed = true;
    return {
      ok: true,
      outputPath,
      keychainService: service,
      targetFingerprint: targetIdentity.fingerprint,
      documents: manifest.documentCount,
      assets: manifest.assetCount,
      assetBytes: manifest.assetBytes,
      encryptedSha256: await hashFile(outputPath),
      archivePlaintextSha256: verified.plaintextSha256,
      localDecryptVerified: true,
      assetChecksumsVerified: true,
    };
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true });
    if (!completed) {
      await fsPromises.unlink(outputPath).catch(() => {});
      await deleteExportPassphrase({ service, account });
    }
  }
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  runSanityEncryptedExport()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(() => {
      process.stderr.write("[sanity-encrypted-export] Export failed.\n");
      process.exitCode = 1;
    });
}
