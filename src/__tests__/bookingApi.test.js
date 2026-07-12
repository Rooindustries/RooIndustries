let holdSlot;
let createBooking;
let releaseHold;
let sendBookingEmails;
let sendBookingEmailsForBooking;
let dispatchRescheduleNotifications;
let formatRequestedTimeFields;
let applyBookingRefund;
let applyBookingStatusTransition;
let createRequiresRescheduleBooking;

const CLIENT_EMAIL = "vihaann2.0@gmail.com";
const OWNER_EMAIL = "serviroo@rooindustries.com";
const OWNER_TZ = "Asia/Kolkata";

const mockSendEmail = jest.fn().mockResolvedValue({ error: null });

let store;
let idCounter = 1;
let revisionCounter = 1;

const resetStore = () => {
  const configuredUtcSlots = [
    "2025-01-15T07:59:00.000Z",
    "2025-01-15T08:00:00.000Z",
    "2025-01-15T08:15:00.000Z",
    "2025-01-15T08:18:00.000Z",
    "2025-01-15T08:20:00.000Z",
    "2025-01-15T08:22:00.000Z",
    "2025-01-15T08:24:00.000Z",
    "2025-01-15T08:25:00.000Z",
    "2025-01-15T08:26:00.000Z",
    "2025-01-15T08:28:00.000Z",
    "2025-01-15T09:00:00.000Z",
    "2025-01-15T10:00:00.000Z",
    "2025-01-15T11:00:00.000Z",
    "2025-01-15T18:30:00.000Z",
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

jest.mock("@sanity/client", () => ({
  createClient: (...args) => mockCreateClient(...args),
}));

jest.mock("resend", () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: mockSendEmail,
    },
  })),
}));

const reserveSlot = async (startTimeUTC, packageTitle = "Test Package") => {
  const req = createReq({ startTimeUTC, packageTitle });
  const res = createRes();
  await holdSlot(req, res);
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
  process.env.RESEND_API_KEY = "test-key";
  process.env.FROM_EMAIL = "booking@roo.test";
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.SITE_NAME = "Roo Industries";
  process.env.RAZORPAY_KEY_ID = "";
  process.env.RAZORPAY_KEY_SECRET = "";
  process.env.PAYPAL_CLIENT_ID = "";
  process.env.PAYPAL_CLIENT_SECRET = "";
  const load = (path) => {
    const mod = require(path);
    return mod && mod.default ? mod.default : mod;
  };
  holdSlot = load("../../src/server/booking/holdSlot");
  createBooking = load("../../src/server/api/ref/createBooking");
  releaseHold = load("../../src/server/booking/releaseHold");
  sendBookingEmails = load("../../src/server/api/ref/sendBookingEmails");
  sendBookingEmailsForBooking =
    require("../../src/server/api/ref/bookingEmails").sendBookingEmailsForBooking;
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
});

beforeEach(() => {
  resetStore();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ error: null });
  process.env.OWNER_EMAIL = OWNER_EMAIL;
  process.env.RAZORPAY_KEY_ID = "";
  process.env.RAZORPAY_KEY_SECRET = "";
  process.env.PAYPAL_CLIENT_ID = "";
  process.env.PAYPAL_CLIENT_SECRET = "";
  globalThis.__rooRateLimitBuckets?.clear?.();
  delete global.fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
  delete global.fetch;
});

