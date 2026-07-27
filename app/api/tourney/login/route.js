import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS,
  TOURNEY_SESSION_MAX_AGE_SECONDS,
  checkTourneyRateLimit,
  createTourneySessionToken,
  getClientAddressFromHeaders,
  getTourneyCookieOptions,
  verifyTourneyCredentials,
} from "../../../../src/server/tourney/auth";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  clearNextSupabaseSession,
  installNextSupabaseSession,
} from "../../../../src/server/supabase/serverSession";
import {
  readBoundedFormData,
  readBoundedJson,
} from "../../../../src/server/request/boundedJson";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import {
  clearPendingDiscordLinkCookie,
  linkPendingDiscordIdentity,
  PENDING_LINK_PROVIDERS,
  resolvePendingDiscordUser,
  resolvePendingSocialLink,
} from "../../../../src/server/supabase/pendingSocialLink";
import {
  queueTourneyDiscordAuthProjection,
  queueTourneyDiscordCrossDomainRoleProjection,
} from "../../../../src/server/tourney/discordDesiredState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVALID_LOGIN_MESSAGE =
  "Invalid roster name, email, or password. Wait for approval before trying to log in.";
const SUSPENDED_LOGIN_MESSAGE =
  "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries.";
const UNAVAILABLE_LOGIN_MESSAGE =
  "Tournament sign-in is temporarily unavailable. Please try again shortly.";
const linkFailedMessage = (provider) => {
  const label = provider === "google" ? "Google" : "Discord";
  return `${label} linking did not complete. Try the ${label} login again.`;
};

const normalizeLinkProvider = (value) => {
  const provider = String(value || "").trim().toLowerCase();
  return PENDING_LINK_PROVIDERS.includes(provider) ? provider : "discord";
};

const wantsJson = (request) =>
  String(request.headers.get("accept") || "").includes("application/json");

const normalizeRedirectTo = (value) => {
  const path = String(value || "/tourney").trim();
  if (
    !path.startsWith("/tourney") ||
    path.startsWith("//") ||
    path.startsWith("/api/") ||
    path === "/tourney/login"
  ) {
    return "/tourney";
  }
  return path;
};

const isRememberMeEnabled = (value) =>
  value === true ||
  value === "true" ||
  value === "on" ||
  value === "1";

const redirectToPath = (request, path = "/tourney") => {
  const url = new URL(normalizeRedirectTo(path), request.url);
  return NextResponse.redirect(url, { status: 303 });
};

const redirectToLogin = (request, error, redirectTo = "/tourney") => {
  const url = new URL("/tourney/login", request.url);
  if (error) {
    url.searchParams.set("error", error);
  }
  const safeRedirect = normalizeRedirectTo(redirectTo);
  if (safeRedirect !== "/tourney") {
    url.searchParams.set("next", safeRedirect);
  }
  return NextResponse.redirect(url, { status: 303 });
};

const readLoginPayload = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    return readBoundedJson(request, { maxBytes: 8 * 1024 });
  }

  const form = await readBoundedFormData(request, {
    maxBytes: 8 * 1024,
    maxFields: 6,
  });
  return {
    linkDiscord: form.get("linkDiscord"),
    linkProvider: form.get("linkProvider"),
    username: form.get("username"),
    password: form.get("password"),
    rememberMe: form.get("rememberMe"),
    redirectTo: form.get("redirectTo"),
  };
};

