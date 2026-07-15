import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient as createSanityClient } from "@sanity/client";
import {
  GLOBAL_SANITY_DATASET,
  GLOBAL_SANITY_PROJECT_ID,
  collectGlobalCmsAssetIds,
  normalizeGlobalCmsAssetManifest,
  stableCmsJson,
} from "../../lib/globalCmsContract.js";

const SANITY_API_VERSION = "2026-07-01";
const MAX_SYNCHRONOUS_ASSET_BYTES = 64 * 1024 * 1024;
const PUBLIC_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const PUBLIC_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/svg+xml",
]);
const PRIVATE_FILE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/octet-stream",
  "application/vnd.microsoft.portable-executable",
  "application/x-msdownload",
]);

const failure = (message, status, code) => {
  const error = new Error(message);
  error.status = status;
  error.statusCode = status;
  error.code = code;
  return error;
};

const assetDescriptor = (asset) => {
  const isImage = asset?._type === "sanity.imageAsset";
  const isFile = asset?._type === "sanity.fileAsset";
  const extension = String(asset?.extension || "")
    .trim()
    .toLowerCase();
  const assetId = String(asset?.assetId || "").trim();
  const sourceUrl = String(asset?.url || "").trim();
  const mimeType = String(asset?.mimeType || "")
    .trim()
    .toLowerCase();
  const expectedBytes = Number(asset?.size || 0);
  const expectedSha1 = String(asset?.sha1hash || "")
    .trim()
    .toLowerCase();
  if (
    (!isImage && !isFile) ||
    !/^[a-z0-9]{1,16}$/.test(extension) ||
    !/^[A-Za-z0-9_.-]{1,240}$/.test(assetId) ||
    !/^[-\w.+]+\/[-\w.+]+$/.test(mimeType) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    !/^[0-9a-f]{40}$/.test(expectedSha1)
  ) {
    throw failure(
      "A CMS asset has invalid metadata.",
      400,
      "CMS_ASSET_INVALID",
    );
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw failure("A CMS asset URL is invalid.", 400, "CMS_ASSET_INVALID");
  }
  const expectedPath = `/${isImage ? "images" : "files"}/${GLOBAL_SANITY_PROJECT_ID}/${GLOBAL_SANITY_DATASET}/`;
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "cdn.sanity.io" ||
    !parsedUrl.pathname.startsWith(expectedPath)
  ) {
    throw failure(
      "A CMS asset URL is outside the global dataset.",
      400,
      "CMS_ASSET_SCOPE_INVALID",
    );
  }
  const storageBucket = isImage
    ? "site-content-public"
    : "optimization-builds-private";
  return {
    legacy_sanity_asset_id: asset._id,
    source_url: sourceUrl,
    storage_bucket: storageBucket,
    storage_path: `${isImage ? "images" : "builds"}/${assetId}.${extension}`,
    mime_type: mimeType,
    byte_size: expectedBytes,
    sha1: expectedSha1,
    width: Number(asset?.metadata?.dimensions?.width || 0) || null,
    height: Number(asset?.metadata?.dimensions?.height || 0) || null,
    metadata: {
      extension,
      source_asset_id: assetId,
      source_sha1: expectedSha1,
      source_type: asset._type,
    },
  };
};

const requireRpcData = ({ data, error }, operation) => {
  if (!error) return data;
  throw failure(
    `Supabase ${operation} failed.`,
    503,
    error.code || "CMS_ASSET_DATABASE_FAILED",
  );
};

