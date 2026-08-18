const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const uploadScript = path.join(
  projectRoot,
  "scripts/upload-download-supabase.mjs"
);

describe("download Supabase migration guard", () => {
  test("uses Supabase's required resumable upload contract", () => {
    const source = fs.readFileSync(uploadScript, "utf8");
    expect(source).toContain(".storage.supabase.co/storage/v1/upload/resumable");
    expect(source).toContain("const TUS_CHUNK_SIZE = 6 * 1024 * 1024");
    expect(source).toContain('"x-upsert": String(overwrite)');
    expect(source).toContain("retryDelays:");
    expect(source).toContain('const OBJECT_CACHE_CONTROL = "3600"');
    expect(source).toContain("cacheControl: OBJECT_CACHE_CONTROL");
    expect(source).not.toContain('cacheControl: "31536000"');
  });

  test("fails before file or network access when catalog basenames differ", () => {
    const result = spawnSync(process.execPath, [uploadScript, "utilities"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOWNLOAD_CATALOG_JSON: JSON.stringify([{
          slug: "utilities",
          fileName: "catalog-name.zip",
          blobPath: "downloads/stored-name.zip",
        }]),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Catalog fileName must match the blobPath basename for "utilities".'
    );
    expect(result.stderr).not.toContain("Local ZIP not found");
  });

  test("does not allow bucket mutation outside apply mode", () => {
    const result = spawnSync(
      process.execPath,
      [uploadScript, "utilities", "--raise-bucket-limit"],
      { cwd: projectRoot, encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--raise-bucket-limit require --apply");
  });
});
