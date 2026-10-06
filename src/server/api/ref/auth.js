import envValue from "../../supabase/envValue.cjs";
const { resolveStoreBackend } = envValue;
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
  const issuedAtMs = Date.now();
  const now = Math.floor(issuedAtMs / 1000);
  const body = {
    v: 2,
    iat: now,
    iatms: issuedAtMs,
    exp: now + maxAgeSeconds,
    rid: payload.referralId,
    code: payload.code || "",
    ab: resolveStoreBackend(payload.authBackend),
    pid: payload.principalId || "",
    sv: Math.max(1, Number(payload.sessionVersion) || 1),
    cv: Math.max(
      1,
      Number(payload.credentialVersion) || Number(payload.sessionVersion) || 1
    ),
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
  payload.ab = resolveStoreBackend(payload.ab);
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
      authBackend: resolveStoreBackend(payload.ab),
      principalId: payload.pid || "",
      sessionVersion: Math.max(1, Number(payload.sv) || 1),
      credentialVersion: Math.max(
        1,
        Number(payload.cv) || Number(payload.sv) || 1
      ),
      issuedAt: Math.max(0, Number(payload.iat) || 0),
      issuedAtMs: Math.max(0, Number(payload.iatms) || 0),
    };
  } catch (error) {
    return null;
  }
};

const validateSupabaseReferralSession = async (session) => {
  const { createSupabaseAdminClient } = await import("../../supabase/adminClient.js");
  const result = await createSupabaseAdminClient().rpc(
    "roo_validate_referral_session",
    {
      p_creator_legacy_id: session.referralId,
      p_session_version: session.sessionVersion,
    }
  );
  if (result.error) throw new Error("referral_session_verification_unavailable");
  const account = result.data;
  if (
    account?.creator_legacy_sanity_id !== session.referralId ||
    !Array.isArray(account.roles) ||
    !account.roles.includes("creator") ||
    (session.principalId && account.principal_id !== session.principalId) ||
    (session.code && account.referral_code !== session.code)
  ) {
    return null;
  }
  return {
    ...session,
    code: account.referral_code || session.code,
    principalId: account.principal_id,
    sessionVersion: account.session_version,
    credentialVersion: account.session_version,
  };
};

export const requireReferralSession = async (req, res) => {
  const session = getReferralSession(req);
  if (session) {
    try {
      const verified = await validateSupabaseReferralSession(session);
      if (verified) return verified;
    } catch {
      res.status(503).json({
        ok: false,
        error: "Account verification is temporarily unavailable.",
      });
      return null;
    }
  }
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
