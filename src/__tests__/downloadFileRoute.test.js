const mockGetDocument = jest.fn();
const mockValidateBooking = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockGetStorageBackend = jest.fn();
const mockStreamDownload = jest.fn();

jest.mock("../server/downloads/downloadAccess", () => ({
  createDownloadSanityClient: jest.fn(() => ({ getDocument: mockGetDocument })),
  validateBookingForDownloadToken: (...args) => mockValidateBooking(...args),
}));
jest.mock("../server/downloads/downloadCatalog", () => ({
  getDownloadBySlug: jest.fn(() => ({
    slug: "utilities",
    fileName: "utilities.zip",
    blobPath: "downloads/utilities.zip",
    storageBackend: "blob",
  })),
}));
jest.mock("../server/downloads/downloadStorage", () => ({
  createSignedBlobDownloadUrl: (...args) => mockCreateSignedUrl(...args),
  DOWNLOAD_STORAGE_BLOB: "blob",
  getDownloadStorageBackend: (...args) => mockGetStorageBackend(...args),
  streamDownload: (...args) => mockStreamDownload(...args),
}));
jest.mock("../server/downloads/downloadToken", () => ({
  verifyDownloadToken: jest.fn(() => ({
    ok: true,
    payload: {
      slug: "utilities",
      fileName: "utilities.zip",
      bookingId: "booking-private",
      emailHash: "email-hash",
    },
  })),
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));

const { GET } = require("../../app/api/downloads/file/route.js");

const request = () =>
  new Request("https://www.rooindustries.com/api/downloads/file", {
    headers: { cookie: "download_access=temporary-cookie-token" },
  });

describe("download file route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDocument.mockResolvedValue({ _id: "booking-private" });
    mockValidateBooking.mockReturnValue({ ok: true });
    mockGetStorageBackend.mockReturnValue("blob");
    mockCreateSignedUrl.mockResolvedValue(
      "https://private-store.blob.vercel-storage.com/downloads/utilities.zip?vercel-blob-signature=signed"
    );
  });

  test("redirects an authorized Blob download without proxying its bytes", async () => {
    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      "private-store.blob.vercel-storage.com/downloads/utilities.zip"
    );
    expect(response.headers.get("location")).not.toContain("booking-private");
    expect(response.headers.get("location")).not.toContain("email-hash");
    expect(response.headers.get("location")).not.toContain("temporary-cookie-token");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ blobPath: "downloads/utilities.zip" })
    );
    expect(mockStreamDownload).not.toHaveBeenCalled();
  });

  test("never mints a signed URL when booking revalidation fails", async () => {
    mockValidateBooking.mockReturnValue({
      ok: false,
      status: 403,
      error: "This booking is not eligible for this download.",
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(mockStreamDownload).not.toHaveBeenCalled();
  });

  test("preserves local streaming for small non-Blob downloads", async () => {
    mockGetStorageBackend.mockReturnValue("local");
    mockStreamDownload.mockResolvedValue({
      stream: "PK",
      contentType: "application/zip",
      contentLength: 2,
      etag: "local-etag",
      cacheControl: "private, no-store",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("content-disposition")).toContain("utilities.zip");
    expect(mockStreamDownload).toHaveBeenCalledTimes(1);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });
});
