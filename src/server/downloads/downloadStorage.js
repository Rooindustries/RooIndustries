import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import {
  hasMatchingDownloadBasename,
  resolveDownloadFilePath,
} from "./downloadCatalog.js";
import { logSafeError } from "../safeErrorLog.js";

export const DOWNLOAD_STORAGE_BLOB = "blob";
export const DOWNLOAD_STORAGE_LOCAL = "local";

const normalizeValue = (value) => String(value || "").trim();

const SIGNED_DOWNLOAD_TTL_SECONDS = 24 * 60 * 60;
const MIN_SIGNED_DOWNLOAD_TTL_SECONDS = SIGNED_DOWNLOAD_TTL_SECONDS;
const MAX_SIGNED_DOWNLOAD_TTL_SECONDS = 7 * 24 * 60 * 60;

const loadBlobSdk = async () => import("@vercel/blob");

const signedDownloadTtlSeconds = (env = process.env) => {
  const configuredValue = normalizeValue(env.DOWNLOAD_SIGNED_URL_TTL_SECONDS);
  if (!configuredValue) return SIGNED_DOWNLOAD_TTL_SECONDS;

  const configured = Number(configuredValue);
  if (!Number.isFinite(configured)) return SIGNED_DOWNLOAD_TTL_SECONDS;
  return Math.min(
    MAX_SIGNED_DOWNLOAD_TTL_SECONDS,
    Math.max(MIN_SIGNED_DOWNLOAD_TTL_SECONDS, Math.trunc(configured))
  );
};

const unavailableDownloadError = (code = "DOWNLOAD_FILE_UNAVAILABLE") => {
  const error = new Error("Download file is not available.");
  error.status = 503;
  error.code = code;
  return error;
};

export const hasBlobCredentials = (env = process.env) =>
  !!(
    normalizeValue(env.BLOB_READ_WRITE_TOKEN) ||
    normalizeValue(env.BLOB_STORE_ID) ||
    normalizeValue(env.VERCEL_OIDC_TOKEN)
  );

export const getDownloadStorageBackend = (download = {}, env = process.env) => {
  const configured = normalizeValue(
    download.storageBackend || env.DOWNLOAD_STORAGE_BACKEND
  ).toLowerCase();

  if (configured === DOWNLOAD_STORAGE_BLOB) return DOWNLOAD_STORAGE_BLOB;
  if (configured === DOWNLOAD_STORAGE_LOCAL) return DOWNLOAD_STORAGE_LOCAL;
  return hasBlobCredentials(env) ? DOWNLOAD_STORAGE_BLOB : DOWNLOAD_STORAGE_LOCAL;
};

export const canRedirectToSignedBlobDownload = (download = {}) =>
  hasMatchingDownloadBasename(download);

export const verifyBlobDownloadMetadata = async (
  download,
  { env = process.env } = {}
) => {
  const pathname = normalizeValue(download?.blobPath);
  if (!pathname || !canRedirectToSignedBlobDownload(download)) {
    const error = unavailableDownloadError();
    error.status = 404;
    throw error;
  }
  const expectedSize = Number(download?.sizeBytes || 0);
  const expectedEtag = normalizeValue(download?.blobEtag);
  const expectedSha256 = normalizeValue(download?.sha256).toLowerCase();
  if (
    !Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
    !expectedEtag || !/^[a-f0-9]{64}$/.test(expectedSha256)
  ) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_INTEGRITY_UNPINNED");
  }

  const { head } = await loadBlobSdk();
  const metadata = await head(pathname, {
    token: normalizeValue(env.BLOB_READ_WRITE_TOKEN) || undefined,
  });
  if (normalizeValue(metadata?.pathname) !== pathname) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_PATH_MISMATCH");
  }

  const remoteSize = Number(metadata?.size);
  if (!Number.isSafeInteger(remoteSize) || remoteSize <= 0) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_SIZE_INVALID");
  }

  if (remoteSize !== expectedSize) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_SIZE_MISMATCH");
  }

  if (normalizeValue(metadata?.etag) !== expectedEtag) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_ETAG_MISMATCH");
  }

  const expectedContentType = normalizeValue(download?.contentType).toLowerCase();
  const remoteContentType = normalizeValue(metadata?.contentType)
    .split(";", 1)[0]
    .toLowerCase();
  if (expectedContentType && remoteContentType !== expectedContentType) {
    throw unavailableDownloadError("DOWNLOAD_BLOB_CONTENT_TYPE_MISMATCH");
  }

  return metadata;
};

