import crypto from "crypto";
import createBookingHandler from "../ref/createBooking.js";
import { createRefWriteClient } from "../ref/sanity.js";
import { resolvePaymentQuote } from "../ref/pricing.js";
import { getBookingSettings, isSlotAllowedForPackage } from "../../booking/slotPolicy.js";
import { buildSlotHoldId } from "../../booking/slotIdentity.js";
import { issueHoldToken, verifyHoldToken } from "../../booking/holdToken.js";
import providerConfig from "./providerConfig.js";
import {
  createPayPalOrder,
  createRazorpayOrder,
  DEFAULT_PAYPAL_CURRENCY,
  DEFAULT_RAZORPAY_CURRENCY,
  verifyPayPalOrder,
  verifyPayPalWebhookSignature,
  verifyRazorpayPayment,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
} from "./providerClients.js";
import {
  createPaymentAccessToken,
  isPaymentAccessTokenRecordMatch,
  isWithinPaymentAccessRecoveryWindow,
  verifyPaymentAccessToken,
} from "./accessToken.js";
import {
  buildBookingSeedKey,
  buildPricingFingerprint,
  buildPaymentRecordEvent,
  buildPaymentRecordId,
  findPaymentRecordByProviderData,
  findReusablePaymentRecord,
  getPaymentHoldExpiryIso,
  getPaymentRecordById,
  HOLD_PHASE_HOLDING,
  HOLD_PHASE_PAYMENT_PENDING,
  isPaymentPendingStatus,
  isPaymentTerminalStatus,
  mergePaymentRecordEvents,
  PAYMENT_HOLD_MINUTES,
  PAYMENT_RECOVERY_MINUTES,
  PAYMENT_RECORD_TYPE,
  PAYMENT_STATUS_ABANDONED,
  PAYMENT_STATUS_BOOKED,
  PAYMENT_STATUS_CAPTURED_CLIENT,
  PAYMENT_STATUS_CAPTURED_WEBHOOK,
  PAYMENT_STATUS_EMAIL_PARTIAL,
  PAYMENT_STATUS_FAILED,
  PAYMENT_STATUS_FINALIZING,
  PAYMENT_STATUS_NEEDS_RECOVERY,
  PAYMENT_STATUS_REFUNDED,
  PAYMENT_STATUS_STARTED,
} from "./paymentRecord.js";

const { resolvePaymentProviders, resolveServerPaymentSessionsEnabled } =
  providerConfig;

const RECOVERY_HOLD_HOURS = 72;

const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const nowIso = () => new Date().toISOString();

