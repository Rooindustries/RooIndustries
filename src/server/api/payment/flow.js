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
  inspectPayPalOrder,
  inspectRazorpayOrder,
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

const { resolvePaymentProviders, resolveServerPaymentSessionsEnabled } =
  providerConfig;

const RECOVERY_HOLD_HOURS = 72;
const FINALIZATION_LEASE_SECONDS = 90;
const WEBHOOK_LEASE_SECONDS = 120;

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
  if (status !== PAYMENT_STATUS_EMAIL_PARTIAL) return false;
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

const buildPublicStatusBody = (record = {}) => ({
  ok: true,
  status: String(record.status || "").trim(),
  provider: String(record.provider || "").trim(),
  bookingId: String(record.bookingId || "").trim(),
  recoveryReason: String(record.recoveryReason || "").trim(),
  nextRecoveryAt: String(record.nextRecoveryAt || "").trim(),
  sessionExpiresAt: String(
    record?.holdSnapshot?.slotHoldExpiresAt || record.sessionExpiresAt || ""
  ).trim(),
  refundState: String(record.refundState || "").trim(),
  refundRequiresBookingSync: record.refundRequiresBookingSync === true,
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
  try {
    if (typeof client.transaction === "function") {
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
      await transaction.commit();
    } else {
      if (couponReservationPlan) {
        throw new Error("Coupon reservations require transactional storage support.");
      }
      await client.create(claim);
      await client.create(record);
      if (holdDoc?._id) {
        await client.patch(holdDoc._id).set(holdPatch).commit();
      }
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

const claimPaymentProof = async ({
  client,
  record,
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const provider = String(record?.provider || "").trim().toLowerCase();
  const claimId =
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
    paymentRecordId: record._id,
    provider: record.provider,
    providerOrderId: String(providerOrderId || "").trim(),
    providerPaymentId: String(providerPaymentId || "").trim(),
    claimedAt: nowIso(),
  };
  try {
    return await client.create(claim);
  } catch (error) {
    if (!isConflictError(error)) throw error;
    const current = await getDocumentById({
      client,
      id: claimId,
      type: PAYMENT_PROOF_CLAIM_TYPE,
    });
    if (String(current?.paymentRecordId || "") === String(record._id || "")) {
      return current;
    }
    const conflict = new Error("This payment has already been used for another booking.");
    conflict.status = 409;
    conflict.code = "payment_proof_already_claimed";
    throw conflict;
  }
};

const acquireFinalizationLease = async ({ client, record, source }) => {
  const current = (await getPaymentRecordById(client, record._id)) || record;
  const currentStatus = String(current.status || "").trim().toLowerCase();
  if (
    currentStatus === PAYMENT_STATUS_FINALIZING &&
    isFutureIso(current.finalizationLeaseExpiresAt)
  ) {
    return { acquired: false, record: current, leaseId: "" };
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
    return { acquired: true, record: leased, leaseId };
  } catch (error) {
    if (!isConflictError(error)) throw error;
    return {
      acquired: false,
      record: (await getPaymentRecordById(client, record._id)) || current,
      leaseId: "",
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
      return claimWebhookReceipt({ client, provider, eventId, eventType, rawBody });
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

  if (
    holdDoc?._id &&
    String(holdDoc.paymentRecordId || "").trim() &&
    String(holdDoc.paymentRecordId || "").trim() !== String(record._id || "").trim() &&
    isFutureIso(holdDoc.expiresAt)
  ) {
    return null;
  }

  const nextNonce = holdDoc?.holdNonce || holdNonce;
  let holdPatch = client
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
    });
  if (holdDoc?._rev && typeof holdPatch.ifRevisionId === "function") {
    holdPatch = holdPatch.ifRevisionId(holdDoc._rev);
  }
  await holdPatch.commit();

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
  if (typeof handler !== "function") return null;
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
  await client.delete(lockId).catch(() => {});
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
  const refreshedHold = await createOrRefreshRecoveryHold({
    client,
    record,
    reason,
  }).catch(() => null);

  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_NEEDS_RECOVERY,
      recoveryReason: reason,
      recoveryAttemptCount,
      nextRecoveryAt: getNextPaymentRecoveryAt(recoveryAttemptCount),
      finalizationLeaseId: "",
      finalizationLeaseExpiresAt: "",
      source,
      ...(Number(details?.createBookingStatus || 0) > 0
        ? {
            recoveryCategory: "booking_finalize",
            recoveryHttpStatus: Number(details.createBookingStatus),
          }
        : {}),
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
  const nextRecord = await patchPaymentRecord({
    client,
    record,
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
  await releasePendingHold({ client, record });
  await releaseCouponForPaymentRecord({
    client,
    record,
    reason,
  }).catch(() => null);
  await releaseUpgradeLockForPaymentRecord({ client, record }).catch(() => null);
  const nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      status: PAYMENT_STATUS_FAILED,
      recoveryReason: reason,
      source,
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

  if (
    isPaymentTerminalStatus(record.status) &&
    String(record.status || "").trim().toLowerCase() !== PAYMENT_STATUS_NEEDS_RECOVERY &&
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
    proofClaim = await claimPaymentProof({
      client,
      record: workingRecord,
      providerOrderId:
        verification.providerOrderId || workingRecord.providerOrderId || "",
      providerPaymentId:
        verification.providerPaymentId || workingRecord.providerPaymentId || "",
    });
  } catch (error) {
    return markRetryableFinalizeFailure({
      client,
      record: workingRecord,
      source: normalizedSource,
      reason: error?.code || "payment_proof_claim_failed",
      details: providerData,
    });
  }

  const captureStatus = resolveClientSourceStatus(normalizedSource);
  workingRecord = await patchPaymentRecord({
    client,
    record: workingRecord,
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

  const createPayload = buildLegacyBookingPayload({
    record: workingRecord,
    providerData,
    source: normalizedSource,
  });
  const result = await invokeCreateBooking(createPayload, {
    paymentFinalizeSource: normalizedSource,
    paymentProofClaimId: String(proofClaim?._id || "").trim(),
    paymentFinalizationLeaseId: lease.leaseId,
    couponReservationId: String(workingRecord.couponReservationId || "").trim(),
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
        recoveryAttemptCount: 0,
        nextRecoveryAt: "",
        finalizationLeaseId: "",
        finalizationLeaseExpiresAt: "",
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
  await releasePendingHold({ client, record });
  await releaseCouponForPaymentRecord({
    client,
    record,
    reason,
    releaseCouponReservation,
  }).catch(() => null);
  await releaseUpgradeLockForPaymentRecord({ client, record }).catch(() => null);
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
  quoteFingerprint,
  prepareCouponReservation = null,
  appendCouponReservation = null,
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

  const sessionScope = buildPaymentSessionScope({
    bookingPayload,
    holdNonce: holdDoc?.holdNonce || "",
  });
  const isUpgrade = !!String(bookingPayload.originalOrderId || "").trim();
  const paymentRecordId = buildPaymentSessionRecordId(
    isUpgrade ? `${sessionScope}:${crypto.randomUUID()}` : sessionScope
  );
  const startClaimId = isUpgrade
    ? buildPaymentUpgradeLockId(sessionScope)
    : buildPaymentStartClaimId(sessionScope);
  const providerIdempotencyKey = buildPaymentProviderIdempotencyKey(paymentRecordId);
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
      })
    : "";
  const createdAt = nowIso();
  const doc = {
    _id: paymentRecordId,
    _type: PAYMENT_RECORD_TYPE,
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
    sessionExpiresAt: expiresAt,
    emailDispatch: {},
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
    scope: sessionScope,
    paymentRecordId,
    provider,
    quoteFingerprint,
    createdAt,
    updatedAt: createdAt,
  };
  const holdPatch = holdDoc?._id
    ? {
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

  let providerPayload;
  if (provider === "razorpay") {
    providerPayload = await createRazorpayOrder({
      amount: quote.effectiveNetAmount,
      currency: DEFAULT_RAZORPAY_CURRENCY,
      receipt: record.providerIdempotencyKey || providerIdempotencyKey,
      notes: {
        paymentRecordId: record._id,
        bookingSeedKey,
        holdId: bookingPayload.slotHoldId || "",
        startTimeUTC: bookingPayload.startTimeUTC || "",
        packageTitle: bookingPayload.packageTitle || "",
        originalOrderId: bookingPayload.originalOrderId || "",
        referralCode: bookingPayload.referralCode || "",
        couponCode: bookingPayload.couponCode || "",
      },
    });
  } else {
    providerPayload = await createPayPalOrder({
      amount: quote.effectiveNetAmount,
      currency: DEFAULT_PAYPAL_CURRENCY,
      description: `${bookingPayload.packageTitle} booking`,
      customId: record._id,
      requestId: record.providerIdempotencyKey || providerIdempotencyKey,
    });
    providerPayload = {
      ...providerPayload,
      clientId: resolvePaymentProviders()?.paypal?.clientId || "",
    };
  }

  record = await attachImmutableProviderOrder({ client, record, providerPayload });
  return record;
};

export const startPaymentSession = async ({
  body,
  client = createRefWriteClient(),
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
      prepareCouponReservation,
      appendCouponReservation,
    });
    const refreshed = record?._id
      ? record
      : await getPaymentRecordById(client, record._id);
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
  paymentAccessToken = "",
  allowLegacyTokenFallback = true,
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
      paymentAccessToken: String(
        paymentAccessToken ||
          (allowLegacyTokenFallback ? requestBody.paymentAccessToken : "") ||
          ""
      ).trim(),
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
    const terminalStatus = String(record?.status || "").trim().toLowerCase();
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
}) => {
  const handler =
    createRequiresRescheduleBooking || (await loadRequiresRescheduleHandler());
  if (typeof handler !== "function") return null;

  const recovery = await handler({
    client,
    paymentRecord: record,
    reason: reason || "captured_payment_requires_reschedule",
    notify: false,
  });
  const bookingId = String(recovery?.bookingId || recovery?.booking?._id || "").trim();
  if (!bookingId) return null;

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
        reason: error?.message || "notification_dispatch_failed",
      };
    }
  }
  const notificationComplete =
    notification?.ok === true && notification?.notificationRequired !== true;
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;

  return patchPaymentRecord({
    client,
    record,
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
      reason: error?.message || "notification_dispatch_failed",
    };
  }
  const complete =
    notification?.ok === true && notification?.notificationRequired !== true;
  const recoveryAttemptCount = Number(record.recoveryAttemptCount || 0) + 1;
  return patchPaymentRecord({
    client,
    record,
    set: {
      status: complete ? PAYMENT_STATUS_BOOKED : PAYMENT_STATUS_EMAIL_PARTIAL,
      recoveryReason: complete
        ? "requires_reschedule"
        : "reschedule_notification_pending",
      recoveryNotificationRequired: !complete,
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
};

export const getPaymentStatus = async ({
  query,
  paymentAccessToken: suppliedPaymentAccessToken = "",
  allowLegacyTokenFallback = true,
  client = createRefWriteClient(),
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
  return {
    httpStatus: 200,
    body: buildPublicStatusBody(resolved.record),
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
  createRequiresRescheduleBooking = null,
  applyBookingRefund = null,
  releaseCouponReservation = null,
  dispatchRescheduleNotifications = null,
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
        PAYMENT_STATUS_EMAIL_PARTIAL,
        PAYMENT_STATUS_NEEDS_RECOVERY,
        PAYMENT_STATUS_REFUNDED,
      ],
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
      if (typeof refundHandler === "function") {
        const sync = await refundHandler({
          client,
          paymentRecord: record,
          refund: {
            full: true,
            type: record.refundState === "reversal" ? "reversal" : "full",
            state: record.refundState || "full",
            processedAmountInSubunits: Number(
              record.refundProcessedAmountInSubunits || 0
            ),
          },
        });
        if (sync?.ok !== false) {
          await patchPaymentRecord({
            client,
            record,
            set: {
              refundRequiresBookingSync: false,
              recoveryReason: "",
              refundBookingSync: normalizeObject(sync),
            },
          });
          summary.refundsSynced += 1;
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
      const inspection = await inspectProviderOrderForRecovery(record);
      if (inspection.state === "captured") {
        providerData = inspection.providerData || {};
        if (!hasRecoverableBookingPayload(record)) {
          const recovered = await recoverCapturedPaymentAsReschedule({
            client,
            record,
            reason: "captured_payment_missing_booking_payload",
            createRequiresRescheduleBooking,
            dispatchRescheduleNotifications,
          });
          if (recovered?._id) {
            summary.finalized += 1;
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
          if (abandoned.paymentRecord?._id) summary.abandoned += 1;
        } else {
          summary.pending += 1;
        }
        continue;
      } else if (inspection.state === "pending") {
        summary.pending += 1;
        continue;
      } else {
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
        const recovered = await recoverCapturedPaymentAsReschedule({
          client,
          record: result.paymentRecord,
          reason: result.paymentRecord.recoveryReason,
          createRequiresRescheduleBooking,
          dispatchRescheduleNotifications,
        });
        if (recovered?._id) {
          summary.finalized += 1;
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
}) => {
  let record = await loadPaymentRecordForFinalize({
    client,
    provider,
    providerOrderId,
    providerPaymentId,
  });
  if (!record?._id) {
    record = await findOrCreateWebhookRecoveryRecord({
      client,
      provider,
      providerOrderId,
      providerPaymentId,
      eventType,
    });
  }

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
  const incomingStatus = normalizedStatus;
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
      previousRefund?.status === "processed" ? "processed" : incomingStatus,
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
      (entry) => String(entry?.providerRefundId || entry?._key || "") !== refundKey &&
        String(entry?._key || "") !== nextRefund._key
    ),
    nextRefund,
  ].slice(-30);
  const expectedAmount = Number(record?.pricingSnapshot?.netAmount || 0);
  const expectedCurrency =
    String(record?.providerPublicData?.currency || currency || "USD")
      .trim()
      .toUpperCase() || "USD";
  const processedAmount = refunds
    .filter((entry) => entry.status === "processed")
    .reduce((sum, entry) => {
      if (provider === "razorpay" && Number(entry.amountInSubunits || 0) > 0) {
        return sum + Number(entry.amountInSubunits || 0);
      }
      return sum + toSubunits(entry.amount || 0, expectedCurrency);
    }, 0);
  const expectedSubunits = toSubunits(expectedAmount, expectedCurrency);
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
  let nextRecord = await patchPaymentRecord({
    client,
    record,
    set: {
      refunds,
      refundState,
      refundProcessedAmountInSubunits: processedAmount,
      refundCurrency: expectedCurrency,
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
    event: buildPaymentRecordEvent({
      status: isFullRefund ? PAYMENT_STATUS_REFUNDED : record.status,
      source: "webhook",
      reason: `refund_${refundState}`,
      data: nextRefund,
    }),
  });

  if (
    isFullRefund &&
    nextRecord.refundRequiresBookingSync === true &&
    typeof applyBookingRefund === "function"
  ) {
    const sync = await applyBookingRefund({
      client,
      paymentRecord: nextRecord,
      refund: {
        ...nextRefund,
        state: refundState,
        type: reversed ? "reversal" : refundState,
        full: isFullRefund,
        processedAmountInSubunits: processedAmount,
      },
    });
    if (sync?.ok !== false) {
      nextRecord = await patchPaymentRecord({
        client,
        record: nextRecord,
        set: {
          refundRequiresBookingSync: false,
          recoveryReason: "",
          refundBookingSync: normalizeObject(sync),
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
  client = createRefWriteClient(),
  applyBookingRefund = null,
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
  });
  if (!receiptClaim.acquired) {
    return {
      httpStatus: receiptClaim.processed ? 200 : 202,
      body: {
        ok: true,
        duplicate: true,
        processing: !receiptClaim.processed,
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

  await completeWebhookReceipt({ client, receipt: receiptClaim.receipt, result });
  return result;
};

export const handlePayPalWebhook = async ({
  req,
  client = createRefWriteClient(),
  applyBookingRefund = null,
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
  });
  if (!receiptClaim.acquired) {
    return {
      httpStatus: receiptClaim.processed ? 200 : 202,
      body: {
        ok: true,
        duplicate: true,
        processing: !receiptClaim.processed,
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

  await completeWebhookReceipt({ client, receipt: receiptClaim.receipt, result });
  return result;
};
