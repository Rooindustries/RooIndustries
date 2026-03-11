import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@sanity/client";
import { formatHostDateLabel } from "../src/utils/timezone.js";

dotenv.config({ path: ".env.local" });

const { default: createOrderHandler } =
  await import("../src/server/api/razorpay/createOrder.js");
const verifyModule = await import("../src/server/api/razorpay/verify.js");
const verifyHandler = verifyModule.default || verifyModule;
const { default: holdSlotHandler } =
  await import("../src/server/booking/holdSlot.js");
const { default: createBookingHandler } =
  await import("../src/server/api/ref/createBooking.js");

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const runId = `booking-test-${Date.now()}`;
const userEmail = process.env.TEST_USER_EMAIL || "nerky@rooindustries.com";
const packageTitle = "Test Package";
const packagePrice = "$100.00";
const testCouponCode = process.env.TEST_COUPON_CODE || "";
const testReferralCode = process.env.TEST_REFERRAL_CODE || "";

const created = {
  bookings: [],
  holds: [],
  coupons: [],
};

const results = [];

const record = (name, ok, details) => {
  results.push({ name, ok, details });
  const status = ok ? "PASS" : "FAIL";
  console.log(`${status} - ${name}${details ? `: ${details}` : ""}`);
};

const makeResponse = () => {
  const capture = { status: 200, body: null, headers: {} };
  return {
    capture,
    res: {
      status(code) {
        capture.status = code;
        return this;
      },
      setHeader(name, value) {
        capture.headers[name] = value;
        return this;
      },
      json(data) {
        capture.body = data;
        return data;
      },
    },
  };
};

const callHandler = async (handler, payload, options = {}) => {
  const req = {
    method: options.method || "POST",
    body: payload,
    headers: options.headers || {},
    query: options.query || {},
  };
  const { capture, res } = makeResponse();
  await handler(req, res);
  return capture;
};

const addDays = (dayOffset) => new Date(2099, 0, 10 + dayOffset);
const formatHostTime = (hour24) => {
  const ampm = hour24 >= 12 ? "PM" : "AM";
  const hour = ((hour24 + 11) % 12) + 1;
  return `${hour}:00 ${ampm}`;
};

const makeSlot = (dayOffset, hour24) => {
  const hostDate = addDays(dayOffset).toDateString();
  const hostTime = formatHostTime(hour24);
  const startTimeUTC = new Date(
    Date.UTC(2099, 0, 10 + dayOffset, hour24, 0, 0),
  ).toISOString();
  return { hostDate, hostTime, startTimeUTC };
};

const makeCustomSlot = (year, monthIndex, dayOfMonth, hour24) => {
  const date = new Date(year, monthIndex, dayOfMonth);
  const hostDate = date.toDateString();
  const hostTime = formatHostTime(hour24);
  const startTimeUTC = new Date(
    Date.UTC(year, monthIndex, dayOfMonth, hour24, 0, 0),
  ).toISOString();
  return { hostDate, hostTime, startTimeUTC };
};

const reserveHold = async (slot, packageOverride = packageTitle) => {
  const response = await callHandler(holdSlotHandler, {
    startTimeUTC: slot.startTimeUTC,
    packageTitle: packageOverride,
  });

  if (response.status !== 200 || !response.body?.holdId || !response.body?.holdToken) {
    throw new Error(
      `hold reservation failed for ${slot.startTimeUTC}: ${JSON.stringify(response.body)}`
    );
  }

  if (!created.holds.includes(response.body.holdId)) {
    created.holds.push(response.body.holdId);
  }

  return response.body;
};

const createCoupon = async (code, discountPercent, maxUses = 1) => {
  const doc = await client.create({
    _type: "coupon",
    title: `Test Coupon ${code}`,
    code,
    discountPercent,
    isActive: true,
    canCombineWithReferral: false,
    maxUses,
    timesUsed: 0,
  });
  created.coupons.push(doc._id);
  return doc;
};