export const isLocalDownloadAvailable = async (download, env = process.env) => {
  try {
    const stats = await fsp.stat(resolveDownloadFilePath(download, env));
    return stats.isFile();
  } catch {
    return false;
  }
};

export const isBlobDownloadAvailable = async (download, env = process.env) => {
  try {
    await verifyBlobDownloadMetadata(download, { env });
    return true;
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      logSafeError("Download blob availability check failed", error);
    }
    return false;
  }
};

export const isDownloadAvailable = async (download, env = process.env) => {
  const backend = getDownloadStorageBackend(download, env);
  if (backend === DOWNLOAD_STORAGE_BLOB) {
    return isBlobDownloadAvailable(download, env);
  }

  return isLocalDownloadAvailable(download, env);
};

export const streamLocalDownload = async (download, env = process.env) => {
  const filePath = resolveDownloadFilePath(download, env);
  const stats = await fsp.stat(filePath);
  if (!stats.isFile()) {
    const error = new Error("Download file is not available.");
    error.status = 404;
    throw error;
  }

  return {
    stream: Readable.toWeb(fs.createReadStream(filePath)),
    contentType: download.contentType || "application/zip",
    contentLength: stats.size,
    etag: "",
    cacheControl: "private, no-store",
  };
};

export const streamBlobDownload = async (download) => {
  const { get } = await loadBlobSdk();
  const result = await get(download.blobPath, { access: "private" });
  if (!result || result.statusCode !== 200 || !result.stream) {
    const error = new Error("Download file is not available.");
    error.status = 404;
    throw error;
  }

  return {
    stream: result.stream,
    contentType:
      result.blob?.contentType || download.contentType || "application/zip",
    contentLength: result.blob?.size || 0,
    etag: result.blob?.etag || "",
    cacheControl: "private, no-store",
  };
};

export const createSignedBlobDownloadUrl = async (
  download,
  { env = process.env, nowMs = Date.now() } = {}
) => {
  const pathname = normalizeValue(download?.blobPath);
  if (
    !pathname ||
    pathname.startsWith("/") ||
    pathname.includes("..") ||
    !canRedirectToSignedBlobDownload(download)
  ) {
    const error = new Error("Download file is not available.");
    error.status = 404;
    throw error;
  }

  await verifyBlobDownloadMetadata(download, { env });
  const validUntil = Math.trunc(nowMs) + signedDownloadTtlSeconds(env) * 1000;
  const { getDownloadUrl, issueSignedToken, presignUrl } = await loadBlobSdk();
  const signedToken = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
    token: normalizeValue(env.BLOB_READ_WRITE_TOKEN) || undefined,
  });
  const result = await presignUrl(signedToken, {
    operation: "get",
    pathname,
    access: "private",
    validUntil,
  });
  let signedUrl = null;
  let returnedPathname = "";
  try {
    signedUrl = new URL(String(result?.presignedUrl || ""));
    returnedPathname = decodeURIComponent(signedUrl.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("Blob returned an invalid signed download URL.");
  }
  if (
    signedUrl.protocol !== "https:" ||
    !signedUrl.hostname.endsWith(".private.blob.vercel-storage.com") ||
    signedUrl.username ||
    signedUrl.password ||
    signedUrl.hash ||
    returnedPathname !== pathname ||
    !signedUrl.searchParams.has("vercel-blob-delegation") ||
    !signedUrl.searchParams.has("vercel-blob-signature")
  ) {
    throw new Error("Blob returned an invalid signed download URL.");
  }
  return getDownloadUrl(signedUrl.toString());
};

export const streamDownload = async (download, env = process.env) => {
  const backend = getDownloadStorageBackend(download, env);
  if (backend === DOWNLOAD_STORAGE_BLOB) {
    return streamBlobDownload(download);
  }

  return streamLocalDownload(download, env);
};
