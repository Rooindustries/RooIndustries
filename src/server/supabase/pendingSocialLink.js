import crypto from "node:crypto";

import { resolveSupabaseAccountByUserId } from "./accounts.js";
import { createSupabaseAdminClient } from "./adminClient.js";
import { readRequestCookie } from "./reauth.js";
import {
  normalizePendingLinkProvider,
  PENDING_LINK_PROVIDERS,
} from "./socialLinkProviders.js";

export { PENDING_LINK_PROVIDERS };

export const PENDING_DISCORD_LINK_COOKIE = "roo_pending_discord_link";
export const PENDING_TOURNEY_DISCORD_LINK_COOKIE =
  "roo_pending_tourney_discord_link";
export const PENDING_DISCORD_LINK_MAX_AGE_SECONDS = 15 * 60;

// Google joined Discord as a linkable provider, so the pending-link proof carries
// which provider it is for. The cookie names stay Discord-branded: they are the
// names already sitting in live browsers, and a rename would silently drop the
// proof for anyone mid-link across the deploy. Google gets its own cookie so a
// person holding one pending proof cannot have it consumed as the other provider.
export const PENDING_GOOGLE_LINK_COOKIE = "roo_pending_google_link";
export const PENDING_TOURNEY_GOOGLE_LINK_COOKIE =
  "roo_pending_tourney_google_link";

const normalizePendingLinkFlow = (value) =>
  String(value || "").trim().toLowerCase() === "tourney"
    ? "tourney"
    : "referral";

const pendingLinkCookieName = (flow, provider = "discord") => {
  const tourney = normalizePendingLinkFlow(flow) === "tourney";
  if (normalizePendingLinkProvider(provider) === "google") {
    return tourney
      ? PENDING_TOURNEY_GOOGLE_LINK_COOKIE
      : PENDING_GOOGLE_LINK_COOKIE;
  }
  return tourney
    ? PENDING_TOURNEY_DISCORD_LINK_COOKIE
    : PENDING_DISCORD_LINK_COOKIE;
};

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
  provider = "discord",
  userId,
} = {}) => {
  const normalizedFlow = normalizePendingLinkFlow(flow);
  const normalizedProvider = normalizePendingLinkProvider(provider);
  const normalizedUserId = String(userId || "").trim();
  const normalizedIntentId = String(intentId || "").trim();
  if (!normalizedUserId || !normalizedIntentId) {
    throw new Error("Pending social link identity is incomplete.");
  }
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      exp: issuedAt + PENDING_DISCORD_LINK_MAX_AGE_SECONDS,
      flow: normalizedFlow,
      iat: issuedAt,
      intentId: normalizedIntentId,
      provider: normalizedProvider,
      userId: normalizedUserId,
      v: 2,
    })
  ).toString("base64url");
  return {
    name: pendingLinkCookieName(normalizedFlow, normalizedProvider),
    value: `${payload}.${signPendingLink(payload, env, normalizedFlow)}`,
    ...pendingLinkCookieOptions(env),
  };
};

export const clearPendingDiscordLinkCookie = ({
  env = process.env,
  flow = "referral",
  provider = "discord",
} = {}) => ({
  name: pendingLinkCookieName(flow, provider),
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
  provider = "discord",
  request,
} = {}) => {
  const normalizedFlow = normalizePendingLinkFlow(flow);
  const normalizedProvider = normalizePendingLinkProvider(provider);
  const token = readRequestCookie(
    request,
    pendingLinkCookieName(normalizedFlow, normalizedProvider)
  );
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
    // A v2 proof minted before Google was linkable carries no provider and is
    // always a Discord proof. Anything newer must name the provider it was read
    // as, so a Google proof can never be spent as a Discord link or vice versa.
    const proofProvider = parsed?.provider
      ? normalizePendingLinkProvider(parsed.provider)
      : "discord";
    if (
      !validVersion ||
      proofProvider !== normalizedProvider ||
      !parsed.userId ||
      !parsed.intentId ||
      Number(parsed.iat) > currentTime + 60 ||
      Number(parsed.exp) <= currentTime
    ) {
      return null;
    }
    return {
      intentId: String(parsed.intentId),
      provider: proofProvider,
      userId: String(parsed.userId),
    };
  } catch {
    return null;
  }
};

// Finds whichever pending proof the browser is actually holding. The caller may
// name a provider, but a person can arrive with either, so the named one is tried
// first and the remaining providers after it -- returning the provider found so
// the link is completed against the identity that was really authenticated.
export const resolvePendingSocialLink = ({
  env = process.env,
  flow = "referral",
  now = Date.now(),
  provider = "",
  request,
} = {}) => {
  const preferred = String(provider || "").trim().toLowerCase();
  const order = PENDING_LINK_PROVIDERS.includes(preferred)
    ? [preferred, ...PENDING_LINK_PROVIDERS.filter((entry) => entry !== preferred)]
    : PENDING_LINK_PROVIDERS;
  for (const candidate of order) {
    const pendingLink = readPendingDiscordLink({
      env,
      flow,
      now,
      provider: candidate,
      request,
    });
    if (pendingLink) return pendingLink;
  }
  return null;
};

