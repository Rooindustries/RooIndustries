let startPaymentSession;
let finalizePaymentSession;
let getPaymentStatus;
let reconcilePaymentSessions;
let handlePayPalWebhook;
let handleRazorpayWebhook;
let verifyPaymentAccessToken;
let paymentRecordConstants;

const mockCreateBooking = jest.fn();
const mockResolvePaymentQuote = jest.fn();
const mockCreateRefWriteClient = jest.fn();
const mockGetBookingSettings = jest.fn();
const mockIsSlotAllowedForPackage = jest.fn();
const mockResolvePaymentProviders = jest.fn();
const mockResolveServerPaymentSessionsEnabled = jest.fn();
const mockCreatePayPalOrder = jest.fn();
const mockCreatePayuOrder = jest.fn();
const mockCreateRazorpayOrder = jest.fn();
const mockVerifyPayPalOrder = jest.fn();
const mockVerifyPayPalWebhookSignature = jest.fn();
const mockVerifyPayuResponse = jest.fn();
const mockVerifyRazorpayPayment = jest.fn();
const mockVerifyRazorpaySignature = jest.fn();
const mockVerifyRazorpayWebhookSignature = jest.fn();

jest.mock("../server/api/ref/createBooking", () => ({
  __esModule: true,
  default: (...args) => mockCreateBooking(...args),
}));

jest.mock("../server/api/ref/pricing", () => ({
  __esModule: true,
  resolvePaymentQuote: (...args) => mockResolvePaymentQuote(...args),
}));

jest.mock("../server/api/ref/sanity", () => ({
  __esModule: true,
  createRefWriteClient: (...args) => mockCreateRefWriteClient(...args),
}));

jest.mock("../server/booking/slotPolicy", () => ({
  __esModule: true,
  getBookingSettings: (...args) => mockGetBookingSettings(...args),
  isSlotAllowedForPackage: (...args) => mockIsSlotAllowedForPackage(...args),
}));

jest.mock("../server/api/payment/providerConfig", () => ({
  __esModule: true,
  default: {
    resolvePaymentProviders: (...args) => mockResolvePaymentProviders(...args),
    resolveServerPaymentSessionsEnabled: (...args) =>
      mockResolveServerPaymentSessionsEnabled(...args),
  },
}));

jest.mock("../server/api/payment/providerClients", () => ({
  __esModule: true,
  DEFAULT_PAYPAL_CURRENCY: "USD",
  DEFAULT_PAYU_CURRENCY: "INR",
  DEFAULT_RAZORPAY_CURRENCY: "USD",
  createPayPalOrder: (...args) => mockCreatePayPalOrder(...args),
  createPayuOrder: (...args) => mockCreatePayuOrder(...args),
  createRazorpayOrder: (...args) => mockCreateRazorpayOrder(...args),
  verifyPayPalOrder: (...args) => mockVerifyPayPalOrder(...args),
  verifyPayPalWebhookSignature: (...args) =>
    mockVerifyPayPalWebhookSignature(...args),
  verifyPayuResponse: (...args) => mockVerifyPayuResponse(...args),
  verifyRazorpayPayment: (...args) => mockVerifyRazorpayPayment(...args),
  verifyRazorpaySignature: (...args) => mockVerifyRazorpaySignature(...args),
  verifyRazorpayWebhookSignature: (...args) =>
    mockVerifyRazorpayWebhookSignature(...args),
}));

const createConflictError = () => {
  const error = new Error("Document already exists");
  error.statusCode = 409;
  error.status = 409;
  return error;
};

let store;
let bookingCounter = 1;

const resetStore = () => {
  store = {
    paymentRecords: [],
    slotHolds: [],
    bookings: [],
  };
  bookingCounter = 1;
};

const findDocById = (id) => {
  const collections = [store.paymentRecords, store.slotHolds, store.bookings];
  for (const collection of collections) {
    const found = collection.find((entry) => entry._id === id);
    if (found) return found;
  }
  return null;
};

