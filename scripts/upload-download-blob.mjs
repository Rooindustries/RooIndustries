import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import posixPath from "node:path/posix";
import dotenv from "dotenv";
import { head, put } from "@vercel/blob";
import integrity from "./download-blob-integrity.cjs";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

const DEFAULT_CONTENT_TYPE = "application/zip";
const { assertRemoteBlobMetadata, inspectDownloadArtifact } = integrity;

const usage = () => {
  console.error(
    "Usage: node scripts/upload-download-blob.mjs <slug> [local-zip-path] [--overwrite] [--verify-only]"
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

const sanitizeBlobPath = (value, fallback) => {
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

const parseCatalogEntry = (entry) => {
  const slug = normalizeSlug(entry.slug);
  if (!slug) return null;
  const fileName = sanitizeFileName(
    entry.fileName || entry.filename,
    `${slug}.zip`
  );
  const blobPath = sanitizeBlobPath(entry.blobPath, `downloads/${fileName}`);
  if (!fileName || !blobPath) {
    throw new Error(`[downloads] Catalog path is invalid for "${slug}".`);
  }
  if (posixPath.basename(blobPath) !== fileName) {
    throw new Error(
      `[downloads] Catalog fileName must match the blobPath basename for "${slug}".`
    );
  }

  const rawSize = entry.sizeBytes ?? entry.size;
  const sizeBytes =
    rawSize === undefined || rawSize === null || rawSize === ""
      ? 0
      : Number(rawSize);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error(`[downloads] Catalog sizeBytes is invalid for "${slug}".`);
  }
  const sha256 = String(entry.sha256 || "").trim().toLowerCase();
  if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`[downloads] Catalog sha256 is invalid for "${slug}".`);
  }
  return {
    slug,
    fileName,
    blobPath,
    sha256,
    sizeBytes,
    contentType:
      String(entry.contentType || "").trim() || DEFAULT_CONTENT_TYPE,
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

const args = process.argv.slice(2);
const overwrite = args.includes("--overwrite");
const verifyOnly = args.includes("--verify-only");
const supportedFlags = new Set(["--overwrite", "--verify-only"]);
if (args.some((arg) => arg.startsWith("--") && !supportedFlags.has(arg))) usage();
const positional = args.filter((arg) => !supportedFlags.has(arg));
const slug = normalizeSlug(positional[0]);
if (!slug || positional.length > 2) usage();

let configured = null;
try {
  configured = parseCatalog().find((entry) => entry.slug === slug) || null;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "[downloads] Download catalog is invalid."
  );
  process.exit(1);
}
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

let localArtifact = null;
try {
  localArtifact = await inspectDownloadArtifact(localPath);
} catch (error) {
  console.error(
    `[downloads] Local artifact failed ZIP integrity verification: ${
      error instanceof Error ? error.message : "unknown failure"
    }`
  );
  process.exit(1);
}

if (configured?.sizeBytes && configured.sizeBytes !== localArtifact.sizeBytes) {
  console.error(
    `[downloads] Local ZIP size ${localArtifact.sizeBytes} does not match catalog sizeBytes ${configured.sizeBytes}.`
  );
  process.exit(1);
}
if (configured?.sha256 && configured.sha256 !== localArtifact.sha256) {
  console.error("[downloads] Local ZIP SHA-256 does not match the catalog hash.");
  process.exit(1);
}

if (verifyOnly) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        verifiedOnly: true,
        slug,
        localPath,
        blobPath,
        sizeBytes: localArtifact.sizeBytes,
        sha256: localArtifact.sha256,
        entryCount: localArtifact.entryCount,
        zip64: localArtifact.zip64,
      },
      null,
      2
    )
  );
  process.exit(0);
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

const remoteMetadata = await head(blobPath);
try {
  assertRemoteBlobMetadata({
    pathname: blobPath,
    uploadResult: blob,
    remoteMetadata,
    localArtifact,
    contentType,
  });
} catch (error) {
  console.error(
    `[downloads] Uploaded Blob failed post-upload verification: ${
      error instanceof Error ? error.message : "unknown failure"
    }`
  );
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      slug,
      localPath,
      blobPath: blob.pathname,
      sizeBytes: localArtifact.sizeBytes,
      remoteSizeBytes: remoteMetadata.size,
      sha256: localArtifact.sha256,
      etag: remoteMetadata.etag,
      entryCount: localArtifact.entryCount,
      zip64: localArtifact.zip64,
      contentType,
      overwritten: allowOverwrite,
      catalogIntegrity: {
        sizeBytes: localArtifact.sizeBytes,
        sha256: localArtifact.sha256,
        blobEtag: remoteMetadata.etag,
      },
    },
    null,
    2
  )
);
