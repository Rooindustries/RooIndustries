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
    v: 2,
    iat: now,
    exp: now + maxAgeSeconds,
    rid: payload.referralId,
    code: payload.code || "",
    ab: payload.authBackend === "supabase" ? "supabase" : "sanity",
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
      principalId: payload.pid || "",
      sessionVersion: Math.max(1, Number(payload.sv) || 1),
      credentialVersion: Math.max(
        1,
        Number(payload.cv) || Number(payload.sv) || 1
      ),
      issuedAt: Math.max(0, Number(payload.iat) || 0),
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

const changedAfterSessionIssued = (changedAt, issuedAt) => {
  const changedAtMs = Date.parse(String(changedAt || ""));
  if (!Number.isFinite(changedAtMs) || !issuedAt) return false;
  return Math.floor(changedAtMs / 1000) > issuedAt;
};

const validatePreCutoverSanityReferralSession = async (session) => {
  const { createDocumentReadClient } = await import("../../data/documentClient.js");
  const client = createDocumentReadClient({
    backendOverride: "sanity",
    domain: "global",
  });
  const account = await client.fetch(
    `*[_type == "referral" && _id == $id][0]{
      _id,
      "code": slug.current,
      registrationStatus,
      passwordResetRequired,
      passwordLoginEnabled,
      passwordChangedAt
    }`,
    { id: session.referralId }
  );
  if (
    account?._id !== session.referralId ||
    !account.code ||
    (session.code && account.code !== session.code) ||
    account.registrationStatus !== "active" ||
    account.passwordResetRequired === true ||
    account.passwordLoginEnabled === false ||
    changedAfterSessionIssued(account.passwordChangedAt, session.issuedAt)
  ) {
    return null;
  }
  return { ...session, code: account.code };
};

const positiveSafeInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

const normalizeFallbackAuthority = (value) => {
  const authoritySchemaVersion = positiveSafeInteger(value?.authoritySchemaVersion);
  const principalSessionVersion = positiveSafeInteger(
    value?.principalSessionVersion
  );
  const credentialVersion = positiveSafeInteger(value?.credentialVersion);
  const authorityVersion = positiveSafeInteger(value?.authorityVersion);
  const credentialChangedAt = String(value?.credentialChangedAt || "");
  const principalId = String(value?.principalId || "").trim().toLowerCase();
  if (
    authoritySchemaVersion !== 1 ||
    !String(value?.legacyCreatorId || "").trim() ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      principalId
    ) ||
    !String(value?.referralCode || "").trim() ||
    !principalSessionVersion ||
    !credentialVersion ||
    !authorityVersion ||
    !Number.isFinite(Date.parse(credentialChangedAt)) ||
    typeof value?.creatorActive !== "boolean" ||
    typeof value?.creatorRolePresent !== "boolean" ||
    typeof value?.currentRecord !== "boolean" ||
    !["active", "disabled", "deleted"].includes(value?.principalStatus)
  ) {
    return null;
  }
  return {
    authoritySchemaVersion,
    legacyCreatorId: String(value.legacyCreatorId),
    principalId,
    referralCode: String(value.referralCode).trim().toLowerCase(),
    principalSessionVersion,
    principalStatus: value.principalStatus,
    creatorActive: value.creatorActive,
    creatorRolePresent: value.creatorRolePresent,
    credentialVersion,
    credentialChangedAt,
    currentRecord: value.currentRecord,
    authorityVersion,
  };
};

export const readReferralFallbackAuthority = async ({
  legacyCreatorId,
  client = null,
  env = process.env,
} = {}) => {
  const creatorId = String(legacyCreatorId || "").trim();
  if (!creatorId) return null;
  let readClient = client;
  if (!readClient) {
    const privateProjectId = String(env.SANITY_PRIVATE_PROJECT_ID || "").trim();
    const privateDataset = String(env.SANITY_PRIVATE_DATASET || "").trim();
    const privateToken = String(
      env.SANITY_PRIVATE_READ_TOKEN || env.SANITY_PRIVATE_WRITE_TOKEN || ""
    ).trim();
    if (!privateProjectId || !privateDataset || !privateToken) {
      throw new Error("Private referral fallback authority is not configured.");
    }
    const { createDocumentReadClient } = await import(
      "../../data/documentClient.js"
    );
    readClient = createDocumentReadClient({
      env,
      backendOverride: "sanity",
      domain: "global",
    });
  }
  const authority = await readClient.fetch(
    `*[
      _type == "referralAuthAuthority"
      && legacyCreatorId == $legacyCreatorId
    ][0]{
      authoritySchemaVersion,
      legacyCreatorId,
      principalId,
      referralCode,
      principalSessionVersion,
      principalStatus,
      creatorActive,
      creatorRolePresent,
      credentialVersion,
      credentialChangedAt,
      currentRecord,
      authorityVersion
    }`,
    { legacyCreatorId: creatorId }
  );
  return normalizeFallbackAuthority(authority);
};

export const isActiveReferralFallbackAuthority = (
  authority,
  { legacyCreatorId = "", referralCode = "" } = {}
) =>
  Boolean(
    authority &&
      authority.legacyCreatorId === String(legacyCreatorId || "").trim() &&
      authority.referralCode === String(referralCode || "").trim().toLowerCase() &&
      authority.principalStatus === "active" &&
      authority.creatorActive === true &&
      authority.creatorRolePresent === true &&
      authority.currentRecord === true
  );

const validateFallbackAuthoritySession = async (session) => {
  const authority = await readReferralFallbackAuthority({
    legacyCreatorId: session.referralId,
  });
  if (
    !isActiveReferralFallbackAuthority(authority, {
      legacyCreatorId: session.referralId,
      referralCode: session.code,
    }) ||
    !session.principalId ||
    authority.principalId !== session.principalId.toLowerCase() ||
    authority.principalSessionVersion !== session.sessionVersion ||
    authority.credentialVersion !== session.credentialVersion ||
    changedAfterSessionIssued(authority.credentialChangedAt, session.issuedAt)
  ) {
    return null;
  }
  return {
    ...session,
    code: authority.referralCode,
    principalId: authority.principalId,
    sessionVersion: authority.principalSessionVersion,
    credentialVersion: authority.credentialVersion,
  };
};

export const requireReferralSession = async (req, res) => {
  const session = getReferralSession(req);
  if (session) {
    try {
      const { resolveSupabaseRuntimePolicy } = await import(
        "../../supabase/runtime.js"
      );
      const policy = resolveSupabaseRuntimePolicy();
      const manualFallback =
        policy.primaryBackend === "sanity" && policy.cutoverEnabled;
      const verified = manualFallback
        ? await validateFallbackAuthoritySession(session)
        : session.authBackend === "supabase" ||
            policy.primaryBackend === "supabase"
          ? await validateSupabaseReferralSession(session)
          : await validatePreCutoverSanityReferralSession(session);
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
