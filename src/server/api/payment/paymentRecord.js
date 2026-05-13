import crypto from "crypto";

export const PAYMENT_RECORD_TYPE = "paymentRecord";
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

const stableHash = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);

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
  if (normalizedProvider === "payu" && providerOrderId) {
    return `paymentRecord.payu.${String(providerOrderId).trim()}`;
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

export const findPaymentRecordByProviderData = async ({
  client,
  provider = "",
  providerOrderId = "",
  providerPaymentId = "",
}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedProvider) return null;

  if (normalizedProvider === "razorpay" && providerPaymentId) {
    return client.fetch(
      `*[_type == $type && provider == "razorpay" && providerPaymentId == $providerPaymentId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        providerPaymentId,
      }
    );
  }

  if (providerOrderId) {
    return client.fetch(
      `*[_type == $type && provider == $provider && providerOrderId == $providerOrderId][0]`,
      {
        type: PAYMENT_RECORD_TYPE,
        provider: normalizedProvider,
        providerOrderId,
      }
    );
  }

  return null;
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
