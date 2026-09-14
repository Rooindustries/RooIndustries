import { NextResponse } from "next/server";
import {
  bootstrapSupabaseNativeAccount,
  resolveSupabaseAccountByUserId,
} from "@/src/server/supabase/accounts";
import {
  clearOAuthIntentCookie,
  failOAuthIntent,
  finalizeOAuthIntent,
  OAUTH_INTENT_COOKIE,
  oauthIntentCookieName,
  readOAuthIntent,
} from "@/src/server/supabase/oauthIntents";
import {
  clearNextSupabaseSession,
  createNextSupabaseSessionClient,
  installNextSupabaseSession,
} from "@/src/server/supabase/serverSession";
import {
  createReferralSessionCookie,
  REF_SESSION_COOKIE,
} from "@/src/server/api/ref/auth";



import {
  clearReauthCookie,
  createReauthToken,
  hashReauthToken,
  reauthCookie,
} from "@/src/server/supabase/reauth";
import {
  clearPendingDiscordLinkCookie,
  createPendingDiscordLinkCookie,
  PENDING_LINK_PROVIDERS,
} from "@/src/server/supabase/pendingSocialLink";
import {
  clearReferralOrphanReclaimCookie,
  createReferralOrphanReclaimCookie,
  reclaimReferralOrphanIdentity,
} from "@/src/server/supabase/orphanIdentityReclaim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const flowDefaults = {
  referral: "/referrals/dashboard",

};

const sessionPreservingActions = new Set(["link", "reauth", "merge", "reclaim"]);

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
  const name = REF_SESSION_COOKIE;
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
    flow === "referral"
        ? "/referrals/login"
        : "/";
  const target = new URL(pathname, origin);
  target.searchParams.set(
    flow === "referral" ? "oauth" : "auth_error",
    error
  );
  return target;
};

