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
const mockCreateRazorpayOrder = jest.fn();
const mockInspectPayPalOrder = jest.fn();
const mockInspectRazorpayOrder = jest.fn();
const mockVerifyPayPalOrder = jest.fn();
const mockVerifyPayPalWebhookSignature = jest.fn();
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
  DEFAULT_RAZORPAY_CURRENCY: "USD",
  toMoney: (value) => Number(Number(value || 0).toFixed(2)),
  toSubunits: (value) => Math.round(Number(value || 0) * 100),
  createPayPalOrder: (...args) => mockCreatePayPalOrder(...args),
  createRazorpayOrder: (...args) => mockCreateRazorpayOrder(...args),
  inspectPayPalOrder: (...args) => mockInspectPayPalOrder(...args),
  inspectRazorpayOrder: (...args) => mockInspectRazorpayOrder(...args),
  verifyPayPalOrder: (...args) => mockVerifyPayPalOrder(...args),
  verifyPayPalWebhookSignature: (...args) =>
    mockVerifyPayPalWebhookSignature(...args),
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
let revisionCounter = 1;

const resetStore = () => {
  store = {
    paymentRecords: [],
    paymentStartClaims: [],
    paymentUpgradeLocks: [],
    paymentProofClaims: [],
    paymentWebhookReceipts: [],
    paymentRecoveryCases: [],
    slotHolds: [],
    bookings: [],
  };
  bookingCounter = 1;
  revisionCounter = 1;
};

const collectionForType = (type) =>
  ({
    paymentRecord: store.paymentRecords,
    paymentStartClaim: store.paymentStartClaims,
    paymentUpgradeLock: store.paymentUpgradeLocks,
    paymentProofClaim: store.paymentProofClaims,
    paymentWebhookReceipt: store.paymentWebhookReceipts,
    paymentRecoveryCase: store.paymentRecoveryCases,
    slotHold: store.slotHolds,
    booking: store.bookings,
  }[type] || null);

const nextRevision = () => `rev-${revisionCounter++}`;

const findDocById = (id) => {
  const collections = [
    store.paymentRecords,
    store.paymentStartClaims,
    store.paymentUpgradeLocks,
    store.paymentProofClaims,
    store.paymentWebhookReceipts,
    store.paymentRecoveryCases,
    store.slotHolds,
    store.bookings,
  ];
  for (const collection of collections) {
    const found = collection.find((entry) => entry._id === id);
    if (found) return found;
  }
  return null;
};

