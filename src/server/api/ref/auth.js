import crypto from "crypto";

export const REF_SESSION_COOKIE = "ref_session";

const readSecret = (key) => String(process.env[key] || "").trim();

const REF_SESSION_SECRET =
  readSecret("REF_SESSION_SECRET") ||
  (process.env.NODE_ENV === "production" ? "" : "dev_ref_session_secret");
const ADMIN_KEY = readSecret("REF_ADMIN_KEY");

const SESSION_AGE_SECONDS = {
  short: 60 * 60 * 12,
  remember: 60 * 60 * 24 * 30,
};

const base64UrlEncode = (value) =>
  Buffer.from(value).toString("base64url");

const base64UrlDecode = (value) =>
  Buffer.from(String(value || ""), "base64url").toString("utf8");

const sign = (input, secret) =>
  crypto.createHmac("sha256", secret).update(input).digest("base64url");

const timingSafeEqualString = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const parseCookies = (header = "") =>
  String(header || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, entry) => {
      const index = entry.indexOf("=");
      if (index <= 0) return acc;
      const key = entry.slice(0, index).trim();
      const value = entry.slice(index + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});

const appendSetCookie = (res, cookieValue) => {
  const prev = res.getHeader?.("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }
  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookieValue]);
    return;
  }
  res.setHeader("Set-Cookie", [prev, cookieValue]);
};

const ensureSessionSecret = () => {
  if (!REF_SESSION_SECRET) {
    throw new Error("REF_SESSION_SECRET is required for referral sessions");
  }
};

const buildSessionToken = (payload, maxAgeSeconds) => {
  ensureSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const body = {
    v: 1,
    iat: now,
    exp: now + maxAgeSeconds,
    rid: payload.referralId,
    code: payload.code || "",
    ab: payload.authBackend === "supabase" ? "supabase" : "sanity",
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signature = sign(encodedPayload, REF_SESSION_SECRET);
  return `${encodedPayload}.${signature}`;
};

const decodeSessionToken = (token) => {
  ensureSessionSecret();
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) return null;
  const expected = sign(encodedPayload, REF_SESSION_SECRET);
  if (!timingSafeEqualString(signature, expected)) return null;
  const payload = JSON.parse(base64UrlDecode(encodedPayload));
  if (!payload?.rid || !payload?.exp) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;
  return payload;
};

export const setReferralSessionCookie = (res, payload, remember = false) => {
  const sessionCookie = createReferralSessionCookie(payload, remember);
  const cookie = [
    `${sessionCookie.name}=${encodeURIComponent(sessionCookie.value)}`,
    `Path=${sessionCookie.path}`,
    sessionCookie.httpOnly ? "HttpOnly" : "",
    `SameSite=${sessionCookie.sameSite}`,
    sessionCookie.secure ? "Secure" : "",
    `Max-Age=${sessionCookie.maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
  appendSetCookie(res, cookie);
};

export const createReferralSessionCookie = (payload, remember = false) => {
  const maxAge = remember
    ? SESSION_AGE_SECONDS.remember
    : SESSION_AGE_SECONDS.short;
  const token = buildSessionToken(payload, maxAge);
  return {
    name: REF_SESSION_COOKIE,
    value: token,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge,
  };
};

export const clearReferralSessionCookie = (res) => {
  const secure = process.env.NODE_ENV === "production";
  const cookie = [
    `${REF_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
  appendSetCookie(res, cookie);
};

export const getReferralSession = (req) => {
  try {
    const cookies = parseCookies(req?.headers?.cookie || "");
    const token = cookies[REF_SESSION_COOKIE];
    const payload = decodeSessionToken(token);
    if (!payload) return null;
    return {
      referralId: payload.rid,
      code: payload.code || "",
      authBackend: payload.ab === "supabase" ? "supabase" : "sanity",
    };
  } catch (error) {
    return null;
  }
};

export const requireReferralSession = (req, res) => {
  const session = getReferralSession(req);
  if (session) return session;
  res
    .status(401)
    .json({ ok: false, error: "Unauthorized. Please log in again." });
  return null;
};

export const requireAdminKey = (req, res) => {
  if (!ADMIN_KEY) {
    res.status(500).json({
      ok: false,
      error: "Access is temporarily unavailable.",
    });
    return false;
  }

  const headerKey = req?.headers?.["x-admin-key"];
  const provided = headerKey;

  if (!provided || !timingSafeEqualString(provided, ADMIN_KEY)) {
    res.status(403).json({ ok: false, error: "Unauthorized request." });
    return false;
  }

  return true;
};

export const requireSecret = (res, secretName, errorMessage) => {
  const keys = Array.isArray(secretName) ? secretName : [secretName];
  const hasSecret = keys.some((key) => String(process.env[key] || "").trim());
  if (hasSecret) return true;

  res.status(500).json({
    ok: false,
    error: errorMessage || "Access is temporarily unavailable.",
  });
  return false;
};
