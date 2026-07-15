let getUpgradeInfo;

const mockGetDocument = jest.fn();
const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({
  getDocument: mockGetDocument,
  fetch: mockFetch,
}));
const mockAssertCommerceStartAllowed = jest.fn();

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

jest.mock("../../src/server/supabase/commerceControl.js", () => ({
  assertCommerceStartAllowed: (...args) => mockAssertCommerceStartAllowed(...args),
}));

const createReq = (input = {}, method = "GET") => ({
  method,
  query: method === "GET" ? input : {},
  body: method === "POST" ? input : {},
});

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const paidBooking = (overrides = {}) => ({
  _id: "booking_1",
  _type: "booking",
  status: "completed",
  email: "client@example.com",
  payerEmail: "payer@example.com",
  packageTitle: "Performance Vertex Overhaul",
  packagePrice: "$84.99",
  displayDate: "Wednesday, January 15, 2025",
  displayTime: "12:00 AM",
  localTimeZone: "America/Los_Angeles",
  startTimeUTC: "2025-01-15T08:00:00.000Z",
  ...overrides,
});

const setupFetch = ({ booking = paidBooking(), extraFetch = null } = {}) => {
  mockFetch.mockImplementation(async (query, params = {}) => {
    const q = String(query || "");
    const extra = extraFetch ? await extraFetch(q, params) : undefined;
    if (extra !== undefined) return extra;

    if (q.includes('_type == "package"') && q.includes("title in $titles")) {
      return {
        title: "XOC / Extreme Overclocking",
        price: "$149.95",
      };
    }
    if (q.includes('_type == "booking"') && q.includes("_id == $id")) {
      return booking;
    }
    if (
      q.includes('_type == "booking"') &&
      q.includes("originalOrderId == $rootId")
    ) {
      return [
        {
          _id: booking._id,
          packageTitle: booking.packageTitle,
          netAmount: 84.99,
        },
      ];
    }
    if (
      q.includes('_type == "package"') &&
      q.includes("title in $titles") &&
      Array.isArray(params.titles)
    ) {
      return {
        title: "XOC / Extreme Overclocking",
        price: "$149.95",
      };
    }
    return null;
  });
};

beforeAll(() => {
  const mod = require("../../src/server/api/ref/getUpgradeInfo");
  getUpgradeInfo = mod && mod.default ? mod.default : mod;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertCommerceStartAllowed.mockResolvedValue({
    primaryBackend: "sanity",
    generation: 0,
    startsPaused: false,
  });
  globalThis.__rooRateLimitBuckets?.clear?.();
});

