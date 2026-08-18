import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import posixPath from "node:path/posix";
import dotenv from "dotenv";
import * as tus from "tus-js-client";
import { createSupabaseAdminClient } from "../src/server/supabase/adminClient.js";
import { resolveSupabaseAdminEnv } from "../src/server/supabase/adminClient.js";
import integrity from "./download-blob-integrity.cjs";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const DEFAULT_BUCKET = "optimization-builds-private";
const DEFAULT_CONTENT_TYPE = "application/zip";
const OBJECT_CACHE_CONTROL = "3600";
const MINIMUM_BUCKET_LIMIT = 5 * 1024 * 1024 * 1024;
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;
const { inspectDownloadArtifact } = integrity;

const fail = (message) => {
  console.error(`[downloads] ${message}`);
  process.exit(1);
};

const usage = () => fail(
  "Usage: node scripts/upload-download-supabase.mjs <slug> [local-zip-path] " +
    "[--apply] [--overwrite] [--raise-bucket-limit] [--verify-only]"
);

const normalizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const sanitizeFileName = (value, fallback) => {
  const fileName = String(value || fallback || "").trim();
  if (
    !fileName ||
    fileName !== path.basename(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(fileName) ||
    !fileName.toLowerCase().endsWith(".zip")
  ) {
    return "";
  }
  return fileName;
};

const sanitizeObjectPath = (value, fallback) => {
  const raw = String(value || fallback || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const normalized = posixPath.normalize(raw);
  if (
    !raw ||
    normalized === "." ||
    raw.split("/").some((part) => part === "..") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return "";
  }
  return normalized;
};

const parseCatalogEntry = (entry) => {
  const slug = normalizeSlug(entry.slug);
  if (!slug) return null;
  const fileName = sanitizeFileName(
    entry.fileName || entry.filename,
    `${slug}.zip`
  );
  const objectPath = sanitizeObjectPath(
    entry.blobPath,
    `downloads/${fileName}`
  );
  if (!fileName || !objectPath) {
    throw new Error(`Catalog path is invalid for "${slug}".`);
  }
  if (posixPath.basename(objectPath) !== fileName) {
    throw new Error(
      `Catalog fileName must match the blobPath basename for "${slug}".`
    );
  }

  const sizeBytes = Number(entry.sizeBytes ?? entry.size ?? 0);
  const sha256 = String(entry.sha256 || "").trim().toLowerCase();
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`Catalog sizeBytes is invalid for "${slug}".`);
  }
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Catalog sha256 is invalid for "${slug}".`);
  }
  const bucket = String(entry.storageBucket || DEFAULT_BUCKET).trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(bucket)) {
    throw new Error(`Catalog storageBucket is invalid for "${slug}".`);
  }
  return {
    slug,
    fileName,
    objectPath,
    sizeBytes,
    sha256,
    bucket,
    contentType: String(entry.contentType || DEFAULT_CONTENT_TYPE).trim(),
  };
};

const parseCatalog = () => {
  const raw = String(process.env.DOWNLOAD_CATALOG_JSON || "").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed || {}).map(([slug, value]) => ({
        slug,
        ...(value && typeof value === "object" ? value : {}),
      }));
  return entries.map(parseCatalogEntry).filter(Boolean);
};

const readOptions = () => {
  const args = process.argv.slice(2);
  const supported = new Set([
    "--apply",
    "--overwrite",
    "--raise-bucket-limit",
    "--verify-only",
  ]);
  if (args.some((arg) => arg.startsWith("--") && !supported.has(arg))) usage();
  const positional = args.filter((arg) => !supported.has(arg));
  const slug = normalizeSlug(positional[0]);
  if (!slug || positional.length > 2) usage();

  const apply = args.includes("--apply");
  const verifyOnly = args.includes("--verify-only");
  const overwrite = args.includes("--overwrite");
  const raiseBucketLimit = args.includes("--raise-bucket-limit");
  if ((overwrite || raiseBucketLimit) && !apply) {
    fail("--overwrite and --raise-bucket-limit require --apply.");
  }
  if (apply && verifyOnly) fail("--apply and --verify-only are mutually exclusive.");
  return { apply, overwrite, positional, raiseBucketLimit, slug, verifyOnly };
};

const inspectLocalArtifact = async (localPath, configured) => {
  const stats = await fsp.stat(localPath).catch(() => null);
  if (!stats?.isFile()) fail(`Local ZIP not found: ${localPath}`);
  let artifact;
  try {
    artifact = await inspectDownloadArtifact(localPath);
  } catch (error) {
    fail(`Local artifact failed ZIP integrity verification: ${error.message}`);
  }
  if (configured?.sizeBytes && configured.sizeBytes !== artifact.sizeBytes) {
    fail("Local ZIP size does not match catalog sizeBytes.");
  }
  if (configured?.sha256 && configured.sha256 !== artifact.sha256) {
    fail("Local ZIP SHA-256 does not match the catalog hash.");
  }
  return artifact;
};

const bucketFileSizeLimit = (bucket) => {
  const raw = bucket.fileSizeLimit ?? bucket.file_size_limit;
  if (raw === null || raw === undefined || raw === "") return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : -1;
};

const allowedMimeTypes = (bucket) =>
  bucket.allowedMimeTypes ?? bucket.allowed_mime_types ?? null;

const bucketAllowsContentType = (bucket, contentType) => {
  const allowed = allowedMimeTypes(bucket);
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.some((pattern) => {
    const normalized = String(pattern || "").trim().toLowerCase();
    if (normalized === contentType.toLowerCase()) return true;
    return normalized.endsWith("/*") &&
      contentType.toLowerCase().startsWith(normalized.slice(0, -1));
  });
};

const loadPrivateBucket = async (client, bucketName) => {
  const { data, error } = await client.storage.getBucket(bucketName);
  if (error || !data) fail(`Supabase bucket "${bucketName}" is unavailable.`);
  if (data.public !== false) fail(`Supabase bucket "${bucketName}" must be private.`);
  return data;
};

const ensureBucketCapacity = async ({
  artifact,
  bucket,
  bucketName,
  client,
  raiseBucketLimit,
}) => {
  const currentLimit = bucketFileSizeLimit(bucket);
  if (currentLimit === -1) fail("Supabase bucket file-size limit is invalid.");
  if (!currentLimit || currentLimit >= artifact.sizeBytes) return bucket;
  if (!raiseBucketLimit) {
    fail(
      `Supabase bucket limit ${currentLimit} is below ${artifact.sizeBytes}; ` +
        "rerun the apply command with --raise-bucket-limit."
    );
  }

  const fileSizeLimit = Math.max(MINIMUM_BUCKET_LIMIT, artifact.sizeBytes);
  const mimeTypes = allowedMimeTypes(bucket);
  const options = { public: false, fileSizeLimit };
  if (Array.isArray(mimeTypes)) options.allowedMimeTypes = mimeTypes;
  const { error } = await client.storage.updateBucket(bucketName, options);
  if (error) fail(`Could not raise the Supabase bucket limit: ${error.message}`);
  return loadPrivateBucket(client, bucketName);
};

const isNotFoundError = (error) => {
  const status = Number(error?.status ?? error?.statusCode);
  return status === 404 || /not found/i.test(String(error?.message || ""));
};

const loadRemoteObject = async (client, bucketName, objectPath) => {
  const { data, error } = await client.storage.from(bucketName).info(objectPath);
  if (error && isNotFoundError(error)) return null;
  if (error || !data) fail(`Supabase object metadata lookup failed: ${error?.message || "unknown failure"}`);
  return data;
};

const assertRemoteObject = ({ artifact, contentType, remote }) => {
  if (!remote) fail("Supabase object does not exist.");
  if (Number(remote.size) !== artifact.sizeBytes) {
    fail("Supabase object size does not match the verified local ZIP.");
  }
  const actualType = String(remote.contentType || "").split(";", 1)[0].toLowerCase();
  if (actualType !== contentType.toLowerCase()) {
    fail("Supabase object content type does not match the catalog.");
  }
  const cacheControl = String(remote.cacheControl || "")
    .trim()
    .toLowerCase()
    .replace(/^max-age=/, "");
  if (cacheControl !== OBJECT_CACHE_CONTROL) {
    fail("Supabase object cache control is not pinned to one hour.");
  }
  const etag = String(remote.etag || "").trim();
  if (!etag) fail("Supabase object metadata is missing an ETag.");
  return etag;
};

const directStorageEndpoint = (supabaseUrl) => {
  const url = new URL(supabaseUrl);
  const suffix = ".supabase.co";
  if (!url.hostname.endsWith(suffix)) {
    fail("SUPABASE_URL must use the project.supabase.co hostname for resumable upload.");
  }
  const projectId = url.hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9]+$/.test(projectId)) fail("SUPABASE_URL project id is invalid.");
  return `https://${projectId}.storage.supabase.co/storage/v1/upload/resumable`;
};

