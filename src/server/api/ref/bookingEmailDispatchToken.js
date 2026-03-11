import crypto from "crypto";

const DEV_BOOKING_EMAIL_DISPATCH_SECRET =
  process.env.NODE_ENV === "production"
    ? ""
    : "dev_booking_email_dispatch_secret";

const resolveTokenSecret = () =>
  String(
    process.env.BOOKING_EMAIL_TOKEN_SECRET ||
      process.env.PAYMENT_SESSION_SECRET ||
      process.env.REF_SESSION_SECRET ||
      DEV_BOOKING_EMAIL_DISPATCH_SECRET
  ).trim();

const base64UrlEncode = (value) => Buffer.from(String(value || "")).toString("base64url");

const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const sign = (value, secret) =>
  crypto.createHmac("sha256", secret).update(String(value || "")).digest("base64url");

const timingSafeEqualString = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

const ensureTokenSecret = () => {
  const secret = resolveTokenSecret();
  if (!secret) {
    throw new Error("BOOKING_EMAIL_TOKEN_SECRET is required for booking email dispatch.");
  }
  return secret;
};

export const canIssueBookingEmailDispatchToken = () => !!resolveTokenSecret();

export const issueBookingEmailDispatchToken = ({
  bookingId = "",
  email = "",
  expirySeconds = 60 * 30,
}) => {
  const normalizedBookingId = String(bookingId || "").trim();
  if (!normalizedBookingId) {
    throw new Error("bookingId is required for booking email dispatch.");
  }

  const secret = ensureTokenSecret();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    bid: normalizedBookingId,
    email: normalizeEmail(email),
    iat: now,
    exp: now + Math.max(60, Number(expirySeconds) || 0),
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
};

export const verifyBookingEmailDispatchToken = ({
  token = "",
  bookingId = "",
  email = "",
}) => {
  const secret = resolveTokenSecret();
  if (!secret) {
    return {
      ok: false,
      reason: "booking_email_token_secret_missing",
      payload: null,
    };
  }

  const normalizedToken = String(token || "").trim();
  if (!normalizedToken.includes(".")) {
    return {
      ok: false,
      reason: "booking_email_token_invalid",
      payload: null,
    };
  }

  const [encodedPayload, providedSignature] = normalizedToken.split(".");
  if (!encodedPayload || !providedSignature) {
    return {
      ok: false,
      reason: "booking_email_token_invalid",
      payload: null,
    };
  }

  const expectedSignature = sign(encodedPayload, secret);
  if (!timingSafeEqualString(providedSignature, expectedSignature)) {
    return {
      ok: false,
      reason: "booking_email_token_invalid",
      payload: null,
    };
  }

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return {
      ok: false,
      reason: "booking_email_token_invalid",
      payload: null,
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload?.bid || !payload?.exp || payload.exp <= now) {
    return {
      ok: false,
      reason: "booking_email_token_expired",
      payload: payload || null,
    };
  }

  const normalizedBookingId = String(bookingId || "").trim();
  if (normalizedBookingId && payload.bid !== normalizedBookingId) {
    return {
      ok: false,
      reason: "booking_email_token_booking_mismatch",
      payload,
    };
  }

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail && normalizeEmail(payload.email) !== normalizedEmail) {
    return {
      ok: false,
      reason: "booking_email_token_email_mismatch",
      payload,
    };
  }

  return {
    ok: true,
    reason: "",
    payload,
  };
};
