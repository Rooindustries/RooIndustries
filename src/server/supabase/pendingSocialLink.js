import crypto from "node:crypto";

import { resolveSupabaseAccountByUserId } from "./accounts.js";
import { createSupabaseAdminClient } from "./adminClient.js";
import { readRequestCookie } from "./reauth.js";

export const PENDING_DISCORD_LINK_COOKIE = "roo_pending_discord_link";
export const PENDING_TOURNEY_DISCORD_LINK_COOKIE =
  "roo_pending_tourney_discord_link";
export const PENDING_DISCORD_LINK_MAX_AGE_SECONDS = 15 * 60;

const normalizePendingLinkFlow = (value) =>
  String(value || "").trim().toLowerCase() === "tourney"
    ? "tourney"
    : "referral";

const pendingLinkCookieName = (flow) =>
  normalizePendingLinkFlow(flow) === "tourney"
    ? PENDING_TOURNEY_DISCORD_LINK_COOKIE
    : PENDING_DISCORD_LINK_COOKIE;

const pendingLinkSecret = (env = process.env, flow = "referral") => {
  const normalizedFlow = normalizePendingLinkFlow(flow);
  const configured = String(
    normalizedFlow === "tourney"
      ? env.TOURNEY_SESSION_SECRET || env.REF_SESSION_SECRET || ""
      : env.REF_SESSION_SECRET || ""
  ).trim();
  if (configured) return configured;
  if (env.NODE_ENV !== "production") {
    return normalizedFlow === "tourney"
      ? "dev_tourney_session_secret"
      : "dev_ref_session_secret";
  }
  throw new Error(
    normalizedFlow === "tourney"
      ? "TOURNEY_SESSION_SECRET is required for pending Tourney Discord links."
      : "REF_SESSION_SECRET is required for pending Discord links."
  );
};

const signPendingLink = (value, env, flow) =>
  crypto
    .createHmac("sha256", pendingLinkSecret(env, flow))
    .update(value)
    .digest("base64url");

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const pendingLinkCookieOptions = (env = process.env) => ({
  httpOnly: true,
  maxAge: PENDING_DISCORD_LINK_MAX_AGE_SECONDS,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

const serializePendingLinkCookie = ({
  httpOnly,
  maxAge,
  name,
  path,
  sameSite,
  secure,
  value,
}) =>
  [
    `${name}=${encodeURIComponent(String(value || ""))}`,
    `Path=${path || "/"}`,
    `Max-Age=${Math.max(0, Math.floor(Number(maxAge) || 0))}`,
    httpOnly ? "HttpOnly" : "",
    secure ? "Secure" : "",
    `SameSite=${String(sameSite || "lax").toLowerCase() === "strict" ? "Strict" : "Lax"}`,
  ]
    .filter(Boolean)
    .join("; ");

export const createPendingDiscordLinkCookie = ({
  env = process.env,
  flow = "referral",
  intentId,
  now = Date.now(),
  userId,
} = {}) => {
  const normalizedFlow = normalizePendingLinkFlow(flow);
  const normalizedUserId = String(userId || "").trim();
  const normalizedIntentId = String(intentId || "").trim();
  if (!normalizedUserId || !normalizedIntentId) {
    throw new Error("Pending Discord link identity is incomplete.");
  }
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      exp: issuedAt + PENDING_DISCORD_LINK_MAX_AGE_SECONDS,
      flow: normalizedFlow,
      iat: issuedAt,
      intentId: normalizedIntentId,
      userId: normalizedUserId,
      v: 2,
    })
  ).toString("base64url");
  return {
    name: pendingLinkCookieName(normalizedFlow),
    value: `${payload}.${signPendingLink(payload, env, normalizedFlow)}`,
    ...pendingLinkCookieOptions(env),
  };
};

export const clearPendingDiscordLinkCookie = ({
  env = process.env,
  flow = "referral",
} = {}) => ({
  name: pendingLinkCookieName(flow),
  value: "",
  ...pendingLinkCookieOptions(env),
  maxAge: 0,
});

export const appendPendingDiscordLinkCookie = (res, cookie) => {
  const serialized = serializePendingLinkCookie(cookie);
  const existing = res.getHeader?.("Set-Cookie");
  res.setHeader(
    "Set-Cookie",
    existing
      ? Array.isArray(existing)
        ? [...existing, serialized]
        : [existing, serialized]
      : serialized
  );
};

export const readPendingDiscordLink = ({
  env = process.env,
  flow = "referral",
  now = Date.now(),
  request,
} = {}) => {
  const normalizedFlow = normalizePendingLinkFlow(flow);
  const token = readRequestCookie(request, pendingLinkCookieName(normalizedFlow));
  const [payload, signature, extra] = String(token || "").split(".");
  if (!payload || !signature || extra) return null;
  if (!safeEqual(signature, signPendingLink(payload, env, normalizedFlow))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const currentTime = Math.floor(now / 1000);
    const validVersion =
      (parsed?.v === 2 && parsed.flow === normalizedFlow) ||
      (parsed?.v === 1 && normalizedFlow === "referral" && !parsed.flow);
    if (
      !validVersion ||
      !parsed.userId ||
      !parsed.intentId ||
      Number(parsed.iat) > currentTime + 60 ||
      Number(parsed.exp) <= currentTime
    ) {
      return null;
    }
    return {
      intentId: String(parsed.intentId),
      userId: String(parsed.userId),
    };
  } catch {
    return null;
  }
};

