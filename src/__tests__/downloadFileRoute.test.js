const mockCanRedirectToSignedBlobDownload = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockGetDocument = jest.fn();
const mockGetDownloadBySlug = jest.fn();
const mockGetStorageBackend = jest.fn();
const mockStreamDownload = jest.fn();
const mockValidateBooking = jest.fn();
const mockVerifyDownloadToken = jest.fn();

jest.mock("../server/downloads/downloadAccess", () => ({
  createDownloadSanityClient: jest.fn(() => ({ getDocument: mockGetDocument })),
  validateBookingForDownloadToken: (...args) => mockValidateBooking(...args),
}));
jest.mock("../server/downloads/downloadCatalog", () => ({
  getDownloadBySlug: (...args) => mockGetDownloadBySlug(...args),
}));
jest.mock("../server/downloads/downloadStorage", () => ({
  canRedirectToSignedBlobDownload: (...args) =>
    mockCanRedirectToSignedBlobDownload(...args),
  createSignedBlobDownloadUrl: (...args) => mockCreateSignedUrl(...args),
  DOWNLOAD_STORAGE_BLOB: "blob",
  getDownloadStorageBackend: (...args) => mockGetStorageBackend(...args),
  streamDownload: (...args) => mockStreamDownload(...args),
}));
jest.mock("../server/downloads/downloadToken", () => ({
  verifyDownloadToken: (...args) => mockVerifyDownloadToken(...args),
}));
jest.mock("../server/safeErrorLog", () => ({ logSafeError: jest.fn() }));

const { GET } = require("../../app/api/downloads/file/route.js");

const catalogDownload = {
  slug: "utilities",
  fileName: "utilities.zip",
  blobPath: "downloads/utilities.zip",
  storageBackend: "blob",
};

const authorizedPayload = {
  slug: "utilities",
  fileName: "utilities.zip",
  bookingId: "booking-private",
  emailHash: "email-hash",
};

const request = (cookie = "download_access=temporary-cookie-token") =>
  new Request("https://www.rooindustries.com/api/downloads/file", {
    headers: cookie ? { cookie } : {},
  });

describe("download file route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyDownloadToken.mockReturnValue({
      ok: true,
      payload: authorizedPayload,
    });
    mockGetDownloadBySlug.mockReturnValue(catalogDownload);
    mockGetDocument.mockResolvedValue({ _id: "booking-private" });
    mockValidateBooking.mockReturnValue({ ok: true });
    mockGetStorageBackend.mockReturnValue("blob");
    mockCanRedirectToSignedBlobDownload.mockReturnValue(true);
    mockCreateSignedUrl.mockResolvedValue(
      "https://store.private.blob.vercel-storage.com/downloads/utilities.zip" +
        "?vercel-blob-delegation=delegation&vercel-blob-signature=signed&download=1"
    );
  });

  test("redirects an authorized Blob download with private no-store headers", async () => {
    const response = await GET(request());
    const location = new URL(response.headers.get("location"));

    expect(response.status).toBe(307);
    expect(location.hostname).toBe("store.private.blob.vercel-storage.com");
    expect(location.pathname).toBe("/downloads/utilities.zip");
    expect(location.searchParams.get("download")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(response.headers.get("location")).not.toContain("booking-private");
    expect(response.headers.get("location")).not.toContain("email-hash");
    expect(response.headers.get("location")).not.toContain(
      "temporary-cookie-token"
    );
    expect(mockCreateSignedUrl).toHaveBeenCalledWith(catalogDownload);
    expect(mockStreamDownload).not.toHaveBeenCalled();
  });

  test("falls back to streaming with the catalog filename when basenames differ", async () => {
    const mismatchedDownload = {
      ...catalogDownload,
      fileName: "catalog-name.zip",
      blobPath: "downloads/stored-name.zip",
    };
    mockGetDownloadBySlug.mockReturnValue(mismatchedDownload);
    mockVerifyDownloadToken.mockReturnValue({
      ok: true,
      payload: { ...authorizedPayload, fileName: "catalog-name.zip" },
    });
    mockCanRedirectToSignedBlobDownload.mockReturnValue(false);
    mockStreamDownload.mockResolvedValue({
      stream: "PK",
      contentType: "application/zip",
      contentLength: 2,
      etag: "blob-etag",
      cacheControl: "private, no-store",
    });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"catalog-name.zip\"; " +
        "filename*=UTF-8''catalog-name.zip"
    );
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(mockStreamDownload).toHaveBeenCalledWith(mismatchedDownload);
  });

  test("never mints or streams a file when the token is unauthorized", async () => {
    mockVerifyDownloadToken.mockReturnValue({
      ok: false,
      reason: "download_token_invalid_signature",
    });

    const response = await GET(request("download_access=invalid-token"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockGetDocument).not.toHaveBeenCalled();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(mockStreamDownload).not.toHaveBeenCalled();
  });

  test("never mints or streams a file when booking revalidation fails", async () => {
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

  test("preserves local streaming and attachment disposition", async () => {
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
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=\"utilities.zip\"; filename*=UTF-8''utilities.zip"
    );
    expect(mockStreamDownload).toHaveBeenCalledTimes(1);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });
});