const providerCallbackError = (url) => {
  const errorCode = String(url.searchParams.get("error_code") || "")
    .trim()
    .toLowerCase();
  if (/^[a-z0-9_]{1,80}$/.test(errorCode)) return errorCode;
  const fallback = String(url.searchParams.get("error") || "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(fallback) ? fallback : "";
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



const resolveRoleSession = async ({ flow, userId }) => {
  const account = await resolveSupabaseAccountByUserId({ userId });
  if (!account || account.status !== "active") return { error: "unlinked" };

  const cookie = referralSession(account);
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
    (clearSupabaseSession || !sessionPreservingActions.has(action))
  ) {
    if (flow && !sessionPreservingActions.has(action)) {
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
  if (intentBindingInvalid || (validIntentId && !intent) || (intent && !normalizeFlow(intent.flow)) || (url.searchParams.has("flow") && !hintedFlow)) {
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



  const code = String(url.searchParams.get("code") || "").trim();
  if (!code) {
    const callbackError = providerCallbackError(url);
    if (callbackError && intent && token && validIntentId) {
      try {
        await failOAuthIntent({
          failureCode: callbackError,
          intentId: validIntentId,
          token,
        });
      } catch {
        return fail({
          action: intent.action,
          error: "unavailable",
          flow,
          request,
          response,
        });
      }
      if (
        callbackError === "identity_already_exists" &&
        intent.action === "link" &&
        intent.flow === "referral" &&
        ["google", "discord"].includes(intent.provider) &&
        intent.target_user_id &&
        intent.principal_id
      ) {
        const target = new URL(
          safeNextPath(intent.return_path, "referral"),
          url.origin
        );
        target.searchParams.set("oauth", "identity_already_exists");
        target.searchParams.set("provider", intent.provider);
        response.cookies.set(
          createReferralOrphanReclaimCookie({
            originalIntentId: validIntentId,
            principalId: intent.principal_id,
            provider: intent.provider,
            targetUserId: intent.target_user_id,
          })
        );
        response.cookies.set(clearOAuthIntentCookie(validIntentId));
        response.cookies.set(clearReauthCookie());
        return setRedirect(response, target);
      }
    }
    return fail({
      action: intent?.action,
      error: callbackError || "missing_code",
      flow,
      request,
      response,
    });
  }

  const supabase = createNextSupabaseSessionClient({ request, response });
  let preservedPrimarySession = null;
  if (intent?.action === "reclaim") {
    const [primaryUser, primarySession] = await Promise.all([
      supabase.auth.getUser(),
      supabase.auth.getSession(),
    ]);
    if (
      primaryUser.error ||
      primarySession.error ||
      primaryUser.data?.user?.id !== intent.target_user_id ||
      !primarySession.data?.session?.access_token ||
      !primarySession.data?.session?.refresh_token
    ) {
      return fail({
        action: intent.action,
        error: "recovery_session_expired",
        flow,
        request,
        response,
      });
    }
    preservedPrimarySession = primarySession.data.session;
  }
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
  if (intent?.action === "reclaim") {
    let reclaimResult;
    try {
      reclaimResult = await reclaimReferralOrphanIdentity({
        orphanUserId: claimedUserId,
        provider: intent.provider,
        token,
      });
      await installNextSupabaseSession({
        request,
        response,
        session: preservedPrimarySession,
      });
    } catch {
      await installNextSupabaseSession({
        request,
        response,
        session: preservedPrimarySession,
      }).catch(() => {});
      const target = new URL(
        safeNextPath(intent.return_path, "referral"),
        url.origin
      );
      target.searchParams.set("oauth", "identity_recovery_failed");
      target.searchParams.set("provider", intent.provider);
      response.cookies.set(clearOAuthIntentCookie(validIntentId));
      return setRedirect(response, target);
    }

    const target = new URL(
      safeNextPath(intent.return_path, "referral"),
      url.origin
    );
    response.cookies.set(clearOAuthIntentCookie(validIntentId));
    response.cookies.set(clearReferralOrphanReclaimCookie());
    response.cookies.set(clearReauthCookie());
    if (reclaimResult.reclaimed || reclaimResult.alreadyLinked) {
      const roleSession = await resolveRoleSession({
        flow: "referral",
        userId: accountUserId,
      });
      if (!roleSession.cookie) {
        target.searchParams.set("oauth", "identity_recovery_failed");
        target.searchParams.set("provider", intent.provider);
        return setRedirect(response, target);
      }
      setRoleCookie(response, roleSession.cookie);
      target.searchParams.set("linked", intent.provider);
      target.searchParams.set("reclaimed", "1");

      return setRedirect(response, target);
    }
    target.searchParams.set(
      "oauth",
      reclaimResult.reason === "active_account"
        ? "identity_owned_by_active_account"
        : "identity_not_reclaimable"
    );
    target.searchParams.set("provider", intent.provider);
    return setRedirect(response, target);
  }
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



  if (!intent) {
    return completeLegacySignin({ request, response, result, url });
  }

  let finalized;
  try {
    const reauthToken = intent.action === "reauth" ? createReauthToken() : "";

      finalized = await finalizeOAuthIntent({
        provider: intent.provider,
        token,
        userId: result.data.user.id,
        ...(reauthToken
          ? { reauthTokenHash: hashReauthToken(reauthToken) }
          : {}),
      });

    if (finalized.flow !== "referral") throw new Error("Unsupported account flow.");
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
        // Unlinked sign-ins from either provider must reach password-based linking.
        if (
          finalized.action === "signin" &&
          PENDING_LINK_PROVIDERS.includes(finalized.provider) &&
          ["referral"].includes(finalized.flow) &&
          (roleSession.error || "unlinked") === "unlinked"
        ) {
          const unlinkedTarget = new URL(
            "/referrals/login",
            url.origin
          );
          unlinkedTarget.searchParams.set(
            "oauth",
            "unlinked"
          );
          unlinkedTarget.searchParams.set("provider", finalized.provider);

          response.cookies.set(
            createPendingDiscordLinkCookie({
              flow: finalized.flow,
              intentId: validIntentId,
              provider: finalized.provider,
              userId: claimedUserId,
            })
          );
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
      if (
        finalized.action === "signin" &&
        PENDING_LINK_PROVIDERS.includes(finalized.provider) &&
        ["referral"].includes(finalized.flow)
      ) {
        response.cookies.set(
          clearPendingDiscordLinkCookie({
            flow: finalized.flow,
            provider: finalized.provider,
          })
        );
      }
      if (finalized.action === "link") {
        target.searchParams.set("linked", finalized.provider);
        response.cookies.set(clearReauthCookie());
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