const createMemoryResponse = () => {
  const state = {
    statusCode: 200,
    body: null,
    headers: {},
  };

  return {
    status(code) {
      state.statusCode = Number(code) || 200;
      return this;
    },
    json(payload) {
      state.body = payload;
      return payload;
    },
    send(payload) {
      state.body = payload;
      return payload;
    },
    end(payload) {
      state.body = payload;
      return payload;
    },
    setHeader(name, value) {
      state.headers[String(name || "").toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return state.headers[String(name || "").toLowerCase()];
    },
    __state: state,
  };
};

const invokeCreateBooking = async (payload, internalContext = {}) => {
  const req = {
    method: "POST",
    body: payload,
    headers: {},
    internalContext,
  };
  const res = createMemoryResponse();
  await createBookingHandler(req, res);
  return {
    status: res.__state.statusCode,
    body: normalizeObject(res.__state.body),
  };
};

const sanitizeBookingPayload = (payload = {}) => {
  const normalized = normalizeObject(payload);
  return {
    ...normalized,
    packageTitle: String(normalized.packageTitle || "").trim(),
    originalOrderId: String(normalized.originalOrderId || "").trim(),
    startTimeUTC: String(normalized.startTimeUTC || "").trim(),
    email: String(normalized.email || "").trim(),
    localTimeZone: String(normalized.localTimeZone || "").trim(),
    displayDate: String(normalized.displayDate || "").trim(),
    displayTime: String(normalized.displayTime || "").trim(),
    referralId: String(normalized.referralId || "").trim(),
    referralCode: String(normalized.referralCode || "").trim(),
    couponCode: String(normalized.couponCode || "").trim(),
    slotHoldId: String(normalized.slotHoldId || "").trim(),
    slotHoldToken: String(normalized.slotHoldToken || "").trim(),
    slotHoldExpiresAt: String(normalized.slotHoldExpiresAt || "").trim(),
  };
};

const getLegacySuccessStatus = (emailDispatch = {}) =>
  emailDispatch?.allSent === false
    ? PAYMENT_STATUS_EMAIL_PARTIAL
    : PAYMENT_STATUS_BOOKED;

const logPayment = (message, details = {}) => {
  console.error(message, details);
};

const getHoldById = async (client, holdId) => {
  if (!holdId) return null;
  return client.fetch(`*[_type == "slotHold" && _id == $id][0]`, { id: holdId });
};

const resolveHoldSlot = async ({ client, bookingPayload }) => {
  const settings = await getBookingSettings({ client });
  return isSlotAllowedForPackage({
    settings,
    packageTitle: bookingPayload.packageTitle,
    startTimeUTC: bookingPayload.startTimeUTC,
  });
};

const assertStartableHold = async ({ client, bookingPayload }) => {
  if (bookingPayload.originalOrderId) {
    return {
      holdDoc: null,
      hostDate: "",
      hostTime: "",
    };
  }

  if (!bookingPayload.slotHoldId || !bookingPayload.slotHoldToken) {
    const error = new Error("Your slot reservation expired.");
    error.status = 409;
    throw error;
  }

  const holdDoc = await getHoldById(client, bookingPayload.slotHoldId);
  if (!holdDoc) {
    const error = new Error("Your slot reservation expired.");
    error.status = 409;
    throw error;
  }

  if (
    holdDoc.expiresAt &&
    new Date(holdDoc.expiresAt).getTime() <= Date.now() &&
    String(holdDoc.phase || HOLD_PHASE_HOLDING) !== HOLD_PHASE_PAYMENT_PENDING
  ) {
    await client.delete(bookingPayload.slotHoldId).catch(() => {});
    const error = new Error("Your slot reservation expired.");
    error.status = 409;
    throw error;
  }

  const validToken = verifyHoldToken({
    token: bookingPayload.slotHoldToken,
    holdId: bookingPayload.slotHoldId,
    startTimeUTC: holdDoc.startTimeUTC || bookingPayload.startTimeUTC,
    holdNonce: holdDoc.holdNonce || "",
  });

  if (!validToken) {
    const error = new Error("This slot reservation is not valid for your session.");
    error.status = 403;
    throw error;
  }

  const slotAllowance = await resolveHoldSlot({ client, bookingPayload });
  if (!slotAllowance.allowed) {
    const error = new Error("The selected slot is not available for this package.");
    error.status = 400;
    throw error;
  }

  if (
    holdDoc.startTimeUTC &&
    String(holdDoc.startTimeUTC) !== String(bookingPayload.startTimeUTC)
  ) {
    const error = new Error("Slot hold does not match selected time.");
    error.status = 400;
    throw error;
  }

  return {
    holdDoc,
    hostDate: slotAllowance.hostDate,
    hostTime: slotAllowance.hostTime,
  };
};

const buildPricingSnapshot = (quote = {}) => ({
  grossAmount: Number(quote.effectiveGrossAmount || 0),
  discountAmount: Number(quote.effectiveDiscountAmount || 0),
  discountPercent: Number(quote.effectiveDiscountPercent || 0),
  netAmount: Number(quote.effectiveNetAmount || 0),
  referralDiscountAmount: Number(quote.referralDiscountAmount || 0),
  referralDiscountPercent: Number(quote.referralDiscountPercent || 0),
  commissionPercent: Number(quote.effectiveCommissionPercent || 0),
  commissionAmount: Number(quote.commissionAmount || 0),
  couponDiscountPercent: Number(quote.couponDiscountPercent || 0),
  couponDiscountAmount: Number(quote.couponDiscountAmount || 0),
  canCombineWithReferral: quote.canCombineWithReferral === true,
  effectiveReferralCode: String(quote.effectiveReferralCode || "").trim(),
  effectiveReferralId: String(quote.effectiveReferralId || "").trim(),
});

const buildRecordPricingFingerprint = ({
  provider = "",
  bookingPayload,
  quote,
  currency = "",
}) =>
  buildPricingFingerprint({
    provider,
    packageTitle: bookingPayload?.packageTitle || "",
    originalOrderId: bookingPayload?.originalOrderId || "",
    startTimeUTC: bookingPayload?.startTimeUTC || "",
    email: bookingPayload?.email || "",
    grossAmount: Number(quote?.effectiveGrossAmount || 0),
    netAmount:
      String(provider || "").trim().toLowerCase() === "free"
        ? 0
        : Number(quote?.effectiveNetAmount || 0),
    discountAmount: Number(quote?.effectiveDiscountAmount || 0),
    referralId: String(quote?.effectiveReferralId || "").trim(),
    referralCode: String(quote?.effectiveReferralCode || "").trim(),
    couponCode: bookingPayload?.couponCode || "",
    currency:
      String(currency || "").trim().toUpperCase() ||
      (String(provider || "").trim().toLowerCase() === "paypal"
        ? DEFAULT_PAYPAL_CURRENCY
        : DEFAULT_RAZORPAY_CURRENCY),
  });

const buildPublicStatusBody = (record = {}) => ({
  ok: true,
  status: String(record.status || "").trim(),
  provider: String(record.provider || "").trim(),
  bookingId: String(record.bookingId || "").trim(),
  recoveryReason: String(record.recoveryReason || "").trim(),
  emailDispatch: normalizeObject(record.emailDispatch),
  emailDispatchToken: String(record.emailDispatchToken || "").trim(),
});

const resolvePaymentRecordSuccessStatus = (emailDispatch = {}) =>
  emailDispatch?.allSent === false
    ? PAYMENT_STATUS_EMAIL_PARTIAL
    : PAYMENT_STATUS_BOOKED;

const resolvePaymentAccessTtlSeconds = () =>
  Math.min(
    (PAYMENT_HOLD_MINUTES + PAYMENT_RECOVERY_MINUTES) * 60,
    24 * 60 * 60
  );

const issuePaymentAccessTokenForRecord = (record = {}) =>
  createPaymentAccessToken({
    paymentRecordId: record._id,
    provider: record.provider,
    pricingFingerprint: record.pricingFingerprint,
    expirySeconds: resolvePaymentAccessTtlSeconds(),
  });

const isTransientVerificationFailure = (reason = "") => {
  const normalized = String(reason || "").trim().toLowerCase();
  return (
    normalized === "razorpay_lookup_exception" ||
    normalized === "paypal_lookup_exception" ||
    normalized.startsWith("razorpay_lookup_failed_5") ||
    normalized.startsWith("paypal_lookup_failed_5")
  );
};

const isTrustedRecoverySource = (source = "") =>
  source === "client" || source === "webhook" || source === "reconcile";

const buildQuotePayload = (quote = {}) => ({
  grossAmount: Number(quote.effectiveGrossAmount || 0),
  discountAmount: Number(quote.effectiveDiscountAmount || 0),
  discountPercent: Number(quote.effectiveDiscountPercent || 0),
  netAmount:
    String(quote.paymentProvider || "").trim().toLowerCase() === "free"
      ? 0
      : Number(quote.effectiveNetAmount || 0),
  isFree: String(quote.paymentProvider || "").trim().toLowerCase() === "free",
  referralDiscountPercent: Number(quote.referralDiscountPercent || 0),
  referralDiscountAmount: Number(quote.referralDiscountAmount || 0),
  commissionPercent: Number(quote.effectiveCommissionPercent || 0),
  couponDiscountPercent: Number(quote.couponDiscountPercent || 0),
  couponDiscountAmount: Number(quote.couponDiscountAmount || 0),
  canCombineWithReferral: quote.canCombineWithReferral === true,
});

const buildProviderPayloadFromRecord = (record = {}) => {
  const provider = String(record.provider || "").trim().toLowerCase();
  if (provider === "razorpay") {
    return {
      orderId: String(record.providerOrderId || "").trim(),
      key: String(record.providerPublicData?.key || "").trim(),
      currency:
        String(record.providerPublicData?.currency || "").trim().toUpperCase() ||
        DEFAULT_RAZORPAY_CURRENCY,
      amount: Number(record.providerPublicData?.amount || 0),
    };
  }

  if (provider === "paypal") {
    return {
      orderId: String(record.providerOrderId || "").trim(),
      currency:
        String(record.providerPublicData?.currency || "").trim().toUpperCase() ||
        DEFAULT_PAYPAL_CURRENCY,
      clientId: String(record.providerPublicData?.clientId || "").trim(),
    };
  }

  return {};
};

const getLegacyBookingByProviderData = async ({
  client,
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "paypal" && providerOrderId) {
    return client.fetch(
      `*[_type == "booking" && paypalOrderId == $paypalOrderId][0]`,
      { paypalOrderId: providerOrderId }
    );
  }

  if (normalizedProvider === "razorpay" && providerPaymentId) {
    return client.fetch(
      `*[_type == "booking" && razorpayPaymentId == $razorpayPaymentId][0]`,
      { razorpayPaymentId: providerPaymentId }
    );
  }

  if (normalizedProvider === "razorpay" && providerOrderId) {
    return client.fetch(
      `*[_type == "booking" && razorpayOrderId == $razorpayOrderId][0]`,
      { razorpayOrderId: providerOrderId }
    );
  }

  return null;
};

const buildEmailDispatchFromBooking = (booking = {}) => {
  const clientSent = !!booking.emailDispatchClientSentAt;
  const ownerSent = !!booking.emailDispatchOwnerSentAt;

  return {
    deliveryEnabled: true,
    deferred: !!booking.emailDispatchDeferred,
    client: {
      attempted:
        clientSent ||
        !!String(booking.emailDispatchStatus || "").trim(),
      sent: clientSent,
      skippedReason: clientSent ? "already_sent" : "",
    },
    owner: {
      attempted:
        ownerSent ||
        !!String(booking.emailDispatchStatus || "").trim(),
      sent: ownerSent,
      skippedReason: ownerSent ? "already_sent" : "",
    },
    allSent: clientSent && ownerSent,
  };
};

const mirrorLegacyBookingToPaymentRecord = async ({
  client,
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
  payerEmail = "",
  booking,
  source = "legacy",
  eventType = "",
}) => {
  if (!booking?._id) return null;

  const normalizedProvider = String(provider || booking.paymentProvider || "")
    .trim()
    .toLowerCase();
  if (normalizedProvider !== "paypal" && normalizedProvider !== "razorpay") {
    return null;
  }

  const bookingSeedKey = buildBookingSeedKey({
    provider: normalizedProvider,
    packageTitle: booking.packageTitle || "",
    originalOrderId: booking.originalOrderId || "",
    startTimeUTC: booking.startTimeUTC || "",
    email: booking.email || booking.payerEmail || "",
  });
  const pricingFingerprint = buildPricingFingerprint({
    provider: normalizedProvider,
    packageTitle: booking.packageTitle || "",
    originalOrderId: booking.originalOrderId || "",
    startTimeUTC: booking.startTimeUTC || "",
    email: booking.email || booking.payerEmail || "",
    grossAmount: Number(booking.grossAmount || booking.packagePrice || 0),
    netAmount: Number(booking.netAmount || booking.packagePrice || 0),
    discountAmount: Number(booking.discountAmount || 0),
    referralCode: booking.referralCode || "",
    couponCode: booking.couponCode || "",
    currency:
      normalizedProvider === "paypal"
        ? DEFAULT_PAYPAL_CURRENCY
        : DEFAULT_RAZORPAY_CURRENCY,
  });
  const emailDispatch = buildEmailDispatchFromBooking(booking);
  const status = resolvePaymentRecordSuccessStatus(emailDispatch);
  const paymentRecordId = buildPaymentRecordId({
    provider: normalizedProvider,
    providerOrderId:
      providerOrderId ||
      booking.paypalOrderId ||
      booking.razorpayOrderId ||
      "",
    providerPaymentId:
      providerPaymentId || booking.razorpayPaymentId || "",
    bookingSeedKey,
  });
  const existing = await getPaymentRecordById(client, paymentRecordId);
  const now = nowIso();
  const event = buildPaymentRecordEvent({
    status,
    source,
    reason: eventType ? "legacy_booking_mirrored_from_webhook" : "",
    data: {
      bookingId: booking._id,
      providerOrderId:
        providerOrderId ||
        booking.paypalOrderId ||
        booking.razorpayOrderId ||
        "",
      providerPaymentId:
        providerPaymentId || booking.razorpayPaymentId || "",
      eventType,
    },
  });

  const doc = {
    _id: paymentRecordId,
    _type: PAYMENT_RECORD_TYPE,
    provider: normalizedProvider,
    status,
    bookingSeedKey,
    pricingFingerprint,
    bookingFinalizationKey:
      normalizedProvider === "paypal"
        ? `paypal:${providerOrderId || booking.paypalOrderId || ""}`
        : `razorpay-order:${providerOrderId || booking.razorpayOrderId || ""}`,
    bookingPayload: {
      packageTitle: String(booking.packageTitle || "").trim(),
      originalOrderId: String(booking.originalOrderId || "").trim(),
      startTimeUTC: String(booking.startTimeUTC || "").trim(),
      email: String(booking.email || booking.payerEmail || "").trim(),
      localTimeZone: String(booking.localTimeZone || "").trim(),
      displayDate: String(booking.displayDate || "").trim(),
      displayTime: String(booking.displayTime || "").trim(),
      referralCode: String(booking.referralCode || "").trim(),
      couponCode: String(booking.couponCode || "").trim(),
      paymentProvider: normalizedProvider,
    },
    pricingSnapshot: {
      grossAmount: Number(booking.grossAmount || booking.packagePrice || 0),
      discountAmount: Number(booking.discountAmount || 0),
      discountPercent: Number(booking.discountPercent || 0),
      netAmount: Number(booking.netAmount || booking.packagePrice || 0),
      referralDiscountAmount: 0,
      referralDiscountPercent: 0,
      commissionPercent: Number(booking.commissionPercent || 0),
      couponDiscountPercent: Number(booking.couponDiscountPercent || 0),
      couponDiscountAmount: Number(booking.couponDiscountAmount || 0),
      canCombineWithReferral: false,
      effectiveReferralCode: String(booking.referralCode || "").trim(),
      effectiveReferralId: "",
    },
    holdSnapshot: existing?.holdSnapshot || {},
    providerOrderId: String(
      providerOrderId || booking.paypalOrderId || booking.razorpayOrderId || ""
    ).trim(),
    providerPaymentId: String(
      providerPaymentId || booking.razorpayPaymentId || ""
    ).trim(),
    payerEmail: String(payerEmail || booking.payerEmail || booking.email || "").trim(),
    verificationState: String(booking.paymentVerificationState || "").trim(),
    verificationWarning: String(booking.paymentVerificationWarning || "").trim(),
    bookingId: String(booking._id || "").trim(),
    recoveryReason: "",
    attemptCount: Number(existing?.attemptCount || 0),
    lastAttemptAt: now,
    source,
    providerPublicData:
      existing?.providerPublicData ||
      (normalizedProvider === "paypal"
        ? {
            orderId: String(
              providerOrderId || booking.paypalOrderId || ""
            ).trim(),
            currency: DEFAULT_PAYPAL_CURRENCY,
            clientId: String(
              resolvePaymentProviders()?.paypal?.clientId || ""
            ).trim(),
          }
        : {
            orderId: String(
              providerOrderId || booking.razorpayOrderId || ""
            ).trim(),
            currency: DEFAULT_RAZORPAY_CURRENCY,
          }),
    emailDispatch,
    emailDispatchToken: "",
    events: mergePaymentRecordEvents(existing?.events || [], event),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  return upsertPaymentRecord({ client, doc });
};

const resolveRecordFromAccessToken = async ({
  client,
  paymentAccessToken = "",
  allowRecoveryExtension = false,
}) => {
  const tokenResult = verifyPaymentAccessToken({ token: paymentAccessToken });
  if (!tokenResult.ok && !tokenResult.expired) {
    const error = new Error("Invalid payment session.");
    error.status = 401;
    error.code = tokenResult.reason || "payment_access_token_invalid";
    throw error;
  }

  const payload = tokenResult.payload || {};
  const record = await getPaymentRecordById(client, payload.paymentRecordId);
  if (!record?._id) {
    const error = new Error("Payment session not found.");
    error.status = 404;
    error.code = "payment_record_not_found";
    throw error;
  }

  if (!isPaymentAccessTokenRecordMatch({ payload, record })) {
    const error = new Error("Payment session does not match the current record.");
    error.status = 403;
    error.code = "payment_access_token_mismatch";
    throw error;
  }

  if (tokenResult.expired) {
    const status = String(record.status || "").trim().toLowerCase();
    if (
      !allowRecoveryExtension ||
      status !== PAYMENT_STATUS_NEEDS_RECOVERY ||
      !isWithinPaymentAccessRecoveryWindow({ payload })
    ) {
      const error = new Error("Payment session expired.");
      error.status = 401;
      error.code = tokenResult.reason || "payment_access_token_expired";
      throw error;
    }
  }

  return { payload, record };
};

const verifyProviderCapture = async ({
  record,
  source = "client",
  providerData = {},
}) => {
  const provider = String(record?.provider || "").trim().toLowerCase();
  if (provider === "free") {
    return { ok: true, trustedCapture: false, payerEmail: "" };
  }

  if (provider === "razorpay") {
    const orderId = String(
      providerData.razorpayOrderId || record.providerOrderId || ""
    ).trim();
    const paymentId = String(
      providerData.razorpayPaymentId || record.providerPaymentId || ""
    ).trim();
    const signature = String(providerData.razorpaySignature || "").trim();

    if (!orderId || !paymentId) {
      return { ok: false, retryable: false, reason: "razorpay_payment_fields_missing" };
    }

    if (source === "client") {
      const validSignature = verifyRazorpaySignature({
        orderId,
        paymentId,
        signature,
        secret: String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
      });
      if (!validSignature) {
        return { ok: false, retryable: false, reason: "razorpay_signature_invalid" };
      }
    }

    const verification = await verifyRazorpayPayment({
      orderId,
      paymentId,
      expectedAmount: Number(record?.pricingSnapshot?.netAmount || 0),
      expectedCurrency:
        String(record?.providerPublicData?.currency || "").trim().toUpperCase() ||
        DEFAULT_RAZORPAY_CURRENCY,
    });
    if (!verification.ok) {
      return {
        ok: false,
        retryable: isTransientVerificationFailure(verification.reason),
        reason: verification.reason || "razorpay_verification_failed",
      };
    }

    return { ok: true, trustedCapture: true, payerEmail: "" };
  }

  if (provider === "paypal") {
    const orderId = String(
      providerData.paypalOrderId || record.providerOrderId || ""
    ).trim();
    if (!orderId) {
      return { ok: false, retryable: false, reason: "paypal_order_id_missing" };
    }

    const verification = await verifyPayPalOrder({
      orderId,
      expectedAmount: Number(record?.pricingSnapshot?.netAmount || 0),
      expectedCurrency:
        String(record?.providerPublicData?.currency || "").trim().toUpperCase() ||
        DEFAULT_PAYPAL_CURRENCY,
    });
    if (!verification.ok) {
      return {
        ok: false,
        retryable: isTransientVerificationFailure(verification.reason),
        reason: verification.reason || "paypal_verification_failed",
      };
    }

    return {
      ok: true,
      trustedCapture: true,
      payerEmail: String(verification.payerEmail || "").trim(),
    };
  }

  return { ok: false, retryable: false, reason: "payment_provider_unsupported" };
};

const patchPaymentRecord = async ({ client, record, set = {}, event = null }) => {
  const existingEvents = Array.isArray(record?.events) ? record.events : [];
  const mergedEvents = event
    ? mergePaymentRecordEvents(existingEvents, event)
    : existingEvents;
  await client
    .patch(record._id)
    .set({
      ...set,
      ...(event ? { events: mergedEvents } : {}),
      updatedAt: nowIso(),
    })
    .commit();

  return {
    ...record,
    ...set,
    ...(event ? { events: mergedEvents } : {}),
    updatedAt: nowIso(),
  };
};

const upsertPaymentRecord = async ({ client, doc }) => {
  const existing = await getPaymentRecordById(client, doc._id);
  if (existing?._id) {
    await client
      .patch(doc._id)
      .set({
        ...doc,
        _id: undefined,
        _type: undefined,
        updatedAt: nowIso(),
      })
      .setIfMissing({
        _type: PAYMENT_RECORD_TYPE,
        createdAt: doc.createdAt || nowIso(),
      })
      .commit();
    return getPaymentRecordById(client, doc._id);
  }

  try {
    await client.create({
      ...doc,
      _type: PAYMENT_RECORD_TYPE,
    });
  } catch (error) {
    const status = Number(error?.statusCode || error?.status || 0) || 0;
    if (status !== 409) throw error;
  }

  return getPaymentRecordById(client, doc._id);
};

const markHoldPaymentPending = async ({
  client,
  holdDoc,
  bookingPayload,
  paymentRecordId,
}) => {
  if (!holdDoc?._id) return null;
  const expiresAt = getPaymentHoldExpiryIso(PAYMENT_HOLD_MINUTES);
  await client
    .patch(holdDoc._id)
    .set({
      phase: HOLD_PHASE_PAYMENT_PENDING,
      paymentRecordId,
      paymentProvider: bookingPayload.paymentProvider || "",
      packageTitle: bookingPayload.packageTitle || holdDoc.packageTitle || "",
      expiresAt,
    })
    .commit();

  return {
    ...holdDoc,
    _id: holdDoc._id,
    hostDate: holdDoc.hostDate,
    hostTime: holdDoc.hostTime,
    phase: HOLD_PHASE_PAYMENT_PENDING,
    paymentRecordId,
    expiresAt,
  };
};

const createOrRefreshRecoveryHold = async ({
  client,
  record,
  reason = "",
}) => {
  const bookingPayload = sanitizeBookingPayload(record.bookingPayload);
  if (!bookingPayload.startTimeUTC || bookingPayload.originalOrderId) {
    return null;
  }

  const slotAllowance = await resolveHoldSlot({ client, bookingPayload });
  if (!slotAllowance.allowed) {
    return null;
  }

  const holdId =
    String(record?.holdSnapshot?.slotHoldId || "").trim() ||
    buildSlotHoldId(bookingPayload.startTimeUTC);
  if (!holdId) return null;

  const expiresAt = new Date(Date.now() + RECOVERY_HOLD_HOURS * 60 * 60 * 1000).toISOString();
  let holdDoc = await getHoldById(client, holdId);
  const holdNonce = crypto.randomUUID();
  if (!holdDoc?._id) {
    try {
      holdDoc = await client.create({
        _id: holdId,
        _type: "slotHold",
        hostDate: slotAllowance.hostDate,
        hostTime: slotAllowance.hostTime,
        startTimeUTC: bookingPayload.startTimeUTC,
        packageTitle: bookingPayload.packageTitle,
        expiresAt,
        holdNonce,
        phase: HOLD_PHASE_PAYMENT_PENDING,
        paymentRecordId: record._id,
        recoveryReason: reason,
      });
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 0) || 0;
      if (status !== 409) throw error;
      holdDoc = await getHoldById(client, holdId);
    }
  }

  const nextNonce = holdDoc?.holdNonce || holdNonce;
  await client
    .patch(holdId)
    .set({
      hostDate: slotAllowance.hostDate,
      hostTime: slotAllowance.hostTime,
      startTimeUTC: bookingPayload.startTimeUTC,
      packageTitle: bookingPayload.packageTitle,
      expiresAt,
      phase: HOLD_PHASE_PAYMENT_PENDING,
      paymentRecordId: record._id,
      holdNonce: nextNonce,
      recoveryReason: reason,
    })
    .commit();

  const holdToken = issueHoldToken({
    holdId,
    startTimeUTC: bookingPayload.startTimeUTC,
    expiresAt,
    holdNonce: nextNonce,
  });

  const holdSnapshot = {
    slotHoldId: holdId,
    slotHoldToken: holdToken,
    slotHoldExpiresAt: expiresAt,
    hostDate: slotAllowance.hostDate,
    hostTime: slotAllowance.hostTime,
    phase: HOLD_PHASE_PAYMENT_PENDING,
  };

  await client
    .patch(record._id)
    .set({
      holdSnapshot,
      updatedAt: nowIso(),
    })
    .commit();

  return holdSnapshot;
};

const releasePendingHold = async ({ client, record }) => {
  const holdId = String(record?.holdSnapshot?.slotHoldId || "").trim();
  if (!holdId) return;
  const holdDoc = await getHoldById(client, holdId);
  if (!holdDoc?._id) return;
  if (String(holdDoc.paymentRecordId || "").trim() !== String(record._id || "").trim()) {
    return;
  }
  await client.delete(holdId).catch(() => {});
};

const syncPaymentRecordHoldState = async ({
  client,
  record,
  holdDoc,
  slotHoldToken = "",
}) => {
  if (!record?._id || !holdDoc?._id) {
    return record;
  }

  const holdSnapshot = {
    slotHoldId: String(holdDoc._id || "").trim(),
    slotHoldToken: String(
      slotHoldToken || record?.holdSnapshot?.slotHoldToken || ""
    ).trim(),
    slotHoldExpiresAt: String(holdDoc.expiresAt || "").trim(),
    hostDate: String(holdDoc.hostDate || "").trim(),
    hostTime: String(holdDoc.hostTime || "").trim(),
    phase:
      String(holdDoc.phase || "").trim().toLowerCase() || HOLD_PHASE_HOLDING,
  };

  return patchPaymentRecord({
    client,
    record,
    set: {
      holdSnapshot,
      bookingPayload: {
        ...sanitizeBookingPayload(record.bookingPayload),
        slotHoldId: holdSnapshot.slotHoldId,
        slotHoldToken: holdSnapshot.slotHoldToken,
        slotHoldExpiresAt: holdSnapshot.slotHoldExpiresAt,
      },
    },
  });
};

const buildLegacyBookingPayload = ({
  record,
  providerData = {},
  source = "client",
}) => {
  const bookingPayload = sanitizeBookingPayload(record.bookingPayload);
  const holdSnapshot = normalizeObject(record.holdSnapshot);
  const normalizedSource = String(source || "client").trim().toLowerCase();

  return {
    ...bookingPayload,
    paymentProvider: record.provider,
    status: "captured",
    deferEmailsUntilConfirmation:
      String(record.provider || "").trim().toLowerCase() !== "free",
    paypalOrderId:
      String(providerData.paypalOrderId || record.providerOrderId || "").trim(),
    payerEmail:
      String(providerData.payerEmail || record.payerEmail || "").trim(),
    razorpayOrderId:
      String(providerData.razorpayOrderId || record.providerOrderId || "").trim(),
    razorpayPaymentId:
      String(providerData.razorpayPaymentId || record.providerPaymentId || "").trim(),
    razorpaySignature:
      String(providerData.razorpaySignature || record.providerSignature || "").trim(),
    slotHoldId:
      String(holdSnapshot.slotHoldId || bookingPayload.slotHoldId || "").trim(),
    slotHoldToken:
      String(holdSnapshot.slotHoldToken || bookingPayload.slotHoldToken || "").trim(),
    slotHoldExpiresAt: String(
      holdSnapshot.slotHoldExpiresAt || bookingPayload.slotHoldExpiresAt || ""
    ).trim(),
    paymentRecordId: record._id,
    recoverySource: normalizedSource === "client" ? "" : normalizedSource,
    recoveredAt: normalizedSource === "client" ? "" : nowIso(),
  };
};

const getVerificationFailureHttpStatus = (reason = "") => {
  const normalized = String(reason || "").trim().toLowerCase();
  if (
    normalized.includes("credentials") ||
    normalized.includes("token") ||
    normalized.includes("auth")
  ) {
    return 503;
  }
  if (isTransientVerificationFailure(normalized)) {
    return 503;
  }
  return 400;
};

const markRetryableFinalizeFailure = async ({
  client,
  record,
  source,
  reason,
  details = {},
}) => {
  const refreshedHold = await createOrRefreshRecoveryHold({
    client,
    record,
    reason,
  }).catch(() => null);

  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_NEEDS_RECOVERY,
      recoveryReason: reason,
      source,
      ...(refreshedHold ? { holdSnapshot: refreshedHold } : {}),
    },
    event: buildPaymentRecordEvent({
      status: PAYMENT_STATUS_NEEDS_RECOVERY,
      source,
      reason,
      data: details,
    }),
  });

  return {
    ok: false,
    httpStatus: 202,
    paymentRecord: nextRecord,
    response: {
      ...buildPublicStatusBody(nextRecord),
    },
  };
};