export const resolvePendingDiscordUser = async ({
  adminClient = createSupabaseAdminClient(),
  env = process.env,
  flow = "referral",
  now = Date.now(),
  provider = "discord",
  request,
} = {}) => {
  const pendingLink = resolvePendingSocialLink({
    env,
    flow,
    now,
    provider,
    request,
  });
  if (!pendingLink) return null;
  const result = await adminClient.auth.admin.getUserById(pendingLink.userId);
  if (result.error) throw result.error;
  const user = result.data?.user || null;
  return providersForUser(user).has(pendingLink.provider) ? user : null;
};

const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");

const providersForUser = (user) =>
  new Set(
    (user?.identities || [])
      .map((identity) => String(identity?.provider || "").trim().toLowerCase())
      .filter(Boolean)
  );

const hasReferralAccount = (account) =>
  (account?.roles || []).includes("creator") ||
  Boolean(account?.creator_legacy_sanity_id);

const hasTourneyAccount = (account) =>
  (account?.roles || []).some((role) => String(role).startsWith("tourney_")) ||
  Boolean(account?.tourney_legacy_player_id);

// Scoped to the domain being linked. A Discord account that already owns an
// account in the *same* domain cannot be linked, because that would fold two real
// accounts together. Owning an account in the *other* domain is expected -- that
// is the referral-then-tourney case -- and is handled as a cross-domain link.
const hasDomainAccount = (account, accountScope = "referral") =>
  accountScope === "tourney"
    ? hasTourneyAccount(account)
    : hasReferralAccount(account);

const hasOtherDomainAccount = (account, accountScope = "referral") =>
  accountScope === "tourney"
    ? hasReferralAccount(account)
    : hasTourneyAccount(account);

const socialIdentityOf = (user, provider = "discord") =>
  (user?.identities || []).find(
    (identity) =>
      String(identity?.provider || "").trim().toLowerCase() ===
      normalizePendingLinkProvider(provider)
  ) || null;

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
  provider = "discord",
  resolveAccount = resolveSupabaseAccountByUserId,
} = {}) => {
  const normalizedAccountScope =
    String(accountScope || "").trim().toLowerCase() === "tourney"
      ? "tourney"
      : "referral";
  const normalizedProvider = normalizePendingLinkProvider(provider);
  const pendingUserId = String(pendingUser?.id || "").trim();
  const targetUserId = String(primaryUserId || "").trim();
  if (
    !pendingUserId ||
    !targetUserId ||
    !providersForUser(pendingUser).has(normalizedProvider)
  ) {
    return { linked: false, reason: "discord_session_missing" };
  }
  if (pendingUserId === targetUserId) {
    return {
      linked: true,
      account: primaryAccount,
      alreadyLinked: true,
      provider: normalizedProvider,
    };
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
      provider: normalizedProvider,
    };
  }
  if (
    !pendingAccount?.principal_id ||
    hasDomainAccount(pendingAccount, normalizedAccountScope)
  ) {
    return { linked: false, reason: "discord_account_not_linkable" };
  }

  // The social account belongs to this person's other domain. Supabase allows
  // one auth.identities row per provider account, so the principals are never
  // merged -- merging would soft-delete the other domain's principal. The domain
  // being linked records its own projected link row instead, which is what its
  // reads resolve against. Both directions are supported: a referral identity can
  // be linked into tourney and a tourney identity into referral.
  if (hasOtherDomainAccount(pendingAccount, normalizedAccountScope)) {
    const identity = socialIdentityOf(pendingUser, normalizedProvider);
    const providerSubject = String(
      identity?.provider_id || identity?.id || ""
    ).trim();
    if (!providerSubject) {
      return { linked: false, reason: "discord_session_missing" };
    }
    const projected = await adminClient.rpc("roo_link_domain_social_identity", {
      p_principal_id: resolvedPrimaryAccount.principal_id,
      p_domain: normalizedAccountScope,
      p_provider: normalizedProvider,
      p_provider_subject: providerSubject,
      p_provider_email:
        String(identity?.identity_data?.email || pendingUser?.email || "")
          .trim()
          .toLowerCase() || null,
      p_metadata: identity?.identity_data || {},
    });
    if (projected.error) {
      throw Object.assign(new Error("Discord account could not be linked."), {
        code: projected.error.code || "DISCORD_LINK_FAILED",
      });
    }
    if (projected.data?.linked === false) {
      return {
        linked: false,
        reason: String(projected.data.reason || "discord_account_not_linkable"),
      };
    }
    return {
      linked: true,
      account: resolvedPrimaryAccount,
      crossDomain: true,
      provider: normalizedProvider,
      providerSubject,
    };
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
  return { linked: true, account: merged.data, provider: normalizedProvider };
};
