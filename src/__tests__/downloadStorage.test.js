const mockGetDownloadUrl = jest.fn();
const mockHead = jest.fn();
const mockIssueSignedToken = jest.fn();
const mockPresignUrl = jest.fn();

jest.mock("@vercel/blob", () => ({
  getDownloadUrl: (...args) => mockGetDownloadUrl(...args),
  head: (...args) => mockHead(...args),
  issueSignedToken: (...args) => mockIssueSignedToken(...args),
  presignUrl: (...args) => mockPresignUrl(...args),
}));

const {
  createSignedBlobDownloadUrl,
} = require("../server/downloads/downloadStorage");

const download = {
  fileName: "utilities.zip",
  blobPath: "downloads/utilities.zip",
  sizeBytes: 3_650_722_816,
  sha256: "8".repeat(64),
  blobEtag: "verified-etag",
  contentType: "application/zip",
};

const privateBlobUrl =
  "https://store.private.blob.vercel-storage.com/downloads/utilities.zip" +
  "?vercel-blob-delegation=delegation&vercel-blob-signature=signed";

describe("signed Blob downloads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIssueSignedToken.mockResolvedValue({
      delegationToken: "delegation",
      clientSigningToken: "signing",
    });
    mockHead.mockResolvedValue({
      pathname: "downloads/utilities.zip",
      size: 3_650_722_816,
      etag: "verified-etag",
      contentType: "application/zip",
    });
    mockPresignUrl.mockResolvedValue({ presignedUrl: privateBlobUrl });
    mockGetDownloadUrl.mockImplementation((value) => {
      const url = new URL(value);
      url.searchParams.set("download", "1");
      return url.toString();
    });
  });

  test("scopes a 24-hour range-resumable URL to the verified private blob", async () => {
    const nowMs = 1_700_000_000_000;
    const url = await createSignedBlobDownloadUrl(download, {
      nowMs,
      env: { BLOB_READ_WRITE_TOKEN: "blob-secret" },
    });

    expect(new URL(url).searchParams.get("download")).toBe("1");
    expect(mockHead).toHaveBeenCalledWith("downloads/utilities.zip", {
      token: "blob-secret",
    });
    expect(mockIssueSignedToken).toHaveBeenCalledWith({
      pathname: "downloads/utilities.zip",
      operations: ["get"],
      validUntil: nowMs + 86_400_000,
      token: "blob-secret",
    });
    expect(mockPresignUrl).toHaveBeenCalledWith(
      expect.objectContaining({ delegationToken: "delegation" }),
      {
        operation: "get",
        pathname: "downloads/utilities.zip",
        access: "private",
        validUntil: nowMs + 86_400_000,
      }
    );
    expect(mockGetDownloadUrl).toHaveBeenCalledWith(privateBlobUrl);
  });

  test.each([
    ["120", 86_400_000],
    ["300", 86_400_000],
    ["9999999", 604_800_000],
    ["not-a-number", 86_400_000],
  ])("clamps configured TTL %s to a safe transfer window", async (ttl, offset) => {
    const nowMs = 1_700_000_000_000;

    await createSignedBlobDownloadUrl(download, {
      nowMs,
      env: {
        BLOB_READ_WRITE_TOKEN: "blob-secret",
        DOWNLOAD_SIGNED_URL_TTL_SECONDS: ttl,
      },
    });

    expect(mockIssueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({ validUntil: nowMs + offset })
    );
  });

  test("fails closed before signing when Blob size differs from the catalog", async () => {
    mockHead.mockResolvedValue({
      pathname: "downloads/utilities.zip",
      size: download.sizeBytes - 100,
      etag: "verified-etag",
      contentType: "application/zip",
    });

    await expect(createSignedBlobDownloadUrl(download)).rejects.toMatchObject({
      code: "DOWNLOAD_BLOB_SIZE_MISMATCH",
      status: 503,
    });
    expect(mockIssueSignedToken).not.toHaveBeenCalled();
  });

  test.each(["sizeBytes", "sha256", "blobEtag"])(
    "fails closed before Blob lookup when %s is not pinned",
    async (missingField) => {
      const unpinned = { ...download };
      delete unpinned[missingField];
      await expect(createSignedBlobDownloadUrl(unpinned)).rejects.toMatchObject({
        code: "DOWNLOAD_BLOB_INTEGRITY_UNPINNED",
        status: 503,
      });
      expect(mockHead).not.toHaveBeenCalled();
      expect(mockIssueSignedToken).not.toHaveBeenCalled();
    }
  );

  test("fails closed when the verified catalog points at another Blob revision", async () => {
    mockHead.mockResolvedValue({
      pathname: "downloads/utilities.zip",
      size: download.sizeBytes,
      etag: "unexpected-etag",
      contentType: "application/zip",
    });

    await expect(createSignedBlobDownloadUrl(download)).rejects.toMatchObject({
      code: "DOWNLOAD_BLOB_ETAG_MISMATCH",
      status: 503,
    });
    expect(mockIssueSignedToken).not.toHaveBeenCalled();
  });

  test("rejects catalog and blob basenames that differ", async () => {
    await expect(
      createSignedBlobDownloadUrl({
        fileName: "catalog-name.zip",
        blobPath: "downloads/stored-name.zip",
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(mockHead).not.toHaveBeenCalled();
  });

  test("rejects paths that could escape the catalog scope", async () => {
    await expect(
      createSignedBlobDownloadUrl({
        fileName: "utilities.zip",
        blobPath: "../utilities.zip",
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockIssueSignedToken).not.toHaveBeenCalled();
  });

  test.each([
    [
      "https://example.com/downloads/utilities.zip" +
        "?vercel-blob-delegation=delegation&vercel-blob-signature=signed",
    ],
    [
      "https://store.private.blob.vercel-storage.com/downloads/other.zip" +
        "?vercel-blob-delegation=delegation&vercel-blob-signature=signed",
    ],
  ])("rejects a signed URL outside the exact private blob scope", async (url) => {
    mockPresignUrl.mockResolvedValue({ presignedUrl: url });

    await expect(createSignedBlobDownloadUrl(download)).rejects.toThrow(
      "invalid signed download URL"
    );
    expect(mockGetDownloadUrl).not.toHaveBeenCalled();
  });
});