const basePayload = (slot) => ({
  date: slot.hostDate,
  time: slot.hostTime,
  hostDate: slot.hostDate,
  hostTime: slot.hostTime,
  hostTimeZone: "Asia/Kolkata",
  localTimeZone: "UTC",
  displayDate: slot.hostDate,
  displayTime: slot.hostTime,
  localTimeLabel: slot.hostTime,
  startTimeUTC: slot.startTimeUTC,
  discord: "test-user",
  email: userEmail,
  specs: "Test build",
  mainGame: "Test Game",
  message: `Automated booking test (${runId})`,
  packageTitle,
  packagePrice,
});

const paidPayload = (slot, overrides = {}) => ({
  ...basePayload(slot),
  status: "captured",
  paymentProvider: "paypal",
  paypalOrderId: `TEST_ORDER_${Date.now()}`,
  payerEmail: userEmail,
  grossAmount: 100,
  netAmount: 100,
  discountPercent: 0,
  discountAmount: 0,
  commissionPercent: 0,
  ...(testCouponCode ? { couponCode: testCouponCode } : {}),
  ...(testReferralCode ? { referralCode: testReferralCode } : {}),
  ...overrides,
});

const freePayload = (slot, overrides = {}) => ({
  ...basePayload(slot),
  status: "captured",
  paymentProvider: "free",
  couponDiscountPercent: 100,
  couponDiscountAmount: 100,
  grossAmount: 100,
  netAmount: 0,
  discountPercent: 100,
  discountAmount: 100,
  commissionPercent: 0,
  ...overrides,
});

const cleanup = async () => {
  const deleteIds = [...created.bookings, ...created.holds, ...created.coupons];
  await Promise.all(deleteIds.map((id) => client.delete(id).catch(() => {})));
};

const checkBookingSettingsOwner = async () => {
  const settings = await client.fetch(
    `*[_type == "bookingSettings"][0]{ ownerEmail }`,
  );
  if (settings?.ownerEmail) {
    record("owner_email_configured", true, settings.ownerEmail);
  } else {
    record("owner_email_configured", false, "ownerEmail missing in Sanity");
  }
};

const testRazorpay = async () => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      record("razorpay_keys", false, "missing RAZORPAY_KEY_ID/SECRET");
      return;
    }

    const createRes = makeResponse();
    await createOrderHandler(
      {
        method: "POST",
        body: { amount: 1, currency: "USD", notes: { runId, packageTitle } },
        headers: {},
      },
      createRes.res,
    );
    const createOk =
      createRes.capture.status === 200 && createRes.capture.body?.ok;
    record(
      "razorpay_create_order",
      createOk,
      createRes.capture.body?.orderId || JSON.stringify(createRes.capture.body),
    );

    const orderId = "order_test_" + Date.now();
    const paymentId = "pay_test_" + Date.now();
    const signature = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const verifyRes = makeResponse();
    await verifyHandler(
      {
        method: "POST",
        body: {
          razorpay_order_id: orderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: signature,
        },
      },
      verifyRes.res,
    );
    const verifyOk =
      verifyRes.capture.status === 200 && verifyRes.capture.body?.ok;
    record(
      "razorpay_verify_signature",
      verifyOk,
      JSON.stringify(verifyRes.capture.body),
    );
  } catch (err) {
    record("razorpay_exception", false, err?.message || String(err));
  }
};