const removeDocById = (id) => {
  [
    store.paymentRecords,
    store.paymentStartClaims,
    store.paymentUpgradeLocks,
    store.paymentProofClaims,
    store.paymentWebhookReceipts,
    store.paymentRecoveryCases,
    store.slotHolds,
    store.bookings,
  ].forEach((collection) => {
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
      return (
        collectionForType(params.type)?.find((entry) => entry._id === params.id) ||
        null
      );
    }

    if (
      q.includes("provider == $provider") &&
      q.includes("providerPaymentId == $providerPaymentId")
    ) {
      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === params.provider &&
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
    const next = { ...doc, _rev: doc._rev || nextRevision() };
    if (!next._id) {
      next._id = `doc_${Date.now()}_${Math.random()}`;
    }
    if (findDocById(next._id)) {
      throw createConflictError();
    }

    const collection = collectionForType(next._type);
    if (collection) {
      collection.push(next);
      return next;
    }

    return next;
  },
  patch: (id) => {
    const ops = {
      set: null,
      setIfMissing: null,
      revisionId: "",
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
      ifRevisionId(revisionId) {
        ops.revisionId = revisionId;
        return api;
      },
      async commit() {
        const doc = findDocById(id);
        if (!doc) return null;
        if (ops.revisionId && doc._rev !== ops.revisionId) {
          throw createConflictError();
        }

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

        doc._rev = nextRevision();

        return doc;
      },
    };
    return api;
  },
  delete: async (id) => {
    removeDocById(id);
    return { _id: id };
  },
  transaction: () => {
    const operations = [];
    const transaction = {
      create(doc) {
        operations.push({ type: "create", doc: { ...doc } });
        return transaction;
      },
      patch(id, callback) {
        const patchOps = { set: {}, revisionId: "" };
        const patchBuilder = {
          set(values = {}) {
            patchOps.set = { ...patchOps.set, ...values };
            return patchBuilder;
          },
          ifRevisionId(revisionId) {
            patchOps.revisionId = revisionId;
            return patchBuilder;
          },
        };
        callback(patchBuilder);
        operations.push({ type: "patch", id, ...patchOps });
        return transaction;
      },
      async commit() {
        operations.forEach((operation) => {
          if (operation.type === "create" && findDocById(operation.doc._id)) {
            throw createConflictError();
          }
          if (operation.type === "patch") {
            const doc = findDocById(operation.id);
            if (!doc || (operation.revisionId && doc._rev !== operation.revisionId)) {
              throw createConflictError();
            }
          }
        });
        for (const operation of operations) {
          if (operation.type === "create") {
            await mockClient.create(operation.doc);
          } else {
            const doc = findDocById(operation.id);
            Object.assign(doc, operation.set, { _rev: nextRevision() });
          }
        }
        return { transactionId: `tx-${Date.now()}` };
      },
    };
    return transaction;
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
  couponDiscountType: "",
  couponDiscountValue: 0,
  canCombineWithReferral: false,
  effectiveReferralCode: "",
  effectiveReferralId: "",
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
    _rev: nextRevision(),
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
  process.env.PAYMENT_LEGACY_CHECKOUT_UNTIL = "2099-01-01T00:00:00.000Z";

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
  mockInspectPayPalOrder.mockResolvedValue({ state: "unpaid" });
  mockInspectRazorpayOrder.mockResolvedValue({ state: "unpaid" });
  mockVerifyPayPalOrder.mockResolvedValue({
    ok: true,
    payerEmail: "payer@example.com",
    payerId: "payer-id-1",
  });
  mockVerifyPayPalWebhookSignature.mockResolvedValue({ ok: true });
  mockVerifyRazorpayPayment.mockResolvedValue({ ok: true });
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
      paypalOrderId: req.body.paypalOrderId || "",
      razorpayOrderId: req.body.razorpayOrderId || "",
      razorpayPaymentId: req.body.razorpayPaymentId || "",
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
    expect(store.paymentProofClaims).toHaveLength(1);
    expect(mockCreateBooking.mock.calls[0]?.[0]?.internalContext).toMatchObject({
      paymentProofClaimId: expect.stringMatching(/^paymentProofClaim\.free\./),
      paymentFinalizationLeaseId: expect.any(String),
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

  test("finalize rejects bad Razorpay signatures without terminating the session", async () => {
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
      ok: false,
      error: "Payment could not be verified.",
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      code: "razorpay_signature_invalid",
    });
  });

  test("captured PayPal amount mismatches stay recoverable", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);
    mockVerifyPayPalOrder.mockResolvedValue({
      ok: false,
      captured: true,
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

    expect(finalized.httpStatus).toBe(202);
    expect(finalized.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      recoveryReason: "paypal_currency_mismatch",
    });
  });

  test("finalize returns the existing result for already-completed sessions", async () => {
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

    expect(secondFinalize.httpStatus).toBe(200);
    expect(secondFinalize.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL,
    });
  });

  test("status is read-only for stale started sessions", async () => {
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
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      recoveryReason: "",
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
    expect(reconciled.body).toMatchObject({
      ok: true,
      summary: {
        scanned: 1,
        finalized: 1,
        abandoned: 0,
        recovery: 0,
      },
    });
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_BOOKED
    );
    expect(mockCreateBooking.mock.calls.at(-1)?.[0]?.body).toMatchObject({
      deferEmailsUntilConfirmation: false,
    });
  });

  test("reconcile completes stale email_partial sessions without duplicate bookings", async () => {
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

    expect(finalized.body.status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );
    expect(store.bookings).toHaveLength(1);

    const existingBookingId = store.bookings[0]._id;
    const record = getOnlyPaymentRecord();
    record.lastAttemptAt = "2000-01-01T00:00:00.000Z";
    record.updatedAt = "2000-01-01T00:00:00.000Z";

    mockCreateBooking.mockImplementationOnce(async (req, res) =>
      res.status(200).json({
        bookingId: existingBookingId,
        emailDispatchToken: "",
        emailDispatch: {
          deliveryEnabled: true,
          client: { attempted: true, sent: true, skippedReason: "" },
          owner: { attempted: true, sent: true, skippedReason: "" },
          allSent: true,
        },
      })
    );

    const reconciled = await reconcilePaymentSessions({
      req: createReq({}, { "x-cron-secret": "cron-secret" }),
      client: mockClient,
    });

    expect(reconciled.httpStatus).toBe(200);
    expect(reconciled.body.summary).toMatchObject({
      scanned: 1,
      finalized: 1,
      recovery: 0,
    });
    expect(store.bookings).toHaveLength(1);
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      bookingId: existingBookingId,
      emailDispatchToken: "",
      emailDispatch: {
        allSent: true,
      },
    });
    expect(mockCreateBooking.mock.calls.at(-1)?.[0]?.body).toMatchObject({
      deferEmailsUntilConfirmation: false,
    });
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
    record.createdAt = "2000-01-01T00:00:00.000Z";
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

  test("reconcile keeps captured sessions recoverable when the slot is gone", async () => {
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
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
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
    expect(second.body).toMatchObject({ ok: true, duplicate: true });
    expect(store.bookings).toHaveLength(1);
  });

  test("Razorpay webhooks finalize the started order record before payment id is stored", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

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

    const result = await handleRazorpayWebhook({
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

    expect(result.httpStatus).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      provider: "razorpay",
      recoveryReason: "",
      emailDispatch: {
        allSent: true,
      },
    });
    expect(store.paymentRecords).toHaveLength(1);
    expect(getOnlyPaymentRecord()).toMatchObject({
      providerOrderId: "razorpay_order_1",
      providerPaymentId: "razorpay_payment_1",
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      bookingId: store.bookings[0]._id,
    });
    expect(mockCreateBooking.mock.calls.at(-1)?.[0]?.body).toMatchObject({
      deferEmailsUntilConfirmation: false,
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("Razorpay webhooks prefer the started order record over an empty recovery duplicate", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload();
    bookingPayload.slotHoldToken = issueTokenForHold(hold);

    await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload,
      },
      client: mockClient,
    });

    store.paymentRecords.push({
      _id: "paymentRecord.razorpay.payment.razorpay_payment_1",
      _type: "paymentRecord",
      provider: "razorpay",
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      bookingPayload: {},
      providerOrderId: "razorpay_order_1",
      providerPaymentId: "razorpay_payment_1",
      recoveryReason: "payment_record_missing_booking_payload",
      events: [],
      createdAt: "2099-01-15T08:05:00.000Z",
      updatedAt: "2099-01-15T08:05:00.000Z",
    });

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

    const result = await handleRazorpayWebhook({
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

    const orderRecord = store.paymentRecords.find(
      (entry) =>
        entry.providerOrderId === "razorpay_order_1" &&
        entry.bookingPayload?.packageTitle
    );

    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_BOOKED
    );
    expect(store.paymentRecords).toHaveLength(2);
    expect(orderRecord).toMatchObject({
      providerPaymentId: "razorpay_payment_1",
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      bookingId: store.bookings[0]._id,
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("start requires the current quote fingerprint before creating an order", async () => {
    delete process.env.PAYMENT_LEGACY_CHECKOUT_UNTIL;
    const hold = createHold();
    const bookingPayload = baseBookingPayload({
      slotHoldToken: issueTokenForHold(hold),
    });

    const missing = await startPaymentSession({
      body: { provider: "paypal", bookingPayload },
      client: mockClient,
    });

    expect(missing).toMatchObject({
      httpStatus: 409,
      body: {
        ok: false,
        code: "quote_fingerprint_required",
      },
    });
    expect(mockCreatePayPalOrder).not.toHaveBeenCalled();

    const accepted = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload,
        quoteFingerprint: paymentRecordConstants.buildQuoteFingerprint({
          bookingPayload,
          quote: baseQuote(),
        }),
      },
      client: mockClient,
    });

    expect(accepted.httpStatus).toBe(200);
    expect(accepted.body.quoteFingerprint).toHaveLength(64);
    expect(mockCreatePayPalOrder).toHaveBeenCalledTimes(1);
  });

  test("start refreshes both the hold document and signed hold token to one expiry", async () => {
    const hold = createHold();
    const originalToken = issueTokenForHold(hold);
    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({ slotHoldToken: originalToken }),
      },
      client: mockClient,
    });

    const refreshedHold = store.slotHolds[0];
    const { verifyHoldToken } = require("../server/booking/holdToken");
    expect(result.body.refreshedHold).toEqual({
      slotHoldId: refreshedHold._id,
      slotHoldToken: expect.any(String),
      slotHoldExpiresAt: refreshedHold.expiresAt,
    });
    expect(result.body.sessionExpiresAt).toBe(refreshedHold.expiresAt);
    expect(result.body.refreshedHold.slotHoldToken).not.toBe(originalToken);
    expect(
      verifyHoldToken({
        token: result.body.refreshedHold.slotHoldToken,
        holdId: refreshedHold._id,
        startTimeUTC: refreshedHold.startTimeUTC,
        holdNonce: refreshedHold.holdNonce,
      })
    ).toBeTruthy();
  });

  test("concurrent providers cannot create two payable orders for one hold", async () => {
    const hold = createHold();
    const bookingPayload = baseBookingPayload({
      slotHoldToken: issueTokenForHold(hold),
    });

    const results = await Promise.all([
      startPaymentSession({
        body: { provider: "paypal", bookingPayload },
        client: mockClient,
      }),
      startPaymentSession({
        body: { provider: "razorpay", bookingPayload },
        client: mockClient,
      }),
    ]);

    expect(results.map((entry) => entry.httpStatus).sort()).toEqual([200, 409]);
    expect(mockCreatePayPalOrder.mock.calls.length + mockCreateRazorpayOrder.mock.calls.length).toBe(1);
    expect(store.paymentRecords).toHaveLength(1);
    expect(store.paymentStartClaims).toHaveLength(1);
  });

  test("start reserves a limited coupon in the same transaction before provider order creation", async () => {
    const hold = createHold();
    const redemption = {
      _id: "couponRedemption.session-1",
      _type: "couponRedemption",
      status: "reserved",
    };
    const prepareCouponReservation = jest.fn().mockResolvedValue({
      coupon: { _id: "coupon-1", _rev: "coupon-rev-1" },
      redemption,
      idempotent: false,
    });
    const appendCouponReservation = jest.fn(
      ({ transaction, redemption: plannedRedemption }) =>
        transaction.create(plannedRedemption)
    );

    const result = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          couponCode: "LASTUSE",
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
      prepareCouponReservation,
      appendCouponReservation,
    });

    expect(result.httpStatus).toBe(200);
    expect(prepareCouponReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        couponCode: "LASTUSE",
        ownerId: expect.stringMatching(/^paymentRecord\.session\./),
      })
    );
    expect(appendCouponReservation).toHaveBeenCalledTimes(1);
    expect(getOnlyPaymentRecord().couponReservationId).toBe(redemption._id);
    expect(mockCreatePayPalOrder).toHaveBeenCalledTimes(1);
    expect(mockCreatePayPalOrder.mock.invocationCallOrder[0]).toBeGreaterThan(
      appendCouponReservation.mock.invocationCallOrder[0]
    );
  });

  test("finalize rejects proof from a different provider order without mutating the session", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });

    const result = await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: { paypalOrderId: "paypal_order_from_another_session" },
      },
      client: mockClient,
    });

    expect(result).toMatchObject({
      httpStatus: 409,
      body: { ok: false, code: "provider_order_id_mismatch" },
    });
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_STARTED,
      providerOrderId: "paypal_order_1",
    });
    expect(mockVerifyPayPalOrder).not.toHaveBeenCalled();
    expect(store.bookings).toHaveLength(0);
    expect(store.paymentProofClaims).toHaveLength(0);
  });

  test("one captured order cannot finalize two separate booking sessions", async () => {
    const firstHold = createHold();
    const firstPayload = baseBookingPayload({
      slotHoldToken: issueTokenForHold(firstHold),
    });
    const first = await startPaymentSession({
      body: { provider: "paypal", bookingPayload: firstPayload },
      client: mockClient,
    });

    const secondHold = createHold({
      id: "slothold-second",
      startTimeUTC: "2099-01-15T09:00:00.000Z",
      holdNonce: "nonce-2",
    });
    const secondPayload = baseBookingPayload({
      startTimeUTC: secondHold.startTimeUTC,
      slotHoldId: secondHold._id,
      slotHoldToken: issueTokenForHold(secondHold),
    });
    const second = await startPaymentSession({
      body: { provider: "paypal", bookingPayload: secondPayload },
      client: mockClient,
    });

    const firstFinalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: first.body.paymentAccessToken,
        providerData: { paypalOrderId: "paypal_order_1" },
      },
      client: mockClient,
    });
    const secondFinalized = await finalizePaymentSession({
      body: {
        paymentAccessToken: second.body.paymentAccessToken,
        providerData: { paypalOrderId: "paypal_order_1" },
      },
      client: mockClient,
    });

    expect(firstFinalized.httpStatus).toBe(200);
    expect(secondFinalized.httpStatus).toBe(202);
    expect(secondFinalized.body).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      recoveryReason: "payment_proof_already_claimed",
    });
    expect(store.bookings).toHaveLength(1);
    expect(store.paymentProofClaims).toHaveLength(1);
  });

  test("concurrent client and webhook finalization share one CAS lease", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });
    const event = {
      id: "paypal-event-concurrent",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "paypal_capture_1",
        supplementary_data: { related_ids: { order_id: "paypal_order_1" } },
      },
    };

    const [clientResult, webhookResult] = await Promise.all([
      finalizePaymentSession({
        body: {
          paymentAccessToken: started.body.paymentAccessToken,
          providerData: { paypalOrderId: "paypal_order_1" },
        },
        client: mockClient,
      }),
      handlePayPalWebhook({
        req: {
          body: event,
          rawBody: JSON.stringify(event),
          headers: { "paypal-transmission-id": "paypal-event-concurrent" },
        },
        client: mockClient,
      }),
    ]);

    expect([clientResult.httpStatus, webhookResult.httpStatus].sort()).toEqual([200, 202]);
    expect(store.bookings).toHaveLength(1);
    expect(store.paymentProofClaims).toHaveLength(1);
  });

  test("full refund webhooks are deduped and invoke booking rollback once", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });
    await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: { paypalOrderId: "paypal_order_1" },
      },
      client: mockClient,
    });
    const applyBookingRefund = jest.fn().mockResolvedValue({
      bookingId: store.bookings[0]._id,
      reopenedSlot: true,
      couponRestored: true,
      referralReversed: true,
      idempotent: false,
    });
    const event = {
      id: "paypal-refund-event-1",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "paypal_refund_1",
        status: "COMPLETED",
        amount: { value: "84.99", currency_code: "USD" },
        supplementary_data: {
          related_ids: {
            order_id: "paypal_order_1",
            capture_id: "paypal_capture_1",
          },
        },
      },
    };
    const request = {
      body: event,
      rawBody: JSON.stringify(event),
      headers: { "paypal-transmission-id": "paypal-refund-event-1" },
    };

    const first = await handlePayPalWebhook({
      req: request,
      client: mockClient,
      applyBookingRefund,
    });
    const duplicate = await handlePayPalWebhook({
      req: request,
      client: mockClient,
      applyBookingRefund,
    });

    expect(first.httpStatus).toBe(200);
    expect(duplicate.body).toMatchObject({ ok: true, duplicate: true });
    expect(applyBookingRefund).toHaveBeenCalledTimes(1);
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_REFUNDED,
      refundState: "full",
      refundRequiresBookingSync: false,
    });
    expect(getOnlyPaymentRecord().refunds).toHaveLength(1);
  });

  test("Razorpay refund events count only unique processed refund IDs", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "razorpay",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });
    await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: {
          razorpayOrderId: "razorpay_order_1",
          razorpayPaymentId: "razorpay_payment_1",
          razorpaySignature: "signature",
        },
      },
      client: mockClient,
    });
    const applyBookingRefund = jest.fn().mockResolvedValue({
      bookingId: store.bookings[0]._id,
      reopenedSlot: true,
    });
    const deliver = (eventType, refundId, amount) => {
      const event = {
        id: `${eventType}-${refundId}-${Math.random()}`,
        event: eventType,
        payload: {
          refund: {
            entity: {
              id: refundId,
              payment_id: "razorpay_payment_1",
              status: eventType.split(".")[1],
              amount,
              currency: "USD",
            },
          },
        },
      };
      return handleRazorpayWebhook({
        req: {
          body: event,
          rawBody: JSON.stringify(event),
          headers: { "x-razorpay-signature": "signature" },
        },
        client: mockClient,
        applyBookingRefund,
      });
    };

    await deliver("refund.processed", "refund_1", 1000);
    await deliver("refund.created", "refund_1", 1000);
    expect(getOnlyPaymentRecord()).toMatchObject({
      refundState: "partial",
      refundProcessedAmountInSubunits: 1000,
    });
    await deliver("refund.processed", "refund_2", 7499);
    await deliver("refund.failed", "refund_2", 7499);

    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_REFUNDED,
      refundState: "full",
      refundProcessedAmountInSubunits: 8499,
      refundRequiresBookingSync: false,
    });
    expect(getOnlyPaymentRecord().refunds).toHaveLength(2);
    expect(applyBookingRefund).toHaveBeenCalledTimes(1);
  });

  test("PayPal pending and failed refunds do not reopen a booking before completion", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });
    await finalizePaymentSession({
      body: {
        paymentAccessToken: started.body.paymentAccessToken,
        providerData: { paypalOrderId: "paypal_order_1" },
      },
      client: mockClient,
    });
    const applyBookingRefund = jest.fn().mockResolvedValue({
      bookingId: store.bookings[0]._id,
      reopenedSlot: true,
    });
    const deliver = (eventType, status) => {
      const event = {
        id: `${eventType}-${status}`,
        event_type: eventType,
        resource: {
          id: "paypal_refund_pending_1",
          status,
          amount: { value: "84.99", currency_code: "USD" },
          supplementary_data: {
            related_ids: {
              order_id: "paypal_order_1",
              capture_id: "paypal_capture_1",
            },
          },
        },
      };
      return handlePayPalWebhook({
        req: {
          body: event,
          rawBody: JSON.stringify(event),
          headers: { "paypal-transmission-id": event.id },
        },
        client: mockClient,
        applyBookingRefund,
      });
    };

    await deliver("PAYMENT.REFUND.PENDING", "PENDING");
    await deliver("PAYMENT.REFUND.FAILED", "FAILED");
    expect(applyBookingRefund).not.toHaveBeenCalled();
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );

    await deliver("PAYMENT.CAPTURE.REFUNDED", "COMPLETED");
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_REFUNDED
    );
    expect(applyBookingRefund).toHaveBeenCalledTimes(1);
    expect(getOnlyPaymentRecord().refunds).toHaveLength(1);
  });

  test("reconcile honors backoff and recovers needs_recovery records", async () => {
    const hold = createHold();
    const started = await startPaymentSession({
      body: {
        provider: "paypal",
        bookingPayload: baseBookingPayload({
          slotHoldToken: issueTokenForHold(hold),
        }),
      },
      client: mockClient,
    });
    const record = getOnlyPaymentRecord();
    record.status = paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY;
    record.nextRecoveryAt = "2099-01-01T00:00:00.000Z";
    mockInspectPayPalOrder.mockResolvedValue({
      state: "captured",
      providerOrderId: "paypal_order_1",
      providerPaymentId: "paypal_capture_1",
      payerEmail: "payer@example.com",
    });

    const skipped = await reconcilePaymentSessions({
      req: createReq({}, { authorization: "Bearer cron-secret" }),
      client: mockClient,
    });
    expect(skipped.body.summary.finalized).toBe(0);
    expect(mockInspectPayPalOrder).not.toHaveBeenCalled();

    record.nextRecoveryAt = "2000-01-01T00:00:00.000Z";
    const recovered = await reconcilePaymentSessions({
      req: createReq({}, { authorization: "Bearer cron-secret" }),
      client: mockClient,
    });
    expect(recovered.body.summary.finalized).toBe(1);
    expect(getPaymentRecord(verifyPaymentAccessToken({
      token: started.body.paymentAccessToken,
    }).payload.paymentRecordId).status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_BOOKED
    );
  });

  test("captured records without payload become visible reschedule bookings", async () => {
    store.paymentRecords.push({
      _id: "paymentRecord.paypal.missing-payload",
      _rev: nextRevision(),
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "paypal_order_missing_payload",
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      bookingPayload: {},
      pricingSnapshot: { netAmount: 84.99 },
      providerPublicData: { currency: "USD" },
      nextRecoveryAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      events: [],
    });
    mockInspectPayPalOrder.mockResolvedValue({
      state: "captured",
      providerOrderId: "paypal_order_missing_payload",
      providerPaymentId: "paypal_capture_missing_payload",
    });
    const createRequiresRescheduleBooking = jest.fn().mockResolvedValue({
      bookingId: "booking_requires_reschedule",
      recoveryCaseId: "bookingRecoveryCase.missing-payload",
      notificationRequired: true,
      idempotent: false,
    });
    const dispatchRescheduleNotifications = jest.fn().mockResolvedValue({
      ok: true,
      notificationRequired: false,
      status: "sent",
    });

    const result = await reconcilePaymentSessions({
      req: createReq({}, { authorization: "Bearer cron-secret" }),
      client: mockClient,
      createRequiresRescheduleBooking,
      dispatchRescheduleNotifications,
    });

    expect(result.body.summary.finalized).toBe(1);
    expect(createRequiresRescheduleBooking).toHaveBeenCalledTimes(1);
    expect(getOnlyPaymentRecord()).toMatchObject({
      status: paymentRecordConstants.PAYMENT_STATUS_BOOKED,
      bookingId: "booking_requires_reschedule",
      requiresReschedule: true,
      recoveryCaseId: "bookingRecoveryCase.missing-payload",
      recoveryNotificationRequired: false,
    });
  });

  test("reschedule notification failure retries email only without recreating booking", async () => {
    store.paymentRecords.push({
      _id: "paymentRecord.paypal.notification-retry",
      _rev: nextRevision(),
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "paypal_order_notification_retry",
      status: paymentRecordConstants.PAYMENT_STATUS_NEEDS_RECOVERY,
      bookingPayload: {},
      pricingSnapshot: { netAmount: 84.99 },
      providerPublicData: { currency: "USD" },
      nextRecoveryAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
      events: [],
    });
    mockInspectPayPalOrder.mockResolvedValue({
      state: "captured",
      providerPaymentId: "paypal_capture_notification_retry",
    });
    const createRequiresRescheduleBooking = jest.fn().mockResolvedValue({
      bookingId: "booking_notification_retry",
      recoveryCaseId: "bookingRecoveryCase.notification-retry",
      notificationRequired: true,
    });
    const dispatchRescheduleNotifications = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        notificationRequired: true,
        status: "partial",
      })
      .mockResolvedValueOnce({
        ok: true,
        notificationRequired: false,
        status: "sent",
      });

    await reconcilePaymentSessions({
      req: createReq({}, { authorization: "Bearer cron-secret" }),
      client: mockClient,
      createRequiresRescheduleBooking,
      dispatchRescheduleNotifications,
    });
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_EMAIL_PARTIAL
    );
    getOnlyPaymentRecord().nextRecoveryAt = "2000-01-01T00:00:00.000Z";

    await reconcilePaymentSessions({
      req: createReq({}, { authorization: "Bearer cron-secret" }),
      client: mockClient,
      createRequiresRescheduleBooking,
      dispatchRescheduleNotifications,
    });
    expect(getOnlyPaymentRecord().status).toBe(
      paymentRecordConstants.PAYMENT_STATUS_BOOKED
    );
    expect(createRequiresRescheduleBooking).toHaveBeenCalledTimes(1);
    expect(dispatchRescheduleNotifications).toHaveBeenCalledTimes(2);
  });
});