const markTerminalFinalizeFailure = async ({
  client,
  record,
  source,
  reason,
  details = {},
  httpStatus = 400,
}) => {
  await releasePendingHold({ client, record });
  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_FAILED,
      recoveryReason: reason,
      source,
    },
    event: buildPaymentRecordEvent({
      status: PAYMENT_STATUS_FAILED,
      source,
      reason,
      data: details,
    }),
  });

  return {
    ok: false,
    httpStatus,
    paymentRecord: nextRecord,
    response: {
      ok: false,
      error: "Payment finalization failed.",
      ...buildPublicStatusBody(nextRecord),
    },
  };
};

const resolveClientSourceStatus = (source = "") => {
  const normalized = String(source || "").trim().toLowerCase();
  if (normalized === "webhook") return PAYMENT_STATUS_CAPTURED_WEBHOOK;
  return PAYMENT_STATUS_CAPTURED_CLIENT;
};

const finalizePaymentRecordInternal = async ({
  client,
  record,
  source = "client",
  providerData = {},
}) => {
  if (!record?._id) {
    return {
      ok: false,
      httpStatus: 404,
      response: {
        ok: false,
        error: "Payment record not found.",
      },
    };
  }

  if (
    isPaymentTerminalStatus(record.status) &&
    String(record.status || "").trim().toLowerCase() !== PAYMENT_STATUS_NEEDS_RECOVERY
  ) {
    return {
      ok: true,
      httpStatus: 200,
      paymentRecord: record,
      response: buildPublicStatusBody(record),
    };
  }

  const normalizedSource = String(source || "client").trim().toLowerCase();
  const bookingPayload = sanitizeBookingPayload(record.bookingPayload);
  if (
    !String(bookingPayload.packageTitle || "").trim() ||
    (!String(bookingPayload.originalOrderId || "").trim() &&
      !String(bookingPayload.startTimeUTC || "").trim())
  ) {
    return markRetryableFinalizeFailure({
      client,
      record,
      source: normalizedSource,
      reason: "payment_record_missing_booking_payload",
      details: providerData,
    });
  }

  const captureStatus = resolveClientSourceStatus(normalizedSource);
  let workingRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: captureStatus,
      providerOrderId:
        String(providerData.paypalOrderId || providerData.razorpayOrderId || record.providerOrderId || "").trim(),
      providerPaymentId:
        String(providerData.razorpayPaymentId || providerData.paypalPaymentId || record.providerPaymentId || "").trim(),
      providerSignature:
        String(providerData.razorpaySignature || record.providerSignature || "").trim(),
      payerEmail: String(providerData.payerEmail || record.payerEmail || "").trim(),
      source: normalizedSource,
      attemptCount: Number(record.attemptCount || 0) + 1,
      lastAttemptAt: nowIso(),
    },
    event: buildPaymentRecordEvent({
      status: captureStatus,
      source: normalizedSource,
      reason: "",
      data: providerData,
    }),
  });

  const verification = await verifyProviderCapture({
    record: workingRecord,
    source: normalizedSource,
    providerData,
  });
  if (!verification.ok) {
    if (
      verification.retryable &&
      String(workingRecord.provider || "").trim().toLowerCase() !== "free" &&
      isTrustedRecoverySource(normalizedSource)
    ) {
      return markRetryableFinalizeFailure({
        client,
        record: workingRecord,
        source: normalizedSource,
        reason: verification.reason,
        details: providerData,
      });
    }

    return markTerminalFinalizeFailure({
      client,
      record: workingRecord,
      source: normalizedSource,
      reason: verification.reason,
      details: providerData,
      httpStatus: getVerificationFailureHttpStatus(verification.reason),
    });
  }

  if (verification.payerEmail) {
    workingRecord = await patchPaymentRecord({
      client,
      record: workingRecord,
      set: {
        payerEmail: verification.payerEmail,
        verificationState: "server_verified",
        verificationWarning: "",
      },
    });
  } else if (String(workingRecord.provider || "").trim().toLowerCase() !== "free") {
    workingRecord = await patchPaymentRecord({
      client,
      record: workingRecord,
      set: {
        verificationState: "server_verified",
        verificationWarning: "",
      },
    });
  }

  workingRecord = await patchPaymentRecord({
    client,
    record: workingRecord,
    set: {
      status: PAYMENT_STATUS_FINALIZING,
      source: normalizedSource,
    },
    event: buildPaymentRecordEvent({
      status: PAYMENT_STATUS_FINALIZING,
      source: normalizedSource,
      reason: "",
    }),
  });

  const createPayload = buildLegacyBookingPayload({
    record: workingRecord,
    providerData,
    source: normalizedSource,
  });
  const result = await invokeCreateBooking(createPayload, {
    paymentFinalizeSource: normalizedSource,
  });

  if (result.status >= 200 && result.status < 300 && result.body?.bookingId) {
    const nextStatus = getLegacySuccessStatus(result.body?.emailDispatch);
    const bookingId = String(result.body.bookingId || "").trim();
    const bookingDoc = await client.fetch(
      `*[_type == "booking" && _id == $id][0]{
        paymentVerificationState,
        paymentVerificationWarning
      }`,
      { id: bookingId }
    );

    const nextRecord = await patchPaymentRecord({
      client,
      record: workingRecord,
      set: {
        status: nextStatus,
        bookingId,
        recoveryReason: "",
        emailDispatch: normalizeObject(result.body?.emailDispatch),
        emailDispatchToken: String(result.body?.emailDispatchToken || "").trim(),
        verificationState: String(bookingDoc?.paymentVerificationState || "").trim(),
        verificationWarning: String(
          bookingDoc?.paymentVerificationWarning || ""
        ).trim(),
      },
      event: buildPaymentRecordEvent({
        status: nextStatus,
        source: normalizedSource,
        data: {
          bookingId,
          emailDispatch: normalizeObject(result.body?.emailDispatch),
        },
      }),
    });

    return {
      ok: true,
      httpStatus: 200,
      paymentRecord: nextRecord,
      response: buildPublicStatusBody(nextRecord),
    };
  }

  const reason =
    String(result.body?.error || result.body?.message || "").trim() ||
    `finalize_failed_${result.status}`;
  if (
    result.status >= 500 &&
    String(workingRecord.provider || "").trim().toLowerCase() !== "free" &&
    isTrustedRecoverySource(normalizedSource)
  ) {
    return markRetryableFinalizeFailure({
      client,
      record: workingRecord,
      source: normalizedSource,
      reason,
      details: {
        createBookingStatus: result.status,
        createBookingBody: result.body,
      },
    });
  }

  return markTerminalFinalizeFailure({
    client,
    record: workingRecord,
    source: normalizedSource,
    reason,
    details: {
      createBookingStatus: result.status,
      createBookingBody: result.body,
    },
    httpStatus: result.status >= 400 ? result.status : 400,
  });
};

