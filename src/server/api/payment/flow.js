import crypto from "crypto";
import { getSafeErrorCode } from "../../safeErrorLog.js";
import { authorizeCronRequest } from "../cronAuth.js";
import createBookingHandler from "../ref/createBooking.js";
import { createCommerceWriteClient } from "../ref/sanity.js";
import { resolvePaymentQuote } from "../ref/pricing.js";
import {
  freezeUpgradeIntent,
  verifyUpgradeIntentToken,
} from "../ref/upgradeIntentToken.js";
import { getBookingSettings, isSlotAllowedForPackage } from "../../booking/slotPolicy.js";
import { issueHoldToken, verifyHoldToken } from "../../booking/holdToken.js";
import providerConfig from "./providerConfig.js";
import {
  createPayPalOrder,
  createRazorpayOrder,
  DEFAULT_PAYPAL_CURRENCY,
  DEFAULT_RAZORPAY_CURRENCY,
  inspectPayPalOrder,
  inspectRazorpayOrder,
  inspectRazorpayPayment,
  toMoney,
  toSubunits,
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
  buildPaymentProofClaimId,
  buildPaymentProviderIdempotencyKey,
  buildPricingFingerprint,
  buildQuoteFingerprint,
  buildPaymentRecordEvent,
  buildPaymentRecordId,
  buildPaymentSessionRecordId,
  buildPaymentSessionScope,
  buildPaymentStartClaimId,
  buildPaymentUpgradeLockId,
  buildWebhookReceiptId,
  findPaymentRecordByProviderData,
  getPaymentHoldExpiryIso,
  getNextPaymentRecoveryAt,
  getPaymentRecordById,
  HOLD_PHASE_HOLDING,
  HOLD_PHASE_PAYMENT_PENDING,
  isPaymentPendingStatus,
  isPaymentTerminalStatus,
  mergePaymentRecordEvents,
  PAYMENT_HOLD_MINUTES,
  PAYMENT_RECOVERY_MINUTES,
  PAYMENT_RECORD_TYPE,
  PAYMENT_PROOF_CLAIM_TYPE,
  PAYMENT_START_CLAIM_TYPE,
  PAYMENT_UPGRADE_LOCK_TYPE,
  PAYMENT_WEBHOOK_RECEIPT_TYPE,
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
import { selectPaymentAuthority } from "./backend.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";

export { authorizeCronRequest };

const { resolvePaymentProviders, resolveServerPaymentSessionsEnabled } =
  providerConfig;

const FINALIZATION_LEASE_SECONDS = 90;
const WEBHOOK_LEASE_SECONDS = 120;
const LATE_CAPTURE_WATCH_HOURS = 24;

const normalizeObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const nowIso = () => new Date().toISOString();

const getFutureIso = (seconds) =>
  new Date(Date.now() + Math.max(1, Number(seconds) || 1) * 1000).toISOString();

const isConflictError = (error) =>
  Number(error?.statusCode || error?.status || 0) === 409;

const isFutureIso = (value) => {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
};

const isDefinitiveMissingProviderOrder = (inspection = {}) =>
  inspection.state === "unavailable" &&
  /^(paypal|razorpay)_lookup_failed_404$/.test(
    String(inspection.reason || "").trim().toLowerCase()
  );

const fromSubunits = (value, currency = "USD") => {
  const factor = String(currency || "").trim().toUpperCase() === "JPY" ? 1 : 100;
  return toMoney(Number(value || 0) / factor);
};

const isLegacyCheckoutCompatibilityOpen = () => {
  const deadline = String(process.env.PAYMENT_LEGACY_CHECKOUT_UNTIL || "").trim();
  return !!deadline && isFutureIso(deadline);
};

const loadBookingRefundHandler = async () => {
  try {
    const module = await import("../ref/bookingRefunds.js");
    return module.applyBookingRefund || module.applyFullPaymentRefund || null;
  } catch (error) {
    if (String(error?.code || "") === "MODULE_NOT_FOUND") return null;
    throw error;
  }
};

const loadRequiresRescheduleHandler = async () => {
  try {
    const module = await import("../ref/bookingCommit.js");
    return module.createRequiresRescheduleBooking || null;
  } catch (error) {
    if (String(error?.code || "") === "MODULE_NOT_FOUND") return null;
    throw error;
  }
};

const loadCouponReservationHandlers = async () => {
  try {
    const module = await import("../ref/couponReservations.js");
    return {
      prepareCouponReservation: module.prepareCouponReservation || null,
      appendCouponReservation: module.appendCouponReservation || null,
      prepareCouponRelease: module.prepareCouponRelease || null,
      appendCouponRelease: module.appendCouponRelease || null,
      releaseCouponReservation: module.releaseCouponReservation || null,
    };
  } catch (error) {
    if (String(error?.code || "") === "MODULE_NOT_FOUND") return {};
    throw error;
  }
};

const loadRescheduleNotificationHandler = async () => {
  try {
    const module = await import("../ref/bookingEmails.js");
    return module.dispatchRescheduleNotifications || null;
  } catch (error) {
    if (String(error?.code || "") === "MODULE_NOT_FOUND") return null;
    throw error;
  }
};

const buildRefreshedHoldBody = (record = {}) => {
  const hold = normalizeObject(record.holdSnapshot);
  if (!String(hold.slotHoldId || "").trim()) return null;
  return {
    slotHoldId: String(hold.slotHoldId || "").trim(),
    slotHoldToken: String(hold.slotHoldToken || "").trim(),
    slotHoldExpiresAt: String(hold.slotHoldExpiresAt || "").trim(),
    phase: String(hold.phase || HOLD_PHASE_PAYMENT_PENDING).trim(),
  };
};

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

const sanitizeProviderFinalizeData = (payload = {}) => {
  const normalized = normalizeObject(payload);
  return {
    paypalOrderId: String(normalized.paypalOrderId || "").trim(),
    paypalPaymentId: String(normalized.paypalPaymentId || "").trim(),
    payerEmail: String(normalized.payerEmail || "").trim(),
    razorpayOrderId: String(normalized.razorpayOrderId || "").trim(),
    razorpayPaymentId: String(normalized.razorpayPaymentId || "").trim(),
    razorpaySignature: String(normalized.razorpaySignature || "").trim(),
  };
};

const getLegacySuccessStatus = (emailDispatch = {}) =>
  emailDispatch?.allSent === false
    ? PAYMENT_STATUS_EMAIL_PARTIAL
    : PAYMENT_STATUS_BOOKED;

const isEmailDispatchComplete = (emailDispatch = {}) => {
  const dispatch = normalizeObject(emailDispatch);
  if (dispatch.allSent === true) return true;
  return !!dispatch.client?.sent && !!dispatch.owner?.sent;
};

const shouldRetryEmailPartialDispatch = ({ record, source = "" }) => {
  const status = String(record?.status || "").trim().toLowerCase();
  if (record?.requiresReschedule === true) return false;
  const emailRecoveryPending =
    status === PAYMENT_STATUS_EMAIL_PARTIAL ||
    (status === PAYMENT_STATUS_BOOKED && record?.emailDispatchRequired === true);
  if (!emailRecoveryPending) return false;
  if (String(source || "").trim().toLowerCase() === "client") return false;
  return !isEmailDispatchComplete(record?.emailDispatch);
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
    const error = new Error("Your slot reservation expired.");
    error.status = 409;
    throw error;
  }

  const validToken = verifyHoldToken({
    token: bookingPayload.slotHoldToken,
    holdId: bookingPayload.slotHoldId,
    startTimeUTC: holdDoc.startTimeUTC || bookingPayload.startTimeUTC,
    holdNonce: holdDoc.holdNonce || "",
    backend: holdDoc.backendOwner === "supabase" ? "supabase" : "sanity",
    cutoverGeneration: Number(holdDoc.cutoverGeneration || 0),
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
  couponDiscountType: String(quote.couponDiscountType || "").trim(),
  couponDiscountValue: Number(quote.couponDiscountValue || 0),
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

const getPublicRecoveryMessage = (record = {}) => {
  const status = String(record.status || "").trim().toLowerCase();
  if (record.requiresReschedule === true) {
    return "Your payment is safe, but the original time needs to be rescheduled. Roo Industries will contact you.";
  }
  if (status === PAYMENT_STATUS_NEEDS_RECOVERY || status === PAYMENT_STATUS_FINALIZING) {
    return "Payment confirmation is taking longer than expected. Please keep this session and try the status check again shortly.";
  }
  if (status === PAYMENT_STATUS_ABANDONED) {
    return "This payment session was released and is no longer payable.";
  }
  if (status === PAYMENT_STATUS_REFUNDED) {
    return "This payment has been refunded.";
  }
  if (status === PAYMENT_STATUS_FAILED) {
    return "Payment could not be completed.";
  }
  return "";
};

const buildPublicEmailDispatch = (dispatch = {}) => ({
  allSent: dispatch?.allSent === true,
  client: { sent: dispatch?.client?.sent === true },
  owner: { sent: dispatch?.owner?.sent === true },
});

const buildPublicFailure = ({
  error,
  fallbackStatus = 500,
  fallbackMessage = "Payment service is temporarily unavailable.",
}) => {
  const suppliedStatus = Number(error?.status || 0);
  const httpStatus =
    suppliedStatus >= 400 && suppliedStatus <= 599
      ? suppliedStatus
      : fallbackStatus;
  const clientError = httpStatus >= 400 && httpStatus < 500;
  const normalizedCode = String(error?.code || "").trim();
  const publicServerCode =
    /^(paypal|razorpay|provider)_[a-z0-9_:-]{1,70}$/i.test(normalizedCode) &&
    !/(credential|secret|internal)/i.test(normalizedCode);
  return {
    httpStatus,
    body: {
      ok: false,
      error:
        clientError && String(error?.message || "").trim()
          ? error.message
          : fallbackMessage,
      ...((clientError || publicServerCode) && normalizedCode
        ? { code: normalizedCode }
        : {}),
    },
  };
};

const buildPublicStatusBody = (record = {}) => ({
  ok: true,
  status: String(record.status || "").trim(),
  provider: String(record.provider || "").trim(),
  bookingId: String(record.bookingId || "").trim(),
  recoveryReason: getPublicRecoveryMessage(record),
  nextRecoveryAt: String(record.nextRecoveryAt || "").trim(),
  sessionExpiresAt: String(
    record?.holdSnapshot?.slotHoldExpiresAt || record.sessionExpiresAt || ""
  ).trim(),
  refundState: String(record.refundState || "").trim(),
  refundRequiresBookingSync: record.refundRequiresBookingSync === true,
  emailDispatch: buildPublicEmailDispatch(record.emailDispatch),
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
    backend: record.backendOwner || "sanity",
    cutoverGeneration: Number(record.cutoverGeneration || 0),
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

const canFinalizeAbandonedRecord = ({ status = "", source = "" }) =>
  String(status || "").trim().toLowerCase() === PAYMENT_STATUS_ABANDONED &&
  isTrustedRecoverySource(String(source || "").trim().toLowerCase());

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
  couponDiscountType: String(quote.couponDiscountType || "").trim(),
  couponDiscountValue: Number(quote.couponDiscountValue || 0),
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
  backendOwner = "supabase",
  cutoverGeneration = 0,
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
    backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
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
      couponDiscountType: String(booking.couponDiscountType || "").trim(),
      couponDiscountValue: Number(booking.couponDiscountValue || 0),
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
  allowStatusReadExtension = false,
}) => {
  const tokenResult = verifyPaymentAccessToken({ token: paymentAccessToken });
  if (!tokenResult.ok && !tokenResult.expired) {
    const error = new Error("Invalid payment session.");
    error.status = 401;
    error.code = tokenResult.reason || "payment_access_token_invalid";
    throw error;
  }

  const payload = tokenResult.payload || {};
  const authority = selectPaymentAuthority({
    backendOwner: payload.backend,
    cutoverGeneration: payload.cutoverGeneration,
  });
  const resolvedClient =
    client ||
    createCommerceWriteClient({
      backendOverride: authority,
    });
  const record = await getPaymentRecordById(
    resolvedClient,
    payload.paymentRecordId
  );
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
    const withinHardCap = isWithinPaymentAccessRecoveryWindow({ payload });
    const recoveryMutationAllowed =
      allowRecoveryExtension && status === PAYMENT_STATUS_NEEDS_RECOVERY;
    if (!withinHardCap || (!allowStatusReadExtension && !recoveryMutationAllowed)) {
      const error = new Error("Payment session expired.");
      error.status = 401;
      error.code = tokenResult.reason || "payment_access_token_expired";
      throw error;
    }
  }

  return { payload, record, client: resolvedClient };
};

const getSubmittedProviderIdentifiers = ({ record = {}, providerData = {} }) => {
  const provider = String(record.provider || "").trim().toLowerCase();
  if (provider === "razorpay") {
    return {
      providerOrderId: String(providerData.razorpayOrderId || "").trim(),
      providerPaymentId: String(providerData.razorpayPaymentId || "").trim(),
    };
  }
  if (provider === "paypal") {
    return {
      providerOrderId: String(providerData.paypalOrderId || "").trim(),
      providerPaymentId: String(providerData.paypalPaymentId || "").trim(),
    };
  }
  return { providerOrderId: "", providerPaymentId: "" };
};

const validateImmutableProviderBinding = ({ record = {}, providerData = {} }) => {
  const submitted = getSubmittedProviderIdentifiers({ record, providerData });
  const storedOrderId = String(record.providerOrderId || "").trim();
  const storedPaymentId = String(record.providerPaymentId || "").trim();

  if (
    submitted.providerOrderId &&
    storedOrderId &&
    submitted.providerOrderId !== storedOrderId
  ) {
    return { ok: false, reason: "provider_order_id_mismatch" };
  }
  if (
    submitted.providerPaymentId &&
    storedPaymentId &&
    submitted.providerPaymentId !== storedPaymentId
  ) {
    return { ok: false, reason: "provider_payment_id_mismatch" };
  }
  return { ok: true, ...submitted };
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

  const binding = validateImmutableProviderBinding({ record, providerData });
  if (!binding.ok) {
    return { ok: false, retryable: false, reason: binding.reason };
  }

  if (provider === "razorpay") {
    const orderId = String(record.providerOrderId || binding.providerOrderId || "").trim();
    const paymentId = String(
      binding.providerPaymentId || record.providerPaymentId || ""
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
        captured: verification.captured === true,
        retryable: isTransientVerificationFailure(verification.reason),
        reason: verification.reason || "razorpay_verification_failed",
      };
    }

    return {
      ok: true,
      trustedCapture: true,
      payerEmail: "",
      providerOrderId: orderId,
      providerPaymentId: paymentId,
    };
  }

  if (provider === "paypal") {
    const orderId = String(record.providerOrderId || binding.providerOrderId || "").trim();
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
        captured: verification.captured === true,
        retryable: isTransientVerificationFailure(verification.reason),
        reason: verification.reason || "paypal_verification_failed",
      };
    }

    return {
      ok: true,
      trustedCapture: true,
      payerEmail: String(verification.payerEmail || "").trim(),
      providerOrderId: orderId,
      providerPaymentId: String(
        verification.providerPaymentId || binding.providerPaymentId || ""
      ).trim(),
    };
  }

  return { ok: false, retryable: false, reason: "payment_provider_unsupported" };
};