const uploadWithTus = ({
  artifact,
  bucketName,
  contentType,
  localPath,
  objectPath,
  overwrite,
  secretKey,
  supabaseUrl,
}) => new Promise((resolve, reject) => {
  const stream = fs.createReadStream(localPath);
  let lastReportedPercent = -5;
  const upload = new tus.Upload(stream, {
    endpoint: directStorageEndpoint(supabaseUrl),
    retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
    headers: {
      authorization: `Bearer ${secretKey}`,
      apikey: secretKey,
      "x-upsert": String(overwrite),
    },
    uploadDataDuringCreation: true,
    removeFingerprintOnSuccess: true,
    uploadSize: artifact.sizeBytes,
    chunkSize: TUS_CHUNK_SIZE,
    metadata: {
      bucketName,
      objectName: objectPath,
      contentType,
      cacheControl: OBJECT_CACHE_CONTROL,
      metadata: JSON.stringify({ sha256: artifact.sha256 }),
    },
    onError: (error) => {
      stream.destroy();
      reject(error);
    },
    onProgress: (uploaded, total) => {
      const percent = Math.floor((uploaded / total) * 100);
      if (percent < lastReportedPercent + 5 && percent !== 100) return;
      lastReportedPercent = percent;
      console.error(`[downloads] Supabase upload ${percent}%`);
    },
    onSuccess: resolve,
  });
  upload.start();
});