const stageAndVerifyAsset = async ({ body, descriptor, tempPath }) => {
  const sha1 = crypto.createHash("sha1");
  const sha256 = crypto.createHash("sha256");
  let bytes = 0;
  const hashingStream = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > descriptor.byte_size) {
        callback(new Error("CMS asset exceeds its declared size."));
        return;
      }
      sha1.update(chunk);
      sha256.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(body),
      hashingStream,
      createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
    );
  } catch {
    throw failure(
      "A CMS asset failed source verification.",
      409,
      "CMS_ASSET_SOURCE_MISMATCH",
    );
  }
  const result = {
    bytes,
    sha1: sha1.digest("hex"),
    sha256: sha256.digest("hex"),
  };
  if (
    result.bytes !== descriptor.byte_size ||
    result.sha1 !== descriptor.sha1
  ) {
    throw failure(
      "A CMS asset failed source verification.",
      409,
      "CMS_ASSET_SOURCE_MISMATCH",
    );
  }
  return result;
};

const hashStream = async (stream) => {
  const sha256 = crypto.createHash("sha256");
  let bytes = 0;
  const iterable =
    typeof ReadableStream !== "undefined" && stream instanceof ReadableStream
      ? Readable.fromWeb(stream)
      : stream;
  for await (const chunk of iterable) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    sha256.update(buffer);
  }
  return { bytes, sha256: sha256.digest("hex") };
};