const patchPaymentRecord = async ({
  client,
  record,
  set = {},
  event = null,
  revisionGuard = false,
}) => {
  const existingEvents = Array.isArray(record?.events) ? record.events : [];
  const mergedEvents = event
    ? mergePaymentRecordEvents(existingEvents, event)
    : existingEvents;
  let patch = client
    .patch(record._id)
    .set({
      ...set,
      ...(event ? { events: mergedEvents } : {}),
      updatedAt: nowIso(),
    });
  if (revisionGuard && record?._rev && typeof patch.ifRevisionId === "function") {
    patch = patch.ifRevisionId(record._rev);
  }
  const committed = await patch.commit();

  return {
    ...record,
    ...normalizeObject(committed),
    ...set,
    ...(event ? { events: mergedEvents } : {}),
    updatedAt: nowIso(),
  };
};

const upsertPaymentRecord = async ({ client, doc }) => {
  const existing = await getPaymentRecordById(client, doc._id);
  if (existing?._id) return existing;

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

const getDocumentById = async ({ client, id, type }) => {
  if (!id) return null;
  return client.fetch(`*[_type == $type && _id == $id][0]`, { type, id });
};

const createStartClaimAndRecord = async ({
  client,
  claim,
  record,
  holdDoc = null,
  holdPatch = {},
  couponReservationPlan = null,
  appendCouponReservation = null,
}) => {
  if (typeof client?.transaction !== "function") {
    const error = new Error("Atomic payment storage is unavailable.");
    error.status = 503;
    error.code = "payment_transaction_unavailable";
    throw error;
  }

  try {
    let transaction = client.transaction().create(claim).create(record);
    if (couponReservationPlan && typeof appendCouponReservation === "function") {
      transaction = appendCouponReservation({
        transaction,
        ...couponReservationPlan,
      });
    }
    if (holdDoc?._id) {
      transaction = transaction.patch(holdDoc._id, (patch) => {
        let next = patch.set(holdPatch);
        if (holdDoc._rev && typeof next.ifRevisionId === "function") {
          next = next.ifRevisionId(holdDoc._rev);
        }
        return next;
      });
    }
    if (client?.backend === "supabase") {
      await transaction.commit({ commandId: `payment-start:${claim._id}` });
    } else {
      await transaction.commit();
    }
    return getPaymentRecordById(client, record._id);
  } catch (error) {
    if (!isConflictError(error)) throw error;
    const existingClaim = await getDocumentById({
      client,
      id: claim._id,
      type: claim._type || PAYMENT_START_CLAIM_TYPE,
    });
    const existingRecordId = String(existingClaim?.paymentRecordId || "").trim();
    const existingRecord = await getPaymentRecordById(client, existingRecordId);
    if (!existingRecord?._id) throw error;
    return existingRecord;
  }
};

const attachImmutableProviderOrder = async ({ client, record, providerPayload }) => {
  const providerOrderId = String(providerPayload?.orderId || "").trim();
  if (!providerOrderId) {
    const error = new Error("Provider order creation did not return an order ID.");
    error.status = 502;
    error.code = "provider_order_id_missing";
    throw error;
  }

  const existingOrderId = String(record?.providerOrderId || "").trim();
  if (existingOrderId) {
    if (existingOrderId !== providerOrderId) {
      const error = new Error("Payment provider order is already bound to this session.");
      error.status = 409;
      error.code = "provider_order_immutable";
      throw error;
    }
    return record;
  }

  try {
    return await patchPaymentRecord({
      client,
      record,
      revisionGuard: true,
      set: {
        providerOrderId,
        providerPublicData: providerPayload,
        bookingFinalizationKey:
          record.provider === "paypal"
            ? `paypal:${providerOrderId}`
            : `razorpay-order:${providerOrderId}`,
        orderState: "created",
        orderCreationLeaseId: "",
        orderCreationLeaseExpiresAt: "",
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_STARTED,
        source: "start",
        reason: "provider_order_created",
        data: { providerOrderId },
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    const current = await getPaymentRecordById(client, record._id);
    if (String(current?.providerOrderId || "").trim() === providerOrderId) {
      return current;
    }
    const conflict = new Error("Payment session changed while creating the order.");
    conflict.status = 409;
    conflict.code = "provider_order_bind_conflict";
    throw conflict;
  }
};

const getPaymentProofClaimIdForRecord = ({
  record,
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const provider = String(record?.provider || "").trim().toLowerCase();
  return (
    provider === "free"
      ? `paymentProofClaim.free.${crypto
          .createHash("sha256")
          .update(String(record._id || ""))
          .digest("hex")
          .slice(0, 40)}`
      : buildPaymentProofClaimId({
          provider: record.provider,
          providerOrderId,
          providerPaymentId,
        })
  );
};

const preparePaymentProofClaim = async ({
  client,
  record,
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const claimId = getPaymentProofClaimIdForRecord({
    record,
    providerOrderId,
    providerPaymentId,
  });
  if (!claimId) {
    const error = new Error("Captured payment proof is incomplete.");
    error.status = 400;
    error.code = "payment_proof_missing";
    throw error;
  }

  const existing = await getDocumentById({
    client,
    id: claimId,
    type: PAYMENT_PROOF_CLAIM_TYPE,
  });
  if (existing?._id) {
    if (String(existing.paymentRecordId || "") !== String(record._id || "")) {
      const error = new Error("This payment has already been used for another booking.");
      error.status = 409;
      error.code = "payment_proof_already_claimed";
      throw error;
    }
    return existing;
  }

  const claim = {
    _id: claimId,
    _type: PAYMENT_PROOF_CLAIM_TYPE,
    backendOwner: record.backendOwner === "supabase" ? "supabase" : "sanity",
    paymentRecordId: record._id,
    provider: record.provider,
    providerOrderId: String(providerOrderId || "").trim(),
    providerPaymentId: String(providerPaymentId || "").trim(),
    claimedAt: nowIso(),
  };
  return claim;
};

const normalizeMarkedDuplicatePaymentRecord = async ({
  client,
  record,
  providerOrderId = "",
  providerPaymentId = "",
  error = null,
}) => {
  if (String(error?.code || "") !== "payment_proof_already_claimed") return null;
  const canonicalPaymentRecordId = String(
    record?.canonicalPaymentRecordId || ""
  ).trim();
  if (record?.duplicatePaymentRecord !== true || !canonicalPaymentRecordId) {
    return null;
  }

  const claimId =
    String(record.paymentProofClaimId || "").trim() ||
    getPaymentProofClaimIdForRecord({
      record,
      providerOrderId,
      providerPaymentId,
    });
  const claim = await getDocumentById({
    client,
    id: claimId,
    type: PAYMENT_PROOF_CLAIM_TYPE,
  });
  if (
    !claim?._id ||
    String(claim.paymentRecordId || "").trim() !== canonicalPaymentRecordId
  ) {
    return null;
  }

  const canonical = await getPaymentRecordById(client, canonicalPaymentRecordId);
  if (!canonical?._id) return null;
  const bookingId = String(claim.bookingId || canonical.bookingId || "").trim();
  const canonicalStatus = String(canonical.status || "").trim().toLowerCase();
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  const status = bookingId
    ? canonicalStatus === PAYMENT_STATUS_REFUNDED
      ? PAYMENT_STATUS_REFUNDED
      : PAYMENT_STATUS_BOOKED
    : PAYMENT_STATUS_NEEDS_RECOVERY;
  const set = {
    canonicalPaymentRecordId,
    duplicatePaymentRecord: true,
    paymentProofClaimId: claim._id,
    bookingId,
    status,
    recoveryReason: bookingId ? "" : "canonical_payment_pending",
    recoveryAttemptCount,
    nextRecoveryAt: bookingId
      ? ""
      : getNextPaymentRecoveryAt(recoveryAttemptCount),
    emailDispatchRequired: false,
    finalizationLeaseId: "",
    finalizationLeaseExpiresAt: "",
  };

  try {
    return await patchPaymentRecord({
      client,
      record,
      revisionGuard: true,
      set,
      event: buildPaymentRecordEvent({
        status,
        source: "reconcile",
        reason: bookingId
          ? "duplicate_payment_record_linked"
          : "duplicate_payment_record_waiting_for_canonical",
        data: { canonicalPaymentRecordId, bookingId },
      }),
    });
  } catch (patchError) {
    if (!isConflictError(patchError)) throw patchError;
    return getPaymentRecordById(client, record._id);
  }
};

const acquireFinalizationLease = async ({ client, record, source }) => {
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const currentStatus = String(current.status || "").trim().toLowerCase();
  const abandonedCaptureRecovery = canFinalizeAbandonedRecord({
    status: currentStatus,
    source,
  });
  const emailRecoveryPending = shouldRetryEmailPartialDispatch({
    record: current,
    source,
  });
  if (
    isPaymentTerminalStatus(currentStatus) &&
    currentStatus !== PAYMENT_STATUS_NEEDS_RECOVERY &&
    !abandonedCaptureRecovery &&
    !emailRecoveryPending
  ) {
    return {
      acquired: false,
      terminal: true,
      record: current,
      leaseId: "",
      previousStatus: currentStatus,
    };
  }
  if (
    currentStatus === PAYMENT_STATUS_FINALIZING &&
    isFutureIso(current.finalizationLeaseExpiresAt)
  ) {
    return {
      acquired: false,
      record: current,
      leaseId: "",
      previousStatus: currentStatus,
    };
  }

  const leaseId = crypto.randomUUID();
  try {
    const leased = await patchPaymentRecord({
      client,
      record: current,
      revisionGuard: true,
      set: {
        status: PAYMENT_STATUS_FINALIZING,
        source,
        finalizationLeaseId: leaseId,
        finalizationLeaseExpiresAt: getFutureIso(FINALIZATION_LEASE_SECONDS),
        attemptCount: Number(current.attemptCount || 0) + 1,
        lastAttemptAt: nowIso(),
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_FINALIZING,
        source,
        reason: "finalization_lease_acquired",
      }),
    });
    return {
      acquired: true,
      record: leased,
      leaseId,
      previousStatus: currentStatus,
    };
  } catch (error) {
    if (!isConflictError(error)) throw error;
    const fresh = (await getPaymentRecordById(client, record._id)) || current;
    const freshStatus = String(fresh.status || "").trim().toLowerCase();
    const freshEmailRecovery = shouldRetryEmailPartialDispatch({
      record: fresh,
      source,
    });
    const freshAbandonedCaptureRecovery = canFinalizeAbandonedRecord({
      status: freshStatus,
      source,
    });
    return {
      acquired: false,
      terminal:
        isPaymentTerminalStatus(freshStatus) &&
        freshStatus !== PAYMENT_STATUS_NEEDS_RECOVERY &&
        !freshAbandonedCaptureRecovery &&
        !freshEmailRecovery,
      record: fresh,
      leaseId: "",
      previousStatus: freshStatus,
    };
  }
};

const getWebhookReceipt = ({ client, id }) =>
  getDocumentById({ client, id, type: PAYMENT_WEBHOOK_RECEIPT_TYPE });

const claimWebhookReceipt = async ({
  client,
  provider,
  eventId,
  eventType,
  rawBody,
  backendOwner = "supabase",
}) => {
  const receiptId = buildWebhookReceiptId({ provider, eventId, eventType, rawBody });
  const existing = await getWebhookReceipt({ client, id: receiptId });
  if (existing?._id && existing.status === "processed") {
    return { acquired: false, processed: true, receipt: existing };
  }
  if (
    existing?._id &&
    existing.status === "processing" &&
    isFutureIso(existing.leaseExpiresAt)
  ) {
    return { acquired: false, processed: false, receipt: existing };
  }

  const leaseId = crypto.randomUUID();
  if (!existing?._id) {
    const receipt = {
      _id: receiptId,
      _type: PAYMENT_WEBHOOK_RECEIPT_TYPE,
      backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
      provider,
      eventId,
      eventType,
      status: "processing",
      leaseId,
      leaseExpiresAt: getFutureIso(WEBHOOK_LEASE_SECONDS),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      return { acquired: true, processed: false, receipt: await client.create(receipt) };
    } catch (error) {
      if (!isConflictError(error)) throw error;
      return claimWebhookReceipt({
        client,
        provider,
        eventId,
        eventType,
        rawBody,
        backendOwner,
      });
    }
  }

  try {
    const receipt = await patchPaymentRecord({
      client,
      record: existing,
      revisionGuard: true,
      set: {
        status: "processing",
        leaseId,
        leaseExpiresAt: getFutureIso(WEBHOOK_LEASE_SECONDS),
      },
    });
    return { acquired: true, processed: false, receipt };
  } catch (error) {
    if (!isConflictError(error)) throw error;
    return { acquired: false, processed: false, receipt: await getWebhookReceipt({ client, id: receiptId }) };
  }
};

const completeWebhookReceipt = async ({ client, receipt, result }) => {
  if (!receipt?._id) return;
  await client
    .patch(receipt._id)
    .set({
      status: "processed",
      httpStatus: Number(result?.httpStatus || 200),
      processedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .commit();
};

const releaseWebhookReceiptForRetry = async ({ client, receipt, result }) => {
  if (!receipt?._id) return;
  try {
    await patchPaymentRecord({
      client,
      record: receipt,
      revisionGuard: true,
      set: {
        status: "retryable",
        httpStatus: Number(result?.httpStatus || 503),
        leaseId: "",
        leaseExpiresAt: "",
        processedAt: "",
      },
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
  }
};

const releasePendingHold = async ({ client, record }) => {
  const holdId = String(record?.holdSnapshot?.slotHoldId || "").trim();
  if (!holdId) return;
  const holdDoc = await getHoldById(client, holdId);
  if (!holdDoc?._id) return;
  if (String(holdDoc.paymentRecordId || "").trim() !== String(record._id || "").trim()) {
    return;
  }
  try {
    let patch = client.patch(holdId).set({
      phase: "released",
      expiresAt: nowIso(),
      paymentRecordId: "",
      paymentProvider: "",
      releaseReason: "payment_session_released",
    });
    if (holdDoc._rev && typeof patch.ifRevisionId === "function") {
      patch = patch.ifRevisionId(holdDoc._rev);
    }
    await patch.commit();
  } catch (error) {
    if (!isConflictError(error)) throw error;
  }
};

const releaseExpiredRecoveryHold = async ({ client, record }) => {
  const holdSnapshot = normalizeObject(record?.holdSnapshot);
  const holdId = String(holdSnapshot.slotHoldId || "").trim();
  if (!holdId) return null;
  const holdDoc = await getHoldById(client, holdId);
  const expiry = new Date(
    holdDoc?.expiresAt || holdSnapshot.slotHoldExpiresAt || ""
  ).getTime();
  if (Number.isFinite(expiry) && expiry > Date.now()) return null;

  const releasedAt = nowIso();
  if (
    holdDoc?._id &&
    String(holdDoc.paymentRecordId || "").trim() === String(record?._id || "").trim()
  ) {
    try {
      let patch = client.patch(holdId).set({
        phase: "released",
        expiresAt: releasedAt,
        paymentRecordId: "",
        paymentProvider: "",
        releaseReason: "payment_recovery_hold_expired",
      });
      if (holdDoc._rev && typeof patch.ifRevisionId === "function") {
        patch = patch.ifRevisionId(holdDoc._rev);
      }
      await patch.commit();
    } catch (error) {
      if (!isConflictError(error)) throw error;
      const current = await getHoldById(client, holdId);
      if (
        current?._id &&
        String(current.paymentRecordId || "").trim() ===
          String(record?._id || "").trim() &&
        !["released", "consumed"].includes(
          String(current.phase || "").trim().toLowerCase()
        )
      ) {
        return null;
      }
    }
  }

  return {
    ...holdSnapshot,
    phase: "released",
    slotHoldExpiresAt: releasedAt,
  };
};

const releaseCouponForPaymentRecord = async ({
  client,
  record,
  reason,
  releaseCouponReservation = null,
}) => {
  const redemptionId = String(record?.couponReservationId || "").trim();
  if (!redemptionId) return null;
  const handler =
    releaseCouponReservation ||
    (await loadCouponReservationHandlers()).releaseCouponReservation;
  if (typeof handler !== "function") {
    throw new Error("Coupon reservation release service is unavailable.");
  }
  return handler({ client, redemptionId, reason });
};

const releaseUpgradeLockForPaymentRecord = async ({ client, record }) => {
  const lockId = String(record?.startClaimId || "").trim();
  if (!lockId.startsWith("paymentUpgradeLock.")) return;
  const lock = await getDocumentById({
    client,
    id: lockId,
    type: PAYMENT_UPGRADE_LOCK_TYPE,
  });
  if (String(lock?.paymentRecordId || "").trim() !== String(record?._id || "").trim()) {
    return;
  }
  await client.delete({
    query: `*[_type == $type && _id == $id && _rev == $revision && paymentRecordId == $paymentRecordId]`,
    params: {
      type: PAYMENT_UPGRADE_LOCK_TYPE,
      id: lockId,
      revision: lock._rev,
      paymentRecordId: record._id,
    },
  });
};

const releasePaymentResources = async ({
  client,
  record,
  reason,
  releaseCouponReservation = null,
}) => {
  const results = await Promise.allSettled([
    releasePendingHold({ client, record }),
    releaseCouponForPaymentRecord({
      client,
      record,
      reason,
      releaseCouponReservation,
    }),
    releaseUpgradeLockForPaymentRecord({ client, record }),
  ]);
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => String(result.reason?.message || "resource_release_failed"));
  return { ok: errors.length === 0, errors };
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
      normalizedSource === "client" &&
      String(record.provider || "").trim().toLowerCase() !== "free",
    paypalOrderId:
      String(record.providerOrderId || providerData.paypalOrderId || "").trim(),
    payerEmail:
      String(providerData.payerEmail || record.payerEmail || "").trim(),
    razorpayOrderId:
      String(record.providerOrderId || providerData.razorpayOrderId || "").trim(),
    razorpayPaymentId:
      String(record.providerPaymentId || providerData.razorpayPaymentId || "").trim(),
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
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const currentStatus = String(current.status || "").trim().toLowerCase();
  if (
    isPaymentTerminalStatus(currentStatus) &&
    currentStatus !== PAYMENT_STATUS_NEEDS_RECOVERY &&
    !shouldRetryEmailPartialDispatch({ record: current, source })
  ) {
    return {
      ok: true,
      httpStatus: 200,
      paymentRecord: current,
      response: buildPublicStatusBody(current),
    };
  }
  const recoveryAttemptCount = Number(current.recoveryAttemptCount || 0) + 1;
  const releasedHoldSnapshot = await releaseExpiredRecoveryHold({
    client,
    record: current,
  });
  let nextRecord;
  try {
    nextRecord = await patchPaymentRecord({
      client,
      record: current,
      revisionGuard: true,
      set: {
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        recoveryReason: reason,
        recoveryAttemptCount,
        nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
        source,
        ...(releasedHoldSnapshot
          ? { holdSnapshot: releasedHoldSnapshot }
          : {}),
        ...(Number(details?.createBookingStatus || 0) > 0
          ? {
              recoveryCategory: "booking_finalize",
              recoveryHttpStatus: Number(details.createBookingStatus),
            }
          : {}),
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        source,
        reason,
        data: details,
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    nextRecord = (await getPaymentRecordById(client, current._id)) || current;
  }

  return {
    ok: false,
    httpStatus: 202,
    paymentRecord: nextRecord,
    response: {
      ...buildPublicStatusBody(nextRecord),
    },
  };
};

const rejectUntrustedFinalizeAttempt = async ({
  client,
  record,
  previousStatus = PAYMENT_STATUS_STARTED,
  source,
  reason,
  details = {},
  httpStatus = 400,
}) => {
  const safeStatus =
    String(previousStatus || "").trim().toLowerCase() === PAYMENT_STATUS_FINALIZING
      ? PAYMENT_STATUS_STARTED
      : String(previousStatus || PAYMENT_STATUS_STARTED).trim().toLowerCase();
  let nextRecord;
  try {
    nextRecord = await patchPaymentRecord({
      client,
      record,
      revisionGuard: true,
      set: {
        status: safeStatus,
        source,
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
      },
      event: buildPaymentRecordEvent({
        status: safeStatus,
        source,
        reason,
        data: details,
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    nextRecord = (await getPaymentRecordById(client, record._id)) || record;
    const currentStatus = String(nextRecord.status || "").trim().toLowerCase();
    const terminal =
      isPaymentTerminalStatus(currentStatus) &&
      currentStatus !== PAYMENT_STATUS_NEEDS_RECOVERY;
    return {
      ok: terminal,
      httpStatus: terminal ? 200 : 202,
      paymentRecord: nextRecord,
      response: {
        ...buildPublicStatusBody(nextRecord),
        ok: terminal,
        ...(terminal
          ? {}
          : {
              error: "Payment state changed while verification was running.",
              code: "payment_state_changed",
            }),
      },
    };
  }
  return {
    ok: false,
    httpStatus,
    paymentRecord: nextRecord,
    response: {
      ...buildPublicStatusBody(nextRecord),
      ok: false,
      error: "Payment could not be verified.",
      code: reason,
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
  const release = await releasePaymentResources({
    client,
    record,
    reason,
  });
  if (!release.ok) {
    const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
    const pendingRecord = await patchPaymentRecord({
      client,
      record,
      set: {
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        recoveryReason: "resource_release_pending",
        recoveryAttemptCount,
        nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
        resourceReleasePending: true,
        resourceReleaseTargetStatus: PAYMENT_STATUS_FAILED,
        resourceReleaseReason: reason,
        source,
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        source,
        reason: "resource_release_pending",
        data: { errors: release.errors },
      }),
    });
    return {
      ok: false,
      httpStatus: 202,
      paymentRecord: pendingRecord,
      response: buildPublicStatusBody(pendingRecord),
    };
  }
  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_FAILED,
      recoveryReason: reason,
      source,
      resourceReleasePending: false,
      resourceReleaseTargetStatus: "",
      resourceReleaseReason: "",
      finalizationLeaseId: "",
      finalizationLeaseExpiresAt: "",
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
      ...buildPublicStatusBody(nextRecord),
      ok: false,
      error: "Payment finalization failed.",
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
  const normalizedSource = String(source || "client").trim().toLowerCase();

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

  const shouldRetryEmailDispatch = shouldRetryEmailPartialDispatch({
    record,
    source: normalizedSource,
  });
  const abandonedCaptureRecovery = canFinalizeAbandonedRecord({
    status: record.status,
    source: normalizedSource,
  });

  if (
    isPaymentTerminalStatus(record.status) &&
    String(record.status || "").trim().toLowerCase() !== PAYMENT_STATUS_NEEDS_RECOVERY &&
    !abandonedCaptureRecovery &&
    !shouldRetryEmailDispatch
  ) {
    return {
      ok: true,
      httpStatus: 200,
      paymentRecord: record,
      response: buildPublicStatusBody(record),
    };
  }

  const bookingPayload = sanitizeBookingPayload(record.bookingPayload);
  if (
    !abandonedCaptureRecovery &&
    (!String(bookingPayload.packageTitle || "").trim() ||
      (!String(bookingPayload.originalOrderId || "").trim() &&
        !String(bookingPayload.startTimeUTC || "").trim()))
  ) {
    return markRetryableFinalizeFailure({
      client,
      record,
      source: normalizedSource,
      reason: "payment_record_missing_booking_payload",
      details: providerData,
    });
  }

  const binding = validateImmutableProviderBinding({ record, providerData });
  if (!binding.ok) {
    return {
      ok: false,
      httpStatus: 409,
      paymentRecord: record,
      response: {
        ...buildPublicStatusBody(record),
        ok: false,
        error: "Payment proof does not belong to this checkout session.",
        code: binding.reason,
      },
    };
  }

  const lease = await acquireFinalizationLease({
    client,
    record,
    source: normalizedSource,
  });
  if (!lease.acquired) {
    if (lease.terminal) {
      return {
        ok: true,
        httpStatus: 200,
        paymentRecord: lease.record,
        response: buildPublicStatusBody(lease.record),
      };
    }
    return {
      ok: false,
      httpStatus: 202,
      paymentRecord: lease.record,
      response: {
        ...buildPublicStatusBody(lease.record),
        status: PAYMENT_STATUS_FINALIZING,
      },
    };
  }
  let workingRecord = lease.record;
  const lateCaptureFromAbandoned =
    lease.previousStatus === PAYMENT_STATUS_ABANDONED;

  const verification = await verifyProviderCapture({
    record: workingRecord,
    source: normalizedSource,
    providerData,
  });
  if (!verification.ok) {
    if (
      (verification.retryable ||
        verification.captured === true ||
        normalizedSource === "webhook") &&
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

    return rejectUntrustedFinalizeAttempt({
      client,
      record: workingRecord,
      previousStatus: record.status,
      source: normalizedSource,
      reason: verification.reason,
      details: providerData,
      httpStatus: getVerificationFailureHttpStatus(verification.reason),
    });
  }

  let proofClaim;
  try {
    proofClaim = await preparePaymentProofClaim({
      client,
      record: workingRecord,
      providerOrderId:
        verification.providerOrderId || workingRecord.providerOrderId || "",
      providerPaymentId:
        verification.providerPaymentId || workingRecord.providerPaymentId || "",
    });
  } catch (error) {
    const duplicate = await normalizeMarkedDuplicatePaymentRecord({
      client,
      record: workingRecord,
      providerOrderId:
        verification.providerOrderId || workingRecord.providerOrderId || "",
      providerPaymentId:
        verification.providerPaymentId || workingRecord.providerPaymentId || "",
      error,
    });
    if (duplicate?._id) {
      const linked = !!String(duplicate.bookingId || "").trim();
      return {
        ok: linked,
        httpStatus: linked ? 200 : 202,
        paymentRecord: duplicate,
        response: buildPublicStatusBody(duplicate),
      };
    }
    return markRetryableFinalizeFailure({
      client,
      record: workingRecord,
      source: normalizedSource,
      reason: error?.code || "payment_proof_claim_failed",
      details: providerData,
    });
  }

  const captureStatus = resolveClientSourceStatus(normalizedSource);
  try {
    workingRecord = await patchPaymentRecord({
      client,
      record: workingRecord,
      revisionGuard: true,
      set: {
        status: PAYMENT_STATUS_FINALIZING,
        providerPaymentId: String(
          workingRecord.providerPaymentId || verification.providerPaymentId || ""
        ).trim(),
        providerSignature: String(
          workingRecord.providerSignature || providerData.razorpaySignature || ""
        ).trim(),
        payerEmail: String(
          verification.payerEmail || providerData.payerEmail || workingRecord.payerEmail || ""
        ).trim(),
        verificationState:
          String(workingRecord.provider || "").trim().toLowerCase() === "free"
            ? String(workingRecord.verificationState || "").trim()
            : "server_verified",
        verificationWarning: "",
        paymentProofClaimId: String(proofClaim?._id || "").trim(),
      },
      event: buildPaymentRecordEvent({
        status: captureStatus,
        source: normalizedSource,
        reason: "provider_capture_verified",
        data: {
          providerOrderId: workingRecord.providerOrderId || "",
          providerPaymentId:
            workingRecord.providerPaymentId || verification.providerPaymentId || "",
        },
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    const current = await getPaymentRecordById(client, workingRecord._id);
    return {
      ok: false,
      httpStatus: isPaymentTerminalStatus(current?.status) ? 200 : 202,
      paymentRecord: current || workingRecord,
      response: buildPublicStatusBody(current || workingRecord),
    };
  }

  if (lateCaptureFromAbandoned) {
    try {
      const recovered = await recoverCapturedPaymentAsReschedule({
        client,
        record: workingRecord,
        reason: "captured_after_abandonment",
        providerData: {
          ...providerData,
          providerOrderId:
            verification.providerOrderId || workingRecord.providerOrderId || "",
          providerPaymentId:
            verification.providerPaymentId || workingRecord.providerPaymentId || "",
          payerEmail:
            verification.payerEmail || providerData.payerEmail || workingRecord.payerEmail || "",
        },
        paymentProofClaim: proofClaim,
      });
      if (recovered?._id) {
        return {
          ok: true,
          httpStatus: 200,
          paymentRecord: recovered,
          response: buildPublicStatusBody(recovered),
        };
      }
    } catch (error) {
      const current = await getPaymentRecordById(client, workingRecord._id);
      if (
        String(current?.status || "").trim().toLowerCase() ===
        PAYMENT_STATUS_REFUNDED
      ) {
        return {
          ok: true,
          httpStatus: 200,
          paymentRecord: current,
          response: buildPublicStatusBody(current),
        };
      }
      return markRetryableFinalizeFailure({
        client,
        record: current || workingRecord,
        source: normalizedSource,
        reason: error?.code || "late_capture_reschedule_failed",
        details: {
          code: getSafeErrorCode(error, "late_capture_reschedule_failed"),
        },
      });
    }

    return markRetryableFinalizeFailure({
      client,
      record: workingRecord,
      source: normalizedSource,
      reason: "late_capture_reschedule_incomplete",
    });
  }

  const createPayload = buildLegacyBookingPayload({
    record: workingRecord,
    providerData,
    source: normalizedSource,
  });
  const result = await invokeCreateBooking(createPayload, {
    documentClient: client,
    backendOwner: workingRecord.backendOwner || "sanity",
    cutoverGeneration: Number(workingRecord.cutoverGeneration || 0),
    paymentFinalizeSource: normalizedSource,
    paymentProofClaim: proofClaim,
    paymentProofClaimId: String(proofClaim?._id || "").trim(),
    paymentFinalizationLeaseId: lease.leaseId,
    couponReservationId: String(workingRecord.couponReservationId || "").trim(),
    emailDispatchAlreadyComplete: isEmailDispatchComplete(
      workingRecord.emailDispatch
    ),
    emailDispatchCompletedAt: String(
      workingRecord.lastEmailDispatchAt ||
        workingRecord.updatedAt ||
        workingRecord.createdAt ||
        ""
    ).trim(),
    preserveHistoricalAccounting:
      workingRecord.historicalBookingReconstruction === true,
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

    let nextRecord = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await getPaymentRecordById(client, workingRecord._id);
      const currentStatus = String(current?.status || "").trim().toLowerCase();
      if (
        current?._id &&
        [
          PAYMENT_STATUS_REFUNDED,
          PAYMENT_STATUS_FAILED,
          PAYMENT_STATUS_ABANDONED,
        ].includes(currentStatus)
      ) {
        nextRecord = current;
        break;
      }
      try {
        nextRecord = await patchPaymentRecord({
          client,
          record: current || workingRecord,
          revisionGuard: true,
          set: {
            status: nextStatus,
            bookingId,
            recoveryReason: "",
            recoveryAttemptCount: 0,
            nextRecoveryAt: "",
            finalizationLeaseId: "",
            finalizationLeaseExpiresAt: "",
            emailDispatch: normalizeObject(result.body?.emailDispatch),
            emailDispatchToken: String(
              result.body?.emailDispatchToken || ""
            ).trim(),
            emailDispatchRequired: nextStatus === PAYMENT_STATUS_EMAIL_PARTIAL,
            verificationState: String(
              bookingDoc?.paymentVerificationState || ""
            ).trim(),
            verificationWarning: String(
              bookingDoc?.paymentVerificationWarning || ""
            ).trim(),
            ...(workingRecord.historicalBookingReconstruction === true
              ? {
                  historicalBookingReconstruction: false,
                  historicalBookingReconstructedAt: nowIso(),
                  historicalAccountingPreserved: true,
                }
              : {}),
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
        break;
      } catch (error) {
        if (!isConflictError(error) || attempt === 4) throw error;
      }
    }

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
  const currentAfterBookingAttempt = await getPaymentRecordById(
    client,
    workingRecord._id
  );
  if (
    currentAfterBookingAttempt?._id &&
    isPaymentTerminalStatus(currentAfterBookingAttempt.status) &&
    String(currentAfterBookingAttempt.status || "").trim().toLowerCase() !==
      PAYMENT_STATUS_NEEDS_RECOVERY
  ) {
    return {
      ok: true,
      httpStatus: 200,
      paymentRecord: currentAfterBookingAttempt,
      response: buildPublicStatusBody(currentAfterBookingAttempt),
    };
  }
  if (
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

const abandonStartedPaymentRecord = async ({
  client,
  record,
  reason,
  releaseCouponReservation = null,
}) => {
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const currentStatus = String(current.status || "").trim().toLowerCase();
  const canStageAbandonment =
    currentStatus === PAYMENT_STATUS_STARTED ||
    currentStatus === PAYMENT_STATUS_NEEDS_RECOVERY ||
    (currentStatus === PAYMENT_STATUS_ABANDONED &&
      current.resourceReleasePending === true);

  if (!canStageAbandonment) {
    return {
      ok: currentStatus === PAYMENT_STATUS_ABANDONED,
      httpStatus: isPaymentTerminalStatus(currentStatus) ? 200 : 202,
      paymentRecord: current,
      response: buildPublicStatusBody(current),
    };
  }

  let stagedRecord = current;
  if (currentStatus !== PAYMENT_STATUS_ABANDONED) {
    const recoveryAttemptCount = Number(current.recoveryAttemptCount || 0) + 1;
    try {
      stagedRecord = await patchPaymentRecord({
        client,
        record: current,
        revisionGuard: true,
        set: {
          status: PAYMENT_STATUS_ABANDONED,
          recoveryReason: reason,
          recoveryAttemptCount,
          nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
          resourceReleasePending: true,
          resourceReleaseTargetStatus: PAYMENT_STATUS_ABANDONED,
          resourceReleaseReason: reason,
          finalizationLeaseId: "",
          finalizationLeaseExpiresAt: "",
        },
        event: buildPaymentRecordEvent({
          status: PAYMENT_STATUS_ABANDONED,
          source: "reconcile",
          reason: `${reason}_release_staged`,
        }),
      });
    } catch (error) {
      if (!isConflictError(error)) throw error;
      const fresh = (await getPaymentRecordById(client, current._id)) || current;
      return {
        ok:
          String(fresh.status || "").trim().toLowerCase() ===
          PAYMENT_STATUS_ABANDONED,
        httpStatus: 202,
        paymentRecord: fresh,
        response: buildPublicStatusBody(fresh),
      };
    }
  }

  const release = await releasePaymentResources({
    client,
    record: stagedRecord,
    reason,
    releaseCouponReservation,
  });
  if (!release.ok) {
    const recoveryAttemptCount = Number(stagedRecord.recoveryAttemptCount || 0) + 1;
    let pendingRecord;
    try {
      pendingRecord = await patchPaymentRecord({
        client,
        record: stagedRecord,
        revisionGuard: true,
        set: {
          status: PAYMENT_STATUS_ABANDONED,
          recoveryReason: "resource_release_pending",
          recoveryAttemptCount,
          nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
          resourceReleasePending: true,
          resourceReleaseTargetStatus: PAYMENT_STATUS_ABANDONED,
          resourceReleaseReason: reason,
        },
        event: buildPaymentRecordEvent({
          status: PAYMENT_STATUS_ABANDONED,
          source: "reconcile",
          reason: "resource_release_pending",
          data: { errors: release.errors },
        }),
      });
    } catch (error) {
      if (!isConflictError(error)) throw error;
      pendingRecord =
        (await getPaymentRecordById(client, stagedRecord._id)) || stagedRecord;
    }
    return {
      ok: false,
      httpStatus: 202,
      paymentRecord: pendingRecord,
      response: buildPublicStatusBody(pendingRecord),
    };
  }
  const shouldWatchForLateCapture = !!String(
    stagedRecord.providerOrderId || ""
  ).trim();
  let nextRecord;
  try {
    nextRecord = await patchPaymentRecord({
      client,
      record: stagedRecord,
      revisionGuard: true,
      set: {
        status: PAYMENT_STATUS_ABANDONED,
        recoveryReason: reason,
        resourceReleasePending: false,
        resourceReleaseTargetStatus: "",
        resourceReleaseReason: "",
        lateCaptureWatchUntil: shouldWatchForLateCapture
          ? getFutureIso(LATE_CAPTURE_WATCH_HOURS * 60 * 60)
          : "",
        nextRecoveryAt: shouldWatchForLateCapture ? getFutureIso(60 * 60) : "",
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_ABANDONED,
        source: "reconcile",
        reason,
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    nextRecord =
      (await getPaymentRecordById(client, stagedRecord._id)) || stagedRecord;
  }

  return {
    ok:
      String(nextRecord.status || "").trim().toLowerCase() ===
      PAYMENT_STATUS_ABANDONED,
    httpStatus: 200,
    paymentRecord: nextRecord,
    response: buildPublicStatusBody(nextRecord),
  };
};

const createProviderOrderForRecord = async (
  record = {},
  { allowProviderCreate = false } = {}
) => {
  const provider = String(record.provider || "").trim().toLowerCase();
  const bookingPayload = sanitizeBookingPayload(record.bookingPayload);
  const pricing = normalizeObject(record.pricingSnapshot);
  const amount = Number(pricing.netAmount || 0);
  const idempotencyKey = String(record.providerIdempotencyKey || "").trim();

  if (provider === "razorpay") {
    return createRazorpayOrder({
      amount,
      currency: DEFAULT_RAZORPAY_CURRENCY,
      receipt: idempotencyKey,
      lookupOnly: !allowProviderCreate,
      notes: {
        paymentRecordId: record._id,
        bookingSeedKey: record.bookingSeedKey || "",
        holdId: bookingPayload.slotHoldId || "",
        startTimeUTC: bookingPayload.startTimeUTC || "",
        packageTitle: bookingPayload.packageTitle || "",
        originalOrderId: bookingPayload.originalOrderId || "",
        referralCode: bookingPayload.referralCode || "",
        couponCode: bookingPayload.couponCode || "",
      },
    });
  }

  if (provider === "paypal") {
    const providerPayload = await createPayPalOrder({
      amount,
      currency: DEFAULT_PAYPAL_CURRENCY,
      description: `${bookingPayload.packageTitle} booking`,
      customId: record._id,
      requestId: idempotencyKey,
    });
    return {
      ...providerPayload,
      clientId: resolvePaymentProviders()?.paypal?.clientId || "",
    };
  }

  throw Object.assign(new Error("Unsupported payment provider."), {
    status: 400,
    code: "unsupported_payment_provider",
  });
};

const createOrReusePaymentRecordForStart = async ({
  client,
  provider,
  bookingPayload,
  holdDoc,
  quote,
  quoteFingerprint,
  upgradeIntentSnapshot = null,
  prepareCouponReservation = null,
  appendCouponReservation = null,
  backendOwner = "supabase",
  cutoverGeneration = 0,
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

  const baseSessionScope = buildPaymentSessionScope({
    bookingPayload,
    holdNonce: holdDoc?.holdNonce || "",
  });
  const isUpgrade = !!String(bookingPayload.originalOrderId || "").trim();
  const upgradeIntentId = String(upgradeIntentSnapshot?.intentId || "").trim();
  if (isUpgrade && !upgradeIntentId) {
    const error = new Error("Upgrade authorization is missing its stable intent ID.");
    error.status = 409;
    error.code = "upgrade_intent_id_missing";
    throw error;
  }
  const sessionScope = isUpgrade
    ? `${baseSessionScope}:${upgradeIntentId}`
    : baseSessionScope;
  const paymentRecordId = buildPaymentSessionRecordId(sessionScope);
  const startClaimId = isUpgrade
    ? buildPaymentUpgradeLockId(sessionScope)
    : buildPaymentStartClaimId(sessionScope);
  const providerIdempotencyKey = buildPaymentProviderIdempotencyKey(paymentRecordId);
  const orderCreationLeaseId =
    provider === "free" ? "" : crypto.randomUUID();
  const expiresAt = getPaymentHoldExpiryIso(PAYMENT_HOLD_MINUTES);
  let couponReservationPlan = null;
  let appendReservation = appendCouponReservation;
  if (String(bookingPayload.couponCode || "").trim()) {
    const loadedHandlers =
      typeof prepareCouponReservation === "function" &&
      typeof appendCouponReservation === "function"
        ? {}
        : await loadCouponReservationHandlers();
    const prepare =
      prepareCouponReservation || loadedHandlers.prepareCouponReservation;
    appendReservation =
      appendReservation || loadedHandlers.appendCouponReservation;
    if (typeof prepare !== "function" || typeof appendReservation !== "function") {
      const error = new Error("Coupon reservation service is unavailable.");
      error.status = 503;
      error.code = "coupon_reservation_unavailable";
      throw error;
    }
    couponReservationPlan = await prepare({
      client,
      couponCode: bookingPayload.couponCode,
      ownerId: paymentRecordId,
      expiresAt,
      paymentRecordId,
    });
  }
  const refreshedHoldToken = holdDoc?._id
    ? issueHoldToken({
        holdId: holdDoc._id,
        startTimeUTC: holdDoc.startTimeUTC || bookingPayload.startTimeUTC,
        expiresAt,
        holdNonce: holdDoc.holdNonce || "",
        backend: backendOwner,
        cutoverGeneration,
      })
    : "";
  const createdAt = nowIso();
  const doc = {
    _id: paymentRecordId,
    _type: PAYMENT_RECORD_TYPE,
    backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
    cutoverGeneration: Math.max(0, Number(cutoverGeneration) || 0),
    provider,
    status: PAYMENT_STATUS_STARTED,
    bookingSeedKey,
    pricingFingerprint,
    quoteFingerprint,
    sessionScope,
    startClaimId,
    providerIdempotencyKey,
    couponReservationId: String(
      couponReservationPlan?.redemption?._id || ""
    ).trim(),
    bookingFinalizationKey: provider === "free" ? bookingSeedKey : "",
    bookingPayload: {
      ...bookingPayload,
      paymentProvider: provider,
      slotHoldToken: refreshedHoldToken || bookingPayload.slotHoldToken || "",
      slotHoldExpiresAt: expiresAt,
    },
    pricingSnapshot: buildPricingSnapshot(quote),
    ...(upgradeIntentSnapshot ? { upgradeIntentSnapshot } : {}),
    holdSnapshot: {
      slotHoldId: bookingPayload.slotHoldId || "",
      slotHoldToken: refreshedHoldToken || bookingPayload.slotHoldToken || "",
      slotHoldExpiresAt: expiresAt,
      hostDate: holdDoc?.hostDate || "",
      hostTime: holdDoc?.hostTime || "",
      phase: holdDoc?._id ? HOLD_PHASE_PAYMENT_PENDING : HOLD_PHASE_HOLDING,
    },
    providerOrderId: "",
    providerPaymentId: "",
    payerEmail: String(bookingPayload.email || "").trim(),
    verificationState: "",
    verificationWarning: "",
    bookingId: "",
    recoveryReason: "",
    attemptCount: 0,
    lastAttemptAt: "",
    source: "start",
    providerPublicData: {},
    orderState: provider === "free" ? "not_required" : "creating",
    orderCreationLeaseId,
    orderCreationLeaseExpiresAt:
      provider === "free" ? "" : getFutureIso(FINALIZATION_LEASE_SECONDS),
    sessionExpiresAt: expiresAt,
    emailDispatch: {},
    emailDispatchRequired: true,
    events: [
      buildPaymentRecordEvent({
        status: PAYMENT_STATUS_STARTED,
        source: "start",
        reason: "payment_session_claimed",
        data: {
          slotHoldId: bookingPayload.slotHoldId || "",
          startClaimId,
        },
      }),
    ],
    createdAt,
    updatedAt: createdAt,
  };
  const claim = {
    _id: startClaimId,
    _type: isUpgrade ? PAYMENT_UPGRADE_LOCK_TYPE : PAYMENT_START_CLAIM_TYPE,
    backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
    scope: sessionScope,
    paymentRecordId,
    provider,
    quoteFingerprint,
    createdAt,
    updatedAt: createdAt,
  };
  const holdPatch = holdDoc?._id
    ? {
        backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
        cutoverGeneration: Math.max(0, Number(cutoverGeneration) || 0),
        phase: HOLD_PHASE_PAYMENT_PENDING,
        paymentRecordId,
        paymentProvider: provider,
        packageTitle: bookingPayload.packageTitle || holdDoc.packageTitle || "",
        expiresAt,
      }
    : {};
  let record = await createStartClaimAndRecord({
    client,
    claim,
    record: doc,
    holdDoc,
    holdPatch,
    couponReservationPlan,
    appendCouponReservation: appendReservation,
  });

  if (String(record.provider || "").trim().toLowerCase() !== provider) {
    const error = new Error("This reservation already has a payment provider selected.");
    error.status = 409;
    error.code = "payment_provider_already_claimed";
    throw error;
  }
  if (
    record.quoteFingerprint &&
    String(record.quoteFingerprint) !== String(quoteFingerprint)
  ) {
    const error = new Error("This reservation is already bound to a different quote.");
    error.status = 409;
    error.code = "payment_quote_already_claimed";
    throw error;
  }
  if (provider === "free" || String(record.providerOrderId || "").trim()) {
    return record;
  }
  if (
    !orderCreationLeaseId ||
    String(record.orderCreationLeaseId || "").trim() !== orderCreationLeaseId
  ) {
    const current = (await getPaymentRecordById(client, record._id)) || record;
    if (String(current.providerOrderId || "").trim()) return current;
    const error = new Error("This payment session is already creating its provider order.");
    error.status = 409;
    error.code = "provider_order_creation_in_progress";
    throw error;
  }

  let providerPayload;
  try {
    providerPayload = await createProviderOrderForRecord(record, {
      allowProviderCreate: true,
    });
  } catch (error) {
    const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
    await patchPaymentRecord({
      client,
      record,
      set: {
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        orderState: "creation_ambiguous",
        recoveryReason: "provider_order_creation_ambiguous",
        recoveryAttemptCount,
        nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
        orderCreationLeaseId: "",
        orderCreationLeaseExpiresAt: "",
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_NEEDS_RECOVERY,
        source: "start",
        reason: "provider_order_creation_ambiguous",
        data: { provider, code: String(error?.code || "").trim() },
      }),
    }).catch(() => null);
    error.status = Number(error?.status) >= 400 ? Number(error.status) : 503;
    error.code = error?.code || "provider_order_creation_ambiguous";
    throw error;
  }

  record = await attachImmutableProviderOrder({ client, record, providerPayload });
  return record;
};

export const startPaymentSession = async ({
  body,
  client = createCommerceWriteClient(),
  backend = client?.backend === "sanity" ? "sanity" : "supabase",
  cutoverGeneration = 0,
  prepareCouponReservation = null,
  appendCouponReservation = null,
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
  let pinnedCutoverGeneration = Math.max(
    0,
    Number(cutoverGeneration) || 0
  );

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
    let upgradeIntentSnapshot = null;
    if (bookingPayload.originalOrderId) {
      if (!String(bookingPayload.email || "").trim()) {
        return {
          httpStatus: 400,
          body: {
            ok: false,
            code: "upgrade_email_required",
            error: "The original booking email is required to start an upgrade.",
          },
        };
      }
      const verifiedUpgradeIntent = verifyUpgradeIntentToken({
        token: bookingPayload.upgradeIntentToken,
        bookingId: bookingPayload.originalOrderId,
        email: bookingPayload.email,
        targetPackageTitle: bookingPayload.packageTitle,
        backend,
        cutoverGeneration: pinnedCutoverGeneration,
      });
      if (!verifiedUpgradeIntent) {
        return {
          httpStatus: 403,
          body: {
            ok: false,
            code: "upgrade_intent_invalid",
            error: "Upgrade authorization expired or no longer matches.",
          },
        };
      }
      upgradeIntentSnapshot = freezeUpgradeIntent({
        payload: verifiedUpgradeIntent,
      });
    }

    const quote = await resolvePaymentQuote({
      packageTitle: bookingPayload.packageTitle,
      originalOrderId: bookingPayload.originalOrderId || "",
      referralId: bookingPayload.referralId || "",
      referralCode: bookingPayload.referralCode || "",
      couponCode: bookingPayload.couponCode || "",
      client,
    });
    const currentQuoteFingerprint = buildQuoteFingerprint({
      bookingPayload,
      quote,
    });
    const submittedQuoteFingerprint = String(
      requestBody.quoteFingerprint || ""
    ).trim();
    if (
      (!submittedQuoteFingerprint && !isLegacyCheckoutCompatibilityOpen()) ||
      (submittedQuoteFingerprint &&
        submittedQuoteFingerprint !== currentQuoteFingerprint)
    ) {
      return {
        httpStatus: 409,
        body: {
          ok: false,
          error: "The checkout price changed. Please review the updated total.",
          code: submittedQuoteFingerprint
            ? "quote_fingerprint_mismatch"
            : "quote_fingerprint_required",
          quote: buildQuotePayload(quote),
          quoteFingerprint: currentQuoteFingerprint,
        },
      };
    }
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
      quoteFingerprint: currentQuoteFingerprint,
      upgradeIntentSnapshot,
      prepareCouponReservation,
      appendCouponReservation,
      backendOwner: backend,
      cutoverGeneration: pinnedCutoverGeneration,
    });
    const refreshed = record?._id
      ? record
      : await getPaymentRecordById(client, record._id);
    const paymentAccessToken = issuePaymentAccessTokenForRecord(refreshed);
    const refreshedStatus = String(refreshed.status || "").trim().toLowerCase();
    if (
      provider !== "free" &&
      [
        PAYMENT_STATUS_BOOKED,
        PAYMENT_STATUS_EMAIL_PARTIAL,
        PAYMENT_STATUS_REFUNDED,
      ].includes(refreshedStatus)
    ) {
      return {
        httpStatus: 200,
        body: {
          ...buildPublicStatusBody(refreshed),
          provider,
          quote: buildQuotePayload(quote),
          quoteFingerprint: currentQuoteFingerprint,
          providerPayload: {},
          paymentAccessToken,
          sessionExpiresAt: String(refreshed.sessionExpiresAt || "").trim(),
          refreshedHold: buildRefreshedHoldBody(refreshed),
        },
      };
    }
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
          quoteFingerprint: currentQuoteFingerprint,
          sessionExpiresAt: String(refreshed.sessionExpiresAt || "").trim(),
          refreshedHold: buildRefreshedHoldBody(refreshed),
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
        quoteFingerprint: currentQuoteFingerprint,
        providerPayload: buildProviderPayloadFromRecord(refreshed),
        paymentAccessToken,
        sessionExpiresAt: String(refreshed.sessionExpiresAt || "").trim(),
        refreshedHold: buildRefreshedHoldBody(refreshed),
      },
    };
  } catch (error) {
    return buildPublicFailure({
      error,
      fallbackMessage: "Failed to start payment.",
    });
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
  paymentAccessToken = "",
  allowLegacyTokenFallback = true,
  client = null,
}) => {
  const requestBody = normalizeObject(body);
  const flatProviderData = sanitizeProviderFinalizeData({
    ...normalizeObject(requestBody.providerData),
    ...requestBody,
  });
  let resolved = null;
  try {
    resolved = await resolveRecordFromAccessToken({
      client,
      paymentAccessToken: String(
        paymentAccessToken ||
          (allowLegacyTokenFallback ? requestBody.paymentAccessToken : "") ||
          ""
      ).trim(),
      allowRecoveryExtension: true,
    });
    client = resolved.client;
  } catch (error) {
    return buildPublicFailure({
      error,
      fallbackStatus: 503,
      fallbackMessage: "Payment status is temporarily unavailable.",
    });
  }

  const record = resolved?.record;
  const terminalStatus = String(record?.status || "").trim().toLowerCase();
  if (
    isPaymentTerminalStatus(record?.status) &&
    terminalStatus !== PAYMENT_STATUS_NEEDS_RECOVERY &&
    terminalStatus !== PAYMENT_STATUS_ABANDONED
  ) {
    const completed = [
      PAYMENT_STATUS_BOOKED,
      PAYMENT_STATUS_EMAIL_PARTIAL,
      PAYMENT_STATUS_REFUNDED,
    ].includes(terminalStatus);
    return {
      httpStatus: completed ? 200 : 409,
      body: {
        ...buildPublicStatusBody(record),
        ok: completed,
        ...(completed ? {} : { error: "Payment session is already terminal." }),
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

export const cancelPaymentSession = async ({
  paymentAccessToken = "",
  client = null,
  releaseCouponReservation = null,
  prepareCouponRelease = null,
  appendCouponRelease = null,
}) => {
  let resolved;
  try {
    resolved = await resolveRecordFromAccessToken({
      client,
      paymentAccessToken: String(paymentAccessToken || "").trim(),
      allowRecoveryExtension: false,
    });
    client = resolved.client;
  } catch (error) {
    return buildPublicFailure({
      error,
      fallbackStatus: 503,
      fallbackMessage: "Payment status is temporarily unavailable.",
    });
  }

  let record = resolved.record;
  const status = String(record.status || "").trim().toLowerCase();
  if (status === PAYMENT_STATUS_ABANDONED) {
    return {
      httpStatus: 200,
      body: {
        ...buildPublicStatusBody(record),
        ok: true,
        cancelled: true,
        refreshedHold: normalizeObject(record.cancelledHoldSnapshot),
      },
    };
  }
  if (isPaymentTerminalStatus(status) || status !== PAYMENT_STATUS_STARTED) {
    return {
      httpStatus: 409,
      body: {
        ...buildPublicStatusBody(record),
        ok: false,
        error: "This payment session can no longer be changed.",
      },
    };
  }

  const inspection = await inspectProviderOrderForRecovery(record);
  if (inspection.state === "captured") {
    const finalized = await finalizePaymentRecordInternal({
      client,
      record,
      source: "reconcile",
      providerData: inspection.providerData || {},
    });
    return {
      httpStatus: finalized.httpStatus,
      body: {
        ...finalized.response,
        cancelled: false,
        captured: true,
      },
    };
  }
  if (inspection.state !== "unpaid") {
    return {
      httpStatus: inspection.state === "unavailable" ? 503 : 409,
      body: {
        ok: false,
        status,
        code: `provider_${inspection.state || "unknown"}`,
        error:
          inspection.state === "unavailable"
            ? "The payment provider could not confirm the order status. Please try again."
            : "Payment approval is already in progress. Close the provider checkout before changing methods.",
      },
    };
  }

  const holdId = String(record?.bookingPayload?.slotHoldId || "").trim();
  if (!holdId) {
    const abandoned = await abandonStartedPaymentRecord({
      client,
      record,
      reason: "customer_changed_payment_method",
      releaseCouponReservation,
    });
    return {
      httpStatus: abandoned.httpStatus,
      body: { ...abandoned.response, ok: abandoned.ok, cancelled: abandoned.ok },
    };
  }

  const loadedCouponHandlers = record.couponReservationId
    ? await loadCouponReservationHandlers()
    : {};
  const releaseCoupon =
    releaseCouponReservation || loadedCouponHandlers.releaseCouponReservation;
  const prepareAtomicCouponRelease =
    prepareCouponRelease || loadedCouponHandlers.prepareCouponRelease;
  const appendAtomicCouponRelease =
    appendCouponRelease || loadedCouponHandlers.appendCouponRelease;
  if (
    record.couponReservationId &&
    (typeof releaseCoupon !== "function" ||
      typeof prepareAtomicCouponRelease !== "function" ||
      typeof appendAtomicCouponRelease !== "function")
  ) {
    return {
      httpStatus: 503,
      body: { ok: false, error: "Coupon release is temporarily unavailable." },
    };
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    record = (await getPaymentRecordById(client, record._id)) || record;
    const currentStatus = String(record.status || "").trim().toLowerCase();
    if (currentStatus !== PAYMENT_STATUS_STARTED) {
      const captured = [
        PAYMENT_STATUS_BOOKED,
        PAYMENT_STATUS_EMAIL_PARTIAL,
        PAYMENT_STATUS_CAPTURED_CLIENT,
        PAYMENT_STATUS_CAPTURED_WEBHOOK,
      ].includes(currentStatus);
      return {
        httpStatus: captured ? 200 : 409,
        body: {
          ...buildPublicStatusBody(record),
          ok: captured,
          captured,
          cancelled: false,
          ...(captured
            ? {}
            : { error: "Payment state changed before it could be released." }),
        },
      };
    }
    const hold = await getHoldById(client, holdId);
    if (
      !hold?._id ||
      String(hold.paymentRecordId || "").trim() !== String(record._id).trim()
    ) {
      return {
        httpStatus: 409,
        body: { ok: false, error: "The slot reservation is no longer owned by this payment." },
      };
    }
    const expiresAt = String(hold.expiresAt || "").trim();
    if (!isFutureIso(expiresAt)) {
      const abandoned = await abandonStartedPaymentRecord({
        client,
        record,
        reason: "customer_cancelled_expired_payment",
        releaseCouponReservation: releaseCoupon,
      });
      return {
        httpStatus: abandoned.httpStatus,
        body: {
          ...abandoned.response,
          ok: abandoned.ok,
          cancelled: abandoned.ok,
          slotReleased: true,
        },
      };
    }

    const holdNonce = crypto.randomUUID();
    const holdToken = issueHoldToken({
      holdId,
      startTimeUTC: hold.startTimeUTC,
      expiresAt,
      holdNonce,
      backend: record.backendOwner || "sanity",
      cutoverGeneration: Number(record.cutoverGeneration || 0),
    });
    const refreshedHold = {
      slotHoldId: holdId,
      slotHoldToken: holdToken,
      slotHoldExpiresAt: expiresAt,
      phase: HOLD_PHASE_HOLDING,
    };
    const startClaimId = String(record.startClaimId || "").trim();
    const claim = startClaimId
      ? await getDocumentById({
          client,
          id: startClaimId,
          type: startClaimId.startsWith("paymentUpgradeLock.")
            ? PAYMENT_UPGRADE_LOCK_TYPE
            : PAYMENT_START_CLAIM_TYPE,
        })
      : null;
    const couponReleasePlan = record.couponReservationId
      ? await prepareAtomicCouponRelease({
          client,
          redemptionId: record.couponReservationId,
        })
      : null;
    if (record.couponReservationId && !couponReleasePlan?.redemption?._id) {
      return {
        httpStatus: 503,
        body: { ok: false, error: "Coupon release is temporarily unavailable." },
      };
    }
    if (
      couponReleasePlan?.redemption?.status === "consumed" ||
      couponReleasePlan?.redemption?.status === "refunded"
    ) {
      return {
        httpStatus: 409,
        body: {
          ok: false,
          error: "Payment state changed before it could be released.",
        },
      };
    }
    const now = nowIso();
    let transaction = client.transaction();
    transaction = transaction.patch(record._id, (patch) =>
      patch
        .ifRevisionId(record._rev)
        .set({
          status: PAYMENT_STATUS_ABANDONED,
          recoveryReason: "customer_changed_payment_method",
          resourceReleasePending: false,
          lateCaptureWatchUntil: getFutureIso(LATE_CAPTURE_WATCH_HOURS * 60 * 60),
          nextRecoveryAt: getFutureIso(60 * 60),
          cancelledHoldSnapshot: refreshedHold,
          updatedAt: now,
          events: mergePaymentRecordEvents(
            record.events,
            buildPaymentRecordEvent({
              status: PAYMENT_STATUS_ABANDONED,
              source: "client",
              reason: "customer_changed_payment_method",
            })
          ),
        })
    );
    transaction = transaction.patch(hold._id, (patch) =>
      patch
        .ifRevisionId(hold._rev)
        .set({
          phase: HOLD_PHASE_HOLDING,
          holdNonce,
          paymentRecordId: "",
          paymentProvider: "",
          expiresAt,
        })
    );
    if (couponReleasePlan?.redemption?._id) {
      transaction = appendAtomicCouponRelease({
        transaction,
        prepared: couponReleasePlan,
        reason: "customer_changed_payment_method",
        releasedAt: now,
      });
    }
    if (
      claim?._id &&
      String(claim.paymentRecordId || "").trim() === String(record._id).trim()
    ) {
      transaction = transaction.delete(claim._id);
    }
    try {
      await transaction.commit();
      return {
        httpStatus: 200,
        body: {
          ok: true,
          status: PAYMENT_STATUS_ABANDONED,
          cancelled: true,
          refreshedHold,
        },
      };
    } catch (error) {
      if (!isConflictError(error) || attempt === 3) throw error;
    }
  }

  return { httpStatus: 409, body: { ok: false, error: "Payment state changed. Try again." } };
};

const getPaymentAgeMinutes = (record = {}) => {
  const reference = record.lastAttemptAt || record.updatedAt || record.createdAt;
  if (!reference) return 0;
  const diffMs = Date.now() - new Date(reference).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return diffMs / (60 * 1000);
};

const getPaymentCreatedAgeMinutes = (record = {}) => {
  const reference = record.createdAt || record.updatedAt || record.lastAttemptAt;
  if (!reference) return 0;
  const diffMs = Date.now() - new Date(reference).getTime();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return diffMs / (60 * 1000);
};

const isRecoveryAttemptDue = (record = {}) => {
  const next = new Date(record.nextRecoveryAt || "").getTime();
  return !Number.isFinite(next) || next <= Date.now();
};

const scheduleProviderRecoveryCheck = async ({
  client,
  record,
  reason,
}) => {
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  const releasedHoldSnapshot = await releaseExpiredRecoveryHold({
    client,
    record,
  });
  return patchPaymentRecord({
    client,
    record,
    set: {
      recoveryReason: String(reason || "provider_status_pending").trim(),
      recoveryAttemptCount,
      lastAttemptAt: nowIso(),
      nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
      source: "reconcile",
      ...(releasedHoldSnapshot
        ? { holdSnapshot: releasedHoldSnapshot }
        : {}),
    },
    event: buildPaymentRecordEvent({
      status: String(record.status || PAYMENT_STATUS_STARTED).trim().toLowerCase(),
      source: "reconcile",
      reason,
    }),
  });
};

const closeExpiredLateCaptureWatch = async ({ client, record }) => {
  const reason = "provider_order_not_found_after_late_capture_watch";
  try {
    return await patchPaymentRecord({
      client,
      record,
      revisionGuard: true,
      set: {
        recoveryReason: reason,
        lateCaptureWatchUntil: "",
        nextRecoveryAt: "",
        providerRecoveryTerminal: true,
        providerRecoveryTerminalAt: nowIso(),
        providerRecoveryTerminalReason: reason,
      },
      event: buildPaymentRecordEvent({
        status: PAYMENT_STATUS_ABANDONED,
        source: "reconcile",
        reason,
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    return (await getPaymentRecordById(client, record._id)) || record;
  }
};

const inspectProviderOrderForRecovery = async (record = {}) => {
  const provider = String(record.provider || "").trim().toLowerCase();
  const providerOrderId = String(record.providerOrderId || "").trim();
  if (provider === "free") return { state: "captured", providerData: {} };
  if (!providerOrderId) {
    return { state: "unavailable", reason: "provider_order_id_missing" };
  }

  const result =
    provider === "paypal"
      ? await inspectPayPalOrder({ orderId: providerOrderId })
      : await inspectRazorpayOrder({ orderId: providerOrderId });
  if (result?.state !== "captured") return result || { state: "unavailable" };
  return {
    ...result,
    providerData:
      provider === "paypal"
        ? {
            paypalOrderId: providerOrderId,
            paypalPaymentId: String(result.providerPaymentId || "").trim(),
            payerEmail: String(result.payerEmail || "").trim(),
          }
        : {
            razorpayOrderId: providerOrderId,
            razorpayPaymentId: String(result.providerPaymentId || "").trim(),
            payerEmail: String(result.payerEmail || "").trim(),
          },
  };
};

const hasRecoverableBookingPayload = (record = {}) => {
  const payload = normalizeObject(record.bookingPayload);
  return !!(
    String(payload.packageTitle || "").trim() &&
    (String(payload.originalOrderId || "").trim() ||
      String(payload.startTimeUTC || "").trim())
  );
};

const recoverCapturedPaymentAsReschedule = async ({
  client,
  record,
  reason,
  createRequiresRescheduleBooking,
  dispatchRescheduleNotifications = null,
  providerData = {},
  paymentProofClaim = null,
}) => {
  const handler =
    createRequiresRescheduleBooking || (await loadRequiresRescheduleHandler());
  if (typeof handler !== "function") return null;

  const recoveredProviderOrderId = String(
    providerData.providerOrderId ||
      providerData.paypalOrderId ||
      providerData.razorpayOrderId ||
      record.providerOrderId ||
      ""
  ).trim();
  const recoveredProviderPaymentId = String(
    providerData.providerPaymentId ||
      providerData.paypalPaymentId ||
      providerData.razorpayPaymentId ||
      record.providerPaymentId ||
      ""
  ).trim();
  const recoveryRecord = {
    ...record,
    providerOrderId: recoveredProviderOrderId,
    providerPaymentId: recoveredProviderPaymentId,
    payerEmail: String(
      providerData.payerEmail || record.payerEmail || ""
    ).trim(),
  };
  const proofClaim =
    paymentProofClaim ||
    (await preparePaymentProofClaim({
      client,
      record: recoveryRecord,
      providerOrderId: recoveredProviderOrderId,
      providerPaymentId: recoveredProviderPaymentId,
    }));
  const preserveHistoricalAccounting =
    record.historicalBookingReconstruction === true ||
    record.historicalAccountingPreserved === true;
  const couponRedemptionId = preserveHistoricalAccounting
    ? ""
    : String(record.couponReservationId || "").trim();
  const holdId = String(record?.holdSnapshot?.slotHoldId || "").trim();
  const [couponRedemption, candidateHold] = await Promise.all([
    couponRedemptionId
      ? getDocumentById({
          client,
          id: couponRedemptionId,
          type: "couponRedemption",
        })
      : null,
    holdId ? getHoldById(client, holdId) : null,
  ]);
  if (couponRedemptionId && !couponRedemption?._id) {
    const error = new Error("Coupon accounting record is missing.");
    error.code = "coupon_redemption_missing";
    throw error;
  }
  const coupon = couponRedemption?.coupon?._ref
    ? await getDocumentById({
        client,
        id: couponRedemption.coupon._ref,
        type: "coupon",
      })
    : null;
  if (couponRedemption?._id && !coupon?._id) {
    const error = new Error("Coupon definition is missing.");
    error.code = "coupon_definition_missing";
    throw error;
  }
  const couponReservation = couponRedemption?._id
    ? { coupon, redemption: couponRedemption, idempotent: false }
    : null;
  const paymentHold =
    candidateHold?._id &&
    String(candidateHold.paymentRecordId || "").trim() === String(record._id)
      ? candidateHold
      : null;
  const referralId = String(
    preserveHistoricalAccounting
      ? ""
      : record?.pricingSnapshot?.effectiveReferralId || ""
  ).trim();
  const normalizedReason = reason || "captured_payment_requires_reschedule";
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  const pendingSet = {
    status: PAYMENT_STATUS_EMAIL_PARTIAL,
    providerPaymentId: recoveredProviderPaymentId,
    payerEmail: recoveryRecord.payerEmail,
    verificationState: "server_verified",
    verificationWarning: "",
    paymentProofClaimId: String(proofClaim?._id || "").trim(),
    requiresReschedule: true,
    recoveryReason: "reschedule_notification_pending",
    recoveryNotificationRequired: true,
    emailDispatchRequired: false,
    recoveryAttemptCount,
    resourceReleasePending: false,
    resourceReleaseTargetStatus: "",
    resourceReleaseReason: "",
    lateCaptureWatchUntil: "",
    finalizationLeaseId: "",
    finalizationLeaseExpiresAt: "",
    ...(holdId
      ? {
          holdSnapshot: {
            ...normalizeObject(record.holdSnapshot),
            phase: paymentHold ? "consumed" : "released",
            slotHoldExpiresAt: nowIso(),
          },
        }
      : {}),
    couponAccountingRecoveredAfterRelease:
      couponRedemption?.status === "released",
    referralAccountingApplied: preserveHistoricalAccounting
      ? record.referralAccountingApplied === true
      : !!referralId,
    ...(record.historicalBookingReconstruction === true
      ? {
          historicalBookingReconstruction: false,
          historicalBookingReconstructedAt: nowIso(),
          historicalAccountingPreserved: true,
        }
      : {}),
    nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
    events: mergePaymentRecordEvents(
      record.events,
      buildPaymentRecordEvent({
        status: PAYMENT_STATUS_EMAIL_PARTIAL,
        source: "reconcile",
        reason: normalizedReason,
        data: {
          providerOrderId: recoveredProviderOrderId,
          providerPaymentId: recoveredProviderPaymentId,
        },
      })
    ),
  };

  let recovery;
  try {
    recovery = await handler({
      client,
      paymentRecord: recoveryRecord,
      reason: normalizedReason,
      notify: false,
      paymentProofClaim: proofClaim,
      paymentRecordMutation: {
        id: record._id,
        revision: record._rev,
        set: pendingSet,
      },
      couponReservation,
      referralId,
      paymentHold,
      preserveHistoricalAccounting,
    });
  } catch (error) {
    const current = await getPaymentRecordById(client, record._id);
    if (
      String(current?.status || "").trim().toLowerCase() ===
      PAYMENT_STATUS_REFUNDED
    ) {
      return current;
    }
    throw error;
  }
  const bookingId = String(recovery?.bookingId || recovery?.booking?._id || "").trim();
  if (!bookingId) return null;

  let linkedRecord = await getPaymentRecordById(client, record._id);
  if (String(linkedRecord?.bookingId || "").trim() !== bookingId) {
    const linkedStatus = String(linkedRecord?.status || "").trim().toLowerCase();
    if (
      linkedRecord?._id &&
      [PAYMENT_STATUS_REFUNDED, PAYMENT_STATUS_FAILED].includes(linkedStatus)
    ) {
      return linkedRecord;
    }
    linkedRecord = await patchPaymentRecord({
      client,
      record: linkedRecord || record,
      revisionGuard: true,
      set: { ...pendingSet, bookingId },
    });
  }

  const notificationHandler =
    dispatchRescheduleNotifications ||
    (await loadRescheduleNotificationHandler());
  let notification = {
    ok: false,
    notificationRequired: true,
    reason: "notification_handler_unavailable",
  };
  if (typeof notificationHandler === "function") {
    try {
      notification = await notificationHandler({
        client,
        bookingId,
        booking: recovery?.booking || null,
      });
    } catch (error) {
      notification = {
        ok: false,
        notificationRequired: true,
        reason: getSafeErrorCode(error, "notification_dispatch_failed"),
      };
    }
  }
  const notificationComplete =
    notification?.ok === true && notification?.notificationRequired !== true;

  const current = (await getPaymentRecordById(client, record._id)) || linkedRecord;
  if (
    String(current?.status || "").trim().toLowerCase() ===
    PAYMENT_STATUS_REFUNDED
  ) {
    return current;
  }

  try {
    return await patchPaymentRecord({
      client,
      record: current,
      revisionGuard: true,
      set: {
        status: notificationComplete
          ? PAYMENT_STATUS_BOOKED
          : PAYMENT_STATUS_EMAIL_PARTIAL,
        bookingId,
        requiresReschedule: true,
        recoveryReason: notificationComplete
          ? "requires_reschedule"
          : "reschedule_notification_pending",
        recoveryCaseId: String(recovery?.recoveryCaseId || "").trim(),
        recoveryNotificationRequired: !notificationComplete,
        emailDispatchRequired: false,
        recoveryNotification: normalizeObject(notification),
        recoveryAttemptCount,
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
        nextRecoveryAt: notificationComplete
          ? ""
          : getNextPaymentRecoveryAt(recoveryAttemptCount),
      },
      event: buildPaymentRecordEvent({
        status: notificationComplete
          ? PAYMENT_STATUS_BOOKED
          : PAYMENT_STATUS_EMAIL_PARTIAL,
        source: "reconcile",
        reason: "captured_payment_requires_reschedule",
        data: {
          bookingId,
          recoveryCaseId: String(recovery?.recoveryCaseId || "").trim(),
        },
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    return (await getPaymentRecordById(client, record._id)) || current;
  }
};

const retryRescheduleNotification = async ({
  client,
  record,
  dispatchRescheduleNotifications = null,
}) => {
  const handler =
    dispatchRescheduleNotifications ||
    (await loadRescheduleNotificationHandler());
  if (typeof handler !== "function" || !record?.bookingId) return null;

  let notification;
  try {
    notification = await handler({ client, bookingId: record.bookingId });
  } catch (error) {
    notification = {
      ok: false,
      notificationRequired: true,
      reason: getSafeErrorCode(error, "notification_dispatch_failed"),
    };
  }
  const complete =
    notification?.ok === true && notification?.notificationRequired !== true;
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const currentStatus = String(current.status || "").trim().toLowerCase();
  if (
    [PAYMENT_STATUS_REFUNDED, PAYMENT_STATUS_FAILED].includes(currentStatus)
  ) {
    return current;
  }
  try {
    return await patchPaymentRecord({
      client,
      record: current,
      revisionGuard: true,
      set: {
        status: complete ? PAYMENT_STATUS_BOOKED : PAYMENT_STATUS_EMAIL_PARTIAL,
        recoveryReason: complete
          ? "requires_reschedule"
          : "reschedule_notification_pending",
        recoveryNotificationRequired: !complete,
        emailDispatchRequired: false,
        recoveryNotification: normalizeObject(notification),
        recoveryAttemptCount,
        nextRecoveryAt: complete
          ? ""
          : getNextPaymentRecoveryAt(recoveryAttemptCount),
      },
      event: buildPaymentRecordEvent({
        status: complete ? PAYMENT_STATUS_BOOKED : PAYMENT_STATUS_EMAIL_PARTIAL,
        source: "reconcile",
        reason: complete
          ? "reschedule_notification_sent"
          : "reschedule_notification_pending",
        data: notification,
      }),
    });
  } catch (error) {
    if (!isConflictError(error)) throw error;
    return (await getPaymentRecordById(client, record._id)) || current;
  }
};

export const getPaymentStatus = async ({
  query,
  paymentAccessToken: suppliedPaymentAccessToken = "",
  allowLegacyTokenFallback = true,
  client = null,
}) => {
  const paymentAccessToken = String(
    suppliedPaymentAccessToken ||
      (allowLegacyTokenFallback
        ? query?.paymentAccessToken || query?.payment
        : "") ||
      ""
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
      allowRecoveryExtension: false,
      allowStatusReadExtension: true,
    });
    client = resolved.client;
  } catch (error) {
    return buildPublicFailure({
      error,
      fallbackStatus: 503,
      fallbackMessage: "Payment status is temporarily unavailable.",
    });
  }
  return {
    httpStatus: 200,
    body: buildPublicStatusBody(resolved.record),
  };
};

export const reconcilePaymentSessions = async ({
  req,
  client = createCommerceWriteClient(),
  backend = client?.backend === "sanity" ? "sanity" : "supabase",
  createRequiresRescheduleBooking = null,
  applyBookingRefund = null,
  releaseCouponReservation = null,
  dispatchRescheduleNotifications = null,
}) => {
  try {
    authorizeCronRequest(req);
  } catch (error) {
    return buildPublicFailure({
      error,
      fallbackMessage: "Payment reconciliation is temporarily unavailable.",
    });
  }

  const policy = resolveSupabaseRuntimePolicy();
  const currentGeneration = Math.max(
    0,
    Number(policy.commerceFailoverGeneration) || 0
  );
  const primaryBackend =
    policy.commercePrimaryBackend === "sanity" ? "sanity" : "supabase";
  const records = await client.fetch(
    `*[_type == $type
      && (
        (
          coalesce(cutoverGeneration, 0) < $currentGeneration
          && $backend == $primaryBackend
        )
        || (
          coalesce(cutoverGeneration, 0) >= $currentGeneration
          && coalesce(backendOwner, "sanity") == $backend
        )
      )
      && (
        lower(status) in $statuses
        || (lower(status) == $refundedStatus && refundRequiresBookingSync == true)
        || (lower(status) == $bookedStatus && emailDispatchRequired == true)
        || (lower(status) == $abandonedStatus && resourceReleasePending == true)
        || (
          lower(status) == $abandonedStatus
          && defined(lateCaptureWatchUntil)
          && lateCaptureWatchUntil != ""
        )
      )
      && (
        !defined(nextRecoveryAt)
        || nextRecoveryAt == ""
        || nextRecoveryAt <= $now
      )
    ] | order(updatedAt asc)[0...50]`,
    {
      type: PAYMENT_RECORD_TYPE,
      backend: backend === "supabase" ? "supabase" : "sanity",
      primaryBackend,
      currentGeneration,
      statuses: [
        PAYMENT_STATUS_STARTED,
        PAYMENT_STATUS_CAPTURED_CLIENT,
        PAYMENT_STATUS_CAPTURED_WEBHOOK,
        PAYMENT_STATUS_FINALIZING,
        PAYMENT_STATUS_EMAIL_PARTIAL,
        PAYMENT_STATUS_NEEDS_RECOVERY,
      ],
      refundedStatus: PAYMENT_STATUS_REFUNDED,
      bookedStatus: PAYMENT_STATUS_BOOKED,
      abandonedStatus: PAYMENT_STATUS_ABANDONED,
      now: nowIso(),
    }
  );

  const summary = {
    scanned: 0,
    finalized: 0,
    abandoned: 0,
    recovery: 0,
    pending: 0,
    providerUnavailable: 0,
    refundsSynced: 0,
  };

  for (const record of Array.isArray(records) ? records : []) {
    summary.scanned += 1;
    const ageMinutes = getPaymentAgeMinutes(record);
    const createdAgeMinutes = getPaymentCreatedAgeMinutes(record);
    const status = String(record.status || "").trim().toLowerCase();

    if (status === PAYMENT_STATUS_REFUNDED && record.refundRequiresBookingSync) {
      const refundHandler = applyBookingRefund || (await loadBookingRefundHandler());
      const sideEffects = await applyFullRefundEffects({
        client,
        record,
        refund: {
          full: true,
          type: record.refundState === "reversal" ? "reversal" : "full",
          state: record.refundState || "full",
          processedAmountInSubunits: Number(
            record.refundProcessedAmountInSubunits || 0
          ),
        },
        applyBookingRefund: refundHandler,
      });
      if (sideEffects.ok) {
        await patchPaymentRecord({
          client,
          record,
          set: {
            refundRequiresBookingSync: false,
            recoveryReason: "",
            nextRecoveryAt: "",
            refundBookingSync: normalizeObject(sideEffects.sync),
          },
        });
        summary.refundsSynced += 1;
      } else {
        const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
        await patchPaymentRecord({
          client,
          record,
          set: {
            recoveryReason: sideEffects.reason || "refund_side_effect_pending",
            recoveryAttemptCount,
            nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
          },
        });
        summary.recovery += 1;
      }
      continue;
    }

    if (record.resourceReleasePending === true) {
      const targetStatus = String(record.resourceReleaseTargetStatus || "")
        .trim()
        .toLowerCase();
      const reason = String(
        record.resourceReleaseReason || "resource_release_retry"
      ).trim();
      const released = targetStatus === PAYMENT_STATUS_FAILED
        ? await markTerminalFinalizeFailure({
            client,
            record,
            source: "reconcile",
            reason,
          })
        : await abandonStartedPaymentRecord({
            client,
            record,
            reason,
            releaseCouponReservation,
          });
      const releasedStatus = String(released?.paymentRecord?.status || "")
        .trim()
        .toLowerCase();
      if (
        releasedStatus !== PAYMENT_STATUS_ABANDONED ||
        released?.paymentRecord?.resourceReleasePending === true
      ) {
        summary.recovery += 1;
      } else {
        summary.abandoned += 1;
      }
      continue;
    }

    if (status === PAYMENT_STATUS_ABANDONED) {
      const inspection = await inspectProviderOrderForRecovery(record);
      if (inspection.state === "captured") {
        const recovered = await finalizePaymentRecordInternal({
          client,
          record,
          source: "reconcile",
          providerData: inspection.providerData || {},
        });
        const recoveredStatus = String(recovered?.paymentRecord?.status || "")
          .trim()
          .toLowerCase();
        if (
          recoveredStatus === PAYMENT_STATUS_BOOKED ||
          recoveredStatus === PAYMENT_STATUS_EMAIL_PARTIAL ||
          recoveredStatus === PAYMENT_STATUS_REFUNDED
        ) {
          summary.finalized += 1;
        } else {
          summary.recovery += 1;
        }
      } else if (
        isDefinitiveMissingProviderOrder(inspection) &&
        !isFutureIso(record.lateCaptureWatchUntil)
      ) {
        await closeExpiredLateCaptureWatch({ client, record });
        summary.abandoned += 1;
      } else {
        await scheduleProviderRecoveryCheck({
          client,
          record,
          reason:
            inspection.state === "unavailable"
              ? inspection.reason || "abandoned_provider_status_unavailable"
              : `abandoned_provider_${inspection.state || "pending"}`,
        });
        if (inspection.state === "unavailable") {
          summary.providerUnavailable += 1;
        } else {
          summary.pending += 1;
        }
      }
      continue;
    }

    const shouldRetryEmailDispatch = shouldRetryEmailPartialDispatch({
      record,
      source: "reconcile",
    });

    if (
      !isPaymentPendingStatus(status) &&
      status !== PAYMENT_STATUS_NEEDS_RECOVERY &&
      !(
        status === PAYMENT_STATUS_EMAIL_PARTIAL &&
        record.requiresReschedule === true
      ) &&
      !shouldRetryEmailDispatch
    ) {
      continue;
    }

    if (!isRecoveryAttemptDue(record)) {
      continue;
    }

    if (
      status === PAYMENT_STATUS_EMAIL_PARTIAL &&
      record.requiresReschedule === true
    ) {
      const notified = await retryRescheduleNotification({
        client,
        record,
        dispatchRescheduleNotifications,
      });
      if (String(notified?.status || "").toLowerCase() === PAYMENT_STATUS_BOOKED) {
        summary.finalized += 1;
      } else {
        summary.recovery += 1;
      }
      continue;
    }

    if (
      ageMinutes < 1 &&
      status !== PAYMENT_STATUS_FINALIZING &&
      status !== PAYMENT_STATUS_EMAIL_PARTIAL &&
      status !== PAYMENT_STATUS_NEEDS_RECOVERY
    ) {
      continue;
    }

    let providerData = {};
    if (
      String(record.provider || "").trim().toLowerCase() !== "free" &&
      (status === PAYMENT_STATUS_STARTED ||
        status === PAYMENT_STATUS_NEEDS_RECOVERY)
    ) {
      if (!String(record.providerOrderId || "").trim()) {
        if (createdAgeMinutes >= PAYMENT_HOLD_MINUTES) {
          const abandoned = await abandonStartedPaymentRecord({
            client,
            record,
            reason: "provider_order_was_never_exposed",
            releaseCouponReservation,
          });
          if (
            String(abandoned?.paymentRecord?.status || "").trim().toLowerCase() ===
              PAYMENT_STATUS_ABANDONED &&
            abandoned?.paymentRecord?.resourceReleasePending !== true
          ) {
            summary.abandoned += 1;
          } else {
            summary.recovery += 1;
          }
          continue;
        }
        try {
          const providerPayload = await createProviderOrderForRecord(record);
          const recoveredRecord = await attachImmutableProviderOrder({
            client,
            record,
            providerPayload,
          });
          Object.assign(record, recoveredRecord, {
            recoveryReason: "",
            orderState: "created",
          });
        } catch (error) {
          await markRetryableFinalizeFailure({
            client,
            record,
            source: "reconcile",
            reason: "provider_order_creation_unavailable",
            details: { code: String(error?.code || "").trim() },
          });
          summary.providerUnavailable += 1;
          summary.recovery += 1;
          continue;
        }
      }
      const inspection = await inspectProviderOrderForRecovery(record);
      if (inspection.state === "captured") {
        providerData = inspection.providerData || {};
        if (!hasRecoverableBookingPayload(record)) {
          let recovered;
          try {
            recovered = await recoverCapturedPaymentAsReschedule({
              client,
              record,
              reason: "captured_payment_missing_booking_payload",
              createRequiresRescheduleBooking,
              dispatchRescheduleNotifications,
              providerData,
            });
          } catch (error) {
            const duplicate = await normalizeMarkedDuplicatePaymentRecord({
              client,
              record,
              providerOrderId: record.providerOrderId,
              providerPaymentId:
                providerData.providerPaymentId ||
                providerData.razorpayPaymentId ||
                providerData.paypalPaymentId ||
                record.providerPaymentId,
              error,
            });
            if (!duplicate?._id) throw error;
            recovered = duplicate;
          }
          if (recovered?._id) {
            if (String(recovered.bookingId || "").trim()) {
              summary.finalized += 1;
            } else {
              summary.recovery += 1;
            }
          } else {
            summary.recovery += 1;
          }
          continue;
        }
      } else if (inspection.state === "unpaid") {
        if (createdAgeMinutes >= PAYMENT_HOLD_MINUTES) {
          const abandoned = await abandonStartedPaymentRecord({
            client,
            record,
            reason: "provider_confirmed_unpaid",
            releaseCouponReservation,
          });
          if (
            String(abandoned?.paymentRecord?.status || "").trim().toLowerCase() ===
              PAYMENT_STATUS_ABANDONED &&
            abandoned?.paymentRecord?.resourceReleasePending !== true
          ) {
            summary.abandoned += 1;
          } else {
            summary.recovery += 1;
          }
        } else {
          await scheduleProviderRecoveryCheck({
            client,
            record,
            reason: "provider_confirmed_unpaid_before_expiry",
          });
          summary.pending += 1;
        }
        continue;
      } else if (inspection.state === "pending") {
        await scheduleProviderRecoveryCheck({
          client,
          record,
          reason: "provider_payment_pending",
        });
        summary.pending += 1;
        continue;
      } else {
        if (
          isDefinitiveMissingProviderOrder(inspection) &&
          createdAgeMinutes >= PAYMENT_HOLD_MINUTES &&
          !String(record.providerPaymentId || "").trim()
        ) {
          const abandoned = await abandonStartedPaymentRecord({
            client,
            record,
            reason: "provider_order_not_found_after_expiry",
            releaseCouponReservation,
          });
          if (
            String(abandoned?.paymentRecord?.status || "")
              .trim()
              .toLowerCase() === PAYMENT_STATUS_ABANDONED &&
            abandoned?.paymentRecord?.resourceReleasePending !== true
          ) {
            summary.abandoned += 1;
          } else {
            summary.recovery += 1;
          }
          continue;
        }
        await markRetryableFinalizeFailure({
          client,
          record,
          source: "reconcile",
          reason: inspection.reason || "provider_status_unavailable",
        });
        summary.providerUnavailable += 1;
        summary.recovery += 1;
        continue;
      }
    }

    const result = await finalizePaymentRecordInternal({
      client,
      record,
      source: "reconcile",
      providerData,
    });
    const nextStatus = String(result?.response?.status || "").trim().toLowerCase();
    if (nextStatus === PAYMENT_STATUS_BOOKED || nextStatus === PAYMENT_STATUS_EMAIL_PARTIAL) {
      summary.finalized += 1;
    } else if (nextStatus === PAYMENT_STATUS_NEEDS_RECOVERY) {
      const recoveryHttpStatus = Number(result?.paymentRecord?.recoveryHttpStatus || 0);
      if (
        result?.paymentRecord?.recoveryCategory === "booking_finalize" &&
        recoveryHttpStatus >= 400 &&
        recoveryHttpStatus < 500
      ) {
        let recovered;
        try {
          recovered = await recoverCapturedPaymentAsReschedule({
            client,
            record: result.paymentRecord,
            reason: result.paymentRecord.recoveryReason,
            createRequiresRescheduleBooking,
            dispatchRescheduleNotifications,
            providerData,
          });
        } catch (error) {
          const duplicate = await normalizeMarkedDuplicatePaymentRecord({
            client,
            record: result.paymentRecord,
            providerOrderId: result.paymentRecord.providerOrderId,
            providerPaymentId:
              providerData.providerPaymentId ||
              providerData.razorpayPaymentId ||
              providerData.paypalPaymentId ||
              result.paymentRecord.providerPaymentId,
            error,
          });
          if (!duplicate?._id) throw error;
          recovered = duplicate;
        }
        if (recovered?._id) {
          if (String(recovered.bookingId || "").trim()) {
            summary.finalized += 1;
          } else {
            summary.recovery += 1;
          }
        } else {
          summary.recovery += 1;
        }
      } else {
        summary.recovery += 1;
      }
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
  backendOwner = "supabase",
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
      backendOwner,
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
      backendOwner: backendOwner === "supabase" ? "supabase" : "sanity",
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

const normalizeRefundStatus = (value = "") => {
  const status = String(value || "").trim().toLowerCase();
  if (["processed", "completed", "refunded", "reversed"].includes(status)) {
    return "processed";
  }
  if (["failed", "denied", "cancelled", "canceled"].includes(status)) {
    return "failed";
  }
  return "pending";
};

const buildRefundMutation = ({
  record,
  provider,
  providerOrderId,
  providerPaymentId,
  providerRefundId,
  eventType,
  refundStatus,
  amount,
  amountInSubunits,
  currency,
  reversed,
  expectedAmountInSubunits = 0,
  expectedCurrency = "",
}) => {
  const normalizedStatus = normalizeRefundStatus(
    reversed ? "reversed" : refundStatus
  );
  const refundKey =
    String(providerRefundId || "").trim() ||
    `${eventType}:${providerPaymentId || providerOrderId}`;
  const existingRefunds = Array.isArray(record.refunds) ? record.refunds : [];
  const previousRefund = existingRefunds.find(
    (entry) =>
      String(entry?.providerRefundId || "").trim() === refundKey ||
      String(entry?._key || "").trim() === refundKey
  );
  const nextRefund = {
    _key: crypto
      .createHash("sha256")
      .update(`${provider}:${refundKey}`)
      .digest("hex")
      .slice(0, 24),
    providerRefundId: String(providerRefundId || "").trim(),
    providerPaymentId: String(providerPaymentId || "").trim(),
    eventType: String(eventType || "").trim(),
    status:
      previousRefund?.status === "processed" ? "processed" : normalizedStatus,
    amount: Math.max(toMoney(previousRefund?.amount || 0), toMoney(amount)),
    amountInSubunits: Math.max(
      Number(previousRefund?.amountInSubunits || 0),
      Number(amountInSubunits || 0)
    ),
    currency: String(currency || "").trim().toUpperCase(),
    reversed: reversed === true,
    updatedAt: nowIso(),
  };
  const refunds = [
    ...existingRefunds.filter(
      (entry) =>
        String(entry?.providerRefundId || entry?._key || "") !== refundKey &&
        String(entry?._key || "") !== nextRefund._key
    ),
    nextRefund,
  ].slice(-100);
  const storedExpectedAmount = Number(record?.pricingSnapshot?.netAmount || 0);
  const resolvedExpectedCurrency =
    String(expectedCurrency || record?.providerPublicData?.currency || currency || "USD")
      .trim()
      .toUpperCase() || "USD";
  const processedAmount = refunds
    .filter((entry) => entry.status === "processed")
    .reduce((sum, entry) => {
      if (provider === "razorpay" && Number(entry.amountInSubunits || 0) > 0) {
        return sum + Number(entry.amountInSubunits || 0);
      }
      return sum + toSubunits(entry.amount || 0, resolvedExpectedCurrency);
    }, 0);
  const expectedSubunits =
    storedExpectedAmount > 0
      ? toSubunits(storedExpectedAmount, resolvedExpectedCurrency)
      : Number(expectedAmountInSubunits || 0);
  const wasFullRefund =
    String(record.refundState || "").trim().toLowerCase() === "full" ||
    String(record.status || "").trim().toLowerCase() === PAYMENT_STATUS_REFUNDED;
  const isFullRefund =
    wasFullRefund ||
    reversed === true ||
    (expectedSubunits > 0 && processedAmount >= expectedSubunits);
  const refundState = isFullRefund
    ? "full"
    : processedAmount > 0
    ? "partial"
    : normalizedStatus;
  return {
    isFullRefund,
    nextRefund,
    processedAmount,
    refundState,
    set: {
      refunds,
      refundState,
      refundProcessedAmountInSubunits: processedAmount,
      refundCurrency: resolvedExpectedCurrency,
      ...(storedExpectedAmount <= 0 && expectedSubunits > 0
        ? {
            pricingSnapshot: {
              ...normalizeObject(record.pricingSnapshot),
              netAmount: fromSubunits(expectedSubunits, resolvedExpectedCurrency),
            },
            providerPublicData: {
              ...normalizeObject(record.providerPublicData),
              currency: resolvedExpectedCurrency,
            },
          }
        : {}),
      refundRequiresBookingSync: isFullRefund
        ? wasFullRefund
          ? record.refundRequiresBookingSync === true
          : true
        : false,
      ...(isFullRefund
        ? {
            status: PAYMENT_STATUS_REFUNDED,
            recoveryReason: "refund_requires_booking_sync",
          }
        : {}),
    },
  };
};

const applyFullRefundEffects = async ({
  client,
  record,
  refund,
  applyBookingRefund,
}) => {
  try {
    if (String(record?.bookingId || "").trim()) {
      if (typeof applyBookingRefund !== "function") {
        return { ok: false, reason: "booking_refund_handler_unavailable" };
      }
      const sync = await applyBookingRefund({
        client,
        paymentRecord: record,
        refund,
      });
      return String(sync?.bookingId || "").trim()
        ? { ok: true, sync }
        : { ok: false, reason: "booking_refund_sync_incomplete", sync };
    }

    const release = await releasePaymentResources({
      client,
      record,
      reason: "full_refund_before_booking",
    });
    return release.ok
      ? {
          ok: true,
          sync: {
            bookingId: "",
            releasedUnbookedPaymentResources: true,
          },
        }
      : {
          ok: false,
          reason: "refund_resource_release_pending",
          errors: release.errors,
        };
  } catch (error) {
    return {
      ok: false,
      reason: getSafeErrorCode(error, "refund_side_effect_failed"),
    };
  }
};

const processPaymentRefund = async ({
  client,
  provider,
  providerOrderId = "",
  providerPaymentId = "",
  providerRefundId = "",
  eventType = "",
  refundStatus = "",
  amount = 0,
  amountInSubunits = 0,
  currency = "",
  reversed = false,
  applyBookingRefund = null,
  backendOwner = "supabase",
}) => {
  let resolvedProviderOrderId = String(providerOrderId || "").trim();
  let razorpayPaymentLookup = null;
  let record = await loadPaymentRecordForFinalize({
    client,
    provider,
    providerOrderId: resolvedProviderOrderId,
    providerPaymentId,
  });
  if (
    String(provider || "").trim().toLowerCase() === "razorpay" &&
    String(providerPaymentId || "").trim() &&
    (!record?._id || !hasRecoverableBookingPayload(record))
  ) {
    razorpayPaymentLookup = await inspectRazorpayPayment({
      paymentId: String(providerPaymentId || "").trim(),
    });
    if (
      razorpayPaymentLookup.state !== "found" ||
      !razorpayPaymentLookup.providerOrderId
    ) {
      return {
        httpStatus: 503,
        retryWebhook: true,
        body: {
          ok: false,
          error: "Razorpay payment details are temporarily unavailable.",
          code:
            razorpayPaymentLookup.reason ||
            "razorpay_refund_order_resolution_failed",
        },
      };
    }
    resolvedProviderOrderId = String(
      razorpayPaymentLookup.providerOrderId
    ).trim();
    const canonicalRecord = await loadPaymentRecordForFinalize({
      client,
      provider,
      providerOrderId: resolvedProviderOrderId,
      providerPaymentId,
    });
    if (canonicalRecord?._id) record = canonicalRecord;
  }
  if (!record?._id) {
    record = await findOrCreateWebhookRecoveryRecord({
      client,
      provider,
      providerOrderId: resolvedProviderOrderId,
      providerPaymentId,
      eventType,
      backendOwner,
    });
  }

  let expectedAmountInSubunits = 0;
  let expectedCurrency = String(
    record?.providerPublicData?.currency || currency || ""
  )
    .trim()
    .toUpperCase();
  if (Number(record?.pricingSnapshot?.netAmount || 0) <= 0) {
    if (String(provider || "").trim().toLowerCase() === "razorpay") {
      if (!razorpayPaymentLookup) {
        razorpayPaymentLookup = await inspectRazorpayPayment({
          paymentId: String(providerPaymentId || "").trim(),
        });
      }
      if (
        razorpayPaymentLookup.state !== "found" ||
        Number(razorpayPaymentLookup.amountInSubunits || 0) <= 0
      ) {
        return {
          httpStatus: 503,
          retryWebhook: true,
          body: {
            ok: false,
            error: "Razorpay refund amount could not be verified.",
            code:
              razorpayPaymentLookup.reason ||
              "razorpay_refund_baseline_unavailable",
          },
        };
      }
      expectedAmountInSubunits = Number(
        razorpayPaymentLookup.amountInSubunits || 0
      );
      expectedCurrency = String(
        razorpayPaymentLookup.currency || expectedCurrency || "USD"
      )
        .trim()
        .toUpperCase();
    } else if (String(provider || "").trim().toLowerCase() === "paypal") {
      const orderInspection = await inspectPayPalOrder({
        orderId: resolvedProviderOrderId,
      });
      const captureAmount = toMoney(
        orderInspection?.details?.purchase_units?.[0]?.payments?.captures?.[0]
          ?.amount?.value ||
          orderInspection?.details?.purchase_units?.[0]?.amount?.value ||
          0
      );
      const captureCurrency = String(
        orderInspection?.details?.purchase_units?.[0]?.payments?.captures?.[0]
          ?.amount?.currency_code ||
          orderInspection?.details?.purchase_units?.[0]?.amount?.currency_code ||
          ""
      )
        .trim()
        .toUpperCase();
      if (orderInspection?.state !== "captured" || captureAmount <= 0) {
        return {
          httpStatus: 503,
          retryWebhook: true,
          body: {
            ok: false,
            error: "PayPal refund amount could not be verified.",
            code:
              orderInspection?.reason || "paypal_refund_baseline_unavailable",
          },
        };
      }
      expectedCurrency = captureCurrency || expectedCurrency || "USD";
      expectedAmountInSubunits = toSubunits(
        captureAmount,
        expectedCurrency
      );
    }
  }

  const normalizedRefundCurrency = String(currency || "").trim().toUpperCase();
  const normalizedExpectedCurrency = String(expectedCurrency || "")
    .trim()
    .toUpperCase();
  if (
    !reversed &&
    normalizeRefundStatus(refundStatus) === "processed" &&
    normalizedRefundCurrency &&
    normalizedExpectedCurrency &&
    normalizedRefundCurrency !== normalizedExpectedCurrency
  ) {
    return {
      httpStatus: 409,
      body: {
        ok: false,
        code: "refund_currency_mismatch",
        error: "Refund currency does not match the captured payment.",
      },
    };
  }

  let mutation = null;
  let nextRecord = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    mutation = buildRefundMutation({
      record,
      provider,
      providerOrderId: resolvedProviderOrderId,
      providerPaymentId,
      providerRefundId,
      eventType,
      refundStatus,
      amount,
      amountInSubunits,
      currency,
      reversed,
      expectedAmountInSubunits,
      expectedCurrency,
    });
    try {
      nextRecord = await patchPaymentRecord({
        client,
        record,
        revisionGuard: true,
        set: mutation.set,
        event: buildPaymentRecordEvent({
          status: mutation.isFullRefund
            ? PAYMENT_STATUS_REFUNDED
            : record.status,
          source: "webhook",
          reason: `refund_${mutation.refundState}`,
          data: mutation.nextRefund,
        }),
      });
      break;
    } catch (error) {
      if (!isConflictError(error) || attempt === 4) throw error;
      record = await getPaymentRecordById(client, record._id);
      if (!record?._id) throw error;
    }
  }
  const {
    isFullRefund,
    nextRefund,
    processedAmount,
    refundState,
  } = mutation;

  if (isFullRefund && nextRecord.refundRequiresBookingSync === true) {
    const sideEffects = await applyFullRefundEffects({
      client,
      record: nextRecord,
      refund: {
        ...nextRefund,
        state: refundState,
        type: reversed ? "reversal" : refundState,
        full: isFullRefund,
        processedAmountInSubunits: processedAmount,
      },
      applyBookingRefund,
    });
    if (sideEffects.ok) {
      nextRecord = await patchPaymentRecord({
        client,
        record: nextRecord,
        set: {
          refundRequiresBookingSync: false,
          recoveryReason: "",
          refundBookingSync: normalizeObject(sideEffects.sync),
        },
      });
    }
  }

  return {
    httpStatus: isFullRefund && nextRecord.refundRequiresBookingSync ? 202 : 200,
    body: {
      ...buildPublicStatusBody(nextRecord),
      refundState,
    },
  };
};

export const handleRazorpayWebhook = async ({
  req,
  client = createCommerceWriteClient(),
  applyBookingRefund = null,
  backendOwner = client?.backend === "sanity" ? "sanity" : "supabase",
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
  const rawBody = String(req?.rawBody || "");
  const eventId = String(event?.id || "").trim();
  const receiptClaim = await claimWebhookReceipt({
    client,
    provider: "razorpay",
    eventId,
    eventType,
    rawBody,
    backendOwner,
  });
  if (!receiptClaim.acquired) {
    return {
      httpStatus: receiptClaim.processed ? 200 : 503,
      body: {
        ok: receiptClaim.processed,
        duplicate: true,
        processing: !receiptClaim.processed,
        ...(!receiptClaim.processed
          ? { error: "Webhook processing is still in progress. Please retry." }
          : {}),
      },
    };
  }

  const payment = normalizeObject(event?.payload?.payment?.entity);
  const refund = normalizeObject(event?.payload?.refund?.entity);
  let result;
  if (!eventType) {
    result = {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  } else if (["refund.created", "refund.processed", "refund.failed"].includes(eventType)) {
    const refundHandler = applyBookingRefund || (await loadBookingRefundHandler());
    result = await processPaymentRefund({
      client,
      provider: "razorpay",
      providerPaymentId: String(refund.payment_id || "").trim(),
      providerRefundId: String(refund.id || "").trim(),
      eventType,
      refundStatus: String(refund.status || eventType.split(".")[1] || "").trim(),
      amountInSubunits: Number(refund.amount || 0),
      currency: String(refund.currency || "").trim(),
      applyBookingRefund: refundHandler,
      backendOwner,
    });
  } else if (
    (eventType !== "payment.captured" && eventType !== "order.paid") ||
    !payment?.id
  ) {
    result = {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  } else {
    const record = await findOrCreateWebhookRecoveryRecord({
      client,
      provider: "razorpay",
      providerOrderId: String(payment.order_id || "").trim(),
      providerPaymentId: String(payment.id || "").trim(),
      payerEmail: String(payment.email || "").trim(),
      eventType,
      backendOwner,
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
    result = { httpStatus: finalized.httpStatus, body: finalized.response };
  }

  if (result?.retryWebhook === true) {
    await releaseWebhookReceiptForRetry({
      client,
      receipt: receiptClaim.receipt,
      result,
    });
  } else {
    await completeWebhookReceipt({ client, receipt: receiptClaim.receipt, result });
  }
  return result;
};

export const handlePayPalWebhook = async ({
  req,
  client = createCommerceWriteClient(),
  applyBookingRefund = null,
  backendOwner = client?.backend === "sanity" ? "sanity" : "supabase",
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
  const rawBody = String(req?.rawBody || "");
  const receiptClaim = await claimWebhookReceipt({
    client,
    provider: "paypal",
    eventId:
      String(event?.id || "").trim() ||
      String(req?.headers?.["paypal-transmission-id"] || "").trim(),
    eventType,
    rawBody,
    backendOwner,
  });
  if (!receiptClaim.acquired) {
    return {
      httpStatus: receiptClaim.processed ? 200 : 503,
      body: {
        ok: receiptClaim.processed,
        duplicate: true,
        processing: !receiptClaim.processed,
        ...(!receiptClaim.processed
          ? { error: "Webhook processing is still in progress. Please retry." }
          : {}),
      },
    };
  }

  const resource = normalizeObject(event?.resource);
  const relatedIds = normalizeObject(resource?.supplementary_data?.related_ids);
  let result;
  if (
    eventType === "PAYMENT.CAPTURE.REFUNDED" ||
    eventType === "PAYMENT.CAPTURE.REVERSED" ||
    eventType === "PAYMENT.REFUND.PENDING" ||
    eventType === "PAYMENT.REFUND.FAILED"
  ) {
    const refundHandler = applyBookingRefund || (await loadBookingRefundHandler());
    result = await processPaymentRefund({
      client,
      provider: "paypal",
      providerOrderId: String(relatedIds.order_id || "").trim(),
      providerPaymentId: String(
        relatedIds.capture_id || resource.capture_id || ""
      ).trim(),
      providerRefundId: String(resource.id || "").trim(),
      eventType,
      refundStatus: String(
        resource.status ||
          (eventType === "PAYMENT.REFUND.PENDING"
            ? "PENDING"
            : eventType === "PAYMENT.REFUND.FAILED"
            ? "FAILED"
            : "COMPLETED")
      ).trim(),
      amount: toMoney(resource?.amount?.value || 0),
      currency: String(resource?.amount?.currency_code || "").trim(),
      reversed: eventType === "PAYMENT.CAPTURE.REVERSED",
      applyBookingRefund: refundHandler,
      backendOwner,
    });
  } else if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
    result = {
      httpStatus: 200,
      body: { ok: true, ignored: true },
    };
  } else {
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
      backendOwner,
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
    result = { httpStatus: finalized.httpStatus, body: finalized.response };
  }

  if (result?.retryWebhook === true) {
    await releaseWebhookReceiptForRetry({
      client,
      receipt: receiptClaim.receipt,
      result,
    });
  } else {
    await completeWebhookReceipt({ client, receipt: receiptClaim.receipt, result });
  }
  return result;
};
