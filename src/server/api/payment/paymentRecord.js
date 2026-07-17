import crypto from "crypto";

export const PAYMENT_RECORD_TYPE = "paymentRecord";
export const PAYMENT_START_CLAIM_TYPE = "paymentStartClaim";
export const PAYMENT_UPGRADE_LOCK_TYPE = "paymentUpgradeLock";
export const PAYMENT_PROOF_CLAIM_TYPE = "paymentProofClaim";
export const PAYMENT_WEBHOOK_RECEIPT_TYPE = "paymentWebhookReceipt";
export const HOLD_PHASE_HOLDING = "holding";
export const HOLD_PHASE_PAYMENT_PENDING = "payment_pending";

export const PAYMENT_STATUS_STARTED = "started";
export const PAYMENT_STATUS_CAPTURED_CLIENT = "captured_client";
export const PAYMENT_STATUS_CAPTURED_WEBHOOK = "captured_webhook";
export const PAYMENT_STATUS_FINALIZING = "finalizing";
export const PAYMENT_STATUS_VERIFIED_SERVER = "verified_server";
export const PAYMENT_STATUS_BOOKED = "booked";
export const PAYMENT_STATUS_EMAIL_PARTIAL = "email_partial";
export const PAYMENT_STATUS_NEEDS_RECOVERY = "needs_recovery";
export const PAYMENT_STATUS_FAILED = "failed";
export const PAYMENT_STATUS_REFUNDED = "refunded";
export const PAYMENT_STATUS_ABANDONED = "abandoned";

export const PAYMENT_HOLD_MINUTES = 20;
export const PAYMENT_RECOVERY_MINUTES = 15;

export const stableHash = (value, length = 24) =>
  crypto
    .createHash("sha256")
    .update(String(value || ""))
    .digest("hex")
    .slice(0, Math.max(8, Number(length) || 24));

const normalizeLowerTrim = (value) => String(value || "").trim().toLowerCase();
const normalizeMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "0.00";
  return parsed.toFixed(2);
};

export const stringifyJson = (value) => {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
};

