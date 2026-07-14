const mockLogSafeError = jest.fn();

jest.mock("../server/safeErrorLog", () => ({
  logSafeError: (...args) => mockLogSafeError(...args),
}));

const {
  getDownloadBySlug,
  hasMatchingDownloadBasename,
  parseDownloadCatalog,
} = require("../server/downloads/downloadCatalog");

const catalogEnv = (entry) => ({
  DOWNLOAD_CATALOG_JSON: JSON.stringify([{
    sizeBytes: 3_650_722_816,
    sha256: "8".repeat(64),
    blobEtag: "verified-blob-etag",
    ...entry,
  }]),
});

describe("download catalog normalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("keeps an exact catalog filename and Blob basename mapping", () => {
    const env = catalogEnv({
      slug: "utilities",
      fileName: "utilities-2026.zip",
      blobPath: "customer-files/utilities-2026.zip",
      storageBackend: "blob",
    });

    expect(parseDownloadCatalog(env)).toEqual([
      expect.objectContaining({
        slug: "utilities",
        fileName: "utilities-2026.zip",
        blobPath: "customer-files/utilities-2026.zip",
      }),
    ]);
    expect(hasMatchingDownloadBasename(getDownloadBySlug("utilities", env))).toBe(
      true
    );
  });

  test("rejects a configured filename and Blob basename mismatch", () => {
    const env = catalogEnv({
      slug: "utilities",
      fileName: "catalog-name.zip",
      blobPath: "downloads/stored-name.zip",
    });

    expect(parseDownloadCatalog(env)).toEqual([]);
    expect(getDownloadBySlug("utilities", env)).toBeNull();
    expect(mockLogSafeError).toHaveBeenCalledWith(
      "Download catalog entry is invalid",
      expect.objectContaining({ code: "download_catalog_entry_invalid" })
    );
  });

  test.each(["nested/utilities.zip", "nested\\utilities.zip"])(
    "rejects a filename containing path components: %s",
    (fileName) => {
      const env = catalogEnv({
        slug: "utilities",
        fileName,
        blobPath: "downloads/utilities.zip",
      });

      expect(getDownloadBySlug("utilities", env)).toBeNull();
    }
  );

  test("rejects Blob paths that normalize through a parent segment", () => {
    const env = catalogEnv({
      slug: "utilities",
      fileName: "utilities.zip",
      blobPath: "downloads/archive/../utilities.zip",
    });

    expect(getDownloadBySlug("utilities", env)).toBeNull();
  });

  test("retains default normalization for slugs without an invalid catalog entry", () => {
    const env = catalogEnv({
      slug: "broken-download",
      fileName: "catalog-name.zip",
      blobPath: "downloads/stored-name.zip",
    });

    expect(getDownloadBySlug("utilities", env)).toMatchObject({
      slug: "utilities",
      fileName: "utilities.zip",
      blobPath: "downloads/utilities.zip",
    });
  });

  test.each(["sizeBytes", "sha256", "blobEtag"])(
    "rejects a configured archive without mandatory %s integrity metadata",
    (missingField) => {
      const entry = {
        slug: "utilities",
        fileName: "utilities.zip",
        blobPath: "downloads/utilities.zip",
        sizeBytes: 3_650_722_816,
        sha256: "8".repeat(64),
        blobEtag: "verified-blob-etag",
      };
      delete entry[missingField];
      const env = {
        DOWNLOAD_CATALOG_JSON: JSON.stringify([entry]),
      };
      expect(getDownloadBySlug("utilities", env)).toBeNull();
    }
  );
});
