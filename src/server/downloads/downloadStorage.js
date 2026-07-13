import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveDownloadFilePath } from "./downloadCatalog.js";
import { logSafeError } from "../safeErrorLog.js";

export const DOWNLOAD_STORAGE_BLOB = "blob";
export const DOWNLOAD_STORAGE_LOCAL = "local";

const normalizeValue = (value) => String(value || "").trim();

const SIGNED_DOWNLOAD_TTL_SECONDS = 4 * 60 * 60;
const MIN_SIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;
const MAX_SIGNED_DOWNLOAD_TTL_SECONDS = 6 * 60 * 60;

const loadBlobSdk = async () => import("@vercel/blob");

const signedDownloadTtlSeconds = (env = process.env) => {
  const configured = Number(env.DOWNLOAD_SIGNED_URL_TTL_SECONDS);
  if (!Number.isFinite(configured)) return SIGNED_DOWNLOAD_TTL_SECONDS;
  return Math.min(
    MAX_SIGNED_DOWNLOAD_TTL_SECONDS,
    Math.max(MIN_SIGNED_DOWNLOAD_TTL_SECONDS, Math.trunc(configured))
  );
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

export const isLocalDownloadAvailable = async (download, env = process.env) => {
  try {
    const stats = await fsp.stat(resolveDownloadFilePath(download, env));
    return stats.isFile();
  } catch {
    return false;
  }
};

export const isBlobDownloadAvailable = async (download) => {
  try {
    const { head } = await loadBlobSdk();
    const metadata = await head(download.blobPath);
    return !!metadata?.pathname;
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
    return isBlobDownloadAvailable(download);
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
  if (!pathname || pathname.startsWith("/") || pathname.includes("..")) {
    const error = new Error("Download file is not available.");
    error.status = 404;
    throw error;
  }

  const validUntil = Math.trunc(nowMs) + signedDownloadTtlSeconds(env) * 1000;
  const { issueSignedToken, presignUrl } = await loadBlobSdk();
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
  const signedUrl = new URL(String(result?.presignedUrl || ""));
  if (
    signedUrl.protocol !== "https:" ||
    !signedUrl.hostname.endsWith(".blob.vercel-storage.com")
  ) {
    throw new Error("Blob returned an invalid signed download URL.");
  }
  return signedUrl.toString();
};

export const streamDownload = async (download, env = process.env) => {
  const backend = getDownloadStorageBackend(download, env);
  if (backend === DOWNLOAD_STORAGE_BLOB) {
    return streamBlobDownload(download);
  }

  return streamLocalDownload(download, env);
};