export const resolvePendingDiscordUser = async ({
  adminClient = createSupabaseAdminClient(),
  env = process.env,
  flow = "referral",
  now = Date.now(),
  request,
} = {}) => {
  const pendingLink = readPendingDiscordLink({ env, flow, now, request });
  if (!pendingLink) return null;
  const result = await adminClient.auth.admin.getUserById(pendingLink.userId);
  if (result.error) throw result.error;
  const user = result.data?.user || null;
  return providersForUser(user).has("discord") ? user : null;
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const providersForUser = (user) =>
  new Set(
    (user?.identities || [])
      .map((identity) => String(identity?.provider || "").trim().toLowerCase())
      .filter(Boolean)
  );

const hasDomainAccount = (account) =>
  (account?.roles || []).some(
    (role) => role === "creator" || String(role).startsWith("tourney_")
  ) || Boolean(account?.creator_legacy_sanity_id || account?.tourney_legacy_player_id);

const isActivePrimaryAccount = (account, accountScope) => {
  if (!account?.principal_id || account?.status === "deleted") return false;
  if (accountScope === "tourney") {
    return (
      (account.roles || []).some((role) => String(role).startsWith("tourney_")) &&
      account.tourney_active !== false &&
      Boolean(account.tourney_username)
    );
  }
  return (
    (account.roles || []).includes("creator") &&
    account.creator_active !== false
  );
};

export const linkPendingDiscordIdentity = async ({
  accountScope = "referral",
  adminClient = createSupabaseAdminClient(),
  pendingUser,
  primaryAccount,
  primaryUserId,
  resolveAccount = resolveSupabaseAccountByUserId,
} = {}) => {
  const normalizedAccountScope =
    String(accountScope || "").trim().toLowerCase() === "tourney"
      ? "tourney"
      : "referral";
  const pendingUserId = String(pendingUser?.id || "").trim();
  const targetUserId = String(primaryUserId || "").trim();
  if (!pendingUserId || !targetUserId || !providersForUser(pendingUser).has("discord")) {
    return { linked: false, reason: "discord_session_missing" };
  }
  if (pendingUserId === targetUserId) {
    return { linked: true, account: primaryAccount, alreadyLinked: true };
  }

  const [pendingAccount, resolvedPrimaryAccount] = await Promise.all([
    resolveAccount({ userId: pendingUserId, adminClient }),
    primaryAccount
      ? Promise.resolve(primaryAccount)
      : resolveAccount({ userId: targetUserId, adminClient }),
  ]);
  if (
    !isActivePrimaryAccount(resolvedPrimaryAccount, normalizedAccountScope)
  ) {
    return {
      linked: false,
      reason:
        normalizedAccountScope === "tourney"
          ? "tourney_account_missing"
          : "creator_account_missing",
    };
  }
  if (pendingAccount?.principal_id === resolvedPrimaryAccount.principal_id) {
    return {
      linked: true,
      account: resolvedPrimaryAccount,
      alreadyLinked: true,
    };
  }
  if (
    !pendingAccount?.principal_id ||
    hasDomainAccount(pendingAccount)
  ) {
    return { linked: false, reason: "discord_account_not_linkable" };
  }

  const primaryGrant = crypto.randomBytes(32).toString("base64url");
  const secondaryGrant = crypto.randomBytes(32).toString("base64url");
  const [primaryProof, secondaryProof] = await Promise.all([
    adminClient.rpc("roo_create_reauth_grant", {
      p_user_id: targetUserId,
      p_token_hash: sha256(primaryGrant),
      p_purpose: "merge_account",
      p_provider: null,
    }),
    adminClient.rpc("roo_create_reauth_grant", {
      p_user_id: pendingUserId,
      p_token_hash: sha256(secondaryGrant),
      p_purpose: "merge_account",
      p_provider: null,
    }),
  ]);
  if (primaryProof.error || secondaryProof.error) {
    throw Object.assign(new Error("Discord account proofs could not be created."), {
      code: primaryProof.error?.code || secondaryProof.error?.code || "DISCORD_LINK_FAILED",
    });
  }

  const merged = await adminClient.rpc("roo_merge_account_principals", {
    p_primary_grant_hash: sha256(primaryGrant),
    p_secondary_grant_hash: sha256(secondaryGrant),
  });
  if (merged.error || !merged.data) {
    throw Object.assign(new Error("Discord account could not be linked."), {
      code: merged.error?.code || "DISCORD_LINK_FAILED",
    });
  }
  return { linked: true, account: merged.data };
};