describe("getUpgradeInfo API", () => {
  test("requires the booking email for upgrade lookup", async () => {
    const req = createReq({ id: "booking_1" });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      error: "Missing booking email.",
    });
    expect(mockGetDocument).not.toHaveBeenCalled();
  });

  test("returns 404 when the booking email does not match", async () => {
    mockGetDocument.mockResolvedValue({
      _id: "booking_1",
      _type: "booking",
      status: "completed",
      email: "client@example.com",
      payerEmail: "payer@example.com",
    });

    const req = createReq({
      id: "booking_1",
      email: "wrong@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: "No booking found with that Order ID.",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("fails closed when a legacy booking has no stored email identity", async () => {
    mockGetDocument.mockResolvedValue({
      _id: "booking_without_email",
      _type: "booking",
      status: "completed",
      email: "",
      payerEmail: "",
    });
    const req = createReq({
      id: "booking_without_email",
      email: "submitted@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: "No booking found with that Order ID.",
    });
  });

  test("returns upgrade pricing without leaking booking PII", async () => {
    const booking = paidBooking({
      discord: "servi",
      specs: "secret specs",
      mainGame: "Overwatch 2",
      message: "private notes",
    });

    mockGetDocument.mockResolvedValue(booking);
    setupFetch({ booking });

    const req = createReq({
      id: "booking_1",
      email: "client@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking).toEqual({
      _id: "booking_1",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      displayDate: "Wednesday, January 15, 2025",
      displayTime: "12:00 AM",
      localTimeZone: "America/Los_Angeles",
      startTimeUTC: "2025-01-15T08:00:00.000Z",
    });
    expect(res.body.booking.email).toBeUndefined();
    expect(res.body.booking.discord).toBeUndefined();
    expect(res.body.booking.specs).toBeUndefined();
    expect(res.body.booking.mainGame).toBeUndefined();
    expect(res.body.booking.message).toBeUndefined();
    expect(res.body.targetPackage.title).toBe("Performance Vertex Max");
    expect(res.body.upgradePrice).toBeCloseTo(14.96, 2);
    expect(res.body.upgradeIntentToken).toBeTruthy();
  });

  test("accepts POST JSON and returns an intent bound to booking, email and package", async () => {
    const booking = paidBooking();
    mockGetDocument.mockResolvedValue(booking);
    setupFetch({ booking });
    const req = createReq(
      { id: "booking_1", email: "client@example.com" },
      "POST"
    );
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    const { verifyUpgradeIntentToken } = require("../../src/server/api/ref/upgradeIntentToken");
    expect(
      verifyUpgradeIntentToken({
        token: res.body.upgradeIntentToken,
        bookingId: "booking_1",
        email: "client@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBeTruthy();
    expect(
      verifyUpgradeIntentToken({
        token: res.body.upgradeIntentToken,
        bookingId: "booking_1",
        email: "client@example.com",
        targetPackageTitle: "Performance Vertex Max (Upgrade)",
      })
    ).toBeTruthy();
    expect(
      verifyUpgradeIntentToken({
        token: res.body.upgradeIntentToken,
        bookingId: "booking_1",
        email: "changed@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBeNull();
    expect(
      verifyUpgradeIntentToken({
        token: res.body.upgradeIntentToken,
        bookingId: "",
        email: "",
        targetPackageTitle: "",
      })
    ).toBeNull();
  });

  test("binds imported legacy bookings to the active commerce generation", async () => {
    const previous = {
      COMMERCE_PRIMARY_BACKEND: process.env.COMMERCE_PRIMARY_BACKEND,
      COMMERCE_CUTOVER_ENABLED: process.env.COMMERCE_CUTOVER_ENABLED,
      COMMERCE_FAILOVER_GENERATION: process.env.COMMERCE_FAILOVER_GENERATION,
      SANITY_REVERSE_MIRROR_WRITES: process.env.SANITY_REVERSE_MIRROR_WRITES,
    };
    Object.assign(process.env, {
      COMMERCE_PRIMARY_BACKEND: "supabase",
      COMMERCE_CUTOVER_ENABLED: "1",
      COMMERCE_FAILOVER_GENERATION: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
    });

    try {
      mockAssertCommerceStartAllowed.mockResolvedValue({
        primaryBackend: "supabase",
        generation: 1,
        startsPaused: false,
      });
      const booking = paidBooking({
        backendOwner: "sanity",
        cutoverGeneration: 0,
      });
      mockGetDocument.mockResolvedValue(booking);
      setupFetch({ booking });
      const res = createRes();

      await getUpgradeInfo(
        createReq({ id: booking._id, email: booking.email }, "POST"),
        res
      );

      const { verifyUpgradeIntentToken } = require("../../src/server/api/ref/upgradeIntentToken");
      expect(res.statusCode).toBe(200);
      expect(
        verifyUpgradeIntentToken({
          token: res.body.upgradeIntentToken,
          bookingId: booking._id,
          email: booking.email,
          targetPackageTitle: "Performance Vertex Max",
          backend: "supabase",
          cutoverGeneration: 1,
        })
      ).toBeTruthy();
      expect(
        verifyUpgradeIntentToken({
          token: res.body.upgradeIntentToken,
          bookingId: booking._id,
          email: booking.email,
          targetPackageTitle: "Performance Vertex Max",
          backend: "sanity",
          cutoverGeneration: 0,
        })
      ).toBeNull();
      expect(mockAssertCommerceStartAllowed).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("a verified upgrade snapshot stays bound after the browser token expires", () => {
    const {
      freezeUpgradeIntent,
      issueUpgradeIntentToken,
      verifyFrozenUpgradeIntent,
      verifyUpgradeIntentToken,
    } = require("../../src/server/api/ref/upgradeIntentToken");
    const now = Date.now();
    const token = issueUpgradeIntentToken({
      bookingId: "booking_frozen_upgrade",
      email: "client@example.com",
      targetPackageTitle: "Performance Vertex Max",
      expiresAt: new Date(now + 1000).toISOString(),
    });
    const payload = verifyUpgradeIntentToken({
      token,
      bookingId: "booking_frozen_upgrade",
      email: "client@example.com",
      targetPackageTitle: "Performance Vertex Max",
    });
    const snapshot = freezeUpgradeIntent({ payload });
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(now + 2000);

    expect(
      verifyUpgradeIntentToken({
        token,
        bookingId: "booking_frozen_upgrade",
        email: "client@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBeNull();
    expect(
      verifyFrozenUpgradeIntent({
        snapshot,
        bookingId: "booking_frozen_upgrade",
        email: "client@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBe(true);
    expect(
      verifyFrozenUpgradeIntent({
        snapshot,
        bookingId: "booking_frozen_upgrade",
        email: "changed@example.com",
        targetPackageTitle: "Performance Vertex Max",
      })
    ).toBe(false);
    nowSpy.mockRestore();
  });

  test("looks up upgrades by booking orderId", async () => {
    const booking = paidBooking({ orderId: "public_order_1" });
    mockGetDocument.mockResolvedValue(null);
    setupFetch({
      booking,
      extraFetch: async (q, params) => {
        if (
          q.includes('_type == "booking"') &&
          q.includes("orderId == $id") &&
          params.id === "public_order_1"
        ) {
          return booking;
        }
        return undefined;
      },
    });

    const req = createReq({
      id: "public_order_1",
      email: "client@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking._id).toBe("booking_1");
  });

  test("looks up upgrades by paymentRecord _id with bookingId", async () => {
    const booking = paidBooking();
    mockGetDocument.mockResolvedValue({
      _id: "paymentRecord.razorpay.order.razorpay_order_1",
      _type: "paymentRecord",
      provider: "razorpay",
      providerOrderId: "razorpay_order_1",
      providerPaymentId: "razorpay_payment_1",
      bookingId: "booking_1",
    });
    setupFetch({ booking });

    const req = createReq({
      id: "paymentRecord.razorpay.order.razorpay_order_1",
      email: "client@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking._id).toBe("booking_1");
  });

  test("looks up upgrades by paymentRecord providerPaymentId", async () => {
    const booking = paidBooking({ razorpayPaymentId: "razorpay_payment_1" });
    mockGetDocument.mockResolvedValue(null);
    setupFetch({
      booking,
      extraFetch: async (q, params) => {
        if (
          q.includes('_type == "paymentRecord"') &&
          q.includes("providerPaymentId == $id") &&
          params.id === "razorpay_payment_1"
        ) {
          return {
            _id: "paymentRecord.razorpay.payment.razorpay_payment_1",
            _type: "paymentRecord",
            provider: "razorpay",
            providerOrderId: "razorpay_order_1",
            providerPaymentId: "razorpay_payment_1",
          };
        }
        if (
          q.includes('_type == "booking"') &&
          q.includes("razorpayPaymentId == $id") &&
          params.id === "razorpay_payment_1"
        ) {
          return booking;
        }
        return undefined;
      },
    });

    const req = createReq({
      id: "razorpay_payment_1",
      email: "client@example.com",
    });
    const res = createRes();

    await getUpgradeInfo(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.booking._id).toBe("booking_1");
  });
});
