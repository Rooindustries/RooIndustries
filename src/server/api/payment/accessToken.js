import crypto from "crypto";

export const PAYMENT_ACCESS_TOKEN_PURPOSE = "payment-session";
export const PAYMENT_ACCESS_TOKEN_HARD_CAP_SECONDS = 24 * 60 * 60;

const normalizeValue = (value) => String(value || "").trim();

const getSecret = () => {
  const secret = normalizeValue(process.env.PAYMENT_SESSION_SECRET);
  if (!secret) {
    const error = new Error("PAYMENT_SESSION_SECRET is required.");
    error.code = "payment_session_secret_missing";
    throw error;
  }
  return secret;
};

const toBase64Url = (value) =>
  Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const fromBase64Url = (value) => {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
};

export const hashPaymentFingerprint = (value = "") =>
  crypto.createHash("sha256").update(normalizeValue(value)).digest("hex");

const signPayload = (encodedPayload) =>
  crypto
    .createHmac("sha256", getSecret())
    .update(encodedPayload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export const createPaymentAccessToken = ({
  paymentRecordId = "",
  provider = "",
  pricingFingerprint = "",
  issuedAtMs = Date.now(),
  expirySeconds = 0,
}) => {
  const iat = Math.floor(Number(issuedAtMs || Date.now()) / 1000);
  const ttl = Math.max(
    60,
    Math.min(Number(expirySeconds || 0) || 0, PAYMENT_ACCESS_TOKEN_HARD_CAP_SECONDS)
  );
  const payload = {
    paymentRecordId: normalizeValue(paymentRecordId),
    provider: normalizeValue(provider).toLowerCase(),
    pricingFingerprintHash: hashPaymentFingerprint(pricingFingerprint),
    purpose: PAYMENT_ACCESS_TOKEN_PURPOSE,
    iat,
    exp: iat + ttl,
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
};

export const verifyPaymentAccessToken = ({
  token = "",
  nowMs = Date.now(),
}) => {
  const normalizedToken = normalizeValue(token);
  if (!normalizedToken) {
    return { ok: false, reason: "payment_access_token_missing" };
  }

  const [encodedPayload, providedSignature] = normalizedToken.split(".");
  if (!encodedPayload || !providedSignature) {
    return { ok: false, reason: "payment_access_token_malformed" };
  }

  const expectedSignature = signPayload(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "payment_access_token_invalid_signature" };
  }

  let payload = null;
  try {
    payload = JSON.parse(fromBase64Url(encodedPayload));
  } catch {
    return { ok: false, reason: "payment_access_token_invalid_payload" };
  }

  if (
    !payload ||
    payload.purpose !== PAYMENT_ACCESS_TOKEN_PURPOSE ||
    !normalizeValue(payload.paymentRecordId) ||
    !normalizeValue(payload.provider) ||
    !normalizeValue(payload.pricingFingerprintHash)
  ) {
    return { ok: false, reason: "payment_access_token_invalid_claims" };
  }

  const nowSeconds = Math.floor(Number(nowMs || Date.now()) / 1000);
  if (nowSeconds > Number(payload.exp || 0)) {
    return {
      ok: false,
      reason: "payment_access_token_expired",
      payload,
      expired: true,
    };
  }

  return { ok: true, payload };
};

export const isPaymentAccessTokenRecordMatch = ({
  payload,
  record,
}) => {
  if (!payload || !record?._id) return false;
  return (
    normalizeValue(payload.paymentRecordId) === normalizeValue(record._id) &&
    normalizeValue(payload.provider).toLowerCase() ===
      normalizeValue(record.provider).toLowerCase() &&
    normalizeValue(payload.pricingFingerprintHash) ===
      hashPaymentFingerprint(record.pricingFingerprint)
  );
};

export const isWithinPaymentAccessRecoveryWindow = ({
  payload,
  nowMs = Date.now(),
}) => {
  if (!payload?.iat) return false;
  const nowSeconds = Math.floor(Number(nowMs || Date.now()) / 1000);
  return nowSeconds <= Number(payload.iat) + PAYMENT_ACCESS_TOKEN_HARD_CAP_SECONDS;
};
