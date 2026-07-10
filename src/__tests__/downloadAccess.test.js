jest.mock("@sanity/client", () => ({
  createClient: jest.fn(() => ({
    getDocument: jest.fn(),
    fetch: jest.fn(),
  })),
}));

const {
  validateBookingForDownloadToken,
  validateDownloadAccess,
} = require("../server/downloads/downloadAccess");
const {
  createDownloadToken,
  hashDownloadEmail,
  verifyDownloadToken,
} = require("../server/downloads/downloadToken");

const env = {
  NODE_ENV: "test",
  DOWNLOAD_TOKEN_SECRET: "download-token-test-secret",
};

const createClient = (booking) => ({
  getDocument: jest.fn(async (id) => (id === booking._id ? booking : null)),
  fetch: jest.fn(async () => null),
});

const paidBooking = (overrides = {}) => ({
  _id: "booking_1",
  _type: "booking",
  status: "completed",
  email: "client@example.com",
  payerEmail: "payer@example.com",
  packageTitle: "Performance Vertex Overhaul",
  ...overrides,
});

describe("download access", () => {
  test("returns a short-lived download URL for a paid matching booking", async () => {
    const booking = paidBooking();
    const result = await validateDownloadAccess({
      slug: "optimizer-pack-v1",
      orderId: booking._id,
      email: "CLIENT@example.com ",
      client: createClient(booking),
      env,
      nowMs: 1_700_000_000_000,
      availabilityCheck: async () => true,
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.download.fileName).toBe("optimizer-pack-v1.zip");
    expect(result.body.booking).toEqual({
      id: "booking_1",
      packageTitle: "Performance Vertex Overhaul",
    });
    expect(result.body.booking.email).toBeUndefined();
    expect(result.body.downloadUrl).toBe("/api/downloads/file");
    expect(result.body.downloadUrl).not.toContain("token");

    const verified = verifyDownloadToken({
      token: result.downloadToken,
      nowMs: 1_700_000_000_000,
      env,
    });
    expect(verified.ok).toBe(true);
    expect(verified.payload).toMatchObject({
      slug: "optimizer-pack-v1",
      fileName: "optimizer-pack-v1.zip",
      bookingId: "booking_1",
    });
    expect(verified.payload.email).toBeUndefined();
    expect(verified.payload.emailHash).toBe(hashDownloadEmail("client@example.com"));
  });

  test("uses the same generic not-found error for email mismatches", async () => {
    const booking = paidBooking();
    const result = await validateDownloadAccess({
      slug: "optimizer-pack-v1",
      orderId: booking._id,
      email: "wrong@example.com",
      client: createClient(booking),
      env,
      availabilityCheck: async () => true,
    });

    expect(result.status).toBe(404);
    expect(result.body).toEqual({
      ok: false,
      error: "No paid booking found with that Order ID.",
    });
  });

  test("rejects bookings that are not marked paid", async () => {
    const booking = paidBooking({ status: "pending" });
    const result = await validateDownloadAccess({
      slug: "optimizer-pack-v1",
      orderId: booking._id,
      email: "client@example.com",
      client: createClient(booking),
      env,
      availabilityCheck: async () => true,
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/not marked as paid/i);
  });

  test("supports catalog filenames and package restrictions", async () => {
    const configuredEnv = {
      ...env,
      DOWNLOAD_CATALOG_JSON: JSON.stringify([
        {
          slug: "max-pack",
          title: "Performance Vertex Max Pack",
          fileName: "max-pack-2026.zip",
          blobPath: "customer-files/max-pack-2026.zip",
          storageBackend: "blob",
          allowedPackageTitles: ["Performance Vertex Max"],
        },
      ]),
    };
    const booking = paidBooking({ packageTitle: "Performance Vertex Overhaul" });
    const result = await validateDownloadAccess({
      slug: "max-pack",
      orderId: booking._id,
      email: "client@example.com",
      client: createClient(booking),
      env: configuredEnv,
      availabilityCheck: async () => true,
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toBe("This booking is not eligible for this download.");

    const eligibleBooking = paidBooking({ packageTitle: "Performance Vertex Max" });
    const eligible = await validateDownloadAccess({
      slug: "max-pack",
      orderId: eligibleBooking._id,
      email: "client@example.com",
      client: createClient(eligibleBooking),
      env: configuredEnv,
      availabilityCheck: async (download) => {
        expect(download.blobPath).toBe("customer-files/max-pack-2026.zip");
        expect(download.storageBackend).toBe("blob");
        return true;
      },
    });

    expect(eligible.status).toBe(200);
    expect(eligible.body.download).toMatchObject({
      slug: "max-pack",
      title: "Performance Vertex Max Pack",
      fileName: "max-pack-2026.zip",
    });
  });

  test("revalidates token access against the booking email hash", () => {
    const booking = paidBooking();
    const download = {
      slug: "optimizer-pack-v1",
      fileName: "optimizer-pack-v1.zip",
      allowedPackageTitles: [],
    };
    const allowed = validateBookingForDownloadToken({
      booking,
      emailHash: hashDownloadEmail("payer@example.com"),
      download,
    });
    const denied = validateBookingForDownloadToken({
      booking,
      emailHash: hashDownloadEmail("wrong@example.com"),
      download,
    });

    expect(allowed.ok).toBe(true);
    expect(denied.status).toBe(403);
  });

  test("expires download tokens", () => {
    const token = createDownloadToken({
      slug: "optimizer-pack-v1",
      fileName: "optimizer-pack-v1.zip",
      bookingId: "booking_1",
      email: "client@example.com",
      issuedAtMs: 1_700_000_000_000,
      ttlSeconds: 60,
      env,
    });

    const verified = verifyDownloadToken({
      token,
      nowMs: 1_700_000_120_000,
      env,
    });

    expect(verified.ok).toBe(false);
    expect(verified.reason).toBe("download_token_expired");
  });
});