const printResult = ({ artifact, bucketName, configured, etag, mode }) => {
  console.log(JSON.stringify({
    ok: true,
    mode,
    slug: configured.slug,
    blobPath: configured.objectPath,
    storageBucket: bucketName,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    etag,
    entryCount: artifact.entryCount,
    zip64: artifact.zip64,
    contentType: configured.contentType,
    catalogIntegrity: {
      storageBackend: "supabase",
      storageBucket: bucketName,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      blobEtag: etag,
    },
  }, null, 2));
};

const options = readOptions();
let configured;
try {
  configured = parseCatalog().find((entry) => entry.slug === options.slug);
} catch (error) {
  fail(error.message || "Download catalog is invalid.");
}
if (!configured) fail(`Catalog entry not found for "${options.slug}".`);

const localPath = path.resolve(
  process.cwd(),
  options.positional[1] || path.join("downloads", configured.fileName)
);
const artifact = await inspectLocalArtifact(localPath, configured);
const { url: supabaseUrl, secretKey } = resolveSupabaseAdminEnv();
const client = createSupabaseAdminClient();
let bucket = await loadPrivateBucket(client, configured.bucket);
bucket = await ensureBucketCapacity({
  artifact,
  bucket,
  bucketName: configured.bucket,
  client,
  raiseBucketLimit: options.raiseBucketLimit,
});
if (bucketFileSizeLimit(bucket) > 0 && bucketFileSizeLimit(bucket) < artifact.sizeBytes) {
  fail("Supabase bucket limit remains below the verified ZIP size.");
}
if (!bucketAllowsContentType(bucket, configured.contentType)) {
  fail("Supabase bucket does not allow the catalog content type.");
}

let remote = await loadRemoteObject(
  client,
  configured.bucket,
  configured.objectPath
);
if (options.verifyOnly) {
  const etag = assertRemoteObject({
    artifact,
    contentType: configured.contentType,
    remote,
  });
  printResult({ artifact, bucketName: configured.bucket, configured, etag, mode: "verified" });
  process.exit(0);
}
if (!options.apply) {
  console.log(JSON.stringify({
    ok: true,
    mode: "dry-run",
    readyToUpload: !remote,
    existingObject: Boolean(remote),
    bucket: configured.bucket,
    blobPath: configured.objectPath,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  }, null, 2));
  process.exit(remote ? 1 : 0);
}
if (remote && !options.overwrite) {
  fail("Supabase object already exists; use --verify-only or explicitly add --overwrite.");
}

try {
  await uploadWithTus({
    artifact,
    bucketName: configured.bucket,
    contentType: configured.contentType,
    localPath,
    objectPath: configured.objectPath,
    overwrite: options.overwrite,
    secretKey,
    supabaseUrl,
  });
} catch (error) {
  fail(`Supabase resumable upload failed: ${error.message || "unknown failure"}`);
}
remote = await loadRemoteObject(client, configured.bucket, configured.objectPath);
const etag = assertRemoteObject({
  artifact,
  contentType: configured.contentType,
  remote,
});
printResult({ artifact, bucketName: configured.bucket, configured, etag, mode: "uploaded" });
