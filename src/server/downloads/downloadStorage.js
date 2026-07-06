import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveDownloadFilePath } from "./downloadCatalog.js";

export const DOWNLOAD_STORAGE_BLOB = "blob";
export const DOWNLOAD_STORAGE_LOCAL = "local";

const normalizeValue = (value) => String(value || "").trim();

const loadBlobSdk = async () => import("@vercel/blob");

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
      console.warn("[downloads] blob availability check failed:", error.message);
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

export const streamDownload = async (download, env = process.env) => {
  const backend = getDownloadStorageBackend(download, env);
  if (backend === DOWNLOAD_STORAGE_BLOB) {
    return streamBlobDownload(download);
  }

  return streamLocalDownload(download, env);
};