const abandonStartedPaymentRecord = async ({ client, record, reason }) => {
  await releasePendingHold({ client, record });
  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_ABANDONED,
      recoveryReason: reason,
    },
    event: buildPaymentRecordEvent({
      status: PAYMENT_STATUS_ABANDONED,
      source: "reconcile",
      reason,
    }),
  });

  return {
    ok: true,
    httpStatus: 200,
    paymentRecord: nextRecord,
    response: buildPublicStatusBody(nextRecord),
  };
};

const createOrReusePaymentRecordForStart = async ({
  client,
  provider,
  bookingPayload,
  holdDoc,
  quote,
}) => {
  const bookingSeedKey = buildBookingSeedKey({
    provider,
    packageTitle: bookingPayload.packageTitle,
    originalOrderId: bookingPayload.originalOrderId,
    startTimeUTC: bookingPayload.startTimeUTC,
    email: bookingPayload.email,
  });
  const pricingFingerprint = buildRecordPricingFingerprint({
    provider,
    bookingPayload,
    quote,
  });

  const reusable = await findReusablePaymentRecord({
    client,
    provider,
    pricingFingerprint,
    slotHoldId: bookingPayload.slotHoldId,
  });
  if (reusable?._id) {
    return reusable;
  }

  let providerPayload = {};
  let providerOrderId = "";
  if (provider === "razorpay") {
    providerPayload = await createRazorpayOrder({
      amount: quote.effectiveNetAmount,
      currency: DEFAULT_RAZORPAY_CURRENCY,
      notes: {
        bookingSeedKey,
        holdId: bookingPayload.slotHoldId || "",
        startTimeUTC: bookingPayload.startTimeUTC || "",
        packageTitle: bookingPayload.packageTitle || "",
        originalOrderId: bookingPayload.originalOrderId || "",
        referralCode: bookingPayload.referralCode || "",
        couponCode: bookingPayload.couponCode || "",
      },
    });
    providerOrderId = providerPayload.orderId;
  } else if (provider === "paypal") {
    providerPayload = await createPayPalOrder({
      amount: quote.effectiveNetAmount,
      currency: DEFAULT_PAYPAL_CURRENCY,
      description: `${bookingPayload.packageTitle} booking`,
      customId: bookingPayload.startTimeUTC || "",
    });
    providerOrderId = providerPayload.orderId;
    providerPayload = {
      ...providerPayload,
      clientId: resolvePaymentProviders()?.paypal?.clientId || "",
    };
  }

  const paymentRecordId = buildPaymentRecordId({
    provider,
    providerOrderId,
    bookingSeedKey,
  });

  const expiresAt = getPaymentHoldExpiryIso(PAYMENT_HOLD_MINUTES);
  const createdAt = nowIso();
  const doc = {
    _id: paymentRecordId,
    provider,
    status: PAYMENT_STATUS_STARTED,
    bookingSeedKey,
    pricingFingerprint,
    bookingFinalizationKey:
      provider === "paypal"
        ? `paypal:${providerOrderId}`
        : provider === "free"
        ? bookingSeedKey
        : `razorpay-order:${providerOrderId}`,
    bookingPayload: {
      ...bookingPayload,
      paymentProvider: provider,
      slotHoldExpiresAt: expiresAt,
    },
    pricingSnapshot: buildPricingSnapshot(quote),
    holdSnapshot: {
      slotHoldId: bookingPayload.slotHoldId || "",
      slotHoldToken: bookingPayload.slotHoldToken || "",
      slotHoldExpiresAt: expiresAt,
      hostDate: holdDoc?.hostDate || "",
      hostTime: holdDoc?.hostTime || "",
      phase:
        String(holdDoc?.phase || "").trim().toLowerCase() || HOLD_PHASE_HOLDING,
    },
    providerOrderId,
    providerPaymentId: "",
    payerEmail: String(bookingPayload.email || "").trim(),
    verificationState: "",
    verificationWarning: "",
    bookingId: "",
    recoveryReason: "",
    attemptCount: 0,
    lastAttemptAt: "",
    source: "start",
    providerPublicData: providerPayload,
    emailDispatch: {},
    events: [
      buildPaymentRecordEvent({
        status: PAYMENT_STATUS_STARTED,
        source: "start",
        data: {
          providerOrderId,
          slotHoldId: bookingPayload.slotHoldId || "",
        },
      }),
    ],
    createdAt,
    updatedAt: createdAt,
  };

  return upsertPaymentRecord({ client, doc });
};

