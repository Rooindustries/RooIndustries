import path from "node:path";
import posixPath from "node:path/posix";
import { logSafeError } from "../safeErrorLog.js";

export const DEFAULT_DOWNLOAD_ROOT = "downloads";
export const DEFAULT_DOWNLOAD_CONTENT_TYPE = "application/zip";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

const titleFromSlug = (slug) =>
  String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const asArray = (value) => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const normalizeStorageBackend = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "blob" || normalized === "local" ? normalized : "";
};

export const normalizeDownloadSlug = (value) => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized || !SLUG_PATTERN.test(normalized)) return "";
  return normalized;
};

const sanitizeFileName = (value, fallback) => {
  const fileName = path.basename(String(value || fallback || "").trim());
  if (!fileName || fileName.includes("/") || fileName.includes("\\")) return "";
  if (!fileName.toLowerCase().endsWith(".zip")) return "";
  return fileName;
};

export const sanitizeBlobPath = (value, fallback) => {
  const raw = String(value || fallback || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!raw) return "";

  const normalized = posixPath.normalize(raw);
  const parts = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    parts.some((part) => part === "..")
  ) {
    return "";
  }

  return normalized;
};

const normalizeCatalogEntry = (entry = {}) => {
  const slug = normalizeDownloadSlug(entry.slug);
  if (!slug) return null;

  const fileName = sanitizeFileName(
    entry.fileName || entry.filename,
    `${slug}.zip`
  );
  if (!fileName) return null;
  const blobPath = sanitizeBlobPath(entry.blobPath, `downloads/${fileName}`);
  if (!blobPath) return null;

  const title = String(entry.title || "").trim() || `${titleFromSlug(slug)} Download`;
  const description =
    String(entry.description || "").trim() ||
    "Enter the Order ID and booking email from your Roo Industries confirmation email to start the download.";

  return {
    slug,
    title,
    description,
    fileName,
    blobPath,
    storageBackend: normalizeStorageBackend(
      entry.storageBackend || entry.backend
    ),
    contentType:
      String(entry.contentType || "").trim() || DEFAULT_DOWNLOAD_CONTENT_TYPE,
    allowedPackageTitles: asArray(entry.allowedPackageTitles || entry.packages)
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  };
};

export const parseDownloadCatalog = (env = process.env) => {
  const raw = String(env.DOWNLOAD_CATALOG_JSON || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed || {}).map(([slug, value]) => ({
          slug,
          ...(value && typeof value === "object" ? value : {}),
        }));

    return entries.map(normalizeCatalogEntry).filter(Boolean);
  } catch (error) {
    logSafeError("Download catalog configuration is invalid", error);
    return [];
  }
};

export const getDownloadBySlug = (slug, env = process.env) => {
  const normalizedSlug = normalizeDownloadSlug(slug);
  if (!normalizedSlug) return null;

  const configured = parseDownloadCatalog(env).find(
    (entry) => entry.slug === normalizedSlug
  );
  if (configured) return configured;

  return normalizeCatalogEntry({ slug: normalizedSlug });
};

export const getDownloadRootDir = (env = process.env) =>
  path.resolve(process.cwd(), String(env.DOWNLOAD_ROOT_DIR || DEFAULT_DOWNLOAD_ROOT));

export const resolveDownloadFilePath = (download, env = process.env) => {
  if (!download?.fileName) {
    throw new Error("Download file name is required.");
  }

  const rootDir = getDownloadRootDir(env);
  const filePath = path.resolve(rootDir, download.fileName);

  if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error("Download file path escapes the download root.");
  }

  return filePath;
};

export const getPublicDownloadInfo = (download) => ({
  slug: download.slug,
  title: download.title,
  description: download.description,
  fileName: download.fileName,
});