const removeDocById = (id) => {
  [store.paymentRecords, store.slotHolds, store.bookings].forEach((collection) => {
    const index = collection.findIndex((entry) => entry._id === id);
    if (index >= 0) {
      collection.splice(index, 1);
    }
  });
};

const mockClient = {
  fetch: async (query, params = {}) => {
    const q = String(query || "");

    if (q.includes('_type == "slotHold"') && q.includes("_id == $id")) {
      return store.slotHolds.find((entry) => entry._id === params.id) || null;
    }

    if (q.includes('_type == "booking"') && q.includes("_id == $id")) {
      return store.bookings.find((entry) => entry._id === params.id) || null;
    }

    if (
      q.includes('_type == "booking"') &&
      q.includes("paypalOrderId == $paypalOrderId")
    ) {
      return (
        store.bookings.find(
          (entry) => entry.paypalOrderId === params.paypalOrderId
        ) || null
      );
    }

    if (
      q.includes('_type == "booking"') &&
      q.includes("razorpayPaymentId == $razorpayPaymentId")
    ) {
      return (
        store.bookings.find(
          (entry) => entry.razorpayPaymentId === params.razorpayPaymentId
        ) || null
      );
    }

    if (
      q.includes('_type == "booking"') &&
      q.includes("razorpayOrderId == $razorpayOrderId")
    ) {
      return (
        store.bookings.find(
          (entry) => entry.razorpayOrderId === params.razorpayOrderId
        ) || null
      );
    }

    if (q.includes("_type == $type && _id == $id")) {
      return store.paymentRecords.find((entry) => entry._id === params.id) || null;
    }

    if (
      q.includes('provider == "razorpay"') &&
      q.includes("providerPaymentId == $providerPaymentId")
    ) {
      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === "razorpay" &&
            entry.providerPaymentId === params.providerPaymentId
        ) || null
      );
    }

    if (
      q.includes("provider == $provider") &&
      q.includes("providerOrderId == $providerOrderId")
    ) {
      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === params.provider &&
            entry.providerOrderId === params.providerOrderId
        ) || null
      );
    }

    if (
      q.includes("pricingFingerprint == $pricingFingerprint") &&
      q.includes("slotHoldId")
    ) {
      const terminalStatuses = new Set([
        "booked",
        "email_partial",
        "needs_recovery",
        "failed",
        "refunded",
        "abandoned",
      ]);

      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === params.provider &&
            entry.pricingFingerprint === params.pricingFingerprint &&
            String(entry?.holdSnapshot?.slotHoldId || "") ===
              String(params.slotHoldId || "") &&
            !terminalStatuses.has(String(entry.status || "").trim().toLowerCase())
        ) || null
      );
    }

    if (q.includes("lower(status) in $statuses")) {
      return [...store.paymentRecords]
        .filter((entry) =>
          Array.isArray(params.statuses)
            ? params.statuses.includes(String(entry.status || "").trim().toLowerCase())
            : false
        )
        .sort((left, right) =>
          String(left.updatedAt || "").localeCompare(String(right.updatedAt || ""))
        )
        .slice(0, 50);
    }

    return null;
  },
  create: async (doc) => {
    const next = { ...doc };
    if (!next._id) {
      next._id = `doc_${Date.now()}_${Math.random()}`;
    }
    if (findDocById(next._id)) {
      throw createConflictError();
    }

    if (next._type === "paymentRecord") {
      store.paymentRecords.push(next);
      return next;
    }

    if (next._type === "slotHold") {
      store.slotHolds.push(next);
      return next;
    }

    if (next._type === "booking") {
      store.bookings.push(next);
      return next;
    }

    return next;
  },
  patch: (id) => {
    const ops = {
      set: null,
      setIfMissing: null,
    };
    const api = {
      set(values = {}) {
        ops.set = { ...ops.set, ...values };
        return api;
      },
      setIfMissing(values = {}) {
        ops.setIfMissing = { ...ops.setIfMissing, ...values };
        return api;
      },
      async commit() {
        const doc = findDocById(id);
        if (!doc) return null;

        if (ops.setIfMissing) {
          Object.entries(ops.setIfMissing).forEach(([key, value]) => {
            if (doc[key] === undefined) {
              doc[key] = value;
            }
          });
        }

        if (ops.set) {
          Object.entries(ops.set).forEach(([key, value]) => {
            if (value !== undefined) {
              doc[key] = value;
            }
          });
        }

        return doc;
      },
    };
    return api;
  },
  delete: async (id) => {
    removeDocById(id);
    return { _id: id };
  },
};

