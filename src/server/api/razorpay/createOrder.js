import {
  resolveBookingPricing,
  resolveUpgradeContext,
} from "../ref/pricing.js";
import { createClient } from "@sanity/client";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import providerConfig from "../payment/providerConfig.js";
import { createPaymentAccessToken } from "../payment/accessToken.js";
import {
  buildBookingSeedKey,
  buildPaymentRecordEvent,
  buildPaymentRecordId,
  buildPricingFingerprint,
  HOLD_PHASE_HOLDING,
  PAYMENT_HOLD_MINUTES,
  PAYMENT_RECORD_TYPE,
  PAYMENT_STATUS_STARTED,
} from "../payment/paymentRecord.js";

const { resolvePaymentProviders } = providerConfig;

const writeClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

function getCredentials() {
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!keyId || !keySecret) {
    return null;
  }
  return { keyId, keySecret };
}

function toSubunits(amount, currency = "USD") {
  const factors = { USD: 100, INR: 100, JPY: 1 };
  const factor = factors[currency] ?? 100;
  return Math.round(amount * factor);
}

function resolveServerCurrency() {
  return (
    String(process.env.RAZORPAY_CURRENCY || "USD").trim().toUpperCase() ||
    "USD"
  );
}

const getPaymentAccessTtlSeconds = () => PAYMENT_HOLD_MINUTES * 60;

