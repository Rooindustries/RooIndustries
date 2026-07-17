import crypto from "node:crypto";

import { createSupabaseAdminClient } from "./adminClient.js";
import { readRequestCookie } from "./reauth.js";

export const REFERRAL_ORPHAN_RECLAIM_COOKIE =
  "roo_referral_orphan_identity_reclaim";
export const REFERRAL_ORPHAN_RECLAIM_MAX_AGE_SECONDS = 15 * 60;

const providers = new Set(["google", "discord"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const reclaimSecret = (env = process.env) => {
  const secret = String(env.REF_SESSION_SECRET || "").trim();
  if (secret) return secret;
  if (env.NODE_ENV !== "production") return "dev_ref_session_secret";
  throw new Error("REF_SESSION_SECRET is required for identity recovery.");
};

const sign = (payload, env) =>
  crypto
    .createHmac("sha256", reclaimSecret(env))
    .update(payload)
    .digest("base64url");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const cookieOptions = (env = process.env) => ({
  httpOnly: true,
  maxAge: REFERRAL_ORPHAN_RECLAIM_MAX_AGE_SECONDS,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export const createReferralOrphanReclaimCookie = ({
  env = process.env,
  originalIntentId,
  now = Date.now(),
  principalId,
  provider,
  targetUserId,
} = {}) => {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedIntentId = String(originalIntentId || "").trim().toLowerCase();
  const normalizedPrincipalId = String(principalId || "").trim().toLowerCase();
  const normalizedTargetUserId = String(targetUserId || "").trim().toLowerCase();
  if (
    !providers.has(normalizedProvider) ||
    !uuidPattern.test(normalizedIntentId) ||
    !uuidPattern.test(normalizedPrincipalId) ||
    !uuidPattern.test(normalizedTargetUserId)
  ) {
    throw new Error("Referral identity recovery is incomplete.");
  }
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + REFERRAL_ORPHAN_RECLAIM_MAX_AGE_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({
      exp: expiresAt,
      iat: issuedAt,
      originalIntentId: normalizedIntentId,
      principalId: normalizedPrincipalId,
      provider: normalizedProvider,
      targetUserId: normalizedTargetUserId,
      v: 1,
    })
  ).toString("base64url");
  return {
    name: REFERRAL_ORPHAN_RECLAIM_COOKIE,
    value: `${payload}.${sign(payload, env)}`,
    ...cookieOptions(env),
  };
};

export const clearReferralOrphanReclaimCookie = (env = process.env) => ({
  name: REFERRAL_ORPHAN_RECLAIM_COOKIE,
  value: "",
  ...cookieOptions(env),
  maxAge: 0,
});

export const readReferralOrphanReclaim = ({
  env = process.env,
  now = Date.now(),
  request,
} = {}) => {
  const token = readRequestCookie(request, REFERRAL_ORPHAN_RECLAIM_COOKIE);
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, env))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const currentTime = Math.floor(now / 1000);
    if (
      parsed?.v !== 1 ||
      !providers.has(parsed.provider) ||
      !uuidPattern.test(parsed.originalIntentId) ||
      !uuidPattern.test(parsed.principalId) ||
      !uuidPattern.test(parsed.targetUserId) ||
      Number(parsed.iat) > currentTime + 60 ||
      Number(parsed.exp) <= currentTime
    ) {
      return null;
    }
    return {
      expiresAt: new Date(Number(parsed.exp) * 1000).toISOString(),
      originalIntentId: parsed.originalIntentId,
      principalId: parsed.principalId,
      provider: parsed.provider,
      targetUserId: parsed.targetUserId,
    };
  } catch {
    return null;
  }
};

export const matchesReferralOrphanReclaim = ({ account, recovery, user } = {}) =>
  Boolean(
    recovery &&
      account?.status === "active" &&
      account?.creator_active !== false &&
      (account?.roles || []).includes("creator") &&
      String(account?.principal_id || "").toLowerCase() === recovery.principalId &&
      String(user?.id || "").toLowerCase() === recovery.targetUserId
  );

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

export const reclaimReferralOrphanIdentity = async ({
  adminClient = createSupabaseAdminClient(),
  orphanUserId,
  provider,
  token,
} = {}) => {
  const result = await adminClient.rpc("roo_reclaim_referral_orphan_identity", {
    p_orphan_user_id: String(orphanUserId || "").trim(),
    p_provider: String(provider || "").trim().toLowerCase(),
    p_token_hash: sha256(token),
  });
  if (result.error || !result.data) {
    const error = new Error("Referral identity recovery could not be completed.");
    error.code = result.error?.code || "IDENTITY_RECLAIM_FAILED";
    throw error;
  }
  return result.data;
};