export const startPaymentSession = async ({
  body,
  client = createRefWriteClient(),
}) => {
  const serverSessionsEnabled = resolveServerPaymentSessionsEnabled();
  if (!serverSessionsEnabled) {
    return {
      httpStatus: 503,
      body: {
        ok: false,
        error: "Server payment sessions are disabled.",
      },
    };
  }

  const requestBody = normalizeObject(body);
  const bookingPayload = sanitizeBookingPayload(requestBody.bookingPayload || {});
  const requestedProvider = String(requestBody.provider || "").trim().toLowerCase();

  if (!bookingPayload.packageTitle) {
    return {
      httpStatus: 400,
      body: {
        ok: false,
        error: "Package details are required to start payment.",
      },
    };
  }

  try {
    const quote = await resolvePaymentQuote({
      packageTitle: bookingPayload.packageTitle,
      originalOrderId: bookingPayload.originalOrderId || "",
      referralId: bookingPayload.referralId || "",
      referralCode: bookingPayload.referralCode || "",
      couponCode: bookingPayload.couponCode || "",
      client,
    });
    const providers = resolvePaymentProviders();
    const quoteProvider = String(quote.paymentProvider || "").trim().toLowerCase();
    let provider = "";

    if (quoteProvider === "free") {
      if (requestedProvider === "free" || !requestedProvider) {
        provider = "free";
      } else {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            error: "Free checkout cannot be started with a paid provider.",
          },
        };
      }
    } else {
      if (requestedProvider === "free") {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            error: "Paid quotes cannot be forced into the free checkout path.",
          },
        };
      }
      provider = requestedProvider || "";
    }

    if (!provider) {
      return {
        httpStatus: 400,
        body: {
          ok: false,
          error: "A payment provider is required to start checkout.",
        },
      };
    }

    if (provider !== "free" && provider !== "paypal" && provider !== "razorpay") {
      return {
        httpStatus: 400,
        body: { ok: false, error: "Unsupported payment provider." },
      };
    }

    if (
      provider === "paypal" &&
      (!providers?.paypal?.enabled || !providers?.paypal?.clientId)
    ) {
      return {
        httpStatus: 400,
        body: { ok: false, error: "PayPal is not available in this environment." },
      };
    }

    if (provider === "razorpay" && !providers?.razorpay?.enabled) {
      return {
        httpStatus: 400,
        body: { ok: false, error: "Razorpay is not available in this environment." },
      };
    }

    const { holdDoc } = await assertStartableHold({ client, bookingPayload });
    const record = await createOrReusePaymentRecordForStart({
      client,
      provider,
      bookingPayload,
      holdDoc,
      quote,
    });

    let refreshed = record;
    if (holdDoc?._id) {
      const pendingHold = await markHoldPaymentPending({
        client,
        holdDoc,
        bookingPayload: { ...bookingPayload, paymentProvider: provider },
        paymentRecordId: record._id,
      });
      refreshed = await syncPaymentRecordHoldState({
        client,
        record,
        holdDoc: pendingHold,
        slotHoldToken: bookingPayload.slotHoldToken,
      });
    }
    if (!refreshed?._id) {
      refreshed = await getPaymentRecordById(client, record._id);
    }
    const paymentAccessToken = issuePaymentAccessTokenForRecord(refreshed);
    if (provider === "free") {
      const finalized = await finalizePaymentRecordInternal({
        client,
        record: refreshed,
        source: "start",
        providerData: {},
      });
      return {
        httpStatus: finalized.httpStatus,
        body: {
          ...finalized.response,
          provider,
          quote: buildQuotePayload(quote),
          paymentAccessToken,
        },
      };
    }

    return {
      httpStatus: 200,
      body: {
        ok: true,
        status: PAYMENT_STATUS_STARTED,
        provider,
        quote: buildQuotePayload(quote),
        providerPayload: buildProviderPayloadFromRecord(refreshed),
        paymentAccessToken,
      },
    };
  } catch (error) {
    return {
      httpStatus: Number(error?.status) || 500,
      body: {
        ok: false,
        error: error?.message || "Failed to start payment.",
        code: error?.code || "",
      },
    };
  }
};

