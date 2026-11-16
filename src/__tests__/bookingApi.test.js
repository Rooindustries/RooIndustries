let holdSlot;
let isSameSupabaseOwnedHold;
let createBooking;
let releaseHold;
let dispatchRescheduleNotifications;
let formatRequestedTimeFields;
let applyBookingRefund;
let applyBookingStatusTransition;
let createRequiresRescheduleBooking;
let bookTourneyFreeSession;
let getTourneyFreeSessionState;
let grantTourneySessionEntitlement;
let resetMemoryTourneyFreeSessionStoreForTests;
let getBookingAvailability;

const CLIENT_EMAIL = "vihaann2.0@gmail.com";
const OWNER_EMAIL = "serviroo@rooindustries.com";
const OWNER_TZ = "Asia/Kolkata";
const previousDataPrimary = process.env.DATA_PRIMARY_BACKEND;
const previousCommercePrimary = process.env.COMMERCE_PRIMARY_BACKEND;
const previousFreeSessionStoreMode =
  process.env.TOURNEY_FREE_SESSION_STORE_MODE;

const mockSendEmail = jest.fn().mockResolvedValue({ data: { id: "email-fixture" }, error: null });
const mockFlushCommerceMirror = jest.fn(async () => {
  throw new Error("Sanity mirror unavailable");
});
const mockAssertCommerceStartAllowed = jest.fn(async () => ({
  primaryBackend: "sanity",
  generation: 0,
  startsPaused: false,
}));

let store;
let idCounter = 1;
let revisionCounter = 1;

const resetStore = () => {
  const configuredUtcSlots = [
    "2099-01-15T07:59:00.000Z",
    "2099-01-15T08:00:00.000Z",
    "2099-01-15T08:15:00.000Z",
    "2099-01-15T08:18:00.000Z",
    "2099-01-15T08:20:00.000Z",
    "2099-01-15T08:22:00.000Z",
    "2099-01-15T08:24:00.000Z",
    "2099-01-15T08:25:00.000Z",
    "2099-01-15T08:26:00.000Z",
    "2099-01-15T08:28:00.000Z",
    "2099-01-15T09:00:00.000Z",
    "2099-01-15T10:00:00.000Z",
    "2099-01-15T11:00:00.000Z",
    "2099-01-15T18:30:00.000Z",
  ];
  const slotsByDate = new Map();
  configuredUtcSlots.forEach((value) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: OWNER_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(value))
      .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const time = `${parts.hour}:${parts.minute}`;
    slotsByDate.set(date, [...new Set([...(slotsByDate.get(date) || []), time])]);
  });
  store = {
    bookings: [],
    paymentRecords: [],
    paymentUpgradeLocks: [],
    slotHolds: [],
    bookingSlots: [],
    couponRedemptions: [],
    paymentProofClaims: [],
    recoveryCases: [],
    coupons: [],
    referrals: [],
    packages: [
      {
        _id: "pkg_vertex",
        _type: "package",
        title: "Performance Vertex Overhaul",
        price: "$84.99",
      },
      {
        _id: "pkg_xoc",
        _type: "package",
        title: "XOC / Extreme Overclocking",
        price: "$149.95",
      },
      {
        _id: "pkg_test",
        _type: "package",
        title: "Test Package",
        price: "$49.95",
      },
    ],
    bookingSettings: {
      ownerEmail: OWNER_EMAIL,
      dateSlots: [...slotsByDate.entries()].map(([date, times]) => ({ date, times })),
    },
  };
  idCounter = 1;
  revisionCounter = 1;
};

