const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const uploadScript = path.join(projectRoot, "scripts/upload-download-blob.mjs");

describe("download Blob upload catalog validation", () => {
  test("fails before upload when fileName and blobPath basenames differ", () => {
    const result = spawnSync(process.execPath, [uploadScript, "utilities"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOWNLOAD_CATALOG_JSON: JSON.stringify([
          {
            slug: "utilities",
            fileName: "catalog-name.zip",
            blobPath: "downloads/stored-name.zip",
          },
        ]),
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Catalog fileName must match the blobPath basename for "utilities".'
    );
    expect(result.stderr).not.toContain("Local ZIP not found");
  });
});