describe("booking reservation API", () => {
  test("reservation creation locks slot for other users", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const startTimeUTC = "2025-01-15T07:59:00.000Z";
    const first = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    expect(first.res.statusCode).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(store.slotHolds).toHaveLength(1);

    const utcDate = new Date(startTimeUTC);
    expect(store.slotHolds[0].hostDate).toBe(formatOwnerDate(utcDate));
    expect(store.slotHolds[0].hostTime).toBe(formatOwnerTime(utcDate));

    const second = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(second.res.statusCode).toBe(409);
    expect(second.body.message).toMatch(/reserved/i);
  });

  test("payment-pending holds cannot be refreshed, moved, or publicly released", async () => {
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    Object.assign(store.slotHolds[0], {
      phase: "payment_pending",
      paymentRecordId: "paymentRecord.session.pending",
    });

    const refreshRes = createRes();
    await holdSlot(
      createReq({
        startTimeUTC,
        packageTitle: "Performance Vertex Overhaul",
        previousHoldId: hold.body.holdId,
        previousHoldToken: hold.body.holdToken,
      }),
      refreshRes
    );
    const moveRes = createRes();
    await holdSlot(
      createReq({
        startTimeUTC: "2025-01-15T08:15:00.000Z",
        packageTitle: "Performance Vertex Overhaul",
        previousHoldId: hold.body.holdId,
        previousHoldToken: hold.body.holdToken,
      }),
      moveRes
    );
    const releaseRes = createRes();
    await releaseHold(
      createReq({
        holdId: hold.body.holdId,
        holdToken: hold.body.holdToken,
      }),
      releaseRes
    );

    expect(refreshRes.statusCode).toBe(409);
    expect(moveRes.statusCode).toBe(409);
    expect(releaseRes.statusCode).toBe(409);
    expect(store.slotHolds).toHaveLength(1);
    expect(store.slotHolds[0]).toMatchObject({
      phase: "payment_pending",
      paymentRecordId: "paymentRecord.session.pending",
    });
  });

  test("reservation expiry releases slot and avoids emails", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);

    const startTimeUTC = "2025-01-15T07:59:00.000Z";
    const first = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(first.res.statusCode).toBe(200);

    nowSpy.mockReturnValue(baseTime + 21 * 60 * 1000);

    const second = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(second.res.statusCode).toBe(200);
    expect(second.body.holdId).toBe(first.body.holdId);
    expect(second.body.holdToken).not.toBe(first.body.holdToken);

    const { res: bookingRes } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "razorpay",
      holdId: first.body.holdId,
      holdToken: first.body.holdToken,
      holdExpiresAt: first.body.expiresAt,
    });

    expect(bookingRes.statusCode).toBe(409);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("reservation -> payment -> confirmation persists booking and emails", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const { res, displayDate, displayTime } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.slotHolds).toHaveLength(1);
    expect(store.slotHolds[0].phase).toBe("consumed");

    const booking = store.bookings[0];
    const utcDate = new Date(startTimeUTC);
    const ownerDate = formatOwnerDate(utcDate);
    const ownerTime = formatOwnerTime(utcDate);

    expect(booking.startTimeUTC).toBe(new Date(startTimeUTC).toISOString());
    expect(booking.displayDate).toBe(displayDate);
    expect(booking.displayTime).toBe(displayTime);
    expect(booking.hostDate).toBe(ownerDate);
    expect(booking.hostTime).toBe(ownerTime);
    expect(booking.localTimeZone).toBe("America/Los_Angeles");
    expect(booking.hostTimeZone).toBe(OWNER_TZ);
    expect(booking.email).toBe(CLIENT_EMAIL);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    const clientCall = mockSendEmail.mock.calls.find(
      ([args]) => args.to === CLIENT_EMAIL
    );
    const ownerCall = mockSendEmail.mock.calls.find(
      ([args]) => args.to === OWNER_EMAIL
    );

    expect(clientCall).toBeTruthy();
    expect(ownerCall).toBeTruthy();
    expect(clientCall[0].attachments).toBeUndefined();
  });

  test("createBooking can defer emails until the success page confirms the flow", async () => {
    const startTimeUTC = "2025-01-15T08:15:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const { res } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
      deferEmailsUntilConfirmation: true,
    });

    expect(res.statusCode).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(res.body.bookingId).toBeTruthy();
    expect(res.body.emailDispatchToken).toBeTruthy();
    expect(res.body.emailDispatch).toMatchObject({
      deferred: true,
      allSent: false,
    });

    const booking = store.bookings.find((entry) => entry._id === res.body.bookingId);
    expect(booking.emailDispatchDeferred).toBe(true);
    expect(booking.emailDispatchStatus).toBe("pending");
    expect(booking.emailDispatchQueuedAt).toBeTruthy();
  });

  test("direct paid bookings backfill a terminal payment record when no record exists yet", async () => {
    const startTimeUTC = "2025-01-15T08:18:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const { res } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
      deferEmailsUntilConfirmation: true,
    });

    expect(res.statusCode).toBe(200);
    expect(store.paymentRecords).toHaveLength(1);
    expect(store.paymentRecords[0]).toMatchObject({
      provider: "paypal",
      status: "email_partial",
      bookingId: res.body.bookingId,
      providerOrderId: "paypal_order_1",
      payerEmail: CLIENT_EMAIL,
      emailDispatchToken: res.body.emailDispatchToken,
    });
    expect(store.paymentRecords[0].bookingPayload).toMatchObject({
      packageTitle: "Performance Vertex Overhaul",
      email: CLIENT_EMAIL,
      paymentProvider: "paypal",
    });
    expect(store.paymentRecords[0].pricingSnapshot.netAmount).toBeCloseTo(84.99, 2);
  });

  test("clubbed coupons reduce the referral base before referral discount and commission", async () => {
    store.referrals.push({
      _id: "ref_creator",
      _type: "referral",
      slug: { current: "creator" },
      currentCommissionPercent: 20,
      currentDiscountPercent: 10,
    });
    store.coupons.push({
      _id: "coupon_five",
      _type: "coupon",
      code: "FIVE",
      discountType: "percent",
      discountPercent: 5,
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
    });

    const startTimeUTC = "2025-01-15T08:22:00.000Z";
    const timeZone = "America/Los_Angeles";
    const utcDate = new Date(startTimeUTC);
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const res = createRes();

    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        packagePrice: "$49.95",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_coupon_referral",
        payerEmail: CLIENT_EMAIL,
        referralCode: "creator",
        couponCode: "FIVE",
        startTimeUTC,
        localTimeZone: timeZone,
        displayDate: formatClientDate(utcDate, timeZone),
        displayTime: formatClientTime(utcDate, timeZone),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      grossAmount: 49.95,
      couponDiscountPercent: 5,
      couponDiscountAmount: 2.5,
      discountAmount: 7.25,
      netAmount: 42.7,
      commissionPercent: 20,
      commissionAmount: 9.49,
    });
  });

  test("rejects targeted coupons for the wrong package", async () => {
    store.coupons.push({
      _id: "coupon_xoc_only",
      _type: "coupon",
      code: "XOCONLY",
      discountType: "fixed",
      discountAmount: 10,
      eligiblePackages: [{ _ref: "pkg_xoc" }],
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
    });

    const startTimeUTC = "2025-01-15T08:24:00.000Z";
    const timeZone = "America/Los_Angeles";
    const utcDate = new Date(startTimeUTC);
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const res = createRes();

    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        packagePrice: "$49.95",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_wrong_package_coupon",
        payerEmail: CLIENT_EMAIL,
        couponCode: "XOCONLY",
        startTimeUTC,
        localTimeZone: timeZone,
        displayDate: formatClientDate(utcDate, timeZone),
        displayTime: formatClientTime(utcDate, timeZone),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "This coupon is not valid for the selected package.",
    });
    expect(store.bookings).toHaveLength(0);
  });

  test("fixed coupons can fully discount the selected package", async () => {
    store.coupons.push({
      _id: "coupon_free_fixed",
      _type: "coupon",
      code: "FIXEDFREE",
      discountType: "fixed",
      discountAmount: 50,
      eligiblePackages: [{ _ref: "pkg_test" }],
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
    });

    const startTimeUTC = "2025-01-15T08:26:00.000Z";
    const timeZone = "America/Los_Angeles";
    const utcDate = new Date(startTimeUTC);
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const res = createRes();

    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        packagePrice: "$49.95",
        status: "captured",
        paymentProvider: "free",
        couponCode: "FIXEDFREE",
        startTimeUTC,
        localTimeZone: timeZone,
        displayDate: formatClientDate(utcDate, timeZone),
        displayTime: formatClientTime(utcDate, timeZone),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      grossAmount: 49.95,
      netAmount: 0,
      couponCode: "FIXEDFREE",
      couponDiscountType: "fixed",
      couponDiscountValue: 50,
      couponDiscountPercent: 100,
      couponDiscountAmount: 49.95,
      commissionAmount: 0,
    });
    expect(store.coupons[0].timesUsed).toBe(1);
  });

  test("rejects non-clubbable coupons when a referral is also present", async () => {
    store.referrals.push({
      _id: "ref_no_club",
      _type: "referral",
      slug: { current: "noclub" },
      currentCommissionPercent: 20,
      currentDiscountPercent: 10,
    });
    store.coupons.push({
      _id: "coupon_no_club",
      _type: "coupon",
      code: "NOCLUB",
      discountType: "percent",
      discountPercent: 5,
      canCombineWithReferral: false,
      isActive: true,
      timesUsed: 0,
    });

    const startTimeUTC = "2025-01-15T08:28:00.000Z";
    const timeZone = "America/Los_Angeles";
    const utcDate = new Date(startTimeUTC);
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const res = createRes();

    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        packagePrice: "$49.95",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_no_club_coupon",
        payerEmail: CLIENT_EMAIL,
        referralCode: "noclub",
        couponCode: "NOCLUB",
        startTimeUTC,
        localTimeZone: timeZone,
        displayDate: formatClientDate(utcDate, timeZone),
        displayTime: formatClientTime(utcDate, timeZone),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "This coupon can't be combined with a referral discount.",
    });
    expect(store.bookings).toHaveLength(0);
  });

  test("sendBookingEmails dispatches deferred emails once and stays idempotent", async () => {
    const startTimeUTC = "2025-01-15T08:20:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const { res: bookingRes } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
      deferEmailsUntilConfirmation: true,
    });

    expect(bookingRes.statusCode).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();

    const firstDispatchRes = createRes();
    await sendBookingEmails(
      createReq({
        bookingId: bookingRes.body.bookingId,
        emailDispatchToken: bookingRes.body.emailDispatchToken,
      }),
      firstDispatchRes
    );

    expect(firstDispatchRes.statusCode).toBe(200);
    expect(firstDispatchRes.body.ok).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const bookingAfterFirstDispatch = store.bookings.find(
      (entry) => entry._id === bookingRes.body.bookingId
    );
    expect(bookingAfterFirstDispatch.emailDispatchClientSentAt).toBeTruthy();
    expect(bookingAfterFirstDispatch.emailDispatchOwnerSentAt).toBeTruthy();
    expect(bookingAfterFirstDispatch.emailDispatchStatus).toBe("sent");

    const secondDispatchRes = createRes();
    await sendBookingEmails(
      createReq({
        bookingId: bookingRes.body.bookingId,
        emailDispatchToken: bookingRes.body.emailDispatchToken,
      }),
      secondDispatchRes
    );

    expect(secondDispatchRes.statusCode).toBe(200);
    expect(secondDispatchRes.body.ok).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  test("sendBookingEmailsForBooking refetches full booking data before rendering", async () => {
    const startTimeUTC = "2025-01-15T08:25:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const { res: bookingRes } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "razorpay",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
      deferEmailsUntilConfirmation: true,
    });

    expect(bookingRes.statusCode).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();

    const booking = store.bookings.find(
      (entry) => entry._id === bookingRes.body.bookingId
    );
    const partialBooking = {
      _id: booking._id,
      email: booking.email,
      packageTitle: booking.packageTitle,
    };

    const result = await sendBookingEmailsForBooking({
      bookingId: booking._id,
      booking: partialBooking,
      client: mockSanityClient,
    });

    expect(result.httpStatus).toBe(200);
    expect(result.body.emailDispatch.allSent).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const ownerCall = mockSendEmail.mock.calls.find(
      ([args]) => args.to === OWNER_EMAIL
    );
    expect(ownerCall).toBeTruthy();
    expect(ownerCall[0].subject).toMatch(
      /^New booking [A-Z0-9]{6} - Performance Vertex Overhaul \(Wed Jan 15 2025 1:55 PM\)$/
    );

    const renderedOwnerEmail = JSON.stringify(ownerCall[0]);
    expect(renderedOwnerEmail).not.toContain("undefined");
    expect(renderedOwnerEmail).toContain("servi");
    expect(renderedOwnerEmail).toContain("GPU/CPU");
    expect(renderedOwnerEmail).toContain("Shooter");
    expect(renderedOwnerEmail).toContain("$84.99");
  });

  test("captured paid bookings auto-reconcile after the original hold expires", async () => {
    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(hold.res.statusCode).toBe(200);

    nowSpy.mockReturnValue(baseTime + 21 * 60 * 1000);

    const { res } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0].slotReservationState).toBe(
      "reconciled_after_expired_hold"
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });

  test("captured paid bookings auto-reconcile when an expired hold was already deleted", async () => {
    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);

    const startTimeUTC = "2025-01-15T09:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(hold.res.statusCode).toBe(200);

    store.slotHolds = [];
    nowSpy.mockReturnValue(baseTime + 21 * 60 * 1000);

    const { res } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0].slotReservationState).toBe(
      "reconciled_after_missing_hold"
    );

    nowSpy.mockRestore();
  });

  test("payment failure releases hold via API and sends no emails", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(store.slotHolds).toHaveLength(1);

    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        status: "captured",
        paymentProvider: "razorpay",
        startTimeUTC,
        localTimeZone: "America/Los_Angeles",
        displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
        displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
        razorpaySignature: "test_signature",
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(store.bookings).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();

    const releaseRes = createRes();
    await releaseHold(
      createReq({ holdId: hold.body.holdId, holdToken: hold.body.holdToken }),
      releaseRes
    );

    expect(releaseRes.statusCode).toBe(200);
    expect(store.slotHolds).toHaveLength(1);
    expect(store.slotHolds[0].phase).toBe("released");
  });

  test("stale hold token cannot release a newly re-acquired slot", async () => {
    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);

    const startTimeUTC = "2025-01-15T07:59:00.000Z";
    const first = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(first.res.statusCode).toBe(200);

    nowSpy.mockReturnValue(baseTime + 21 * 60 * 1000);
    const second = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(second.res.statusCode).toBe(200);
    expect(second.body.holdId).toBe(first.body.holdId);
    expect(second.body.holdToken).not.toBe(first.body.holdToken);

    const staleReleaseRes = createRes();
    await releaseHold(
      createReq({ holdId: first.body.holdId, holdToken: first.body.holdToken }),
      staleReleaseRes
    );

    expect(staleReleaseRes.statusCode).toBe(403);
    expect(store.slotHolds).toHaveLength(1);

    nowSpy.mockRestore();
  });

  test("race conditions prevent double bookings and duplicate emails", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    const first = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(first.res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);

    const duplicate = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(duplicate.res.statusCode).toBe(200);
    expect(duplicate.res.body.idempotent).toBe(true);
    expect(store.bookings).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  test("one provider proof cannot create bookings for two different slots", async () => {
    const firstTime = "2025-01-15T08:00:00.000Z";
    const secondTime = "2025-01-15T09:00:00.000Z";
    const [firstHold, secondHold] = await Promise.all([
      reserveSlot(firstTime, "Performance Vertex Overhaul"),
      reserveSlot(secondTime, "Performance Vertex Overhaul"),
    ]);

    const [first, second] = await Promise.all([
      createPaidBooking({
        startTimeUTC: firstTime,
        timeZone: "America/Los_Angeles",
        paymentProvider: "paypal",
        holdId: firstHold.body.holdId,
        holdToken: firstHold.body.holdToken,
        holdExpiresAt: firstHold.body.expiresAt,
      }),
      createPaidBooking({
        startTimeUTC: secondTime,
        timeZone: "America/Los_Angeles",
        paymentProvider: "paypal",
        holdId: secondHold.body.holdId,
        holdToken: secondHold.body.holdToken,
        holdExpiresAt: secondHold.body.expiresAt,
      }),
    ]);

    expect([first.res.statusCode, second.res.statusCode].sort()).toEqual([200, 202]);
    expect([first.res.body.idempotent, second.res.body.idempotent]).toContain(true);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookingSlots).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  test("atomically enforces the final coupon use across concurrent bookings", async () => {
    store.coupons.push({
      _id: "coupon_last_use",
      _rev: "coupon_last_use_rev",
      _type: "coupon",
      code: "LASTFREE",
      discountType: "percent",
      discountPercent: 100,
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
      activeReservations: 0,
      maxUses: 1,
    });
    const times = [
      "2025-01-15T08:24:00.000Z",
      "2025-01-15T08:26:00.000Z",
    ];
    const holds = await Promise.all(times.map((time) => reserveSlot(time, "Test Package")));
    const submit = (startTimeUTC, hold, suffix) => {
      const utcDate = new Date(startTimeUTC);
      const res = createRes();
      return createBooking(
        createReq({
          email: `client-${suffix}@example.com`,
          packageTitle: "Test Package",
          status: "captured",
          paymentProvider: "free",
          couponCode: "LASTFREE",
          bookingRequestId: `free-${suffix}`,
          startTimeUTC,
          localTimeZone: "America/Los_Angeles",
          displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
          displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
          slotHoldId: hold.body.holdId,
          slotHoldToken: hold.body.holdToken,
        }),
        res
      ).then(() => res);
    };

    const results = await Promise.all([
      submit(times[0], holds[0], "one"),
      submit(times[1], holds[1], "two"),
    ]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(store.bookings).toHaveLength(1);
    expect(store.coupons[0].timesUsed).toBe(1);
    expect(store.coupons[0].activeReservations).toBe(0);
    expect(store.couponRedemptions).toHaveLength(1);
    expect(store.couponRedemptions[0].status).toBe("consumed");
  });

  test("rejects sub-minute and off-calendar hold requests", async () => {
    const subMinute = await reserveSlot(
      "2025-01-15T08:00:30.000Z",
      "Performance Vertex Overhaul"
    );
    const offCalendar = await reserveSlot(
      "2025-01-17T08:00:00.000Z",
      "Performance Vertex Overhaul"
    );

    expect(subMinute.res.statusCode).toBe(400);
    expect(subMinute.body.message).toMatch(/exact configured minute/i);
    expect(offCalendar.res.statusCode).toBe(400);
    expect(offCalendar.body.message).toMatch(/not available/i);
    expect(store.slotHolds).toHaveLength(0);
  });

  test("cancelling a booking releases only its slot lock for rebooking", async () => {
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const created = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
    });

    const transition = await applyBookingStatusTransition({
      client: mockSanityClient,
      bookingId: created.res.body.bookingId,
      status: "canceled",
      source: "test",
    });
    const replacement = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");

    expect(transition.status).toBe("cancelled");
    expect(store.bookings[0].status).toBe("cancelled");
    expect(store.bookingSlots[0].status).toBe("released");
    expect(replacement.res.statusCode).toBe(200);
  });

  test("an active upgrade does not keep its refunded original slot blocked", async () => {
    const startTimeUTC = "2025-01-15T08:25:00.000Z";
    const { buildBookingSlotId } = require("../../src/server/booking/slotIdentity");
    const slotLockId = buildBookingSlotId(startTimeUTC);
    store.bookings.push(
      {
        _id: "booking_original_refunded",
        _rev: "booking_original_refunded_rev",
        _type: "booking",
        status: "refunded",
        startTimeUTC,
        slotLockId,
      },
      {
        _id: "booking_active_upgrade",
        _rev: "booking_active_upgrade_rev",
        _type: "booking",
        status: "captured",
        startTimeUTC,
        originalOrderId: "booking_original_refunded",
      }
    );
    store.bookingSlots.push({
      _id: slotLockId,
      _rev: "slot_lock_stale_rev",
      _type: "bookingSlot",
      bookingId: "booking_original_refunded",
      startTimeUTC,
      status: "active",
    });

    const replacement = await reserveSlot(
      startTimeUTC,
      "Performance Vertex Overhaul"
    );

    expect(replacement.res.statusCode).toBe(200);
    expect(store.bookingSlots[0]).toMatchObject({
      status: "released",
      releaseReason: "booking_status_repair",
    });
  });

  test("a cancelled booking cannot be reactivated over a new checkout hold", async () => {
    const startTimeUTC = "2025-01-15T08:24:00.000Z";
    store.bookings.push({
      _id: "booking_cancelled_with_replacement_hold",
      _rev: "booking_cancelled_with_replacement_hold_rev",
      _type: "booking",
      status: "cancelled",
      startTimeUTC,
    });
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(hold.res.statusCode).toBe(200);

    await expect(
      applyBookingStatusTransition({
        client: mockSanityClient,
        bookingId: "booking_cancelled_with_replacement_hold",
        status: "captured",
        source: "admin-test",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(store.bookings[0].status).toBe("cancelled");
  });

  test("checkout cannot overwrite a hold barrier created by concurrent reactivation", async () => {
    const startTimeUTC = "2025-01-15T08:26:00.000Z";
    const bookingId = "booking_cancelled_during_hold";
    store.bookings.push({
      _id: bookingId,
      _rev: "booking_cancelled_during_hold_rev",
      _type: "booking",
      status: "cancelled",
      startTimeUTC,
    });

    const originalFetch = mockSanityClient.fetch;
    let reactivated = false;
    mockSanityClient.fetch = async (query, params = {}) => {
      const q = String(query || "");
      if (
        !reactivated &&
        q.includes('_type == "slotHold"') &&
        q.includes("_id == $id")
      ) {
        reactivated = true;
        await applyBookingStatusTransition({
          client: mockSanityClient,
          bookingId,
          status: "captured",
          source: "admin-test",
        });
      }
      return originalFetch(query, params);
    };

    let checkout;
    try {
      checkout = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    } finally {
      mockSanityClient.fetch = originalFetch;
    }

    expect(reactivated).toBe(true);
    expect(checkout.res.statusCode).toBe(409);
    expect(store.bookings[0].status).toBe("captured");
    expect(store.bookingSlots).toHaveLength(1);
    expect(store.bookingSlots[0]).toMatchObject({
      bookingId,
      status: "active",
    });
    expect(store.slotHolds).toHaveLength(1);
    expect(store.slotHolds[0]).toMatchObject({
      bookingId,
      phase: "consumed",
    });
  });

  test("full refunds reopen the slot and reverse coupon and referral accounting once", async () => {
    store.referrals.push({
      _id: "ref_refund",
      _rev: "ref_refund_rev",
      _type: "referral",
      slug: { current: "refundref" },
      currentCommissionPercent: 10,
      currentDiscountPercent: 5,
      successfulReferrals: 0,
    });
    store.coupons.push({
      _id: "coupon_refund",
      _rev: "coupon_refund_rev",
      _type: "coupon",
      code: "REFUND10",
      discountType: "percent",
      discountPercent: 10,
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
      activeReservations: 0,
      maxUses: 1,
    });
    const startTimeUTC = "2025-01-15T08:22:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        status: "captured",
        paymentProvider: "paypal",
        paypalOrderId: "paypal_refund_booking",
        referralCode: "refundref",
        couponCode: "REFUND10",
        startTimeUTC,
        localTimeZone: "America/Los_Angeles",
        displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
        displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
      }),
      res
    );
    const first = await applyBookingRefund({
      client: mockSanityClient,
      paymentRecord: { bookingId: res.body.bookingId },
      refund: { id: "refund_1", full: true, amount: 42.7 },
    });
    const second = await applyBookingRefund({
      client: mockSanityClient,
      paymentRecord: { bookingId: res.body.bookingId },
      refund: { id: "refund_1", full: true, amount: 42.7 },
    });
    const latePartial = await applyBookingRefund({
      client: mockSanityClient,
      paymentRecord: { bookingId: res.body.bookingId },
      refund: { id: "refund_partial_late", type: "partial", amount: 1 },
    });

    expect(first).toMatchObject({
      reopenedSlot: true,
      couponRestored: true,
      referralReversed: true,
      idempotent: false,
    });
    expect(second.idempotent).toBe(true);
    expect(latePartial.idempotent).toBe(true);
    expect(store.bookings[0].status).toBe("refunded");
    expect(store.bookings[0].refundStatus).toBe("full");
    expect(store.bookingSlots[0].status).toBe("released");
    expect(store.coupons[0].timesUsed).toBe(0);
    expect(store.coupons[0].isActive).toBe(true);
    expect(store.referrals[0].successfulReferrals).toBe(0);
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
      startTimeUTC: "2025-01-15T08:26:00.000Z",
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
      startTimeUTC: "2025-01-15T08:26:00.000Z",
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
      startTimeUTC: "2025-01-15T08:26:00.000Z",
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

  test("refund restores coupon capacity without undoing a later manual disable", async () => {
    store.coupons.push({
      _id: "coupon_manual_disable",
      _rev: "coupon_manual_disable_rev",
      _type: "coupon",
      code: "MANUALOFF",
      discountType: "percent",
      discountPercent: 100,
      canCombineWithReferral: false,
      isActive: true,
      timesUsed: 0,
      activeReservations: 0,
      maxUses: 1,
    });
    const startTimeUTC = "2025-01-15T08:28:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      createReq({
        email: CLIENT_EMAIL,
        packageTitle: "Test Package",
        status: "captured",
        paymentProvider: "free",
        couponCode: "MANUALOFF",
        bookingRequestId: "manual-disable-refund",
        startTimeUTC,
        localTimeZone: "America/Los_Angeles",
        displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
        displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
      }),
      res
    );
    const coupon = store.coupons[0];
    coupon.isActive = false;
    coupon._updatedAt = new Date(
      new Date(coupon.autoDeactivatedAt).getTime() + 60 * 1000
    ).toISOString();

    await applyBookingRefund({
      client: mockSanityClient,
      paymentRecord: { bookingId: res.body.bookingId },
      refund: { id: "refund_manual_disable", full: true },
    });

    expect(coupon.timesUsed).toBe(0);
    expect(coupon.isActive).toBe(false);
  });

  test("concurrent email dispatch uses one lease and stable Resend keys", async () => {
    const startTimeUTC = "2025-01-15T08:20:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const created = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "paypal",
      holdId: hold.body.holdId,
      holdToken: hold.body.holdToken,
      deferEmailsUntilConfirmation: true,
    });

    const [first, second] = await Promise.all([
      sendBookingEmailsForBooking({
        bookingId: created.res.body.bookingId,
        client: mockSanityClient,
      }),
      sendBookingEmailsForBooking({
        bookingId: created.res.body.bookingId,
        client: mockSanityClient,
      }),
    ]);

    expect([first.httpStatus, second.httpStatus].sort()).toEqual([200, 202]);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmail.mock.calls[0][1].idempotencyKey).toMatch(/-client$/);
    expect(mockSendEmail.mock.calls[1][1].idempotencyKey).toMatch(/-owner$/);
  });

  test("reschedule recovery notifies both sides once with stable keys", async () => {
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
      originalRequestedStartTimeUTC: "2025-01-15T08:00:00.000Z",
      localTimeZone: "America/Los_Angeles",
      displayDate: "Wednesday, January 15, 2025",
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
    expect(clientEmail.subject).toBe(
      "We need to reschedule your Roo Industries booking"
    );
    expect(clientEmail.html).toContain("We need to reschedule your booking");
    expect(clientEmail.html).toContain("Wednesday, January 15, 2025");
    expect(clientEmail.html).toContain("12:00 AM");
    expect(clientEmail.html).toContain(
      "Pacific Standard Time (America/Los_Angeles)"
    );
    expect(clientEmail.html).not.toContain("2025-01-15T08:00:00.000Z");
    expect(store.bookings[0].recoveryNotificationStatus).toBe("sent");
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
        value: "India Standard Time (Asia/Kolkata)",
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
        startTimeUTC: "2025-01-15T08:00:00.000Z",
        localTimeZone: "America/Los_Angeles",
        displayDate: "Wednesday, January 15, 2025",
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
      displayDate: "Wednesday, January 15, 2025",
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
        startTimeUTC: "2025-01-15T08:00:00.000Z",
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
      releasedAt: "2025-01-15T08:20:00.000Z",
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
      startTimeUTC: "2025-01-15T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
      paymentProvider: "razorpay",
    });

    expect(res.statusCode).toBe(409);
    expect(store.bookings).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  test("upgrade booking backfills original booking details without leaking them from the client", async () => {
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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
      error: "Upgrade details do not match the original booking.",
    });
    expect(store.bookings).toHaveLength(1);
  });

  test("upgrade pricing uses cumulative paid amount across prior paid upgrades", async () => {
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "This order already matches the target package.",
    });
  });

  test("rejects Razorpay payments that are not captured upstream", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_123";
    process.env.RAZORPAY_KEY_SECRET = "rzp_secret";

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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

  test("internal Razorpay webhook recovery can book without client signature", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_123";
    process.env.RAZORPAY_KEY_SECRET = "rzp_secret";

    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);
    const startTimeUTC = "2025-01-15T10:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(hold.res.statusCode).toBe(200);

    store.slotHolds = [];
    nowSpy.mockReturnValue(baseTime + 21 * 60 * 1000);

    const paymentRecordId =
      "paymentRecord.razorpay.order.razorpay_order_webhook";
    const claimId = "paymentProofClaim.razorpay.razorpay_payment_webhook";
    const leaseId = "lease_razorpay_webhook";
    store.paymentRecords.push({
      _id: paymentRecordId,
      _rev: "payment_record_webhook_rev",
      _type: "paymentRecord",
      provider: "razorpay",
      providerOrderId: "razorpay_order_webhook",
      providerPaymentId: "razorpay_payment_webhook",
      status: "finalizing",
      paymentProofClaimId: claimId,
      finalizationLeaseId: leaseId,
      finalizationLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      pricingSnapshot: { grossAmount: 84.99, netAmount: 84.99 },
    });
    store.paymentProofClaims.push({
      _id: claimId,
      _rev: "payment_claim_webhook_rev",
      _type: "paymentProofClaim",
      paymentRecordId,
      provider: "razorpay",
      providerOrderId: "razorpay_order_webhook",
      providerPaymentId: "razorpay_payment_webhook",
    });

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        order_id: "razorpay_order_webhook",
        currency: "USD",
        amount: 8499,
        status: "captured",
      }),
    }));

    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      {
        ...createReq({
          discord: "webhook-user",
          email: CLIENT_EMAIL,
          specs: "Webhook recovery PC",
          mainGame: "Payment QA",
          packageTitle: "Performance Vertex Overhaul",
          packagePrice: "$84.99",
          status: "captured",
          paymentProvider: "razorpay",
          paymentRecordId,
          razorpayOrderId: "razorpay_order_webhook",
          razorpayPaymentId: "razorpay_payment_webhook",
          localTimeZone: "America/Los_Angeles",
          startTimeUTC,
          displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
          displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
          slotHoldId: hold.body.holdId,
          slotHoldToken: hold.body.holdToken,
          slotHoldExpiresAt: hold.body.expiresAt,
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
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      paymentProvider: "razorpay",
      razorpayOrderId: "razorpay_order_webhook",
      razorpayPaymentId: "razorpay_payment_webhook",
      slotReservationState: "reconciled_after_missing_hold",
    });

    nowSpy.mockRestore();
  });

  test("atomically consumes the internal proof claim and finalization lease", async () => {
    const startTimeUTC = "2025-01-15T10:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const paymentRecordId = "paymentRecord.paypal.order.internal_order";
    const claimId = "paymentProofClaim.paypal.internal_order";
    const leaseId = "lease_internal_order";
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
      pricingSnapshot: { grossAmount: 84.99, netAmount: 84.99 },
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
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      packagePrice: "$84.99",
      grossAmount: 84.99,
      netAmount: 84.99,
    });
  });

  test("internal reconstruction preserves completed email delivery without resending", async () => {
    const startTimeUTC = "2025-01-15T10:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    const paymentRecordId = "paymentRecord.paypal.order.email_reconstruction";
    const claimId = "paymentProofClaim.paypal.email_reconstruction";
    const leaseId = "lease_email_reconstruction";
    const completedAt = "2025-01-15T10:05:00.000Z";
    store.referrals.push({
      _id: "ref_historical_reconstruction",
      _type: "referral",
      successfulReferrals: 4,
    });
    store.paymentRecords.push({
      _id: paymentRecordId,
      _rev: "payment_record_email_reconstruction_rev",
      _type: "paymentRecord",
      provider: "paypal",
      providerOrderId: "email_reconstruction",
      status: "finalizing",
      paymentProofClaimId: claimId,
      finalizationLeaseId: leaseId,
      finalizationLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      pricingSnapshot: {
        grossAmount: 84.99,
        netAmount: 84.99,
        couponDiscountAmount: 0,
        couponDiscountPercent: 0,
        effectiveReferralId: "ref_historical_reconstruction",
      },
    });
    store.paymentProofClaims.push({
      _id: claimId,
      _rev: "proof_claim_email_reconstruction_rev",
      _type: "paymentProofClaim",
      paymentRecordId,
      provider: "paypal",
      providerOrderId: "email_reconstruction",
      providerPaymentId: "",
    });
    const utcDate = new Date(startTimeUTC);
    const res = createRes();

    await createBooking(
      {
        ...createReq({
          email: CLIENT_EMAIL,
          packageTitle: "Performance Vertex Overhaul",
          status: "captured",
          paymentProvider: "paypal",
          paypalOrderId: "email_reconstruction",
          paymentRecordId,
          couponCode: "HISTORICAL",
          startTimeUTC,
          localTimeZone: "America/Los_Angeles",
          displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
          displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
          slotHoldId: hold.body.holdId,
          slotHoldToken: hold.body.holdToken,
          deferEmailsUntilConfirmation: false,
        }),
        internalContext: {
          paymentFinalizeSource: "reconcile",
          paymentProofClaimId: claimId,
          paymentFinalizationLeaseId: leaseId,
          emailDispatchAlreadyComplete: true,
          emailDispatchCompletedAt: completedAt,
          preserveHistoricalAccounting: true,
        },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.bookings[0]).toMatchObject({
      emailDispatchStatus: "sent",
      emailDispatchClientSentAt: completedAt,
      emailDispatchOwnerSentAt: completedAt,
    });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(store.couponRedemptions).toHaveLength(0);
    expect(store.referrals[0].successfulReferrals).toBe(4);
    expect(store.paymentRecords[0]).toMatchObject({
      status: "booked",
      bookingId: res.body.bookingId,
    });
  });

  test("free internal finalization atomically commits its prepared proof claim", async () => {
    store.coupons.push({
      _id: "coupon_internal_free",
      _rev: "coupon_internal_free_rev",
      _type: "coupon",
      code: "INTERNALFREE",
      discountType: "percent",
      discountPercent: 100,
      canCombineWithReferral: true,
      isActive: true,
      timesUsed: 0,
      activeReservations: 0,
      maxUses: 5,
    });
    const startTimeUTC = "2025-01-15T08:28:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Test Package");
    const paymentRecordId = "paymentRecord.free.internal_free";
    const paymentProofClaimId = "paymentProofClaim.free.internal_free";
    const leaseId = "lease_internal_free";
    store.paymentRecords.push({
      _id: paymentRecordId,
      _rev: "payment_record_free_rev",
      _type: "paymentRecord",
      provider: "free",
      status: "finalizing",
      paymentProofClaimId,
      finalizationLeaseId: leaseId,
      finalizationLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      pricingSnapshot: {
        grossAmount: 49.95,
        netAmount: 0,
        discountAmount: 49.95,
        discountPercent: 100,
        couponDiscountAmount: 49.95,
        couponDiscountPercent: 100,
        couponDiscountType: "percent",
        couponDiscountValue: 100,
      },
    });
    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      {
        ...createReq({
          email: CLIENT_EMAIL,
          packageTitle: "Test Package",
          status: "captured",
          paymentProvider: "free",
          paymentRecordId,
          couponCode: "INTERNALFREE",
          startTimeUTC,
          localTimeZone: "America/Los_Angeles",
          displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
          displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
          slotHoldId: hold.body.holdId,
          slotHoldToken: hold.body.holdToken,
          deferEmailsUntilConfirmation: true,
        }),
        internalContext: {
          paymentFinalizeSource: "reconcile",
          paymentProofClaimId,
          paymentProofClaim: {
            _id: paymentProofClaimId,
            _type: "paymentProofClaim",
            paymentRecordId,
            provider: "free",
            providerOrderId: "",
            providerPaymentId: "",
          },
          paymentFinalizationLeaseId: leaseId,
        },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.paymentRecords[0].bookingId).toBe(res.body.bookingId);
    expect(store.paymentProofClaims).toHaveLength(1);
    expect(store.paymentProofClaims[0]).toMatchObject({
      paymentRecordId,
      bookingId: res.body.bookingId,
      status: "claimed",
    });
    expect(store.couponRedemptions[0].status).toBe("consumed");
  });

  test("public Razorpay createBooking still requires client signature", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_123";
    process.env.RAZORPAY_KEY_SECRET = "rzp_secret";

    const startTimeUTC = "2025-01-15T11:00:00.000Z";
    const hold = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(hold.res.statusCode).toBe(200);

    const utcDate = new Date(startTimeUTC);
    const res = createRes();
    await createBooking(
      createReq({
        discord: "public-user",
        email: CLIENT_EMAIL,
        specs: "Public payment PC",
        mainGame: "Payment QA",
        packageTitle: "Performance Vertex Overhaul",
        packagePrice: "$84.99",
        status: "captured",
        paymentProvider: "razorpay",
        paymentRecordId: "paymentRecord.razorpay.order.razorpay_order_public",
        razorpayOrderId: "razorpay_order_public",
        razorpayPaymentId: "razorpay_payment_public",
        localTimeZone: "America/Los_Angeles",
        startTimeUTC,
        displayDate: formatClientDate(utcDate, "America/Los_Angeles"),
        displayTime: formatClientTime(utcDate, "America/Los_Angeles"),
        slotHoldId: hold.body.holdId,
        slotHoldToken: hold.body.holdToken,
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Missing payment verification fields." });
  });

  test("rejects PayPal payments with the wrong captured currency", async () => {
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";

    const startTimeUTC = "2025-01-15T08:00:00.000Z";
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
      createReq({
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

  test("rate limits repeated hold requests", async () => {
    const startTimeUTC = "2025-01-15T08:00:00.000Z";
    let lastResponse = null;

    for (let index = 0; index < 21; index += 1) {
      lastResponse = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    }

    expect(lastResponse.res.statusCode).toBe(429);
    expect(lastResponse.body).toEqual({
      ok: false,
      error: "Too many slot hold requests. Please try again later.",
    });
  });
});

describe("email time zone separation and midnight handling", () => {
  test.each([
    {
      label: "client 11:59 PM",
      startTimeUTC: "2025-01-15T07:59:00.000Z",
      timeZone: "America/Los_Angeles",
    },
    {
      label: "client 12:00 AM",
      startTimeUTC: "2025-01-15T08:00:00.000Z",
      timeZone: "America/Los_Angeles",
    },
    {
      label: "owner crosses midnight",
      startTimeUTC: "2025-01-15T18:30:00.000Z",
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
