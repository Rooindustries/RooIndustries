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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INVALID_LOGIN_MESSAGE =
  "Invalid Discord username, email, or password. Wait for approval before trying to log in.";
const SUSPENDED_LOGIN_MESSAGE =
  "You have been suspended from the tourney. Please contact serviroo through Discord or at serviroo@rooindustries.com for further queries.";
const UNAVAILABLE_LOGIN_MESSAGE =
  "Tournament sign-in is temporarily unavailable. Please try again shortly.";

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
    maxFields: 4,
  });
  return {
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
  } catch {
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

  const response = wantsJson(request)
    ? NextResponse.json({
        ok: true,
        role: result.account.role,
        username: result.account.username,
      })
    : redirectToPath(request, payload?.redirectTo);
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
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
