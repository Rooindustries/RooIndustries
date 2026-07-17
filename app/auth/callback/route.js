import { NextResponse } from "next/server";
import {
  bootstrapSupabaseNativeAccount,
  resolveSupabaseAccountByUserId,
} from "@/src/server/supabase/accounts";
import {
  clearOAuthIntentCookie,
  finalizeOAuthIntent,
  OAUTH_INTENT_COOKIE,
  oauthIntentCookieName,
  readOAuthIntent,
} from "@/src/server/supabase/oauthIntents";
import {
  clearNextSupabaseSession,
  createNextSupabaseSessionClient,
} from "@/src/server/supabase/serverSession";
import {
  createReferralSessionCookie,
  REF_SESSION_COOKIE,
} from "@/src/server/api/ref/auth";
import {
  TOURNEY_SESSION_COOKIE,
  createTourneySessionToken,
  getTourneyCookieOptions,
} from "@/src/server/tourney/auth";
import { isSupabaseTourneyDatabase } from "@/src/server/tourney/sqlClient";
import {
  queueTourneyDiscordAuthProjection,
  resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure,
} from "@/src/server/tourney/discordDesiredState";
import {
  clearReauthCookie,
  createReauthToken,
  hashReauthToken,
  reauthCookie,
} from "@/src/server/supabase/reauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const flowDefaults = {
  referral: "/referrals/dashboard",
  tourney: "/tourney",
};

const normalizeFlow = (value) => {
  const flow = String(value || "").trim().toLowerCase();
  return Object.hasOwn(flowDefaults, flow) ? flow : "";
};

const safeNextPath = (value, flow = "") => {
  const fallback = flowDefaults[flow] || "/";
  const path = String(value || fallback).trim();
  if (
    !/^\/(?!\/)[^\\\u0000-\u001f]*$/.test(path) ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/")
  ) {
    return fallback;
  }
  if (flow === "referral" && !path.startsWith("/referrals/")) return fallback;
  if (flow === "tourney" && !path.startsWith("/tourney")) return fallback;
  if (flow === "tourney" && path === "/tourney/login") return fallback;
  return path;
};

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Expires", "0");
  response.headers.set("Pragma", "no-cache");
  return response;
};

const setRedirect = (response, target) => {
  response.headers.set("Location", String(target));
  return noStore(response);
};