const loadPaymentRecordForFinalize = async ({
  client,
  paymentRecordId = "",
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  if (paymentRecordId) {
    const byId = await getPaymentRecordById(client, paymentRecordId);
    if (byId?._id) return byId;
  }

  return findPaymentRecordByProviderData({
    client,
    provider,
    providerOrderId,
    providerPaymentId,
  });
};

export const finalizePaymentSession = async ({
  body,
  client = createRefWriteClient(),
}) => {
  const requestBody = normalizeObject(body);
  const providerData = normalizeObject(requestBody.providerData);
  const flatProviderData = {
    ...providerData,
    ...requestBody,
  };
  let resolved = null;
  try {
    resolved = await resolveRecordFromAccessToken({
      client,
      paymentAccessToken: String(requestBody.paymentAccessToken || "").trim(),
      allowRecoveryExtension: true,
    });
  } catch (error) {
    return {
      httpStatus: Number(error?.status) || 401,
      body: {
        ok: false,
        error: error?.message || "Invalid payment session.",
        code: error?.code || "",
      },
    };
  }

  const record = resolved?.record;
  if (
    isPaymentTerminalStatus(record?.status) &&
    String(record?.status || "").trim().toLowerCase() !== PAYMENT_STATUS_NEEDS_RECOVERY
  ) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        error: "Payment session is already terminal.",
        ...buildPublicStatusBody(record),
      },
    };
  }

  const finalized = await finalizePaymentRecordInternal({
    client,
    record,
    source: "client",
    providerData: flatProviderData,
  });

  return {
    httpStatus: finalized.httpStatus,
    body: finalized.response,
  };
};