const baseQuote = (overrides = {}) => ({
  paymentProvider: "paypal",
  effectiveGrossAmount: 84.99,
  effectiveDiscountAmount: 0,
  effectiveDiscountPercent: 0,
  effectiveNetAmount: 84.99,
  referralDiscountPercent: 0,
  referralDiscountAmount: 0,
  effectiveCommissionPercent: 0,
  commissionAmount: 0,
  couponDiscountPercent: 0,
  couponDiscountAmount: 0,
  canCombineWithReferral: false,
  effectiveReferralCode: "",
  effectiveReferralId: "",
  currency: "USD",
  ...overrides,
});

const createHold = ({
  id = "slothold-test",
  startTimeUTC = "2099-01-15T08:00:00.000Z",
  hostDate = "Wed Jan 15 2099",
  hostTime = "1:30 PM",
  expiresAt = "2099-01-15T08:20:00.000Z",
  holdNonce = "nonce-1",
  phase = "holding",
  paymentRecordId = "",
} = {}) => {
  const hold = {
    _id: id,
    _type: "slotHold",
    startTimeUTC,
    hostDate,
    hostTime,
    expiresAt,
    holdNonce,
    phase,
    paymentRecordId,
    packageTitle: "Performance Vertex Overhaul",
  };
  store.slotHolds.push(hold);
  return hold;
};

const baseBookingPayload = (overrides = {}) => ({
  packageTitle: "Performance Vertex Overhaul",
  startTimeUTC: "2099-01-15T08:00:00.000Z",
  email: "client@example.com",
  localTimeZone: "America/Los_Angeles",
  displayDate: "Wednesday, January 15, 2099",
  displayTime: "12:00 AM",
  slotHoldId: "slothold-test",
  slotHoldToken: "",
  referralCode: "",
  couponCode: "",
  ...overrides,
});

const issueTokenForHold = (hold) => {
  const { issueHoldToken } = require("../server/booking/holdToken");
  return issueHoldToken({
    holdId: hold._id,
    startTimeUTC: hold.startTimeUTC,
    expiresAt: hold.expiresAt,
    holdNonce: hold.holdNonce,
  });
};

const getPaymentRecord = (id = "") =>
  store.paymentRecords.find((entry) => entry._id === id) || null;

const getOnlyPaymentRecord = () => {
  expect(store.paymentRecords).toHaveLength(1);
  return store.paymentRecords[0];
};

const createReq = (body = {}, headers = {}) => ({
  method: "POST",
  body,
  headers,
});

beforeAll(() => {
  process.env.PAYMENT_SESSION_SECRET = "payment-session-test-secret";
  process.env.CRON_SECRET = "cron-secret";

  const flow = require("../server/api/payment/flow");
  startPaymentSession = flow.startPaymentSession;
  finalizePaymentSession = flow.finalizePaymentSession;
  getPaymentStatus = flow.getPaymentStatus;
  reconcilePaymentSessions = flow.reconcilePaymentSessions;
  handlePayPalWebhook = flow.handlePayPalWebhook;
  handleRazorpayWebhook = flow.handleRazorpayWebhook;

  verifyPaymentAccessToken = require("../server/api/payment/accessToken").verifyPaymentAccessToken;
  paymentRecordConstants = require("../server/api/payment/paymentRecord");
});

