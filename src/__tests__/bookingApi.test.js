let holdSlot;
let createBooking;
let releaseHold;

const CLIENT_EMAIL = "vihaann2.0@gmail.com";
const OWNER_EMAIL = "serviroo@rooindustries.com";
const OWNER_TZ = "Asia/Kolkata";

const mockSendEmail = jest.fn().mockResolvedValue({ error: null });

let store;
let idCounter = 1;

const resetStore = () => {
  store = {
    bookings: [],
    slotHolds: [],
    coupons: [],
    referrals: [],
    bookingSettings: { ownerEmail: OWNER_EMAIL },
  };
  idCounter = 1;
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

const createReq = (body = {}, method = "POST") => ({ method, body });

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
    store.slotHolds,
    store.coupons,
    store.referrals,
  ];
  for (const collection of collections) {
    const found = collection.find((doc) => doc._id === id);
    if (found) return found;
  }
  return null;
};

const mockSanityClient = {
  fetch: async (query, params = {}) => {
    const q = String(query || "");
    if (q.includes('_type == "bookingSettings"')) {
      return store.bookingSettings;
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
    if (q.includes('_type == "coupon"') && q.includes("lower(code)")) {
      return (
        store.coupons.find(
          (c) =>
            String(c.code || "").toLowerCase() ===
            String(params.code || "").toLowerCase()
        ) || null
      );
    }
    return null;
  },
  create: async (doc) => {
    const next = { ...doc };
    if (!next._id) {
      next._id = `doc_${idCounter++}`;
    }
    if (next._type === "slotHold") {
      store.slotHolds.push(next);
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
    return next;
  },
  delete: async (id) => {
    const removeFrom = (list) => {
      const index = list.findIndex((doc) => doc._id === id);
      if (index >= 0) list.splice(index, 1);
    };
    removeFrom(store.slotHolds);
    removeFrom(store.bookings);
    removeFrom(store.coupons);
    removeFrom(store.referrals);
    return { _id: id };
  },
  patch: (id) => {
    const ops = { setIfMissing: null, set: null, inc: null };
    const patchApi = {
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
      async commit() {
        const doc = findById(id);
        if (!doc) return null;
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
        return doc;
      },
    };
    return patchApi;
  },
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
  holdExpiresAt,
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
    slotHoldExpiresAt: holdExpiresAt || null,
  };

  if (paymentProvider === "paypal") {
    payload.paypalOrderId = "paypal_order_1";
    payload.payerEmail = CLIENT_EMAIL;
  }

  if (paymentProvider === "razorpay") {
    payload.razorpayOrderId = "razorpay_order_1";
    payload.razorpayPaymentId = "razorpay_payment_1";
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
  const load = (path) => {
    const mod = require(path);
    return mod && mod.default ? mod.default : mod;
  };
  holdSlot = load("../../api/holdSlot");
  createBooking = load("../../api/ref/createBooking");
  releaseHold = load("../../api/releaseHold");
});

beforeEach(() => {
  resetStore();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ error: null });
  process.env.OWNER_EMAIL = OWNER_EMAIL;
});

afterEach(() => {
  jest.restoreAllMocks();
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

  test("reservation expiry releases slot and avoids emails", async () => {
    expect(CLIENT_EMAIL).toBe("vihaann2.0@gmail.com");
    expect(OWNER_EMAIL).toBe("serviroo@rooindustries.com");

    const baseTime = new Date("2025-01-01T00:00:00.000Z").getTime();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(baseTime);

    const startTimeUTC = "2025-01-15T07:59:00.000Z";
    const first = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(first.res.statusCode).toBe(200);

    nowSpy.mockReturnValue(baseTime + 16 * 60 * 1000);

    const second = await reserveSlot(startTimeUTC, "Performance Vertex Overhaul");
    expect(second.res.statusCode).toBe(200);
    expect(second.body.holdId).not.toBe(first.body.holdId);

    const { res: bookingRes } = await createPaidBooking({
      startTimeUTC,
      timeZone: "America/Los_Angeles",
      paymentProvider: "razorpay",
      holdId: first.body.holdId,
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
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(res.statusCode).toBe(200);
    expect(store.bookings).toHaveLength(1);
    expect(store.slotHolds).toHaveLength(0);

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
        slotHoldExpiresAt: hold.body.expiresAt,
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(store.bookings).toHaveLength(0);
    expect(mockSendEmail).not.toHaveBeenCalled();

    const releaseRes = createRes();
    await releaseHold(
      createReq({ holdId: hold.body.holdId }),
      releaseRes
    );

    expect(releaseRes.statusCode).toBe(200);
    expect(store.slotHolds).toHaveLength(0);
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
      holdExpiresAt: hold.body.expiresAt,
    });

    expect(duplicate.res.statusCode).toBe(409);
    expect(store.bookings).toHaveLength(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
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