const invalidResponse = (request, payload, status = 401, reason = "") => {
  if (reason === "unavailable") {
    if (wantsJson(request)) {
      return NextResponse.json(
        { ok: false, error: UNAVAILABLE_LOGIN_MESSAGE },
        { status: 503, headers: { "Retry-After": "30" } }
      );
    }
    return redirectToLogin(request, "unavailable", payload?.redirectTo);
  }
  const isSuspended = reason === "suspended";
  const message = isSuspended ? SUSPENDED_LOGIN_MESSAGE : INVALID_LOGIN_MESSAGE;
  if (wantsJson(request)) {
    return NextResponse.json(
      { ok: false, error: message },
      { status }
    );
  }
  return redirectToLogin(request, isSuspended ? "suspended" : "1", payload?.redirectTo);
};

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json({ ok: false, error: "Cross-origin request rejected." }, { status: 403 });
  }
  let payload;
  try {
    payload = await readLoginPayload(request);
  } catch (error) {
    const status = Number(error?.status || 400);
    if (wantsJson(request)) {
      return NextResponse.json(
        { ok: false, error: error?.message || "Invalid login request." },
        { status }
      );
    }
    return redirectToLogin(request, "1");
  }
  const username = String(payload?.username || "").trim().toLowerCase();
  const clientAddress = getClientAddressFromHeaders(request.headers);
  const rateLimit = await checkTourneyRateLimit({
    key: `tourney-login:${clientAddress}:${username || "unknown"}`,
    max: 8,
    windowMs: 15 * 60 * 1000,
  });

  if (!rateLimit.ok) {
    if (wantsJson(request)) {
      return NextResponse.json(
        { ok: false, error: rateLimit.error || "Too many attempts. Please try again later." },
        {
          status: rateLimit.status || 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        }
      );
    }
    if (rateLimit.status === 503) {
      return NextResponse.json(
        { ok: false, error: rateLimit.error },
        { status: 503, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }
    return redirectToLogin(request, "rate", payload?.redirectTo);
  }

  let result;
  try {
    result = await verifyTourneyCredentials({
      username,
      password: payload?.password,
    });
  } catch (error) {
    logSafeError("Tournament login credential verification failed", error);
    return invalidResponse(request, payload, 503, "unavailable");
  }

  if (!result.ok) {
    return invalidResponse(
      request,
      payload,
      result.reason === "unavailable" ? 503 : 401,
      result.reason
    );
  }

  const sessionMaxAgeSeconds = isRememberMeEnabled(payload?.rememberMe)
    ? TOURNEY_REMEMBERED_SESSION_MAX_AGE_SECONDS
    : TOURNEY_SESSION_MAX_AGE_SECONDS;
  const token = createTourneySessionToken({
    account: result.account,
    maxAgeSeconds: sessionMaxAgeSeconds,
  });
  if (!token) {
    return invalidResponse(request, payload, 503);
  }

  const linkDiscord = isRememberMeEnabled(payload?.linkDiscord);
  const requestedLinkProvider = normalizeLinkProvider(payload?.linkProvider);
  let discordLinked = false;
  let discordLinkError = "";
  let linkedProvider = "";
  // Named outside the attempt so the failure copy and the redirect notice still
  // report the provider whose proof was actually spent, including from the catch.
  let attemptedProvider = requestedLinkProvider;
  if (linkDiscord) {
    try {
      // Whichever pending proof the browser actually holds wins. The form reports
      // which provider it came from, but the proof is authoritative: a stale
      // Discord cookie must never be spent to satisfy a Google link.
      const pendingLink = resolvePendingSocialLink({
        flow: "tourney",
        provider: requestedLinkProvider,
        request,
      });
      if (pendingLink) attemptedProvider = pendingLink.provider;
      const pendingUser = pendingLink
        ? await resolvePendingDiscordUser({
            flow: "tourney",
            provider: pendingLink.provider,
            request,
          })
        : null;
      const primaryUserId = String(
        result.supabaseSession?.user?.id || ""
      ).trim();
      if (!pendingLink || !pendingUser || !primaryUserId) {
        discordLinkError = linkFailedMessage(attemptedProvider);
      } else {
        const provider = pendingLink.provider;
        const linked = await linkPendingDiscordIdentity({
          accountScope: "tourney",
          pendingUser,
          primaryUserId,
          provider,
        });
        if (!linked.linked) {
          discordLinkError = linkFailedMessage(provider);
        } else if (provider !== "discord") {
          // Only Discord carries a guild role to project. A Google link is
          // complete once the identity row exists.
          discordLinked = true;
          linkedProvider = provider;
        } else if (linked.crossDomain) {
          // The Discord account signs in to this person's other domain, so the
          // tourney-domain identity link is already projected. Queue the guild
          // role from the tourney principal rather than the Discord auth user.
          const projected = await queueTourneyDiscordCrossDomainRoleProjection({
            commandId: `discord-cross-domain:${pendingLink.intentId}:${primaryUserId}`,
            userId: primaryUserId,
          });
          if (projected.queued || projected.reason === "not_configured") {
            discordLinked = true;
            linkedProvider = provider;
          } else {
            discordLinkError = linkFailedMessage(provider);
          }
        } else {
          const resumed = await queueTourneyDiscordAuthProjection({
            accountUserId: pendingLink.userId,
            attemptExternalWork: true,
            claimedUserId: pendingLink.userId,
            commandId: `discord-oauth:${pendingLink.intentId}:${pendingLink.userId}`,
            intentId: pendingLink.intentId,
            resumeStoredCredential: true,
            userId: pendingLink.userId,
          });
          if (!resumed.applied && resumed.reason !== "pending") {
            discordLinkError = linkFailedMessage(provider);
          } else {
            discordLinked = true;
            linkedProvider = provider;
          }
        }
      }
    } catch (error) {
      logSafeError("Tournament pending social linking failed", error);
      discordLinkError = linkFailedMessage(attemptedProvider);
    }
  }

  const noticeProvider = linkedProvider || attemptedProvider;
  const response = wantsJson(request)
    ? NextResponse.json({
        ok: true,
        role: result.account.role,
        username: result.account.username,
        ...(discordLinked
          ? { discordLinked: true, linkedProvider: noticeProvider }
          : {}),
        ...(discordLinkError ? { discordLinkError } : {}),
      })
    : redirectToPath(
        request,
        linkDiscord
          ? `/tourney?notice=${
              discordLinked
                ? `${noticeProvider}-linked`
                : `${noticeProvider}-link-failed`
            }`
          : payload?.redirectTo
      );
  response.cookies.set({
    name: TOURNEY_SESSION_COOKIE,
    value: token,
    ...getTourneyCookieOptions(process.env, {
      maxAgeSeconds: sessionMaxAgeSeconds,
    }),
  });
  await clearNextSupabaseSession({ request, response }).catch(() => {});
  if (result.supabaseSession) {
    await installNextSupabaseSession({
      request,
      response,
      session: result.supabaseSession,
    }).catch(() => {});
  }
  // Both proofs are cleared once a link attempt has run. Leaving the other
  // provider's cookie behind would let a later sign-in silently spend a stale
  // proof the person has already moved on from.
  if (linkDiscord) {
    for (const provider of PENDING_LINK_PROVIDERS) {
      response.cookies.set(
        clearPendingDiscordLinkCookie({ flow: "tourney", provider })
      );
    }
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
