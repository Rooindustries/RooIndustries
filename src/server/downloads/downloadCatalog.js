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
  const fileName = String(value || fallback || "").trim();
  if (
    !fileName ||
    fileName !== path.basename(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(fileName)
  ) {
    return "";
  }
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
  const rawParts = raw.split("/");
  const parts = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    rawParts.some((part) => part === "..") ||
    parts.some((part) => part === "..")
  ) {
    return "";
  }

  return normalized;
};

export const hasMatchingDownloadBasename = (download = {}) => {
  const rawFileName = String(download.fileName || "");
  const rawBlobPath = String(download.blobPath || "");
  const fileName = rawFileName.trim();
  const blobPath = sanitizeBlobPath(rawBlobPath);
  return (
    !!fileName &&
    !!blobPath &&
    rawFileName === fileName &&
    rawBlobPath === blobPath &&
    posixPath.basename(blobPath) === fileName
  );
};

const normalizeExpectedSize = (entry = {}) => {
  const raw = entry.sizeBytes ?? entry.size;
  if (raw === undefined || raw === null || raw === "") return 0;
  const size = Number(raw);
  return Number.isSafeInteger(size) && size > 0 ? size : -1;
};

const normalizeSha256 = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
};

const normalizeEtag = (value) => {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.length <= 256 && !/[\x00-\x1f\x7f]/.test(normalized)
    ? normalized
    : null;
};

const normalizeCatalogEntry = (entry = {}, { requireIntegrity = true } = {}) => {
  const slug = normalizeDownloadSlug(entry.slug);
  if (!slug) return null;

  const fileName = sanitizeFileName(
    entry.fileName || entry.filename,
    `${slug}.zip`
  );
  if (!fileName) return null;
  const blobPath = sanitizeBlobPath(entry.blobPath, `downloads/${fileName}`);
  if (!blobPath || !hasMatchingDownloadBasename({ fileName, blobPath })) return null;
  const sizeBytes = normalizeExpectedSize(entry);
  const sha256 = normalizeSha256(entry.sha256);
  const blobEtag = normalizeEtag(entry.blobEtag ?? entry.etag);
  if (sizeBytes < 0 || sha256 === null || blobEtag === null) return null;
  if (requireIntegrity && (sizeBytes <= 0 || !sha256 || !blobEtag)) return null;

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
    sizeBytes,
    sha256,
    blobEtag,
    allowedPackageTitles: asArray(entry.allowedPackageTitles || entry.packages)
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  };
};

const readDownloadCatalog = (env = process.env) => {
  const raw = String(env.DOWNLOAD_CATALOG_JSON || "").trim();
  if (!raw) return { entries: [], invalidSlugs: new Set(), malformed: false };

  try {
    const parsed = JSON.parse(raw);
    const sourceEntries = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed || {}).map(([slug, value]) => ({
          slug,
          ...(value && typeof value === "object" ? value : {}),
        }));
    const entries = [];
    const invalidSlugs = new Set();

    for (const sourceEntry of sourceEntries) {
      const normalized = normalizeCatalogEntry(sourceEntry);
      if (normalized) {
        entries.push(normalized);
        continue;
      }

      const configuredSlug = normalizeDownloadSlug(sourceEntry?.slug);
      if (configuredSlug) invalidSlugs.add(configuredSlug);
      const error = new Error("Download catalog entry is invalid.");
      error.code = "download_catalog_entry_invalid";
      logSafeError("Download catalog entry is invalid", error);
    }

    return { entries, invalidSlugs, malformed: false };
  } catch (error) {
    logSafeError("Download catalog configuration is invalid", error);
    return { entries: [], invalidSlugs: new Set(), malformed: true };
  }
};

export const parseDownloadCatalog = (env = process.env) =>
  readDownloadCatalog(env).entries;

export const getDownloadBySlug = (slug, env = process.env) => {
  const normalizedSlug = normalizeDownloadSlug(slug);
  if (!normalizedSlug) return null;

  const catalog = readDownloadCatalog(env);
  const configured = catalog.entries.find(
    (entry) => entry.slug === normalizedSlug
  );
  if (configured) return configured;
  if (catalog.malformed || catalog.invalidSlugs.has(normalizedSlug)) return null;

  return normalizeCatalogEntry(
    { slug: normalizedSlug },
    { requireIntegrity: false }
  );
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
