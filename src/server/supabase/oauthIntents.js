import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";

export const OAUTH_INTENT_COOKIE = "roo_oauth_intent";
export const OAUTH_INTENT_MAX_AGE_SECONDS = 10 * 60;

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const intentProjection = [
  "id",
  "action",
  "domain_subject",
  "expires_at",
  "flow",
  "provider",
  "return_path",
  "status",
  "target_user_id",
].join(",");

export const readOAuthIntent = async ({
  token,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  if (!token) return null;
  const result = await adminClient
    .schema("accounts")
    .from("oauth_intents")
    .select(intentProjection)
    .eq("token_hash", sha256(token))
    .maybeSingle();
  if (result.error) throw new Error("OAuth intent could not be read.");
  return result.data || null;
};

export const createOAuthIntent = async ({
  action,
  domainSubject = "",
  flow,
  provider,
  returnPath,
  targetUserId = "",
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    Date.now() + OAUTH_INTENT_MAX_AGE_SECONDS * 1000
  ).toISOString();
  const result = await adminClient.rpc("roo_create_oauth_intent", {
    p_intent: {
      action,
      domain_subject: domainSubject || null,
      expires_at: expiresAt,
      flow,
      provider,
      return_path: returnPath,
      target_user_id: targetUserId || null,
      token_hash: sha256(token),
    },
  });
  if (result.error) {
    throw new Error("OAuth intent could not be created.");
  }
  return { token, expiresAt, id: result.data?.id || "" };
};

export const finalizeOAuthIntent = async ({
  guildId = "",
  provider,
  token,
  userId,
  adminClient = createSupabaseAdminClient(),
} = {}) => {
  const result = await adminClient.rpc("roo_finalize_oauth_intent", {
    p_guild_id: guildId || null,
    p_provider: provider,
    p_token_hash: sha256(token),
    p_user_id: userId,
  });
  if (result.error || !result.data) {
    const error = new Error("OAuth intent could not be finalized.");
    error.code = result.error?.code || "OAUTH_INTENT_FAILED";
    throw error;
  }
  return result.data;
};

export const oauthIntentCookieName = (intentId = "") => {
  const normalized = String(intentId || "").trim().toLowerCase();
  return /^[0-9a-f-]{36}$/.test(normalized)
    ? `${OAUTH_INTENT_COOKIE}.${normalized}`
    : OAUTH_INTENT_COOKIE;
};

export const oauthIntentCookie = (token, intentId = "", env = process.env) => ({
  name: oauthIntentCookieName(intentId),
  value: token,
  httpOnly: true,
  maxAge: OAUTH_INTENT_MAX_AGE_SECONDS,
  path: "/auth/callback",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export const clearOAuthIntentCookie = (intentId = "", env = process.env) => ({
  name: oauthIntentCookieName(intentId),
  value: "",
  httpOnly: true,
  maxAge: 0,
  path: "/auth/callback",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});