export const parseJson = (value, fallback = {}) => {
  if (!value || typeof value !== "string") return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export const buildBookingSeedKey = ({
  provider = "",
  packageTitle = "",
  originalOrderId = "",
  startTimeUTC = "",
  email = "",
}) =>
  [
    String(provider || "").trim().toLowerCase(),
    String(packageTitle || "").trim().toLowerCase(),
    String(originalOrderId || "").trim(),
    String(startTimeUTC || "").trim(),
    String(email || "").trim().toLowerCase(),
  ]
    .filter(Boolean)
    .join(":");

export const buildPricingFingerprint = ({
  provider = "",
  packageTitle = "",
  originalOrderId = "",
  startTimeUTC = "",
  email = "",
  grossAmount = 0,
  netAmount = 0,
  discountAmount = 0,
  referralId = "",
  referralCode = "",
  couponCode = "",
  currency = "",
}) =>
  stringifyJson({
    provider: normalizeLowerTrim(provider),
    packageTitle: String(packageTitle || "").trim(),
    originalOrderId: String(originalOrderId || "").trim(),
    startTimeUTC: String(startTimeUTC || "").trim(),
    email: normalizeLowerTrim(email),
    grossAmount: normalizeMoney(grossAmount),
    netAmount: normalizeMoney(netAmount),
    discountAmount: normalizeMoney(discountAmount),
    referralId: String(referralId || "").trim(),
    referralCode: normalizeLowerTrim(referralCode),
    couponCode: normalizeLowerTrim(couponCode),
    currency: String(currency || "").trim().toUpperCase(),
  });

export const buildQuoteFingerprint = ({
  bookingPayload = {},
  quote = {},
}) =>
  stableHash(
    buildPricingFingerprint({
      provider:
        String(quote.paymentProvider || "").trim().toLowerCase() === "free"
          ? "free"
          : "paid",
      packageTitle: bookingPayload.packageTitle || "",
      originalOrderId: bookingPayload.originalOrderId || "",
      startTimeUTC: bookingPayload.startTimeUTC || "",
      email: bookingPayload.email || "",
      grossAmount: Number(quote.effectiveGrossAmount || 0),
      netAmount:
        String(quote.paymentProvider || "").trim().toLowerCase() === "free"
          ? 0
          : Number(quote.effectiveNetAmount || 0),
      discountAmount: Number(quote.effectiveDiscountAmount || 0),
      referralId: String(quote.effectiveReferralId || "").trim(),
      referralCode: String(quote.effectiveReferralCode || "").trim(),
      couponCode: bookingPayload.couponCode || "",
      currency: "QUOTE",
    }),
    64
  );

export const buildPaymentSessionScope = ({
  bookingPayload = {},
  holdNonce = "",
}) => {
  const holdId = String(bookingPayload.slotHoldId || "").trim();
  if (holdId) return `hold:${holdId}:${String(holdNonce || "").trim()}`;

  const originalOrderId = String(bookingPayload.originalOrderId || "").trim();
  if (originalOrderId) {
    return [
      "upgrade",
      originalOrderId,
      normalizeLowerTrim(bookingPayload.packageTitle),
    ].join(":");
  }

  return [
    "booking",
    normalizeLowerTrim(bookingPayload.packageTitle),
    String(bookingPayload.startTimeUTC || "").trim(),
    normalizeLowerTrim(bookingPayload.email),
  ].join(":");
};

export const buildPaymentSessionRecordId = (scope = "") =>
  `paymentRecord.session.${stableHash(scope, 40)}`;

export const buildPaymentStartClaimId = (scope = "") =>
  `paymentStartClaim.${stableHash(scope, 40)}`;

export const buildPaymentUpgradeLockId = (scope = "") =>
  `paymentUpgradeLock.${stableHash(scope, 40)}`;

export const buildPaymentProofClaimId = ({
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const normalizedProvider = normalizeLowerTrim(provider) || "unknown";
  const proofId =
    normalizedProvider === "razorpay"
      ? String(providerPaymentId || "").trim()
      : String(providerOrderId || providerPaymentId || "").trim();
  return proofId
    ? `paymentProofClaim.${normalizedProvider}.${stableHash(proofId, 40)}`
    : "";
};

export const buildPaymentProviderIdempotencyKey = (paymentRecordId = "") =>
  `roo_${stableHash(paymentRecordId, 32)}`;

export const buildWebhookReceiptId = ({
  provider = "",
  eventId = "",
  eventType = "",
  rawBody = "",
}) =>
  `paymentWebhookReceipt.${normalizeLowerTrim(provider) || "unknown"}.${stableHash(
    `${eventId || ""}:${eventType || ""}:${rawBody || ""}`,
    40
  )}`;

export const getPaymentRecoveryBackoffMinutes = (attemptCount = 0) => {
  const normalized = Math.max(0, Number(attemptCount) || 0);
  if (normalized <= 1) return 1;
  if (normalized === 2) return 5;
  if (normalized === 3) return 15;
  return 60;
};

export const getNextPaymentRecoveryAt = (attemptCount = 0, now = Date.now()) =>
  new Date(
    Number(now) + getPaymentRecoveryBackoffMinutes(attemptCount) * 60 * 1000
  ).toISOString();

export const buildPaymentRecordId = ({
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
  bookingSeedKey = "",
}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase() || "unknown";
  if (normalizedProvider === "paypal" && providerOrderId) {
    return `paymentRecord.paypal.${String(providerOrderId).trim()}`;
  }
  if (normalizedProvider === "razorpay" && providerPaymentId) {
    return `paymentRecord.razorpay.payment.${String(providerPaymentId).trim()}`;
  }
  if (normalizedProvider === "razorpay" && providerOrderId) {
    return `paymentRecord.razorpay.order.${String(providerOrderId).trim()}`;
  }

  const fallbackSeed = bookingSeedKey || `${normalizedProvider}:${providerOrderId}:${providerPaymentId}`;
  return `paymentRecord.${normalizedProvider}.${stableHash(fallbackSeed)}`;
};

export const buildPaymentRecordEvent = ({
  status = "",
  source = "",
  reason = "",
  data = null,
}) => ({
  _key: stableHash(
    `${status}:${source}:${reason}:${Date.now()}:${Math.random()}`
  ),
  at: new Date().toISOString(),
  status: String(status || "").trim(),
  source: String(source || "").trim(),
  reason: String(reason || "").trim(),
  dataJson: data ? stringifyJson(data) : "",
});

export const mergePaymentRecordEvents = (existing = [], nextEvent = null) => {
  const list = Array.isArray(existing) ? [...existing] : [];
  if (nextEvent) list.push(nextEvent);
  return list.slice(-40);
};

export const isPaymentTerminalStatus = (status = "") => {
  const normalized = String(status || "").trim().toLowerCase();
  return (
    normalized === PAYMENT_STATUS_BOOKED ||
    normalized === PAYMENT_STATUS_EMAIL_PARTIAL ||
    normalized === PAYMENT_STATUS_NEEDS_RECOVERY ||
    normalized === PAYMENT_STATUS_FAILED ||
    normalized === PAYMENT_STATUS_REFUNDED ||
    normalized === PAYMENT_STATUS_ABANDONED
  );
};

export const getPaymentHoldExpiryIso = (minutes = PAYMENT_HOLD_MINUTES) =>
  new Date(Date.now() + minutes * 60 * 1000).toISOString();

export const isPaymentPendingStatus = (status = "") => {
  const normalized = String(status || "").trim().toLowerCase();
  return (
    normalized === PAYMENT_STATUS_STARTED ||
    normalized === PAYMENT_STATUS_CAPTURED_CLIENT ||
    normalized === PAYMENT_STATUS_CAPTURED_WEBHOOK ||
    normalized === PAYMENT_STATUS_FINALIZING ||
    normalized === PAYMENT_STATUS_VERIFIED_SERVER
  );
};

export const getPaymentRecordById = async (client, id) => {
  if (!id) return null;
  return client.fetch(
    `*[_type == $type && _id == $id][0]`,
    { type: PAYMENT_RECORD_TYPE, id }
  );
};

const hasPaymentRecordBookingPayload = (record = {}) => {
  const payload = record?.bookingPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  return !!(
    String(payload.packageTitle || "").trim() ||
    String(payload.originalOrderId || "").trim() ||
    String(payload.startTimeUTC || "").trim()
  );
};

export const findPaymentRecordByProviderData = async ({
  client,
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedProvider) return null;

  let byProviderPaymentId = null;
  if (providerPaymentId) {
    const byPaymentId = await client.fetch(
      `*[_type == $type && provider == $provider && providerPaymentId == $providerPaymentId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        provider: normalizedProvider,
        providerPaymentId,
      }
    );
    if (byPaymentId?._id && hasPaymentRecordBookingPayload(byPaymentId)) {
      return byPaymentId;
    }
    byProviderPaymentId = byPaymentId;
  }

  if (providerOrderId) {
    const byOrderId = await client.fetch(
      `*[_type == $type && provider == $provider && providerOrderId == $providerOrderId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        provider: normalizedProvider,
        providerOrderId,
      }
    );
    if (byOrderId?._id) return byOrderId;
  }

  return byProviderPaymentId || null;
};

export const findReusablePaymentRecord = async ({
  client,
  provider = "",
  pricingFingerprint = "",
  slotHoldId = "",
}) => {
  if (!provider || !pricingFingerprint) return null;
  return client.fetch(
    `*[_type == $type
      && provider == $provider
      && pricingFingerprint == $pricingFingerprint
      && coalesce(holdSnapshot.slotHoldId, "") == $slotHoldId
      && !(
        lower(status) in ["booked", "email_partial", "needs_recovery", "failed", "refunded", "abandoned"]
      )
    ][0]`,
    {
      type: PAYMENT_RECORD_TYPE,
      provider: String(provider || "").trim().toLowerCase(),
      pricingFingerprint,
      slotHoldId,
    }
  );
};