const clearDomainCookie = (response, flow) => {
  const name = flow === "tourney" ? TOURNEY_SESSION_COOKIE : REF_SESSION_COOKIE;
  response.cookies.set({
    name,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
};

const errorTarget = ({ origin, flow, error }) => {
  const pathname =
    flow === "tourney"
      ? "/tourney/login"
      : flow === "referral"
        ? "/referrals/login"
        : "/";
  const target = new URL(pathname, origin);
  target.searchParams.set(
    flow === "tourney" ? "error" : flow === "referral" ? "oauth" : "auth_error",
    error
  );
  return target;
};

const getCookieValue = (request, name) => {
  const structured = request.cookies?.get?.(name)?.value;
  if (structured) return structured;
  const match = String(request.headers.get("cookie") || "")
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return "";
  const raw = match.slice(name.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const referralSession = (account) => {
  if (!(account?.roles || []).includes("creator")) return null;
  if (account.creator_active === false) return null;
  const creatorId =
    account.creator_legacy_sanity_id || account.legacy_sanity_id || "";
  if (!creatorId || !account.referral_code) return null;
  return createReferralSessionCookie({
    authBackend: "supabase",
    code: account.referral_code,
    principalId: account.principal_id,
    referralId: creatorId,
    sessionVersion: account.session_version,
  });
};

const tourneySession = (account) => {
  const role = String(account?.tourney_role || "").replace(/^tourney_/, "");
  if (!account?.tourney_username || !["player", "viewer", "caster", "owner"].includes(role)) {
    return null;
  }
  const value = createTourneySessionToken({
    account: {
      authBackend: "supabase",
      role,
      username: account.tourney_username,
      version: String(account.credential_version || "1"),
      ...(account.principal_id ? { principalId: account.principal_id } : {}),
      ...(account.tourney_legacy_player_id || account.legacy_sanity_id
        ? { playerId: account.tourney_legacy_player_id || account.legacy_sanity_id }
        : {}),
    },
  });
  return value
    ? { name: TOURNEY_SESSION_COOKIE, value, ...getTourneyCookieOptions() }
    : null;
};

const resolveRoleSession = async ({ flow, userId }) => {
  const account = await resolveSupabaseAccountByUserId({ userId });
  if (!account || account.status !== "active") return { error: "unlinked" };
  if (flow === "tourney" && account.tourney_active === false) {
    return {
      account,
      error: account.tourney_status === "removed" ? "suspended" : "awaiting_approval",
    };
  }
  const cookie = flow === "tourney" ? tourneySession(account) : referralSession(account);
  return cookie ? { account, cookie } : { account, error: "unlinked" };
};

const setRoleCookie = (response, cookie) => {
  if (cookie) response.cookies.set(cookie);
};

const fail = async ({
  action = "",
  clearSupabaseSession = false,
  error,
  flow,
  preserveExistingSession = false,
  request,
  response,
}) => {
  const intentId = String(
    new URL(request.url).searchParams.get("intent") || ""
  ).trim();
  response.cookies.set(clearOAuthIntentCookie(intentId));
  if (
    !preserveExistingSession &&
    (clearSupabaseSession || !["link", "reauth", "merge"].includes(action))
  ) {
    if (flow && !["link", "reauth", "merge"].includes(action)) {
      clearDomainCookie(response, flow);
    }
    await clearNextSupabaseSession({ request, response }).catch(() => {});
  }
  return setRedirect(
    response,
    errorTarget({ origin: new URL(request.url).origin, flow, error })
  );
};

const completeLegacySignin = async ({ request, response, result, url }) => {
  const flow = normalizeFlow(url.searchParams.get("flow"));
  if (!flow) {
    return fail({ error: "invalid_intent", flow, request, response });
  }
  const roleSession = await resolveRoleSession({
    flow,
    userId: result.data.user.id,
  });
  if (!roleSession.cookie) {
    return fail({
      error: roleSession.error || "unlinked",
      flow,
      request,
      response,
    });
  }
  setRoleCookie(response, roleSession.cookie);
  return setRedirect(
    response,
    new URL(safeNextPath(url.searchParams.get("next"), flow), url.origin)
  );
};

export async function GET(request) {
  const url = new URL(request.url);
  const response = NextResponse.redirect(new URL("/", url.origin), { status: 303 });
  const hintedFlow = normalizeFlow(url.searchParams.get("flow"));
  if (hintedFlow === "tourney" && !isSupabaseTourneyDatabase(process.env)) {
    return fail({
      error: "oauth_temporarily_unavailable",
      flow: hintedFlow,
      preserveExistingSession: true,
      request,
      response,
    });
  }
  const intentId = String(url.searchParams.get("intent") || "").trim().toLowerCase();
  const validIntentId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(intentId)
    ? intentId
    : "";
  const token = getCookieValue(
    request,
    validIntentId ? oauthIntentCookieName(validIntentId) : OAUTH_INTENT_COOKIE
  );
  let intent = null;
  let intentBindingInvalid = false;

  try {
    intent = token && validIntentId
      ? await readOAuthIntent({ intentId: validIntentId, token })
      : null;
    if (intent && validIntentId && intent.id !== validIntentId) {
      intent = null;
      intentBindingInvalid = true;
    }
  } catch {
    return fail({ error: "unavailable", flow: "", request, response });
  }

  const flow = normalizeFlow(intent?.flow) || hintedFlow;
  if (intentBindingInvalid || (validIntentId && !intent)) {
    return fail({ error: "invalid_intent", flow, request, response });
  }
  if (intent && (intent.status !== "pending" || Date.parse(intent.expires_at) <= Date.now())) {
    return fail({
      action: intent.action,
      error: "expired_intent",
      flow,
      request,
      response,
    });
  }

  if (flow === "tourney" && !isSupabaseTourneyDatabase(process.env)) {
    return fail({
      action: intent?.action,
      error: "oauth_temporarily_unavailable",
      flow,
      preserveExistingSession: true,
      request,
      response,
    });
  }

  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) {
    return fail({
      action: intent?.action,
      error: "missing_code",
      flow,
      request,
      response,
    });
  }

  const supabase = createNextSupabaseSessionClient({ request, response });
  const result = await supabase.auth.exchangeCodeForSession(code);
  if (result.error || !result.data?.user?.id || !result.data?.session) {
    return fail({
      action: intent?.action,
      error: "exchange_failed",
      flow,
      request,
      response,
    });
  }
  const claimedUserId = String(result.data.user.id || "").trim();
  const accountUserId = String(intent?.target_user_id || claimedUserId).trim();
  if (
    intent?.target_user_id && claimedUserId !== accountUserId &&
    intent.action !== "reauth"
  ) {
    return fail({
      action: intent.action,
      clearSupabaseSession: true,
      error: "unlinked",
      flow,
      request,
      response,
    });
  }
  const discordProjection = intent?.provider === "discord" && validIntentId
    ? {
        accountUserId,
        claimedUserId,
        commandId: `discord-oauth:${validIntentId}:${accountUserId}`,
        deferUntil: intent.expires_at,
        intentId: validIntentId,
        userId: accountUserId,
      }
    : null;
  if (discordProjection) {
    try {
      const queued = await queueTourneyDiscordAuthProjection({
        ...discordProjection,
        accessToken: String(result.data.session.provider_token || ""),
        attemptExternalWork: false,
      });
      if (
        !queued.applied &&
        !["pending", "not_linked", "not_configured"].includes(queued.reason)
      ) {
        throw new Error("Discord OAuth projection was not durably queued.");
      }
    } catch {
      return fail({
        action: intent.action,
        clearSupabaseSession: true,
        error: "unavailable",
        flow,
        request,
        response,
      });
    }
  }

  if (!intent) {
    return completeLegacySignin({ request, response, result, url });
  }

  let finalized;
  try {
    const reauthToken = intent.action === "reauth" ? createReauthToken() : "";
    try {
      finalized = await finalizeOAuthIntent({
        provider: intent.provider,
        token,
        userId: result.data.user.id,
        ...(reauthToken
          ? { reauthTokenHash: hashReauthToken(reauthToken) }
          : {}),
      });
    } catch (error) {
      if (!discordProjection) throw error;
      const resolution = await resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure({
        claimedUserId: discordProjection.claimedUserId,
        commandId: discordProjection.commandId,
        intentId: discordProjection.intentId,
        userId: discordProjection.userId,
      });
      if (!resolution.finalized) throw error;
      finalized = {
        action: intent.action,
        flow: intent.flow,
        provider: intent.provider,
        return_path: intent.return_path,
      };
    }
    const returnPath = safeNextPath(finalized.return_path, finalized.flow);
    let target = new URL(returnPath, url.origin);

    if (finalized.action === "signup") {
      const existingRole = await resolveRoleSession({
        flow: finalized.flow,
        userId: result.data.user.id,
      });
      if (existingRole.cookie) {
        setRoleCookie(response, existingRole.cookie);
        target = new URL(flowDefaults[finalized.flow], url.origin);
      } else {
        await bootstrapSupabaseNativeAccount({ userId: result.data.user.id });
        target.searchParams.set("oauth", "ready");
        target.searchParams.set("provider", finalized.provider);
      }
    } else if (finalized.action === "reauth") {
      const roleSession = await resolveRoleSession({
        flow: finalized.flow,
        userId: result.data.user.id,
      });
      if (!roleSession.cookie) {
        return fail({
          action: finalized.action,
          clearSupabaseSession: true,
          error: roleSession.error || "unlinked",
          flow: finalized.flow,
          request,
          response,
        });
      }
      setRoleCookie(response, roleSession.cookie);
      response.cookies.set(reauthCookie(reauthToken));
      target.searchParams.set("reauth", "ready");
    } else {
      const roleSession = await resolveRoleSession({
        flow: finalized.flow,
        userId: result.data.user.id,
      });
      if (!roleSession.cookie) {
        if (
          finalized.action === "signin" &&
          finalized.flow === "referral" &&
          finalized.provider === "discord" &&
          (roleSession.error || "unlinked") === "unlinked"
        ) {
          const unlinkedTarget = new URL("/referrals/login", url.origin);
          unlinkedTarget.searchParams.set("oauth", "unlinked");
          unlinkedTarget.searchParams.set("provider", "discord");
          response.cookies.set(clearOAuthIntentCookie(validIntentId));
          return setRedirect(response, unlinkedTarget);
        }
        return fail({
          action: finalized.action,
          clearSupabaseSession: true,
          error: roleSession.error || "unlinked",
          flow: finalized.flow,
          request,
          response,
        });
      }
      setRoleCookie(response, roleSession.cookie);
      if (finalized.action === "link") {
        target.searchParams.set("linked", finalized.provider);
        response.cookies.set(clearReauthCookie());
      }
    }

    if (finalized.provider === "discord" && discordProjection) {
      try {
        const deferTourneySignup = finalized.flow === "tourney" &&
          finalized.action === "signup";
        const sync = deferTourneySignup
          ? { applied: false, reason: "pending" }
          : await queueTourneyDiscordAuthProjection({
              ...discordProjection,
              accessToken: String(result.data.session.provider_token || ""),
              attemptExternalWork: true,
            });
        if (!sync.applied && !["not_linked", "not_configured"].includes(sync.reason)) {
          target.searchParams.set("discord_role", "pending");
        }
      } catch {
        target.searchParams.set("discord_role", "pending");
      }
    }

    response.cookies.set(clearOAuthIntentCookie(validIntentId));
    return setRedirect(response, target);
  } catch {
    return fail({
      action: intent.action,
      clearSupabaseSession: true,
      error: "unavailable",
      flow,
      request,
      response,
    });
  }
}