const getPaymentAgeMinutes = (record = {}) => {
  const reference = record.lastAttemptAt || record.updatedAt || record.createdAt;
  if (!reference) return 0;
  const diffMs = Date.now() - new Date(reference).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return diffMs / (60 * 1000);
};

export const getPaymentStatus = async ({
  query,
  client = createRefWriteClient(),
}) => {
  const paymentAccessToken = String(
    query?.paymentAccessToken || query?.payment || ""
  ).trim();
  if (!paymentAccessToken) {
    return {
      httpStatus: 401,
      body: {
        ok: false,
        error: "Missing payment access token.",
      },
    };
  }

  let resolved = null;
  try {
    resolved = await resolveRecordFromAccessToken({
      client,
      paymentAccessToken,
      allowRecoveryExtension: true,
    });
  } catch (error) {
    return {
      httpStatus: Number(error?.status) || 401,
      body: {
        ok: false,
        error: error?.message || "Invalid payment session.",
        code: error?.code || "",
      },
    };
  }
  let record = resolved.record;

  if (
    String(record.status || "").trim().toLowerCase() === PAYMENT_STATUS_STARTED &&
    getPaymentAgeMinutes(record) >= PAYMENT_HOLD_MINUTES
  ) {
    const abandoned = await abandonStartedPaymentRecord({
      client,
      record,
      reason: "payment_session_expired_before_capture",
    });
    record = abandoned.paymentRecord;
  }

  return {
    httpStatus: 200,
    body: buildPublicStatusBody(record),
  };
};

