let getUpgradeInfo;

const mockGetDocument = jest.fn();
const mockFetch = jest.fn();
const mockCreateClient = jest.fn(() => ({
  getDocument: mockGetDocument,
  fetch: mockFetch,
}));

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

const createReq = (query = {}, method = "GET") => ({ method, query });

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
