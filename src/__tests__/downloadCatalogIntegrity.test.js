jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));

const {
  getDownloadBySlug,
  parseDownloadCatalog,
} = require("../server/downloads/downloadCatalog");

const sha256 = "8".repeat(64);
const blobEtag = "verified-blob-etag";

describe("download catalog integrity metadata", () => {
  test("retains private size and hash metadata without exposing it publicly", () => {
    const env = {
      DOWNLOAD_CATALOG_JSON: JSON.stringify([
        {
          slug: "utilities",
          fileName: "utilities.zip",
          blobPath: "downloads/utilities.zip",
          sizeBytes: 3_650_722_816,
          sha256,
          blobEtag,
        },
      ]),
    };

    expect(parseDownloadCatalog(env)).toEqual([
      expect.objectContaining({
        slug: "utilities",
        sizeBytes: 3_650_722_816,
        sha256,
        blobEtag,
      }),
    ]);
  });

  test.each([
    [{ sha256: "not-a-sha" }],
    [{ sizeBytes: -1 }],
    [{ fileName: "utilities.zip", blobPath: "downloads/other.zip" }],
  ])("does not fall back to an unsafe default for an invalid configured entry", (patch) => {
    const env = {
      DOWNLOAD_CATALOG_JSON: JSON.stringify([
        {
          slug: "utilities",
          fileName: "utilities.zip",
          blobPath: "downloads/utilities.zip",
          sizeBytes: 3_650_722_816,
          sha256,
          blobEtag,
          ...patch,
        },
      ]),
    };

    expect(getDownloadBySlug("utilities", env)).toBeNull();
  });
});