const formatClientDate = (utcDate, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(utcDate);

const formatClientTime = (utcDate, timeZone) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(utcDate);

const formatOwnerDate = (utcDate, timeZone = OWNER_TZ) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
  })
    .formatToParts(utcDate)
    .reduce((acc, cur) => {
      acc[cur.type] = cur.value;
      return acc;
    }, {});

  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.year}`.trim();
};

const formatOwnerTime = (utcDate, timeZone = OWNER_TZ) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(utcDate);

const createReq = (body = {}, method = "POST", headers = {}) => ({
  method,
  body,
  headers,
});

const createUpgradeFinalizationReq = (body) => {
  const { buildPaymentUpgradeLockId } = require("../server/api/payment/paymentRecord");
  const { issueUpgradeIntentToken, verifyUpgradeIntentToken, freezeUpgradeIntent } = require("../server/api/ref/upgradeIntentToken");
  const original = store.bookings.find(booking => booking._id === body.originalOrderId);
  for (const booking of store.bookings) {
    Object.assign(booking, { _rev: `${booking._id}.rev`, backendOwner: "sanity", cutoverGeneration: 0,
      currency: "USD", paymentProvider: "paypal", paypalOrderId: `${booking._id}.order`,
      paymentRecordId: `${booking._id}.payment` });
    store.paymentRecords.push({ _id: booking.paymentRecordId, _rev: `${booking.paymentRecordId}.rev`,
      _type: "paymentRecord", provider: "paypal", providerOrderId: booking.paypalOrderId,
      providerPaymentId: `${booking._id}.capture`, bookingId: booking._id, status: "booked",
      verificationState: "server_verified", backendOwner: "sanity", cutoverGeneration: 0,
      pricingSnapshot: { currency: "USD", netAmount: booking.netAmount },
      providerPublicData: { currency: "USD", totalAmount: Math.round(booking.netAmount * 100) } });
  }
  const authorization = { bookingId: original._id, email: original.email,
    targetPackageTitle: body.packageTitle, backend: "sanity", cutoverGeneration: 0 };
  const paymentRecordId = "paymentRecord.upgrade.fixture";
  const claimId = "paymentProofClaim.upgrade.fixture";
  const leaseId = "lease_upgrade_fixture";
  const providerOrderId = body.paypalOrderId || body.razorpayOrderId;
  const amount = Number(body.packagePrice.replace("$", ""));
  store.paymentRecords.push({ _id: paymentRecordId, _rev: "upgrade_payment_rev", _type: "paymentRecord",
    provider: body.paymentProvider, providerOrderId, providerPaymentId: body.razorpayPaymentId || "upgrade_capture",
    status: "finalizing", backendOwner: "sanity", cutoverGeneration: 0, verificationState: "server_verified",
    bookingPayload: { ...body }, pricingSnapshot: { currency: "USD", grossAmount: amount, netAmount: amount },
    upgradeIntentSnapshot: freezeUpgradeIntent({ payload: verifyUpgradeIntentToken({
      ...authorization, token: issueUpgradeIntentToken(authorization) }) }),
    paymentProofClaimId: claimId, finalizationLeaseId: leaseId,
    finalizationLeaseExpiresAt: new Date(Date.now() + 300000).toISOString() });
  store.paymentProofClaims.push({ _id: claimId, _rev: "upgrade_proof_rev", _type: "paymentProofClaim",
    paymentRecordId, provider: body.paymentProvider, providerOrderId,
    providerPaymentId: body.razorpayPaymentId || "upgrade_capture" });
  store.paymentUpgradeLocks.push({ _id: buildPaymentUpgradeLockId(`upgrade:${original._id}`),
    _rev: "upgrade_lock_rev", _type: "paymentUpgradeLock", paymentRecordId });
  return { ...createReq({ ...body, paymentRecordId }), internalContext: {
    paymentFinalizeSource: "reconcile", backendOwner: "sanity", cutoverGeneration: 0,
    paymentProofClaimId: claimId, paymentFinalizationLeaseId: leaseId } };
};

const createRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  return res;
};

const findById = (id) => {
  const collections = [
    store.bookings,
    store.paymentRecords,
    store.paymentUpgradeLocks,
    store.slotHolds,
    store.bookingSlots,
    store.couponRedemptions,
    store.paymentProofClaims,
    store.recoveryCases,
    store.coupons,
    store.referrals,
    store.packages,
  ];
  for (const collection of collections) {
    const found = collection.find((doc) => doc._id === id);
    if (found) return found;
  }
  return null;
};

const createConflictError = () => {
  const err = new Error("Document already exists");
  err.statusCode = 409;
  err.status = 409;
  return err;
};

const mockSanityClient = {
  flushCommerceMirror: (...args) => mockFlushCommerceMirror(...args),
  fetch: async (query, params = {}) => {
    const q = String(query || "");
    if (q.includes('_type == "bookingSettings"')) {
      return store.bookingSettings;
    }
    if (
      q.includes('_type == "package"') &&
      q.includes("title in $titles")
    ) {
      const titles = Array.isArray(params.titles) ? params.titles : [];
      return store.packages.find((pkg) => titles.includes(pkg.title)) || null;
    }
    if (
      q.includes('_type == "package"') &&
      q.includes("title == $title")
    ) {
      return (
        store.packages.find((pkg) => pkg.title === params.title) || null
      );
    }
    if (
      q.includes('_type == "referral"') &&
      q.includes("_id == $id")
    ) {
      return store.referrals.find((ref) => ref._id === params.id) || null;
    }
    if (
      q.includes('_type == "referral"') &&
      q.includes("slug.current == $code")
    ) {
      return (
        store.referrals.find(
          (ref) =>
            String(ref.slug?.current || "").toLowerCase() ===
            String(params.code || "").toLowerCase()
        ) || null
      );
    }
    if (q.includes("_type == $type && _id == $id")) {
      const found = findById(params.id);
      return found?._type === params.type ? found : null;
    }
    if (
      q.includes('_type == $type') &&
      q.includes('provider == "paypal"') &&
      q.includes("providerOrderId == $providerOrderId")
    ) {
      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === "paypal" &&
            entry.providerOrderId === params.providerOrderId
        ) || null
      );
    }
    if (
      q.includes('_type == $type') &&
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
      q.includes('_type == $type') &&
      q.includes('provider == "razorpay"') &&
      q.includes("providerOrderId == $providerOrderId")
    ) {
      return (
        store.paymentRecords.find(
          (entry) =>
            entry.provider === "razorpay" &&
            entry.providerOrderId === params.providerOrderId
        ) || null
      );
    }
    if (
      q.includes('_type == "booking"') &&
      q.includes("originalOrderId == $rootId")
    ) {
      return store.bookings.filter((booking) => {
        const status = String(booking.status || "").toLowerCase();
        const isPaid = status === "captured" || status === "completed";
        return (
          isPaid &&
          (booking._id === params.rootId || booking.originalOrderId === params.rootId)
        );
      });
    }
    if (
      q.includes('_type == "booking"') &&
      q.includes("_id == $id")
    ) {
      return store.bookings.find((b) => b._id === params.id) || null;
    }
    if (
      q.includes('_type == "booking"') &&
      q.includes("startTimeUTC == $startTimeUTC")
    ) {
      return store.bookings.filter(
        (booking) => booking.startTimeUTC === params.startTimeUTC
      );
    }
    if (
      q.includes('_type == "booking"') &&
      q.includes("hostDate == $date") &&
      q.includes("hostTime == $time")
    ) {
      return (
        store.bookings.find(
          (b) => b.hostDate === params.date && b.hostTime === params.time
        ) || null
      );
    }
    if (q.includes('_type == "booking"') && q.includes("paypalOrderId")) {
      return (
        store.bookings.find((b) => b.paypalOrderId === params.paypalOrderId) ||
        null
      );
    }
    if (q.includes('_type == "paymentRecord"') && q.includes("_id == $id")) {
      return store.paymentRecords.find((entry) => entry._id === params.id) || null;
    }
    if (q.includes('_type == "paymentUpgradeLock"') && q.includes("_id == $id")) {
      return store.paymentUpgradeLocks.find((entry) => entry._id === params.id) || null;
    }
    if (q.includes('_type == "booking"') && q.includes("razorpayPaymentId")) {
      return (
        store.bookings.find(
          (b) => b.razorpayPaymentId === params.razorpayPaymentId
        ) || null
      );
    }
    if (q.includes('_type == "booking"') && q.includes("dodoPaymentId")) {
      return store.bookings.find((booking) =>
        booking.paymentProvider === "dodo" &&
        booking.dodoPaymentId === params.dodoPaymentId &&
        booking.dodoCheckoutSessionId === params.dodoCheckoutSessionId
      ) || null;
    }
    if (q.includes('_type == "slotHold"') && q.includes("_id == $id")) {
      return store.slotHolds.find((h) => h._id === params.id) || null;
    }
    if (
      q.includes('_type == "slotHold"') &&
      q.includes("hostDate == $date") &&
      q.includes("hostTime == $time") &&
      q.includes("expiresAt > now()")
    ) {
      return (
        store.slotHolds.find((h) => {
          if (h.hostDate !== params.date || h.hostTime !== params.time) {
            return false;
          }
          return h.expiresAt && new Date(h.expiresAt) > new Date();
        }) || null
      );
    }
    if (q.includes('_type == "slotHold"') && q.includes("._id")) {
      return store.slotHolds
        .filter(
          (h) => h.hostDate === params.date && h.hostTime === params.time
        )
        .map((h) => h._id);
    }
    if (q.includes('_type == "bookingSlot"') && q.includes("_id == $id")) {
      return store.bookingSlots.find((entry) => entry._id === params.id) || null;
    }
    if (q.includes('_type == "paymentProofClaim"') && q.includes("_id == $id")) {
      return store.paymentProofClaims.find((entry) => entry._id === params.id) || null;
    }
    if (q.includes('_type == "couponRedemption"') && q.includes("_id == $id")) {
      const found = store.couponRedemptions.find((entry) => entry._id === params.id);
      return found ? { ...found } : null;
    }
    if (q.includes('_type == "coupon"') && q.includes("_id == $id")) {
      const found = store.coupons.find((entry) => entry._id === params.id);
      return found ? { ...found } : null;
    }
    if (q.includes('_type == "coupon"') && q.includes("lower(code)")) {
      const found = store.coupons.find(
          (c) =>
            String(c.code || "").toLowerCase() ===
            String(params.code || "").toLowerCase()
        );
      return found ? { ...found } : null;
    }
    return null;
  },
  create: async (doc) => {
    const next = { ...doc, _rev: `rev_${revisionCounter++}` };
    if (!next._id) {
      next._id = `doc_${idCounter++}`;
    }
    if (findById(next._id)) {
      throw createConflictError();
    }
    if (next._type === "slotHold") {
      store.slotHolds.push(next);
    }
    if (next._type === "bookingSlot") {
      store.bookingSlots.push(next);
    }
    if (next._type === "couponRedemption") {
      store.couponRedemptions.push(next);
    }
    if (next._type === "paymentProofClaim") {
      store.paymentProofClaims.push(next);
    }
    if (next._type === "bookingRecoveryCase") {
      store.recoveryCases.push(next);
    }
    if (next._type === "paymentRecord") {
      store.paymentRecords.push(next);
    }
    if (next._type === "paymentUpgradeLock") {
      store.paymentUpgradeLocks.push(next);
    }
    if (next._type === "booking") {
      store.bookings.push(next);
    }
    if (next._type === "coupon") {
      store.coupons.push(next);
    }
    if (next._type === "referral") {
      store.referrals.push(next);
    }
    if (next._type === "package") {
      store.packages.push(next);
    }
    return next;
  },
  delete: async (id) => {
    const resolvedId = typeof id === "object" ? id?.params?.id : id;
    const removeFrom = (list) => {
      const index = list.findIndex((doc) => doc._id === resolvedId);
      if (index >= 0) list.splice(index, 1);
    };
    removeFrom(store.slotHolds);
    removeFrom(store.bookingSlots);
    removeFrom(store.couponRedemptions);
    removeFrom(store.paymentProofClaims);
    removeFrom(store.recoveryCases);
    removeFrom(store.paymentRecords);
    removeFrom(store.paymentUpgradeLocks);
    removeFrom(store.bookings);
    removeFrom(store.coupons);
    removeFrom(store.referrals);
    removeFrom(store.packages);
    return { _id: resolvedId };
  },
  patch: (id) => {
    const ops = { setIfMissing: null, set: null, inc: null, dec: null, revision: "" };
    const patchApi = {
      ifRevisionId(revision) {
        ops.revision = revision;
        return patchApi;
      },
      setIfMissing(values = {}) {
        ops.setIfMissing = { ...ops.setIfMissing, ...values };
        return patchApi;
      },
      set(values = {}) {
        ops.set = { ...ops.set, ...values };
        return patchApi;
      },
      inc(values = {}) {
        ops.inc = { ...ops.inc, ...values };
        return patchApi;
      },
      dec(values = {}) {
        ops.dec = { ...ops.dec, ...values };
        return patchApi;
      },
      async commit() {
        const doc = findById(id);
        if (!doc) return null;
        if (ops.revision && doc._rev !== ops.revision) {
          throw createConflictError();
        }
        if (ops.setIfMissing) {
          Object.entries(ops.setIfMissing).forEach(([key, value]) => {
            if (doc[key] === undefined) doc[key] = value;
          });
        }
        if (ops.set) {
          Object.assign(doc, ops.set);
        }
        if (ops.inc) {
          Object.entries(ops.inc).forEach(([key, value]) => {
            doc[key] = (doc[key] || 0) + value;
          });
        }
        if (ops.dec) {
          Object.entries(ops.dec).forEach(([key, value]) => {
            doc[key] = (doc[key] || 0) - value;
          });
        }
        doc._rev = `rev_${revisionCounter++}`;
        return doc;
      },
    };
    return patchApi;
  },
};

mockSanityClient.transaction = () => {
  const operations = [];
  const transaction = {
    create(doc) {
      operations.push({ type: "create", doc: { ...doc } });
      return transaction;
    },
    createIfNotExists(doc) {
      operations.push({ type: "createIfNotExists", doc: { ...doc } });
      return transaction;
    },
    patch(id, builder) {
      const state = { set: {}, setIfMissing: {}, inc: {}, dec: {}, revision: "" };
      const patchApi = {
        ifRevisionId(revision) {
          state.revision = revision;
          return patchApi;
        },
        set(values = {}) {
          Object.assign(state.set, values);
          return patchApi;
        },
        setIfMissing(values = {}) {
          Object.assign(state.setIfMissing, values);
          return patchApi;
        },
        inc(values = {}) {
          Object.assign(state.inc, values);
          return patchApi;
        },
        dec(values = {}) {
          Object.assign(state.dec, values);
          return patchApi;
        },
      };
      if (typeof builder === "function") builder(patchApi);
      else Object.assign(state, builder || {});
      operations.push({ type: "patch", id, state });
      return transaction;
    },
    async commit() {
      for (const operation of operations) {
        if (operation.type === "create" && findById(operation.doc._id)) {
          throw createConflictError();
        }
        if (operation.type === "patch") {
          const doc = findById(operation.id);
          if (!doc) throw createConflictError();
          if (operation.state.revision && doc._rev !== operation.state.revision) {
            throw createConflictError();
          }
        }
      }
      for (const operation of operations) {
        if (operation.type === "create") {
          mockSanityClient.create(operation.doc);
        } else if (operation.type === "createIfNotExists") {
          if (!findById(operation.doc._id)) {
            mockSanityClient.create(operation.doc);
          }
        } else {
          const doc = findById(operation.id);
          Object.entries(operation.state.setIfMissing).forEach(([key, value]) => {
            if (doc[key] === undefined) doc[key] = value;
          });
          Object.assign(doc, operation.state.set);
          Object.entries(operation.state.inc).forEach(([key, value]) => {
            doc[key] = (doc[key] || 0) + value;
          });
          Object.entries(operation.state.dec).forEach(([key, value]) => {
            doc[key] = (doc[key] || 0) - value;
          });
          doc._rev = `rev_${revisionCounter++}`;
        }
      }
      return { transactionId: `tx_${revisionCounter}` };
    },
  };
  return transaction;
};

const mockCreateClient = jest.fn(() => mockSanityClient);

jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: (...args) => mockCreateClient(...args),
  createDocumentReadClient: (...args) => mockCreateClient(...args),
  createDocumentWriteClient: (...args) => mockCreateClient(...args),
}));

jest.mock("resend", () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: mockSendEmail,
    },
  })),
}));

jest.mock("../server/supabase/commerceControl.js", () => ({
  assertCommerceStartAllowed: (...args) =>
    mockAssertCommerceStartAllowed(...args),
}));

const reserveSlot = async (startTimeUTC, packageTitle = "Test Package") => {
  const req = createReq({ startTimeUTC, packageTitle });
  const res = createRes();
  await holdSlot(req, res);
  if (res.statusCode === 200) {
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(
      new Date().getTime()
    );
  }
  return { res, body: res.body };
};

const createPaidBooking = async ({
  startTimeUTC,
  timeZone,
  paymentProvider = "paypal",
  holdId,
  holdToken,
  holdExpiresAt,
  deferEmailsUntilConfirmation = false,
}) => {
  const utcDate = new Date(startTimeUTC);
  const displayDate = formatClientDate(utcDate, timeZone);
  const displayTime = formatClientTime(utcDate, timeZone);

  const payload = {
    discord: "servi",
    email: CLIENT_EMAIL,
    specs: "GPU/CPU",
    mainGame: "Shooter",
    message: "See you there",
    packageTitle: "Performance Vertex Overhaul",
    packagePrice: "$84.99",
    status: "captured",
    paymentProvider,
    localTimeZone: timeZone,
    startTimeUTC,
    displayDate,
    displayTime,
    slotHoldId: holdId || null,
    slotHoldToken: holdToken || null,
    slotHoldExpiresAt: holdExpiresAt || null,
    deferEmailsUntilConfirmation,
  };

  if (paymentProvider === "paypal") {
    payload.paypalOrderId = "paypal_order_1";
    payload.payerEmail = CLIENT_EMAIL;
  }

  if (paymentProvider === "razorpay") {
    payload.razorpayOrderId = "razorpay_order_1";
    payload.razorpayPaymentId = "razorpay_payment_1";
    payload.razorpaySignature = "test_signature";
  }

  const req = createReq(payload);
  const res = createRes();
  await createBooking(req, res);

  return { res, payload, displayDate, displayTime };
};

beforeAll(() => {
  process.env.DATA_PRIMARY_BACKEND = "sanity";
  process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
  process.env.SANITY_PROJECT_ID = "test-project";
  process.env.SANITY_DATASET = "test-dataset";
  process.env.SANITY_WRITE_TOKEN = "test-write-token";
  process.env.RESEND_API_KEY = "test-key";
  process.env.FROM_EMAIL = "booking@roo.test";
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.SITE_NAME = "Roo Industries";
  process.env.RAZORPAY_KEY_ID = "";
  process.env.RAZORPAY_KEY_SECRET = "";
  process.env.PAYPAL_CLIENT_ID = "";
  process.env.PAYPAL_CLIENT_SECRET = "";
  process.env.TOURNEY_FREE_SESSION_STORE_MODE = "memory";
  const load = (path) => {
    const mod = require(path);
    return mod && mod.default ? mod.default : mod;
  };
  holdSlot = load("../../src/server/booking/holdSlot");
  ({ isSameSupabaseOwnedHold } = require(
    "../../src/server/booking/holdSlot"
  ));
  createBooking = load("../../src/server/api/ref/createBooking");
  releaseHold = load("../../src/server/booking/releaseHold");
  dispatchRescheduleNotifications =
    require("../../src/server/api/ref/bookingEmails").dispatchRescheduleNotifications;
  formatRequestedTimeFields =
    require("../../src/server/api/ref/bookingEmails").formatRequestedTimeFields;
  ({ applyBookingRefund, applyBookingStatusTransition } = require(
    "../../src/server/api/ref/bookingRefunds"
  ));
  ({ createRequiresRescheduleBooking } = require(
    "../../src/server/api/ref/bookingCommit"
  ));

  ({ getBookingAvailability } = require(
    "../../src/server/booking/availability"
  ));
});

afterAll(() => {
  if (previousDataPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
  else process.env.DATA_PRIMARY_BACKEND = previousDataPrimary;
  if (previousCommercePrimary === undefined) {
    delete process.env.COMMERCE_PRIMARY_BACKEND;
  } else {
    process.env.COMMERCE_PRIMARY_BACKEND = previousCommercePrimary;
  }
  if (previousFreeSessionStoreMode === undefined) {
    delete process.env.TOURNEY_FREE_SESSION_STORE_MODE;
  } else {
    process.env.TOURNEY_FREE_SESSION_STORE_MODE = previousFreeSessionStoreMode;
  }
});

beforeEach(() => {
  resetStore();

  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ data: { id: "email-fixture" }, error: null });
  mockFlushCommerceMirror.mockClear();
  mockAssertCommerceStartAllowed.mockClear();
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.RAZORPAY_KEY_ID = "";
  process.env.RAZORPAY_KEY_SECRET = "";
  process.env.PAYPAL_CLIENT_ID = "";
  process.env.PAYPAL_CLIENT_SECRET = "";
  globalThis.__rooRateLimitBuckets?.clear?.();
  delete global.fetch;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete global.fetch;
});

describe("booking reservation API", () => {
  ;

  test.each([true, false])("Dodo reuses its existing booking when emails succeed: %s", async (emailsSucceed) => {
    const booking = {
      _id: "booking_dodo_existing",
      grossAmount: 84.99,
      netAmount: 84.99,
      _rev: "booking_dodo_existing_fixture_revision",
      _type: "booking",
      status: "captured",
      paymentProvider: "dodo",
      dodoPaymentId: "pay_dodo_existing",
      dodoCheckoutSessionId: "cks_dodo_existing",
      paymentRecordId: "paymentRecord.dodo_existing",
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      startTimeUTC: "2099-01-15T08:00:00.000Z",
      localTimeZone: OWNER_TZ,
      displayDate: "Thursday, January 15, 2099",
      displayTime: "1:30 PM",
    };
    store.bookings.push(booking);
    store.paymentRecords.push({
      _id: booking.paymentRecordId,
      _rev: "dodo_payment_fixture_revision",
      pricingSnapshot: { grossAmount: 84.99, netAmount: 84.99 },
      _type: "paymentRecord",
      provider: "dodo",
      status: "finalizing",
      verificationState: "server_verified",
      providerOrderId: booking.dodoCheckoutSessionId,
      providerPaymentId: booking.dodoPaymentId,
    });
    mockSendEmail.mockResolvedValue({ data: emailsSucceed ? { id: "email-fixture" } : null, error: emailsSucceed ? null : { message: "Unavailable" } });
    const req = createReq(booking);
    req.internalContext = { paymentFinalizeSource: "reconcile" };
    const res = createRes();

    await createBooking(req, res);

    expect({ status: res.statusCode, body: res.body }).toMatchObject({ status: emailsSucceed ? 200 : 503, body: { bookingId: booking._id } });
    expect(res.body).toMatchObject({
      bookingId: booking._id,
      idempotent: true,
      emailDispatch: { allSent: emailsSucceed },
    });
    expect(store.bookings).toHaveLength(1);
    expect(store.slotHolds).toHaveLength(0);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  test.each([true, false])("Dodo full refunds retain tax in recovery amount %s", async recovery => {
    store.bookings.push({ _id: "booking_tax_full", _rev: "booking_tax_full_fixture_revision", _type: "booking", status: "captured", netAmount: 99.95, dodoTotalAmount: 125.44 });
    await applyBookingRefund({ client: mockSanityClient, paymentRecord: { bookingId: "booking_tax_full", ...(recovery ? { provider: "dodo" } : {}) },
      refund: { full: true, ...(recovery ? { processedAmountInSubunits: 12544 } : {}) } });
    expect(store.bookings[0]).toMatchObject({ status: "refunded", refundedAmount: 125.44 });
  });

  test("Dodo partial refunds reduce commission against the tax-inclusive customer charge", async () => {
    store.bookings.push({ _id: "booking_tax_refund", _rev: "booking_tax_refund_fixture_revision", _type: "booking", status: "captured", netAmount: 99.95, commissionAmount: 10 });
    await applyBookingRefund({ client: mockSanityClient, paymentRecord: {
      provider: "dodo", bookingId: "booking_tax_refund", providerPublicData: { taxInclusive: false, totalAmount: 12544 },
    }, refund: { full: false, totalRefundedAmount: 62.72 } });
    expect(store.bookings[0]).toMatchObject({ status: "captured", refundedAmount: 62.72, dodoTotalAmount: 125.44, commissionAmount: 5 });
  });

  test("Dodo reschedule recovery preserves the taxable charge and adjusted commission", async () => {
    const paymentRecord = {
      _id: "paymentRecord.dodo.tax_recovery", _type: "paymentRecord", provider: "dodo", providerOrderId: "cks_tax", providerPaymentId: "pay_tax", verificationState: "server_verified",
      bookingPayload: { email: CLIENT_EMAIL, packageTitle: "Performance Vertex Max" },
      pricingSnapshot: { grossAmount: 99.95, netAmount: 99.95, commissionAmount: 10, commissionPercent: 10 },
      providerPublicData: { taxInclusive: false, totalAmount: 12544 }, refundState: "partial", refundProcessedAmountInSubunits: 6272,
    };
    const result = await createRequiresRescheduleBooking({ client: mockSanityClient, paymentRecord, notify: false });
    expect(result.booking).toMatchObject({ netAmount: 99.95, dodoTotalAmount: 125.44, refundedAmount: 62.72, commissionAmount: 5 });
  });

  test("admin refund releases an upgrade lock and upgrade status changes never claim a slot", async () => {
    const bookingId = "booking_upgrade_admin_refund";
    const paymentRecordId = "paymentRecord.session.upgrade_admin_refund";
    const startClaimId = "paymentUpgradeLock.upgrade_admin_refund";
    store.bookings.push({
      _id: bookingId,
      _rev: "booking_upgrade_admin_refund_rev",
      _type: "booking",
      status: "captured",
      originalOrderId: "booking_original",
      startTimeUTC: "2099-01-15T08:26:00.000Z",
      paymentRecordId,
    });
    store.paymentRecords.push({
      _id: paymentRecordId,
      _rev: "payment_upgrade_admin_refund_rev",
      _type: "paymentRecord",
      bookingId,
      startClaimId,
    });
    store.paymentUpgradeLocks.push({
      _id: startClaimId,
      _rev: "upgrade_lock_admin_refund_rev",
      _type: "paymentUpgradeLock",
      paymentRecordId,
    });

    const refunded = await applyBookingStatusTransition({
      client: mockSanityClient,
      bookingId,
      status: "refunded",
      source: "admin-test",
    });
    expect(refunded.upgradeLockReleased).toBe(true);
    expect(store.paymentUpgradeLocks).toHaveLength(0);
    expect(store.paymentRecords[0].status).toBe("refunded");
    expect(store.bookingSlots).toHaveLength(0);
  });

  test("a refunded booking cannot be reactivated without restoring its accounting", async () => {
    store.bookings.push({
      _id: "booking_refunded_terminal",
      _rev: "booking_refunded_terminal_rev",
      _type: "booking",
      status: "refunded",
      startTimeUTC: "2099-01-15T08:26:00.000Z",
      couponRestoredAfterRefund: true,
      referralReversedAfterRefund: true,
    });

    await expect(
      applyBookingStatusTransition({
        client: mockSanityClient,
        bookingId: "booking_refunded_terminal",
        status: "captured",
        source: "admin-test",
      })
    ).rejects.toMatchObject({
      status: 409,
      code: "refunded_booking_terminal",
    });
    expect(store.bookings[0].status).toBe("refunded");
    expect(store.bookingSlots).toHaveLength(0);
  });

  test("a cancelled upgrade can be restored without claiming its original slot", async () => {
    const bookingId = "booking_cancelled_upgrade";
    store.bookings.push({
      _id: bookingId,
      _rev: "booking_cancelled_upgrade_rev",
      _type: "booking",
      status: "cancelled",
      originalOrderId: "booking_original",
      startTimeUTC: "2099-01-15T08:26:00.000Z",
    });

    const restored = await applyBookingStatusTransition({
      client: mockSanityClient,
      bookingId,
      status: "captured",
      source: "admin-test",
    });

    expect(restored.status).toBe("captured");
    expect(store.bookingSlots).toHaveLength(0);
  });

  test.each([undefined, 101.99])("reschedule recovery notifies both sides once with paid total %s", async dodoTotalAmount => {
    store.bookings.push({
      _id: "booking.recovery-notify",
      _rev: "recovery_notify_rev",
      _type: "booking",
      status: "captured",
      requiresReschedule: true,
      recoveryReason: "slot_occupied",
      recoveryNotificationStatus: "pending",
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      netAmount: 84.99,
      ...(dodoTotalAmount ? { dodoTotalAmount } : {}),
      originalRequestedStartTimeUTC: "2099-01-15T08:00:00.000Z",
      localTimeZone: "America/Los_Angeles",
      displayDate: "Thursday, January 15, 2099",
      displayTime: "12:00 AM",
    });

    const first = await dispatchRescheduleNotifications({
      client: mockSanityClient,
      bookingId: "booking.recovery-notify",
    });
    const second = await dispatchRescheduleNotifications({
      client: mockSanityClient,
      bookingId: "booking.recovery-notify",
    });

    expect(first).toMatchObject({ ok: true, notificationRequired: false });
    expect(second).toMatchObject({ idempotent: true, notificationRequired: false });
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls[0][1].idempotencyKey).toMatch(
      /-reschedule-client$/
    );
    expect(mockSendEmail.mock.calls[1][1].idempotencyKey).toMatch(
      /-reschedule-owner$/
    );
    const clientEmail = mockSendEmail.mock.calls[0][0];
    expect(clientEmail.html).toContain(`$${dodoTotalAmount || 84.99}`);
    expect(clientEmail.subject).toBe(
      "We need to reschedule your Roo Industries booking"
    );
    expect(clientEmail.html).toContain("We need to reschedule your booking");
    expect(clientEmail.html).toContain("Thursday, January 15, 2099");
    expect(clientEmail.html).toContain("12:00 AM");
    expect(clientEmail.html).toContain(
      "GMT-08:00 (America/Los_Angeles)"
    );
    expect(clientEmail.html).not.toContain("2099-01-15T08:00:00.000Z");
    expect(store.bookings[0].recoveryNotificationStatus).toBe("sent");
    expect(mockFlushCommerceMirror).not.toHaveBeenCalled();
  });

  test("reschedule emails render the requested time without exposing an ISO timestamp", () => {
    expect(
      formatRequestedTimeFields({
        originalRequestedStartTimeUTC: "2026-03-18T03:30:00.000Z",
        localTimeZone: "Asia/Kolkata",
      })
    ).toEqual([
      { label: "Requested Date", value: "Wednesday, March 18, 2026" },
      { label: "Requested Time", value: "9:00 AM" },
      {
        label: "Time Zone",
        value: "GMT+05:30 (Asia/Kolkata)",
      },
    ]);
    expect(
      formatRequestedTimeFields({
        originalRequestedStartTimeUTC: "2026-03-18T03:30:00.000Z",
      })
    ).toEqual([
      { label: "Requested Date", value: "Wednesday, March 18, 2026" },
      { label: "Requested Time", value: "3:30 AM" },
      { label: "Time Zone", value: "UTC" },
    ]);
  });

  test("captured unreconstructable payments create one visible recovery case", async () => {
    const paymentRecord = {
      _id: "paymentRecord.paypal.order.recovery_case",
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "recovery_case",
      payerEmail: CLIENT_EMAIL,
      bookingPayload: {
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Overhaul",
        startTimeUTC: "2099-01-15T08:00:00.000Z",
        localTimeZone: "America/Los_Angeles",
        displayDate: "Thursday, January 15, 2099",
        displayTime: "12:00 AM",
      },
      pricingSnapshot: { grossAmount: 84.99, netAmount: 84.99 },
    };

    const first = await createRequiresRescheduleBooking({
      client: mockSanityClient,
      paymentRecord,
      reason: "slot_occupied",
    });
    const second = await createRequiresRescheduleBooking({
      client: mockSanityClient,
      paymentRecord,
      reason: "slot_occupied",
    });

    expect(first).toMatchObject({
      idempotent: false,
      notificationRequired: false,
    });
    expect(second.idempotent).toBe(true);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      status: "captured",
      requiresReschedule: true,
      recoveryNotificationStatus: "sent",
      localTimeZone: "America/Los_Angeles",
      displayDate: "Thursday, January 15, 2099",
      displayTime: "12:00 AM",
    });
    expect(store.recoveryCases).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  test("reschedule recovery atomically settles coupon, referral, hold, and refund accounting", async () => {
    const paymentRecord = {
      _id: "paymentRecord.paypal.recovery-accounting",
      _rev: "payment_recovery_accounting_rev",
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "paypal_recovery_accounting",
      providerPaymentId: "capture_recovery_accounting",
      status: "finalizing",
      couponReservationId: "couponRedemption.recovery-accounting",
      bookingPayload: {
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Overhaul",
        startTimeUTC: "2099-01-15T08:00:00.000Z",
        couponCode: "RECOVER",
      },
      pricingSnapshot: {
        grossAmount: 84.99,
        netAmount: 42.5,
        couponDiscountAmount: 42.49,
        couponDiscountType: "fixed",
        couponDiscountValue: 42.49,
        effectiveReferralId: "ref_recovery_accounting",
        effectiveReferralCode: "recoveryref",
      },
    };
    const coupon = {
      _id: "coupon_recovery_accounting",
      _rev: "coupon_recovery_accounting_rev",
      _type: "coupon",
      code: "RECOVER",
      isActive: true,
      timesUsed: 0,
      activeReservations: 1,
      maxUses: 1,
    };
    const redemption = {
      _id: "couponRedemption.recovery-accounting",
      _rev: "redemption_recovery_accounting_rev",
      _type: "couponRedemption",
      coupon: { _type: "reference", _ref: coupon._id },
      paymentRecordId: paymentRecord._id,
      status: "reserved",
    };
    const referral = {
      _id: "ref_recovery_accounting",
      _rev: "ref_recovery_accounting_rev",
      _type: "referral",
      successfulReferrals: 0,
    };
    const hold = {
      _id: "slotHold.recovery-accounting",
      _rev: "hold_recovery_accounting_rev",
      _type: "slotHold",
      phase: "payment_pending",
      paymentRecordId: paymentRecord._id,
    };
    const proof = {
      _id: "paymentProofClaim.paypal.recovery-accounting",
      _rev: "proof_recovery_accounting_rev",
      _type: "paymentProofClaim",
      paymentRecordId: paymentRecord._id,
      provider: "paypal",
      providerOrderId: paymentRecord.providerOrderId,
    };
    store.paymentRecords.push(paymentRecord);
    store.coupons.push(coupon);
    store.couponRedemptions.push(redemption);
    store.referrals.push(referral);
    store.slotHolds.push(hold);
    store.paymentProofClaims.push(proof);

    const recovered = await createRequiresRescheduleBooking({
      client: mockSanityClient,
      paymentRecord,
      reason: "slot_occupied",
      notify: false,
      paymentProofClaim: proof,
      paymentRecordMutation: {
        id: paymentRecord._id,
        revision: paymentRecord._rev,
        set: { status: "email_partial", requiresReschedule: true },
      },
      couponReservation: { coupon, redemption },
      referralId: referral._id,
      paymentHold: hold,
    });

    expect(recovered.bookingId).toMatch(/^booking\./);
    expect(store.bookings[0]).toMatchObject({
      couponRedemptionId: redemption._id,
      referral: { _ref: referral._id },
      referralAccountingApplied: true,
    });
    expect(redemption).toMatchObject({
      status: "consumed",
      bookingId: recovered.bookingId,
    });
    expect(coupon).toMatchObject({
      timesUsed: 1,
      activeReservations: 0,
      isActive: false,
    });
    expect(referral.successfulReferrals).toBe(1);
    expect(hold).toMatchObject({
      phase: "consumed",
      bookingId: recovered.bookingId,
    });
    expect(paymentRecord.bookingId).toBe(recovered.bookingId);
    expect(proof.bookingId).toBe(recovered.bookingId);

    await applyBookingRefund({
      client: mockSanityClient,
      paymentRecord,
      refund: { id: "refund_recovery_accounting", full: true, amount: 42.5 },
    });

    expect(store.bookings[0].status).toBe("refunded");
    expect(redemption.status).toBe("refunded");
    expect(coupon.timesUsed).toBe(0);
    expect(referral.successfulReferrals).toBe(0);
    expect(paymentRecord.status).toBe("refunded");
  });

  test("late capture consumes a coupon reservation that abandonment released", async () => {
    const paymentRecord = {
      _id: "paymentRecord.paypal.late-coupon",
      _rev: "payment_late_coupon_rev",
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "paypal_late_coupon",
      status: "finalizing",
      bookingPayload: {
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Overhaul",
        couponCode: "LASTUSE",
      },
      pricingSnapshot: { grossAmount: 84.99, netAmount: 42.5 },
    };
    const coupon = {
      _id: "coupon_late_capture",
      _rev: "coupon_late_capture_rev",
      _type: "coupon",
      code: "LASTUSE",
      isActive: false,
      timesUsed: 1,
      activeReservations: 0,
      maxUses: 1,
    };
    const redemption = {
      _id: "couponRedemption.late-capture",
      _rev: "redemption_late_capture_rev",
      _type: "couponRedemption",
      coupon: { _type: "reference", _ref: coupon._id },
      paymentRecordId: paymentRecord._id,
      status: "released",
      releasedAt: "2099-01-15T08:20:00.000Z",
    };
    store.paymentRecords.push(paymentRecord);
    store.coupons.push(coupon);
    store.couponRedemptions.push(redemption);

    const recovered = await createRequiresRescheduleBooking({
      client: mockSanityClient,
      paymentRecord,
      reason: "captured_after_abandonment",
      notify: false,
      paymentRecordMutation: {
        id: paymentRecord._id,
        revision: paymentRecord._rev,
        set: { status: "email_partial", requiresReschedule: true },
      },
      couponReservation: { coupon, redemption },
    });

    expect(store.bookings[0].couponRedemptionId).toBe(redemption._id);
    expect(redemption).toMatchObject({
      status: "consumed",
      bookingId: recovered.bookingId,
      recoveredAfterRelease: true,
      capacityExceededAtRecovery: true,
    });
    expect(coupon).toMatchObject({ timesUsed: 2, activeReservations: 0 });
  });

  test("payment-confirmed-without-reservation is rejected", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const { res } = await createPaidBooking({
      startTimeUTC: "2099-01-15T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
      paymentProvider: "razorpay",
    });

    expect(res.statusCode).toBe(409);
    expect(store.bookings).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("upgrade booking backfills original booking details without leaking them from the client", async () => {
    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      discord: "servi",
      email: CLIENT_EMAIL,
      specs: "9800X3D / RTX 5080",
      mainGame: "Overwatch 2",
      message: "Original booking notes",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Max (Upgrade)",
        packagePrice: "$14.96",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_1",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(2);

    const upgrade = store.bookings.find((b) => b._id !== "booking_original");
    expect(upgrade.email).toBe(CLIENT_EMAIL);
    expect(upgrade.discord).toBe("servi");
    expect(upgrade.specs).toBe("9800X3D / RTX 5080");
    expect(upgrade.mainGame).toBe("Overwatch 2");
    expect(upgrade.message).toBe("Original booking notes");
    expect(upgrade.startTimeUTC).toBe(startTimeUTC);
    expect(upgrade.displayDate).toBe(
      formatClientDate(originalUtcDate, "America/Los_Angeles")
    );
    expect(upgrade.displayTime).toBe(
      formatClientTime(originalUtcDate, "America/Los_Angeles")
    );
    expect(upgrade.originalOrderId).toBe("booking_original");
  });

  test("upgrade booking rejects requests without the original booking email", async () => {
    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      payerEmail: "payer@example.com",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        packageTitle: "Performance Vertex Max",
        packagePrice: "$14.96",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_missing_email",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "Upgrade details do not match the original booking.",
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("upgrade booking rejects mismatched booking email", async () => {
    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      payerEmail: "payer@example.com",
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: "wrong@example.com",
        packageTitle: "Performance Vertex Max",
        packagePrice: "$14.96",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_wrong_email",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "The frozen upgrade authorization no longer matches.",
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("upgrade pricing uses cumulative paid amount across prior paid upgrades", async () => {
    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });
    store.bookings.push({
      _id: "booking_upgrade_prior",
      _type: "booking",
      status: "captured",
      email: CLIENT_EMAIL,
      originalOrderId: "booking_original",
      packageTitle: "Cooling Tuning Add-On",
      packagePrice: "$5.00",
      grossAmount: 5,
      netAmount: 5,
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Max",
        packagePrice: "$9.96",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_cumulative",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    const upgrade = store.bookings.find((b) => b._id === res.body.bookingId);
    expect(upgrade.grossAmount).toBeCloseTo(9.96, 2);
    expect(upgrade.netAmount).toBeCloseTo(9.96, 2);
    expect(upgrade.packagePrice).toBe("$9.96");
  });

  test("upgrade booking rejects orders already at the target package", async () => {
    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });
    store.bookings.push({
      _id: "booking_upgrade_target",
      _type: "booking",
      status: "captured",
      email: CLIENT_EMAIL,
      originalOrderId: "booking_original",
      packageTitle: "Performance Vertex Max",
      packagePrice: "$14.96",
      grossAmount: 14.96,
      netAmount: 14.96,
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Max",
        packagePrice: "$0.00",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_already_target",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: "This booking already received the upgrade.",
      code: "upgrade_credit_changed_after_quote",
    });
  });

  test("rejects Razorpay payments that are not captured upstream", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_123";
    process.env.RAZORPAY_KEY_SECRET = "rzp_secret";

    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        order_id: "razorpay_order_1",
        currency: "USD",
        amount: 1496,
        status: "authorized",
      }),
    }));

    const signature = require("crypto")
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update("razorpay_order_1|razorpay_payment_1")
      .digest("hex");

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Max",
        packagePrice: "$14.96",
        status: "captured",
        paymentProvider: "razorpay",
        razorpayOrderId: "razorpay_order_1",
        razorpayPaymentId: "razorpay_payment_1",
        razorpaySignature: signature,
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Payment verification failed." });
  });

  test.each([false, true])("atomically consumes the internal proof claim and finalization lease with referral=%s", async (withReferral) => {
    const startTimeUTC = "2099-01-15T10:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const paymentRecordId = "paymentRecord.paypal.order.internal_order";
    const claimId = "paymentProofClaim.paypal.internal_order";
    const leaseId = "lease_internal_order";
    const { buildPricingFingerprint } = require("../server/api/payment/paymentRecord");
    const { hashPaymentFingerprint, isPaymentAccessTokenRecordMatch } = require("../server/api/payment/accessToken");
    const pricingSnapshot = {
      grossAmount: 84.99,
      netAmount: withReferral ? 80.74 : 84.99,
      discountAmount: withReferral ? 4.25 : 0,
      discountPercent: withReferral ? 5 : 0,
      referralDiscountAmount: withReferral ? 4.25 : 0,
      referralDiscountPercent: withReferral ? 5 : 0,
      commissionPercent: withReferral ? 10 : 0,
      commissionAmount: withReferral ? 8.5 : 0,
      effectiveReferralId: withReferral ? "ref_frozen" : "",
      effectiveReferralCode: withReferral ? "frozen-code" : "",
    };
    if (withReferral) store.referrals.push({ _id: "ref_frozen", _type: "referral", successfulReferrals: 0 });
    const pricingFingerprint = buildPricingFingerprint({
      provider: "paypal", packageTitle: "Performance Vertex Overhaul",
      startTimeUTC, email: CLIENT_EMAIL, currency: "USD",
      grossAmount: pricingSnapshot.grossAmount, netAmount: pricingSnapshot.netAmount,
      discountAmount: pricingSnapshot.discountAmount,
      referralId: pricingSnapshot.effectiveReferralId,
      referralCode: pricingSnapshot.effectiveReferralCode,
    });
    const tokenClaims = {
      paymentRecordId, provider: "paypal", backend: "sanity", cutoverGeneration: 0,
      pricingFingerprintHash: hashPaymentFingerprint(pricingFingerprint),
    };
    store.paymentRecords.push({
      _id: paymentRecordId,
      _rev: "payment_record_rev",
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "internal_order",
      status: "finalizing",
      paymentProofClaimId: claimId,
      finalizationLeaseId: leaseId,
      finalizationLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      pricingSnapshot: { ...pricingSnapshot },
      pricingFingerprint,
    });
    store.paymentProofClaims.push({
      _id: claimId,
      _rev: "proof_claim_rev",
      _type: "paymentProofClaim",
      paymentRecordId,
      provider: "paypal",
      providerOrderId: "internal_order",
      providerPaymentId: "",
    });
    store.packages.find(
      (entry) => entry.title === "Performance Vertex Overhaul"
    ).price = "$999.00";
    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      {
        ...createReq({
          email: CLIENT_EMAIL,
          packageTitle: "Performance Vertex Overhaul",
          status: "captured",
          paymentProvider: "paypal",
          paypalOrderId: "internal_order",
          paymentRecordId,
          referralCode: pricingSnapshot.effectiveReferralCode,
          startTimeUTC,
          localTimeZone: "America/Los_Angeles",
          displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
          displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
          slotHoldId: hold.body.holdId,
          slotHoldToken: hold.body.holdToken,
          deferEmailsUntilConfirmation: true,
        }),
        internalContext: {
          paymentFinalizeSource: "webhook",
          paymentProofClaimId: claimId,
          paymentFinalizationLeaseId: leaseId,
        },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.paymentProofClaims[0].bookingId).toBe(res.body.bookingId);
    expect(store.paymentRecords[0]).toMatchObject({
      status: "email_partial",
      bookingId: res.body.bookingId,
      finalizationLeaseId: "",
    });
    expect(isPaymentAccessTokenRecordMatch({ payload: tokenClaims, record: store.paymentRecords[0] })).toBe(true);
    expect(store.paymentRecords[0].pricingSnapshot).toEqual(pricingSnapshot);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: pricingSnapshot.netAmount,
    });
  });

  test("rejects PayPal payments with the wrong captured currency", async () => {
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";

    const startTimeUTC = "2099-01-15T08:00:00.000Z";
    const originalUtcDate = new Date(startTimeUTC);
    store.bookings.push({
      _id: "booking_original",
      _type: "booking",
      status: "completed",
      email: CLIENT_EMAIL,
      payerEmail: CLIENT_EMAIL,
      packageTitle: "Performance Vertex Overhaul",
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
      localTimeZone: "America/Los_Angeles",
      startTimeUTC,
      displayDate: formatClientDate(originalUtcDate, "America/Los_Angeles"),
      displayTime: formatClientTime(originalUtcDate, "America/Los_Angeles"),
      hostDate: formatOwnerDate(originalUtcDate),
      hostTime: formatOwnerTime(originalUtcDate),
    });

    global.fetch = jest.fn(async (url) => {
      if (String(url).includes("/v1/oauth2/token")) {
        return {
          ok: true,
          json: async () => ({ access_token: "paypal-token" }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          status: "COMPLETED",
          payer: { email_address: CLIENT_EMAIL },
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    amount: {
                      value: "14.96",
                      currency_code: "EUR",
                    },
                  },
                ],
              },
            },
          ],
        }),
      };
    });

    const res = createRes();
    await createBooking(
      createUpgradeFinalizationReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Max",
        packagePrice: "$14.96",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_upgrade_currency_mismatch",
        originalOrderId: "booking_original",
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Payment verification failed." });
  });
});

describe("email time zone separation and midnight handling", () => {
  test.each([
    {
      label: "client 11:59 PM",
      startTimeUTC: "2099-01-15T07:59:00.000Z",
      timeZone: "America/Los_Angeles",
    },
    {
      label: "client 12:00 AM",
      startTimeUTC: "2099-01-15T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
    },
    {
      label: "owner crosses midnight",
      startTimeUTC: "2099-01-15T18:30:00.000Z",
      timeZone: "America/Los_Angeles",
    },
  ])("client/owner emails keep correct dates at $label", async ({ startTimeUTC, timeZone }) => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const { res } = await createPaidBooking({
      startTimeUTC,
      timeZone,
      paymentProvider: "razorpay",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const utcDate = new Date(startTimeUTC);
    const clientDate = formatClientDate(utcDate, timeZone);
    const clientTime = formatClientTime(utcDate, timeZone);
    const ownerDate = formatOwnerDate(utcDate);
    const ownerTime = formatOwnerTime(utcDate);

    const clientCall = mockSendEmail.mock.calls.find(
      ([args]) => args.to === CLIENT_EMAIL
    );
    const ownerCall = mockSendEmail.mock.calls.find(
      ([args]) => args.to === OWNER_EMAIL
    );

    expect(clientCall).toBeTruthy();
    expect(ownerCall).toBeTruthy();

    const clientHtml = clientCall[0].html;
    const ownerHtml = ownerCall[0].html;

    expect(clientHtml).toContain(clientDate);
    expect(clientHtml).toContain(clientTime);
    expect(clientHtml).toContain(timeZone);
    expect(clientHtml).not.toContain(ownerDate);
    expect(clientHtml).not.toContain(ownerTime);
    expect(clientHtml).not.toContain(OWNER_TZ);

    expect(ownerHtml).toContain(ownerDate);
    expect(ownerHtml).toContain(ownerTime);
    expect(ownerHtml).toContain(OWNER_TZ);
    expect(ownerHtml).toContain(clientDate);
    expect(ownerHtml).toContain(clientTime);
    expect(ownerHtml).toContain(timeZone);
  });
});