const testPayPal = async () => {
  try {
    const clientId = process.env.REACT_APP_PAYPAL_CLIENT_ID;
    const clientSecret = process.env.REACT_APP_PAYPAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      record("paypal_credentials", false, "missing PAYPAL client id/secret");
      return;
    }

    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );
    const bases = [
      "https://api-m.sandbox.paypal.com",
      "https://api-m.paypal.com",
    ];

    let token = null;
    let baseUsed = null;
    let lastStatus = null;

    for (const base of bases) {
      const res = await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      });

      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        token = data.access_token;
        baseUsed = base;
        break;
      }

      if (res.status !== 401) {
        break;
      }
    }

    if (!token || !baseUsed) {
      record("paypal_oauth", false, `status ${lastStatus || "unknown"}`);
      return;
    }

    record("paypal_oauth", true, baseUsed);

    const orderRes = await fetch(`${baseUsed}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: "USD",
              value: "1.00",
            },
            description: `Booking test ${runId}`,
          },
        ],
      }),
    });

    if (!orderRes.ok) {
      record("paypal_create_order", false, `status ${orderRes.status}`);
      return;
    }

    const orderData = await orderRes.json();
    record("paypal_create_order", true, orderData.id || "no order id");
  } catch (err) {
    record("paypal_exception", false, err?.message || String(err));
  }
};

const testBookingFlow = async () => {
  await checkBookingSettingsOwner();

  const couponSuffix = String(Date.now()).slice(-6);
  const freeCouponCode = `TESTFREE${couponSuffix}`;
  const holdCouponCode = `TESTHOLD${couponSuffix}`;
  const invalidCouponCode = `TESTHALF${couponSuffix}`;

  const freeCoupon = await createCoupon(freeCouponCode, 100);
  const holdCoupon = await createCoupon(holdCouponCode, 100, 5);
  const invalidCoupon = await createCoupon(invalidCouponCode, 50);

  const paidSlot = makeSlot(0, 10);
  const paidHold = await reserveHold(paidSlot);

  const paidRes = await callHandler(createBookingHandler, {
    ...paidPayload(paidSlot, {
      slotHoldId: paidHold.holdId,
      slotHoldToken: paidHold.holdToken,
    }),
  });
  if (paidRes.status === 200 && paidRes.body?.bookingId) {
    created.bookings.push(paidRes.body.bookingId);
    record("paid_booking_success", true, paidRes.body.bookingId);
  } else {
    record("paid_booking_success", false, JSON.stringify(paidRes.body));
  }

  const paidHoldCleanup = await client.fetch(
    `*[_type == "slotHold" && hostDate == $date && hostTime == $time][0]`,
    { date: paidSlot.hostDate, time: paidSlot.hostTime },
  );
  record(
    "paid_hold_cleanup",
    !paidHoldCleanup,
    paidHoldCleanup ? "hold still exists" : "",
  );

  const freeSlot = makeSlot(1, 11);
  const freeHold = await reserveHold(freeSlot);

  const freeRes = await callHandler(createBookingHandler, {
    ...freePayload(freeSlot, {
      slotHoldId: freeHold.holdId,
      slotHoldToken: freeHold.holdToken,
      couponCode: freeCoupon.code,
    }),
  });
  if (freeRes.status === 200 && freeRes.body?.bookingId) {
    created.bookings.push(freeRes.body.bookingId);
    record("free_booking_success", true, freeRes.body.bookingId);
  } else {
    record("free_booking_success", false, JSON.stringify(freeRes.body));
  }

  const freeCouponCheck = await client.fetch(
    `*[_type == "coupon" && _id == $id][0]{ timesUsed, isActive }`,
    { id: freeCoupon._id },
  );
  record(
    "free_coupon_usage",
    freeCouponCheck?.timesUsed === 1,
    JSON.stringify(freeCouponCheck),
  );

  const missingProvider = await callHandler(createBookingHandler, {
    ...basePayload(makeSlot(2, 12)),
  });
  record("missing_payment_provider", missingProvider.status === 400);

  const paidMissingProof = await callHandler(createBookingHandler, {
    ...paidPayload(makeSlot(3, 13), { paypalOrderId: "" }),
  });
  record("paid_missing_proof", paidMissingProof.status === 400);

  const freeMissingCoupon = await callHandler(createBookingHandler, {
    ...freePayload(makeSlot(4, 14)),
  });
  record("free_missing_coupon", freeMissingCoupon.status === 400);

  const freeBadCoupon = await callHandler(createBookingHandler, {
    ...freePayload(makeSlot(5, 15), {
      couponCode: invalidCoupon.code,
      couponDiscountPercent: 50,
      couponDiscountAmount: 50,
      discountPercent: 50,
      discountAmount: 50,
      netAmount: 50,
    }),
  });
  record("free_coupon_not_100", freeBadCoupon.status === 400);

  const mismatchSlot = makeSlot(6, 16);
  const mismatchHold = await reserveHold(makeSlot(6, 17));
  const mismatchRes = await callHandler(createBookingHandler, {
    ...paidPayload(mismatchSlot, {
      slotHoldId: mismatchHold.holdId,
      slotHoldToken: mismatchHold.holdToken,
    }),
  });
  record("slot_hold_mismatch", mismatchRes.status === 400);

  const activeHoldSlot = makeSlot(7, 17);
  await reserveHold(activeHoldSlot);
  const activeHoldRes = await callHandler(createBookingHandler, {
    ...freePayload(activeHoldSlot, { couponCode: holdCoupon.code }),
  });
  record("active_hold_without_id", activeHoldRes.status === 409);

  const expiredSlot = makeSlot(8, 18);
  const expiredHold = await reserveHold(expiredSlot);
  await client
    .patch(expiredHold.holdId)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000).toISOString() })
    .commit();
  const freeExpiredRes = await callHandler(createBookingHandler, {
    ...freePayload(expiredSlot, {
      slotHoldId: expiredHold.holdId,
      slotHoldToken: expiredHold.holdToken,
      couponCode: holdCoupon.code,
    }),
  });
  record("free_expired_hold", freeExpiredRes.status === 409);

  const paidExpiredSlot = makeSlot(9, 19);
  const paidExpiredHold = await reserveHold(paidExpiredSlot);
  await client
    .patch(paidExpiredHold.holdId)
    .set({ expiresAt: new Date(Date.now() - 60 * 1000).toISOString() })
    .commit();
  const originalResendKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "";
  const paidExpiredRes = await callHandler(createBookingHandler, {
    ...paidPayload(paidExpiredSlot, {
      slotHoldId: paidExpiredHold.holdId,
      slotHoldToken: paidExpiredHold.holdToken,
    }),
  });
  process.env.RESEND_API_KEY = originalResendKey;
  if (paidExpiredRes.status === 200 && paidExpiredRes.body?.bookingId) {
    created.bookings.push(paidExpiredRes.body.bookingId);
    record("paid_expired_hold_reconciled", true, paidExpiredRes.body.bookingId);
  } else {
    record(
      "paid_expired_hold_reconciled",
      false,
      JSON.stringify(paidExpiredRes.body),
    );
  }

  const duplicateSlot = makeSlot(10, 20);
  const existingBooking = await client.create({
    _type: "booking",
    date: duplicateSlot.hostDate,
    time: duplicateSlot.hostTime,
    hostDate: duplicateSlot.hostDate,
    hostTime: duplicateSlot.hostTime,
    status: "captured",
    paymentProvider: "paypal",
    email: userEmail,
    packageTitle,
    packagePrice,
  });
  created.bookings.push(existingBooking._id);
  const duplicateRes = await callHandler(createBookingHandler, {
    ...paidPayload(duplicateSlot),
  });
  record("duplicate_booking", duplicateRes.status === 409);

  const unsupportedRes = await callHandler(createBookingHandler, {
    ...paidPayload(makeSlot(11, 21), { paymentProvider: "stripe" }),
  });
  record("unsupported_payment_provider", unsupportedRes.status === 400);

  const singleDigitSlot = makeCustomSlot(2099, 0, 5, 9);
  const singleDigitHold = await reserveHold(singleDigitSlot);
  const hostDateLabel = formatHostDateLabel(
    new Date(singleDigitSlot.startTimeUTC),
    "Asia/Kolkata",
  );
  const singleDigitRes = await callHandler(createBookingHandler, {
    ...paidPayload(singleDigitSlot, {
      slotHoldId: singleDigitHold.holdId,
      slotHoldToken: singleDigitHold.holdToken,
      hostDate: hostDateLabel,
    }),
  });
  if (singleDigitRes.status === 200 && singleDigitRes.body?.bookingId) {
    created.bookings.push(singleDigitRes.body.bookingId);
    record("single_digit_day_hold_match", true, singleDigitRes.body.bookingId);
  } else {
    record(
      "single_digit_day_hold_match",
      false,
      JSON.stringify(singleDigitRes.body),
    );
  }
};

try {
  console.log(`Running booking tests (${runId})...`);
  await testRazorpay();
  await testPayPal();
  await testBookingFlow();
} catch (err) {
  record("test_runner_exception", false, err?.message || String(err));
} finally {
  await cleanup();
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\nCompleted ${results.length} checks. Passed ${passed}, Failed ${
      results.length - passed
    }.`,
  );
}