const authorizeCron = (req) => {
  const configured = String(process.env.CRON_SECRET || "").trim();
  if (!configured) {
    const error = new Error("CRON_SECRET is required.");
    error.status = 500;
    throw error;
  }

  const provided =
    String(req?.headers?.["x-cron-secret"] || "").trim() ||
    String(req?.headers?.authorization || "")
      .replace(/^Bearer\s+/i, "")
      .trim() ||
    String(req?.body?.cronSecret || "").trim();
  if (!provided || provided !== configured) {
    const error = new Error("Unauthorized request.");
    error.status = 403;
    throw error;
  }
};

export const reconcilePaymentSessions = async ({
  req,
  client = createRefWriteClient(),
}) => {
  try {
    authorizeCron(req);
  } catch (error) {
    return {
      httpStatus: Number(error?.status) || 500,
      body: {
        ok: false,
        error: error?.message || "Failed to authorize reconcile request.",
      },
    };
  }

  const records = await client.fetch(
    `*[_type == $type
      && lower(status) in $statuses
    ] | order(updatedAt asc)[0...50]`,
    {
      type: PAYMENT_RECORD_TYPE,
      statuses: [
        PAYMENT_STATUS_STARTED,
        PAYMENT_STATUS_CAPTURED_CLIENT,
        PAYMENT_STATUS_CAPTURED_WEBHOOK,
        PAYMENT_STATUS_FINALIZING,
      ],
    }
  );

  const summary = {
    scanned: 0,
    finalized: 0,
    abandoned: 0,
    recovery: 0,
  };

  for (const record of Array.isArray(records) ? records : []) {
    summary.scanned += 1;
    const ageMinutes = getPaymentAgeMinutes(record);
    const status = String(record.status || "").trim().toLowerCase();

    if (status === PAYMENT_STATUS_STARTED && ageMinutes >= PAYMENT_HOLD_MINUTES) {
      const abandoned = await abandonStartedPaymentRecord({
        client,
        record,
        reason: "payment_session_expired_before_capture",
      });
      if (abandoned.paymentRecord?._id) summary.abandoned += 1;
      continue;
    }

    if (!isPaymentPendingStatus(status)) {
      continue;
    }

    if (ageMinutes < PAYMENT_RECOVERY_MINUTES && status !== PAYMENT_STATUS_FINALIZING) {
      continue;
    }

    const result = await finalizePaymentRecordInternal({
      client,
      record,
      source: "reconcile",
      providerData: {},
    });
    const nextStatus = String(result?.response?.status || "").trim().toLowerCase();
    if (nextStatus === PAYMENT_STATUS_BOOKED || nextStatus === PAYMENT_STATUS_EMAIL_PARTIAL) {
      summary.finalized += 1;
    } else if (nextStatus === PAYMENT_STATUS_NEEDS_RECOVERY) {
      summary.recovery += 1;
    }
  }

  return {
    httpStatus: 200,
    body: {
      ok: true,
      summary,
    },
  };
};

const findOrCreateWebhookRecoveryRecord = async ({
  client,
  provider,
  providerOrderId = "",
  providerPaymentId = "",
  payerEmail = "",
  eventType = "",
}) => {
  const existing = await loadPaymentRecordForFinalize({
    client,
    provider,
    providerOrderId,
    providerPaymentId,
  });
  if (existing?._id) return existing;

  const existingBooking = await getLegacyBookingByProviderData({
    client,
    provider,
    providerOrderId,
    providerPaymentId,
  });
  if (existingBooking?._id) {
    return mirrorLegacyBookingToPaymentRecord({
      client,
      provider,
      providerOrderId,
      providerPaymentId,
      payerEmail,
      booking: existingBooking,
      source: "webhook",
      eventType,
    });
  }

  const paymentRecordId = buildPaymentRecordId({
    provider,
    providerOrderId,
    providerPaymentId,
    bookingSeedKey: `${provider}:${providerOrderId}:${providerPaymentId}:${eventType}`,
  });

  return upsertPaymentRecord({
    client,
    doc: {
      _id: paymentRecordId,
      provider,
      status: PAYMENT_STATUS_NEEDS_RECOVERY,
      bookingSeedKey: "",
      bookingFinalizationKey: "",
      bookingPayload: {},
      pricingSnapshot: {},
      holdSnapshot: {},
      providerOrderId,
      providerPaymentId,
      payerEmail,
      verificationState: "",
      verificationWarning: "",
      bookingId: "",
      recoveryReason: "missing_payment_record_for_webhook_event",
      attemptCount: 1,
      lastAttemptAt: nowIso(),
      source: "webhook",
      providerPublicData: {},
      emailDispatch: {},
      events: [
        buildPaymentRecordEvent({
          status: PAYMENT_STATUS_NEEDS_RECOVERY,
          source: "webhook",
          reason: "missing_payment_record_for_webhook_event",
          data: { eventType, providerOrderId, providerPaymentId },
        }),
      ],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  });
};

export const handleRazorpayWebhook = async ({
  req,
  client = createRefWriteClient(),
}) => {
  const signature = String(req?.headers?.["x-razorpay-signature"] || "").trim();
  const verified = verifyRazorpayWebhookSignature({
    rawBody: String(req?.rawBody || ""),
    signature,
  });
  if (!verified) {
    return {
      httpStatus: 401,
      body: {
        ok: false,
        error: "Invalid Razorpay webhook signature.",
      },
    };
  }

  const event = normalizeObject(req?.body);
  const eventType = String(event?.event || "").trim();
  const payment = normalizeObject(event?.payload?.payment?.entity);
  if (!eventType || !payment?.id) {
    return {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  }

  if (eventType !== "payment.captured" && eventType !== "order.paid") {
    return {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  }

  const record = await findOrCreateWebhookRecoveryRecord({
    client,
    provider: "razorpay",
    providerOrderId: String(payment.order_id || "").trim(),
    providerPaymentId: String(payment.id || "").trim(),
    payerEmail: String(payment.email || "").trim(),
    eventType,
  });

  const finalized = await finalizePaymentRecordInternal({
    client,
    record,
    source: "webhook",
    providerData: {
      razorpayOrderId: String(payment.order_id || "").trim(),
      razorpayPaymentId: String(payment.id || "").trim(),
      payerEmail: String(payment.email || "").trim(),
    },
  });

  return {
    httpStatus: finalized.httpStatus,
    body: finalized.response,
  };
};

export const handlePayPalWebhook = async ({
  req,
  client = createRefWriteClient(),
}) => {
  const verified = await verifyPayPalWebhookSignature({
    rawBody: String(req?.rawBody || ""),
    headers: normalizeObject(req?.headers),
  });
  if (!verified.ok) {
    return {
      httpStatus: 401,
      body: {
        ok: false,
        error: verified.reason || "Invalid PayPal webhook signature.",
      },
    };
  }

  const event = normalizeObject(req?.body);
  const eventType = String(event?.event_type || "").trim();
  if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
    return {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  }

  const resource = normalizeObject(event?.resource);
  const relatedIds = normalizeObject(resource?.supplementary_data?.related_ids);
  const orderId = String(relatedIds.order_id || "").trim();
  const captureId = String(resource.id || "").trim();
  const payerEmail = String(resource?.payer?.email_address || "").trim();
  const record = await findOrCreateWebhookRecoveryRecord({
    client,
    provider: "paypal",
    providerOrderId: orderId,
    providerPaymentId: captureId,
    payerEmail,
    eventType,
  });

  const finalized = await finalizePaymentRecordInternal({
    client,
    record,
    source: "webhook",
    providerData: {
      paypalOrderId: orderId,
      paypalPaymentId: captureId,
      payerEmail,
    },
  });

  return {
    httpStatus: finalized.httpStatus,
    body: finalized.response,
  };
};