const upsertLegacyStartedPaymentRecord = async ({
  bookingPayload = {},
  pricing,
  order,
  keyId = "",
  currency = "USD",
}) => {
  const normalizedBookingPayload =
    bookingPayload && typeof bookingPayload === "object" ? bookingPayload : {};
  const bookingSeedKey = buildBookingSeedKey({
    provider: "razorpay",
    packageTitle: normalizedBookingPayload.packageTitle || "",
    originalOrderId: normalizedBookingPayload.originalOrderId || "",
    startTimeUTC: normalizedBookingPayload.startTimeUTC || "",
    email: normalizedBookingPayload.email || "",
  });
  const pricingFingerprint = buildPricingFingerprint({
    provider: "razorpay",
    packageTitle: normalizedBookingPayload.packageTitle || "",
    originalOrderId: normalizedBookingPayload.originalOrderId || "",
    startTimeUTC: normalizedBookingPayload.startTimeUTC || "",
    email: normalizedBookingPayload.email || "",
    grossAmount: Number(pricing?.effectiveGrossAmount || 0),
    netAmount: Number(pricing?.effectiveNetAmount || 0),
    discountAmount: Number(pricing?.effectiveDiscountAmount || 0),
    referralCode: normalizedBookingPayload.referralCode || "",
    couponCode: normalizedBookingPayload.couponCode || "",
    currency,
  });
  const recordId = buildPaymentRecordId({
    provider: "razorpay",
    providerOrderId: String(order?.id || "").trim(),
    bookingSeedKey,
  });
  const now = new Date().toISOString();
  const doc = {
    _id: recordId,
    _type: PAYMENT_RECORD_TYPE,
    provider: "razorpay",
    status: PAYMENT_STATUS_STARTED,
    bookingSeedKey,
    pricingFingerprint,
    bookingFinalizationKey: `razorpay-order:${String(order?.id || "").trim()}`,
    bookingPayload: {
      packageTitle: String(normalizedBookingPayload.packageTitle || "").trim(),
      originalOrderId: String(normalizedBookingPayload.originalOrderId || "").trim(),
      startTimeUTC: String(normalizedBookingPayload.startTimeUTC || "").trim(),
      email: String(normalizedBookingPayload.email || "").trim(),
      localTimeZone: String(normalizedBookingPayload.localTimeZone || "").trim(),
      displayDate: String(normalizedBookingPayload.displayDate || "").trim(),
      displayTime: String(normalizedBookingPayload.displayTime || "").trim(),
      referralCode: String(normalizedBookingPayload.referralCode || "").trim(),
      couponCode: String(normalizedBookingPayload.couponCode || "").trim(),
      slotHoldId: String(normalizedBookingPayload.slotHoldId || "").trim(),
      slotHoldToken: String(normalizedBookingPayload.slotHoldToken || "").trim(),
      slotHoldExpiresAt: String(
        normalizedBookingPayload.slotHoldExpiresAt || ""
      ).trim(),
      paymentProvider: "razorpay",
    },
    pricingSnapshot: {
      grossAmount: Number(pricing?.effectiveGrossAmount || 0),
      discountAmount: Number(pricing?.effectiveDiscountAmount || 0),
      discountPercent: Number(pricing?.effectiveDiscountPercent || 0),
      netAmount: Number(pricing?.effectiveNetAmount || 0),
      referralDiscountAmount: Number(pricing?.referralDiscountAmount || 0),
      referralDiscountPercent: Number(pricing?.referralDiscountPercent || 0),
      commissionPercent: Number(pricing?.effectiveCommissionPercent || 0),
      commissionAmount: Number(pricing?.commissionAmount || 0),
      couponDiscountPercent: Number(pricing?.couponDiscountPercent || 0),
      couponDiscountAmount: Number(pricing?.couponDiscountAmount || 0),
      canCombineWithReferral: pricing?.canCombineWithReferral === true,
      effectiveReferralCode: String(pricing?.effectiveReferralCode || "").trim(),
      effectiveReferralId: String(pricing?.effectiveReferralId || "").trim(),
    },
    holdSnapshot: {
      slotHoldId: String(normalizedBookingPayload.slotHoldId || "").trim(),
      slotHoldToken: String(normalizedBookingPayload.slotHoldToken || "").trim(),
      slotHoldExpiresAt: String(
        normalizedBookingPayload.slotHoldExpiresAt || ""
      ).trim(),
      phase: HOLD_PHASE_HOLDING,
    },
    providerOrderId: String(order?.id || "").trim(),
    providerPaymentId: "",
    payerEmail: String(normalizedBookingPayload.email || "").trim(),
    verificationState: "",
    verificationWarning: "",
    bookingId: "",
    recoveryReason: "",
    attemptCount: 0,
    lastAttemptAt: "",
    source: "legacy-start",
    providerPublicData: {
      orderId: String(order?.id || "").trim(),
      amount: Number(order?.amount || 0),
      currency: String(order?.currency || currency).trim().toUpperCase(),
      key: String(keyId || "").trim(),
    },
    emailDispatch: {},
    emailDispatchToken: "",
    events: [
      buildPaymentRecordEvent({
        status: PAYMENT_STATUS_STARTED,
        source: "legacy-start",
        data: {
          providerOrderId: String(order?.id || "").trim(),
          slotHoldId: String(normalizedBookingPayload.slotHoldId || "").trim(),
        },
      }),
    ],
    createdAt: now,
    updatedAt: now,
  };

  try {
    await writeClient.create(doc);
  } catch (error) {
    const conflict =
      Number(error?.statusCode || error?.status || 0) === 409;
    if (!conflict) throw error;

    await writeClient
      .patch(recordId)
      .set({
        ...doc,
        _id: undefined,
        _type: undefined,
      })
      .setIfMissing({
        _type: PAYMENT_RECORD_TYPE,
        createdAt: doc.createdAt,
      })
      .commit();
  }

  return {
    paymentRecordId: recordId,
    paymentAccessToken: createPaymentAccessToken({
      paymentRecordId: recordId,
      provider: "razorpay",
      pricingFingerprint,
      expirySeconds: getPaymentAccessTtlSeconds(),
    }),
  };
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  const providers = resolvePaymentProviders();
  if (!providers?.razorpay?.enabled) {
    return res.status(400).json({
      ok: false,
      message: "Razorpay is not available in this environment.",
    });
  }

  const credentials = getCredentials();

  if (!credentials) {
    return res.status(500).json({
      ok: false,
      message: "Razorpay keys are missing on the server",
    });
  }

  try {
    const { notes = {}, bookingPayload = null } = req.body || {};
    const clientAddress = getClientAddress(req);
    const rateLimitKey = [
      "razorpay-create-order",
      clientAddress,
      String(notes.packageTitle || "").trim().toLowerCase(),
      String(notes.originalOrderId || "").trim().toLowerCase(),
      String(notes.referralCode || "").trim().toLowerCase(),
      String(notes.couponCode || "").trim().toLowerCase(),
    ].join(":");
    if (
      !requireRateLimit(res, {
        key: rateLimitKey,
        max: 12,
        message: "Too many payment order requests. Please try again later.",
      })
    ) {
      return;
    }
    const currency = resolveServerCurrency();

    if (!notes?.packageTitle) {
      return res.status(400).json({
        ok: false,
        message: "Missing package details required to create the order",
      });
    }

    const upgradeContext = notes.originalOrderId
      ? await resolveUpgradeContext({
          originalOrderId: notes.originalOrderId || "",
          packageTitle: notes.packageTitle,
        })
      : null;

    const pricing = await resolveBookingPricing({
      packageTitle: notes.packageTitle,
      originalOrderId: notes.originalOrderId || "",
      referralCode: notes.referralCode || "",
      couponCode: notes.couponCode || "",
      paymentProvider: "razorpay",
      upgradeContext,
    });

    const options = {
      amount: toSubunits(pricing.effectiveNetAmount, currency),
      currency,
      receipt: `booking_${Date.now()}`,
      notes: {
        packageTitle: notes.packageTitle || "",
        originalOrderId: notes.originalOrderId || "",
        referralCode: notes.referralCode || "",
        couponCode: notes.couponCode || "",
        expectedAmount: String(pricing.effectiveNetAmount),
      },
    };

    const basic = Buffer.from(
      `${credentials.keyId}:${credentials.keySecret}`
    ).toString("base64");

    const upstream = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options),
    });

    const order = await upstream.json();

    if (!upstream.ok || !order?.id) {
      const details =
        order?.error?.description ||
        order?.error?.reason ||
        order?.error?.code;
      throw new Error(details || `Razorpay order create failed (${upstream.status})`);
    }

    const legacySession =
      bookingPayload &&
      typeof bookingPayload === "object" &&
      String(bookingPayload.packageTitle || "").trim()
        ? await upsertLegacyStartedPaymentRecord({
            bookingPayload: {
              ...bookingPayload,
              packageTitle:
                bookingPayload.packageTitle || notes.packageTitle || "",
              originalOrderId:
                bookingPayload.originalOrderId || notes.originalOrderId || "",
              referralCode:
                bookingPayload.referralCode || notes.referralCode || "",
              couponCode: bookingPayload.couponCode || notes.couponCode || "",
            },
            pricing,
            order,
            keyId: credentials.keyId,
            currency,
          })
        : { paymentRecordId: "", paymentAccessToken: "" };

    return res.status(200).json({
      ok: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: credentials.keyId,
      paymentRecordId: legacySession.paymentRecordId,
      paymentAccessToken: legacySession.paymentAccessToken,
    });
  } catch (err) {
    console.error("Razorpay createOrder error:", err);
    const status = Number(err?.status) || 500;
    return res.status(status).json({
      ok: false,
      message: err?.message || "Failed to create Razorpay order",
    });
  }
}
