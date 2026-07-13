const mockIssueSignedToken = jest.fn();
const mockPresignUrl = jest.fn();

jest.mock("@vercel/blob", () => ({
  issueSignedToken: (...args) => mockIssueSignedToken(...args),
  presignUrl: (...args) => mockPresignUrl(...args),
}));

const {
  createSignedBlobDownloadUrl,
} = require("../server/downloads/downloadStorage");

describe("signed Blob downloads", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIssueSignedToken.mockResolvedValue({
      delegationToken: "delegation",
      clientSigningToken: "signing",
    });
    mockPresignUrl.mockResolvedValue({
      presignedUrl:
        "https://private-store.blob.vercel-storage.com/downloads/utilities.zip?vercel-blob-signature=signed",
    });
  });

  test("scopes a temporary GET URL to the exact private blob", async () => {
    const nowMs = 1_700_000_000_000;
    const url = await createSignedBlobDownloadUrl(
      { blobPath: "downloads/utilities.zip" },
      {
        nowMs,
        env: {
          BLOB_READ_WRITE_TOKEN: "blob-secret",
          DOWNLOAD_SIGNED_URL_TTL_SECONDS: "7200",
        },
      }
    );

    expect(url).toContain("downloads/utilities.zip");
    expect(mockIssueSignedToken).toHaveBeenCalledWith({
      pathname: "downloads/utilities.zip",
      operations: ["get"],
      validUntil: nowMs + 7_200_000,
      token: "blob-secret",
    });
    expect(mockPresignUrl).toHaveBeenCalledWith(
      expect.objectContaining({ delegationToken: "delegation" }),
      {
        operation: "get",
        pathname: "downloads/utilities.zip",
        access: "private",
        validUntil: nowMs + 7_200_000,
      }
    );
  });

  test("rejects paths that could escape the catalog scope", async () => {
    await expect(
      createSignedBlobDownloadUrl({ blobPath: "../utilities.zip" })
    ).rejects.toMatchObject({ status: 404 });
    expect(mockIssueSignedToken).not.toHaveBeenCalled();
  });

  test("rejects signed URLs outside the Vercel Blob host", async () => {
    mockPresignUrl.mockResolvedValue({
      presignedUrl: "https://example.com/downloads/utilities.zip?token=bad",
    });

    await expect(
      createSignedBlobDownloadUrl({ blobPath: "downloads/utilities.zip" })
    ).rejects.toThrow("invalid signed download URL");
  });
});