const fetchSourceAsset = async ({ descriptor, token, fetchImpl }) => {
  let response;
  try {
    response = await fetchImpl(descriptor.source_url, {
      headers: {
        Accept: descriptor.mime_type,
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw failure(
      "A CMS asset could not be downloaded.",
      503,
      "CMS_ASSET_DOWNLOAD_FAILED",
    );
  }
  if (!response.ok || !response.body) {
    throw failure(
      "A CMS asset could not be downloaded.",
      503,
      "CMS_ASSET_DOWNLOAD_FAILED",
    );
  }
  const contentType = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (
    (contentType && contentType !== descriptor.mime_type) ||
    (contentLength && contentLength !== descriptor.byte_size)
  ) {
    throw failure(
      "A CMS asset failed source verification.",
      409,
      "CMS_ASSET_SOURCE_MISMATCH",
    );
  }
  return response.body;
};

const uploadAndVerifyAsset = async ({
  descriptor,
  token,
  supabaseClient,
  fetchImpl,
}) => {
  const body = await fetchSourceAsset({ descriptor, token, fetchImpl });
  const tempPath = path.join(os.tmpdir(), `roo-cms-${crypto.randomUUID()}`);
  try {
    const source = await stageAndVerifyAsset({ body, descriptor, tempPath });
    const upload = await supabaseClient.storage
      .from(descriptor.storage_bucket)
      .upload(descriptor.storage_path, createReadStream(tempPath), {
        cacheControl: "31536000",
        contentType: descriptor.mime_type,
        duplex: "half",
        upsert: true,
      });
    if (upload.error) {
      throw failure(
        "A CMS asset could not be stored.",
        503,
        "CMS_ASSET_UPLOAD_FAILED",
      );
    }
    const download = await supabaseClient.storage
      .from(descriptor.storage_bucket)
      .download(descriptor.storage_path)
      .asStream();
    if (download.error || !download.data) {
      throw failure(
        "A stored CMS asset could not be verified.",
        503,
        "CMS_ASSET_VERIFY_FAILED",
      );
    }
    const stored = await hashStream(download.data);
    if (stored.bytes !== source.bytes || stored.sha256 !== source.sha256) {
      throw failure(
        "A stored CMS asset failed verification.",
        503,
        "CMS_ASSET_VERIFY_FAILED",
      );
    }
    return { ...descriptor, sha256: source.sha256 };
  } finally {
    await unlink(tempPath).catch(() => {});
  }
};

const manifestMatchesStored = (descriptor, stored) =>
  stored?.migration_status === "verified" &&
  stored.legacy_sanity_asset_id === descriptor.legacy_sanity_asset_id &&
  stored.source_url === descriptor.source_url &&
  stored.storage_bucket === descriptor.storage_bucket &&
  stored.storage_path === descriptor.storage_path &&
  stored.mime_type === descriptor.mime_type &&
  Number(stored.byte_size) === descriptor.byte_size &&
  /^[0-9a-f]{64}$/.test(String(stored.sha256 || ""));

const assertAssetCanBeUploaded = (descriptor) => {
  const isPublicImage = descriptor.storage_bucket === "site-content-public";
  const allowedMimeTypes = isPublicImage
    ? PUBLIC_IMAGE_MIME_TYPES
    : PRIVATE_FILE_MIME_TYPES;
  if (!allowedMimeTypes.has(descriptor.mime_type)) {
    throw failure(
      "The CMS asset type is not supported by storage.",
      400,
      "CMS_ASSET_TYPE_UNSUPPORTED",
    );
  }
  const maxBytes = isPublicImage
    ? PUBLIC_IMAGE_MAX_BYTES
    : MAX_SYNCHRONOUS_ASSET_BYTES;
  if (descriptor.byte_size > maxBytes) {
    throw failure(
      isPublicImage
        ? "CMS images must be 20 MB or smaller."
        : "CMS files over 64 MB must use the verified download catalog.",
      413,
      "CMS_ASSET_TOO_LARGE",
    );
  }
};

const loadSanityAssets = async ({ assetIds, token, sanityClientFactory }) => {
  if (assetIds.length < 1) return [];
  const client = sanityClientFactory({
    projectId: GLOBAL_SANITY_PROJECT_ID,
    dataset: GLOBAL_SANITY_DATASET,
    apiVersion: SANITY_API_VERSION,
    token,
    useCdn: false,
    perspective: "raw",
  });
  return client.fetch(
    `*[_id in $ids]{_id,_type,assetId,extension,url,mimeType,size,sha1hash,metadata{dimensions{width,height}}}`,
    { ids: assetIds },
  );
};

export const prepareGlobalCmsAssets = async ({
  document,
  suppliedManifest,
  token,
  supabaseClient,
  fetchImpl = fetch,
  sanityClientFactory = createSanityClient,
} = {}) => {
  const assetIds = collectGlobalCmsAssetIds(document);
  if (assetIds.length > 100) {
    throw failure(
      "A CMS document references too many assets.",
      400,
      "CMS_ASSET_LIMIT",
    );
  }
  const supplied = normalizeGlobalCmsAssetManifest(suppliedManifest);
  if (
    stableCmsJson(supplied.map((asset) => asset._id)) !==
    stableCmsJson(assetIds)
  ) {
    throw failure(
      "The CMS asset manifest is incomplete.",
      400,
      "CMS_ASSET_MANIFEST_INCOMPLETE",
    );
  }
  const authoritative = normalizeGlobalCmsAssetManifest(
    await loadSanityAssets({ assetIds, token, sanityClientFactory }),
  );
  if (stableCmsJson(authoritative) !== stableCmsJson(supplied)) {
    throw failure(
      "The CMS asset manifest changed before publishing.",
      409,
      "CMS_ASSET_MANIFEST_STALE",
    );
  }
  if (authoritative.length < 1) return [];

  const descriptors = authoritative.map(assetDescriptor);

  const storedRows = requireRpcData(
    await supabaseClient.rpc("roo_asset_manifest_for_refs", {
      p_asset_ids: assetIds,
      p_source_urls: null,
    }),
    "asset manifest lookup",
  );
  const storedById = new Map(
    (Array.isArray(storedRows) ? storedRows : []).map((row) => [
      row.legacy_sanity_asset_id,
      row,
    ]),
  );
  const prepared = [];
  for (const descriptor of descriptors) {
    const stored = storedById.get(descriptor.legacy_sanity_asset_id);
    if (manifestMatchesStored(descriptor, stored)) {
      prepared.push({ ...descriptor, sha256: stored.sha256 });
      continue;
    }
    assertAssetCanBeUploaded(descriptor);
    prepared.push(
      await uploadAndVerifyAsset({
        descriptor,
        token,
        supabaseClient,
        fetchImpl,
      }),
    );
  }
  return prepared;
};