beforeEach(() => {
  resetStore();
  jest.clearAllMocks();

  mockCreateRefWriteClient.mockReturnValue(mockClient);
  mockResolvePaymentQuote.mockResolvedValue(baseQuote());
  mockGetBookingSettings.mockResolvedValue({});
  mockIsSlotAllowedForPackage.mockResolvedValue({
    allowed: true,
    hostDate: "Wed Jan 15 2099",
    hostTime: "1:30 PM",
  });
  mockResolvePaymentProviders.mockReturnValue({
    serverSessionsEnabled: true,
    paypal: {
      enabled: true,
      mode: "sandbox",
      clientId: "paypal-client-id",
    },
    razorpay: {
      enabled: true,
      mode: "test",
    },
    payu: {
      enabled: false,
      mode: "missing",
    },
    market: {
      id: "global",
      currency: "USD",
    },
  });
  mockResolveServerPaymentSessionsEnabled.mockReturnValue(true);
  mockCreatePayPalOrder.mockResolvedValue({
    orderId: "paypal_order_1",
    currency: "USD",
  });
  mockCreateRazorpayOrder.mockResolvedValue({
    orderId: "razorpay_order_1",
    amount: 8499,
    currency: "USD",
    key: "rzp_test_key",
  });
  mockCreatePayuOrder.mockResolvedValue({
    orderId: "payu_txn_1",
    amount: 8499,
    currency: "INR",
    action: "https://test.payu.in/_payment",
    method: "POST",
    fields: {
      key: "payu-key",
      txnid: "payu_txn_1",
      amount: "84.99",
      productinfo: "Performance Vertex Overhaul booking",
      firstname: "Roo Customer",
      email: "client@example.com",
      hash: "hash",
    },
  });
  mockVerifyPayPalOrder.mockResolvedValue({
    ok: true,
    payerEmail: "payer@example.com",
    payerId: "payer-id-1",
  });
  mockVerifyPayPalWebhookSignature.mockResolvedValue({ ok: true });
  mockVerifyRazorpayPayment.mockResolvedValue({ ok: true });
  mockVerifyPayuResponse.mockReturnValue({
    ok: true,
    providerPaymentId: "mihpay_1",
    payerEmail: "client@example.com",
  });
  mockVerifyRazorpaySignature.mockReturnValue(true);
  mockVerifyRazorpayWebhookSignature.mockReturnValue(true);

  mockCreateBooking.mockImplementation(async (req, res) => {
    const override = req.internalContext?.testOverride || {};
    const statusCode = Number(override.statusCode || 200);
    if (statusCode >= 400) {
      return res.status(statusCode).json(
        override.body || { error: "Booking finalization failed." }
      );
    }

    const bookingId = override.bookingId || `booking_${bookingCounter++}`;
    store.bookings.push({
      _id: bookingId,
      _type: "booking",
      paymentVerificationState:
        override.paymentVerificationState || "server_verified",
      paymentVerificationWarning:
        override.paymentVerificationWarning || "",
      paymentProvider: req.body.paymentProvider,
      currency: req.body.currency || "",
      paypalOrderId: req.body.paypalOrderId || "",
      razorpayOrderId: req.body.razorpayOrderId || "",
      razorpayPaymentId: req.body.razorpayPaymentId || "",
      payuTransactionId: req.body.payuTransactionId || "",
      payuPaymentId: req.body.payuPaymentId || "",
    });

    if (req.body.slotHoldId) {
      removeDocById(req.body.slotHoldId);
    }

    return res.status(200).json({
      bookingId,
      emailDispatchToken: req.body.deferEmailsUntilConfirmation
        ? override.emailDispatchToken || `dispatch_${bookingId}`
        : "",
      emailDispatch:
        override.emailDispatch ||
        (req.body.deferEmailsUntilConfirmation
          ? {
              deliveryEnabled: true,
              deferred: true,
              client: {
                attempted: false,
                sent: false,
                skippedReason: "deferred_until_confirmation",
              },
              owner: {
                attempted: false,
                sent: false,
                skippedReason: "deferred_until_confirmation",
              },
              allSent: false,
            }
          : {
              deliveryEnabled: true,
              client: { attempted: true, sent: true, skippedReason: "" },
              owner: { attempted: true, sent: true, skippedReason: "" },
              allSent: true,
            }),
    });
  });
});

