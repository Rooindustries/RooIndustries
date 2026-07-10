import crypto from "node:crypto";

export const DOWNLOAD_TOKEN_PURPOSE = "download-file";
export const DOWNLOAD_TOKEN_TTL_SECONDS = 10 * 60;

const normalizeValue = (value) => String(value || "").trim();

const getSecret = (env = process.env) => {
  const secret =
    normalizeValue(env.DOWNLOAD_TOKEN_SECRET) ||
    (env.NODE_ENV === "production" ? "" : "dev_download_token_secret");

  if (!secret) {
    const error = new Error(
      "DOWNLOAD_TOKEN_SECRET is required."
    );
    error.code = "download_token_secret_missing";
    throw error;
  }

  return secret;
};

const base64UrlEncode = (value) => Buffer.from(value).toString("base64url");

const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const signPayload = (encodedPayload, env = process.env) =>
  crypto
    .createHmac("sha256", getSecret(env))
    .update(encodedPayload)
    .digest("base64url");

export const hashDownloadEmail = (email) =>
  crypto
    .createHash("sha256")
    .update(normalizeValue(email).toLowerCase())
    .digest("hex");

export const createDownloadToken = ({
  slug = "",
  fileName = "",
  bookingId = "",
  email = "",
  issuedAtMs = Date.now(),
  ttlSeconds = DOWNLOAD_TOKEN_TTL_SECONDS,
  env = process.env,
}) => {
  const iat = Math.floor(Number(issuedAtMs || Date.now()) / 1000);
  const ttl = Math.max(60, Math.min(Number(ttlSeconds) || 0, 60 * 60));
  const payload = {
    purpose: DOWNLOAD_TOKEN_PURPOSE,
    slug: normalizeValue(slug),
    fileName: normalizeValue(fileName),
    bookingId: normalizeValue(bookingId),
    emailHash: hashDownloadEmail(email),
    iat,
    exp: iat + ttl,
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload, env)}`;
};

export const verifyDownloadToken = ({
  token = "",
  nowMs = Date.now(),
  env = process.env,
}) => {
  const normalizedToken = normalizeValue(token);
  if (!normalizedToken) return { ok: false, reason: "download_token_missing" };

  const parts = normalizedToken.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "download_token_malformed" };
  }
  const [encodedPayload, providedSignature] = parts;
  if (!encodedPayload || !providedSignature) {
    return { ok: false, reason: "download_token_malformed" };
  }

  const expectedSignature = signPayload(encodedPayload, env);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return { ok: false, reason: "download_token_invalid_signature" };
  }

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { ok: false, reason: "download_token_invalid_payload" };
  }

  if (
    !payload ||
    payload.purpose !== DOWNLOAD_TOKEN_PURPOSE ||
    !normalizeValue(payload.slug) ||
    !normalizeValue(payload.fileName) ||
    !normalizeValue(payload.bookingId) ||
    !normalizeValue(payload.emailHash)
  ) {
    return { ok: false, reason: "download_token_invalid_claims" };
  }

  const nowSeconds = Math.floor(Number(nowMs || Date.now()) / 1000);
  if (nowSeconds >= Number(payload.exp || 0)) {
    return {
      ok: false,
      reason: "download_token_expired",
      payload,
      expired: true,
    };
  }

  return { ok: true, payload };
};
