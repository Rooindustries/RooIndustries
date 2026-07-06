import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import posixPath from "node:path/posix";
import dotenv from "dotenv";
import { put } from "@vercel/blob";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const DEFAULT_CONTENT_TYPE = "application/zip";

const usage = () => {
  console.error(
    "Usage: node scripts/upload-download-blob.mjs <slug> [local-zip-path] [--overwrite]"
  );
  process.exit(1);
};

const normalizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const sanitizeFileName = (value, fallback) => {
  const fileName = path.basename(String(value || fallback || "").trim());
  if (!fileName || !fileName.toLowerCase().endsWith(".zip")) return "";
  return fileName;
};

const sanitizeBlobPath = (value, fallback) => {
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

  return entries
    .map((entry) => {
      const slug = normalizeSlug(entry.slug);
      if (!slug) return null;
      const fileName = sanitizeFileName(
        entry.fileName || entry.filename,
        `${slug}.zip`
      );
      if (!fileName) return null;
      const blobPath = sanitizeBlobPath(entry.blobPath, `downloads/${fileName}`);
      if (!blobPath) return null;
      return {
        slug,
        fileName,
        blobPath,
        contentType:
          String(entry.contentType || "").trim() || DEFAULT_CONTENT_TYPE,
      };
    })
    .filter(Boolean);
};

const args = process.argv.slice(2);
const overwrite = args.includes("--overwrite");
const positional = args.filter((arg) => arg !== "--overwrite");
const slug = normalizeSlug(positional[0]);
if (!slug) usage();

const configured = parseCatalog().find((entry) => entry.slug === slug);
const fileName = configured?.fileName || `${slug}.zip`;
const blobPath = configured?.blobPath || `downloads/${fileName}`;
const contentType = configured?.contentType || DEFAULT_CONTENT_TYPE;
const localPath = path.resolve(
  process.cwd(),
  positional[1] || path.join("downloads", fileName)
);

const stats = await fsp.stat(localPath).catch(() => null);
if (!stats?.isFile()) {
  console.error(`[downloads] Local ZIP not found: ${localPath}`);
  process.exit(1);
}

const allowOverwrite =
  overwrite || String(process.env.DOWNLOAD_BLOB_ALLOW_OVERWRITE || "") === "1";

const blob = await put(blobPath, fs.createReadStream(localPath), {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite,
  cacheControlMaxAge: 30 * 24 * 60 * 60,
  contentType,
  multipart: true,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      slug,
      localPath,
      blobPath: blob.pathname,
      size: stats.size,
      contentType,
      overwritten: allowOverwrite,
    },
    null,
    2
  )
);