describe("payment session flow", () => {
  test("start finalizes free sessions immediately and persists a booked record", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockResolvePaymentQuote.mockResolvedValue(
      baseQuote({
        paymentProvider: "free",
        effectiveNetAmount: 0,
      })
    );

    const result = await startPaymentSession({
      body: {
        provider: "free",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      provider: "free",
      quote: {
        isFree: true,
        netAmount: 0,
      },
    });
    expect(typeof result.body.paymentAccessToken).toBe("string");
    expect(store.bookings).toHaveLength(1);
    expect(store.slotHolds).toHaveLength(0);
    expect(getOnlyPaymentRecord()).toMatchObject({
      provider: "free",
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      bookingId: store.bookings[0]._id,
    });
  });

  test("start returns a PayPal session with provider payload and pending hold state", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      provider: "paypal",
      providerPayload: {
        orderId: "paypal_order_1",
        currency: "USD",
        clientId: "paypal-client-id",
      },
    });

    const record = getOnlyPaymentRecord();
    expect(record.provider).toBe("paypal");
    expect(record.status).toBe(paymentRecordConstants.PAYMENT_STATUS_STARTED);
    expect(record.providerOrderId).toBe("paypal_order_1");
    expect(record.holdSnapshot.phase).toBe(paymentRecordConstants.HOLD_PHASE_PAYMENT_PENDING);
    expect(store.slotHolds[0]).toMatchObject({
      phase: paymentRecordConstants.HOLD_PHASE_PAYMENT_PENDING,
      paymentRecordId: record._id,
    });
  });

  test("start returns a Razorpay session with provider payload", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const result = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      provider: "razorpay",
      providerPayload: {
        orderId: "razorpay_order_1",
        amount: 8499,
        currency: "USD",
        key: "rzp_test_key",
      },
    });
  });

  test("start returns a PayU session for the India market", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockResolvePaymentQuote.mockResolvedValue(
      baseQuote({
        paymentProvider: "paid",
        effectiveGrossAmount: 999,
        effectiveNetAmount: 999,
        currency: "INR",
      })
    );
    mockResolvePaymentProviders.mockReturnValue({
      serverSessionsEnabled: true,
      market: { id: "india", currency: "INR" },
      paypal: { enabled: false, mode: "live", clientId: "" },
      razorpay: { enabled: false, mode: "live" },
      payu: { enabled: true, mode: "live" },
    });

    const result = await startPaymentSession({
      body: {
        provider: "payu",
        bookingPayload,
      },
      headers: { host: "www.rooindustries.in" },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      provider: "payu",
      providerPayload: {
        orderId: "payu_txn_1",
        currency: "INR",
        action: "https://test.payu.in/_payment",
        fields: {
          txnid: "payu_txn_1",
        },
      },
    });
    expect(mockCreatePayuOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 999,
        email: "client@example.com",
      })
    );
    expect(getOnlyPaymentRecord()).toMatchObject({
      provider: "payu",
      pricingSnapshot: expect.objectContaining({
        netAmount: 999,
        currency: "INR",
      }),
    });
  });

  test("start rejects unsupported providers", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const result = await startPaymentSession({
      body: {
        provider: "stripe",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body).toEqual({
      ok: false,
      error: "Unsupported payment provider.",
    });
  });

  test("start rejects PayPal when the runtime policy disables it", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockResolvePaymentProviders.mockReturnValue({
      serverSessionsEnabled: true,
      paypal: {
        enabled: false,
        mode: "live",
        clientId: "",
      },
      razorpay: {
        enabled: true,
        mode: "test",
      },
    });

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body).toEqual({
      ok: false,
      error: "PayPal is not available in this environment.",
    });
  });

  test("start rejects Razorpay when the runtime policy disables it", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockResolvePaymentProviders.mockReturnValue({
      serverSessionsEnabled: true,
      paypal: {
        enabled: true,
        mode: "sandbox",
        clientId: "paypal-client-id",
      },
      razorpay: {
        enabled: false,
        mode: "live",
      },
    });

    const result = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body).toEqual({
      ok: false,
      error: "Razorpay is not available in this environment.",
    });
  });

  test("start rejects missing holds", async () => {
    const bookingPayload = baseBookingPayload({
      slotHoldId: "missing_hold",
      slotHoldToken: "missing_token",
    });

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toBe("Your slot reservation expired.");
  });

  test("start rejects invalid hold tokens", async () => {
    createHold();

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: "invalid-token",
        }),
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(403);
    expect(result.body.error).toBe(
      "This slot reservation is not valid for your session."
    );
  });

  test("start rejects already-expired holds", async () => {
    createHold({
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(store.slotHolds[0]),
        }),
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toBe("Your slot reservation expired.");
  });

  test("start rejects disallowed slots for the selected package", async () => {
    const hold = createHold();
    mockIsSlotAllowedForPackage.mockResolvedValue({
      allowed: false,
      hostDate: hold.hostDate,
      hostTime: hold.hostTime,
    });

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });

    expect(result.httpStatus).toBe(400);
    expect(result.body.error).toBe("The selected slot is not available for this package.");
  });

  test("finalize books a PayPal session and persists verification metadata", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const finalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          paypalOrderId: "paypal_order_1",
        },
      },
      client: mockClient,
    });

    expect(finalized.httpStatus).toBe(200);
    expect(finalized.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL,
      provider: "paypal",
      bookingId: store.bookings[0]._id,
      emailDispatchToken: `dispatch_${store.bookings[0]._id}`,
      emailDispatch: {
        deferred: true,
        allSent: false,
      },
    });

    const record = getOnlyPaymentRecord();
    expect(record).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL,
      bookingId: store.bookings[0]._id,
      payerEmail: "payer@example.com",
      verificationState: "server_verified",
      verificationWarning: "",
      emailDispatchToken: `dispatch_${store.bookings[0]._id}`,
    });
  });

  test("finalize books a Razorpay session with captured upstream verification", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    const finalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          razorpayOrderId: "razorpay_order_1",
          razorpayPaymentId: "razorpay_payment_1",
          razorpaySignature: "razorpay_signature_1",
        },
      },
      client: mockClient,
    });

    expect(finalized.httpStatus).toBe(200);
    expect(finalized.body.status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL,
      providerPaymentId: "razorpay_payment_1",
    });
  });

  test("finalize books a PayU session and records INR currency", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockResolvePaymentQuote.mockResolvedValue(
      baseQuote({
        paymentProvider: "paid",
        effectiveGrossAmount: 999,
        effectiveNetAmount: 999,
        currency: "INR",
      })
    );
    mockResolvePaymentProviders.mockReturnValue({
      serverSessionsEnabled: true,
      market: { id: "india", currency: "INR" },
      paypal: { enabled: false, mode: "live", clientId: "" },
      razorpay: { enabled: false, mode: "live" },
      payu: { enabled: true, mode: "live" },
    });

    const started = await startPaymentSession({
      body: {
        provider: "payu",
        bookingPayload,
      },
      headers: { host: "www.rooindustries.in" },
      client: mockClient,
    });

    const finalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          txnid: "payu_txn_1",
          mihpayid: "mihpay_1",
          status: "success",
          amount: "999.00",
          productinfo: "Performance Vertex Overhaul booking",
          firstname: "Roo Customer",
          email: "client@example.com",
          hash: "hash",
        },
      },
      client: mockClient,
    });

    expect(finalized.httpStatus).toBe(200);
    expect(mockVerifyPayuResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedAmount: 999,
      })
    );
    expect(store.bookings[0]).toMatchObject({
      paymentProvider: "payu",
      currency: "INR",
      payuTransactionId: "payu_txn_1",
      payuPaymentId: "mihpay_1",
    });
  });

  test("finalize rejects bad Razorpay signatures and marks the session failed", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockVerifyRazorpaySignature.mockReturnValue(false);

    const started = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    const finalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          razorpayOrderId: "razorpay_order_1",
          razorpayPaymentId: "razorpay_payment_1",
          razorpaySignature: "bad_signature",
        },
      },
      client: mockClient,
    });

    expect(finalized.httpStatus).toBe(400);
    expect(finalized.body).toMatchObject({
      ok: true,
      error: "Payment finalization failed.",
      status: paymentRecordConstants.PAYMENT_STATUS_FAILED,
      recoveryReason: "razorpay_signature_invalid",
    });
  });

  test("finalize rejects non-captured PayPal verification failures and marks the session failed", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockVerifyPayPalOrder.mockResolvedValue({
      ok: false,
      reason: "paypal_currency_mismatch",
    });

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const finalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          paypalOrderId: "paypal_order_1",
        },
      },
      client: mockClient,
    });

    expect(finalized.httpStatus).toBe(400);
    expect(finalized.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_FAILED,
      recoveryReason: "paypal_currency_mismatch",
    });
  });

  test("finalize rejects already-terminal sessions", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const firstFinalize = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          paypalOrderId: "paypal_order_1",
        },
      },
      client: mockClient,
    });

    expect(firstFinalize.httpStatus).toBe(200);

    const secondFinalize = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          paypalOrderId: "paypal_order_1",
        },
      },
      client: mockClient,
    });

    expect(secondFinalize.httpStatus).toBe(409);
    expect(secondFinalize.body).toMatchObject({
      ok: true,
      error: "Payment session is already terminal.",
      status: paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL,
    });
  });

  test("status abandons stale started sessions", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    const status = await getPaymentStatus({
      query: {
        paymentAccessToken: started.body.paymentAccessToken,
      },
      client: mockClient,
    });

    expect(status.httpStatus).toBe(200);
    expect(status.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_ABANDONED,
      recoveryReason: "payment_session_expired_before_capture",
    });
  });

  test("webhooks create recovery records when the original payment record is missing", async () => {
    const rawBody = JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "paypal_capture_missing_record",
        supplementary_data: {
          related_ids: {
            order_id: "paypal_order_missing_record",
          },
        },
        payer: {
          email_address: "payer@example.com",
        },
      },
    });

    const result = await handlePayPalWebhook({
      req: createReq(
        JSON.parse(rawBody),
        {
          "paypal-transmission-id": "tx-1",
        }
      ),
      client: mockClient,
    });

    expect(result.httpStatus).toBe(202);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      provider: "paypal",
      recoveryReason: "payment_record_missing_booking_payload",
    });

    const record = getOnlyPaymentRecord();
    expect(record).toMatchObject({
      provider: "paypal",
      providerOrderId: "paypal_order_missing_record",
      providerPaymentId: "paypal_capture_missing_record",
      recoveryReason: "payment_record_missing_booking_payload",
    });
  });

  test("webhooks mirror legacy bookings into terminal payment records when the booking already exists", async () => {
    store.bookings.push({
      _id: "booking_legacy_paypal",
      _type: "booking",
      paymentProvider: "paypal",
      paypalOrderId: "paypal_order_existing_booking",
      email: "payer@example.com",
      payerEmail: "payer@example.com",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      startTimeUTC: "2099-01-15T08:00:00.000Z",
      displayDate: "Wednesday, January 15, 2099",
      displayTime: "12:00 AM",
      localTimeZone: "America/Los_Angeles",
      paymentVerificationState: "server_verified",
      paymentVerificationWarning: "",
      emailDispatchDeferred: false,
      emailDispatchStatus: "sent",
      emailDispatchClientSentAt: "2099-01-15T08:05:00.000Z",
      emailDispatchOwnerSentAt: "2099-01-15T08:05:00.000Z",
    });

    const rawBody = JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "paypal_capture_existing_booking",
        supplementary_data: {
          related_ids: {
            order_id: "paypal_order_existing_booking",
          },
        },
        payer: {
          email_address: "payer@example.com",
        },
      },
    });

    const result = await handlePayPalWebhook({
      req: createReq(JSON.parse(rawBody), {
        "paypal-transmission-id": "tx-existing",
      }),
      client: mockClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      provider: "paypal",
      bookingId: "booking_legacy_paypal",
      recoveryReason: "",
    });

    const record = getOnlyPaymentRecord();
    expect(record).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      providerOrderId: "paypal_order_existing_booking",
      providerPaymentId: "paypal_capture_existing_booking",
      bookingId: "booking_legacy_paypal",
      recoveryReason: "",
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("reconcile finalizes stale captured sessions into bookings", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.status = paymentRecordConstants.PAYMENT_STATUS_CAPTURED_CLIENT;
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    const reconciled = await reconcilePaymentSessions({
      req: createReq({}, { "x-cron-secret": "cron-secret" }),
      client: mockClient,
    });

    expect(reconciled.httpStatus).toBe(200);
    expect(reconciled.body).toEqual({
      ok: true,
      summary: {
        scanned: 1,
        finalized: 1,
        abandoned: 0,
        recovery: 0,
      },
    });
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );
  });

  test("reconcile moves retryable verification failures into needs_recovery", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockVerifyPayPalOrder.mockResolvedValue({
      ok: false,
      reason: "paypal_lookup_exception",
    });

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.status = paymentRecordConstants.PAYMENT_STATUS_CAPTURED_CLIENT;
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    const reconciled = await reconcilePaymentSessions({
      req: createReq({}, { "x-cron-secret": "cron-secret" }),
      client: mockClient,
    });

    expect(reconciled.httpStatus).toBe(200);
    expect(reconciled.body.summary.recovery).toBe(1);
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      recoveryReason: "paypal_lookup_exception",
    });
  });

  test("reconcile abandons stale started sessions", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    const reconciled = await reconcilePaymentSessions({
      req: createReq({}, { "x-cron-secret": "cron-secret" }),
      client: mockClient,
    });

    expect(reconciled.httpStatus).toBe(200);
    expect(reconciled.body.summary.abandoned).toBe(1);
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_ABANDONED
    );
  });

  test("reconcile marks sessions failed when the slot is gone before recovery", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.status = paymentRecordConstants.PAYMENT_STATUS_CAPTURED_CLIENT;
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    mockCreateBooking.mockImplementationOnce(async (_req, res) =>
      res.status(409).json({ error: "This slot is already booked." })
    );

    const reconciled = await reconcilePaymentSessions({
      req: createReq({}, { "x-cron-secret": "cron-secret" }),
      client: mockClient,
    });

    expect(reconciled.httpStatus).toBe(200);
    expect(reconciled.body.summary.finalized).toBe(0);
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_FAILED,
      recoveryReason: "This slot is already booked.",
    });
  });

  test("repeated webhook delivery is idempotent and does not duplicate bookings", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    const started = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    const decoded = verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    });
    const record = getPaymentRecord(decoded.payload.paymentRecordId);
    record.status = paymentRecordConstants.PAYMENT_STATUS_CAPTURED_CLIENT;
    record.providerPaymentId = "razorpay_payment_1";

    const event = {
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "razorpay_payment_1",
            order_id: "razorpay_order_1",
            email: "payer@example.com",
          },
        },
      },
    };
    const rawBody = JSON.stringify(event);

    const first = await handleRazorpayWebhook({
      req: {
        method: "POST",
        body: event,
        rawBody,
        headers: {
          "x-razorpay-signature": "webhook_signature",
        },
      },
      client: mockClient,
    });
    const second = await handleRazorpayWebhook({
      req: {
        method: "POST",
        body: event,
        rawBody,
        headers: {
          "x-razorpay-signature": "webhook_signature",
        },
      },
      client: mockClient,
    });

    expect(first.httpStatus).toBe(200);
    expect(second.httpStatus).toBe(200);
    expect(second.body.status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );
    expect(store.bookings).toHaveLength(1);
  });
});
