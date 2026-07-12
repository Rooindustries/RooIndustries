import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import {
  bootstrapSupabaseNativeAccount,
  resolveSupabaseAccountAlias,
} from "@/src/server/supabase/accounts";
import { createReferralSessionCookie } from "@/src/server/api/ref/auth";
import {
  TOURNEY_SESSION_COOKIE,
  createTourneySessionToken,
  getTourneyCookieOptions,
} from "@/src/server/tourney/auth";

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
    path.startsWith("/auth/callback") ||
    path.startsWith("/account")
  ) {
    return fallback;
  }
  if (flow === "referral" && !path.startsWith("/referrals/")) return fallback;
  if (flow === "tourney" && !path.startsWith("/tourney")) return fallback;
  if (flow === "tourney" && path === "/tourney/login") return fallback;
  return path;
};

const errorRedirect = ({ url, flow, error }) => {
  const pathname =
    flow === "tourney"
      ? "/tourney/login"
      : flow === "referral"
        ? "/referrals/login"
        : "/";
  const target = new URL(pathname, url.origin);
  target.searchParams.set(flow === "tourney" ? "error" : flow === "referral" ? "oauth" : "auth_error", error);
  return NextResponse.redirect(target, { status: 303 });
};

const requestCookies = (request) => {
  const structured = request.cookies?.getAll?.();
  if (Array.isArray(structured)) return structured;
  return String(request.headers.get("cookie") || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return [];
      const name = entry.slice(0, separator).trim();
      const encodedValue = entry.slice(separator + 1);
      try {
        return [{ name, value: decodeURIComponent(encodedValue) }];
      } catch {
        return [{ name, value: encodedValue }];
      }
    })
    .filter((entry) => entry.name && entry.value);
};

const createOAuthClient = ({ request, response }) => {
  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const publishableKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
  ).trim();
  if (!supabaseUrl || !publishableKey) return null;

  return createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll: () => requestCookies(request),
      setAll: (cookies, headers = {}) => {
        for (const { name, value, options } of cookies) {
          response.cookies.set(name, value, options);
        }
        for (const [name, value] of Object.entries(headers)) {
          response.headers.set(name, value);
        }
      },
    },
  });
};

const verifiedEmail = (user) => {
  const email = String(user?.email || "").trim().toLowerCase();
  return email && user?.email_confirmed_at ? email : "";
};

const referralSession = (account) => {
  if (!(account?.roles || []).includes("creator")) return null;
  if (!account.legacy_sanity_id || !account.referral_code) return null;
  return createReferralSessionCookie({
    referralId: account.legacy_sanity_id,
    code: account.referral_code,
    authBackend: "supabase",
  });
};

const tourneySession = (account) => {
  const role = String(account?.tourney_role || "").replace(/^tourney_/, "");
  if (!account?.tourney_username || !["player", "viewer", "caster", "owner"].includes(role)) {
    return null;
  }
  const value = createTourneySessionToken({
    account: {
      username: account.tourney_username,
      role,
      version: String(account.credential_version || "1"),
      authBackend: "supabase",
    },
  });
  return value
    ? { name: TOURNEY_SESSION_COOKIE, value, ...getTourneyCookieOptions() }
    : null;
};

const resolveRoleSession = async ({ flow, user }) => {
  const email = verifiedEmail(user);
  if (!email) return { error: "unlinked" };
  const account = await resolveSupabaseAccountAlias({
    identifier: email,
    accountScope: flow === "tourney" ? "tourney" : "default",
  });
  if (account?.status !== "active") return { error: "unlinked" };
  if (flow === "tourney" && account.tourney_active === false) {
    return { error: account.tourney_status === "removed" ? "suspended" : "unlinked" };
  }
  const cookie = flow === "tourney" ? tourneySession(account) : referralSession(account);
  return cookie ? { account, cookie } : { error: "unlinked" };
};

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function GET(request) {
  const url = new URL(request.url);
  const flow = normalizeFlow(url.searchParams.get("flow"));
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"), flow);
  const target = new URL(next, url.origin);
  const response = NextResponse.redirect(target, { status: 303 });

  if (!code) {
    return errorRedirect({ url, flow, error: "missing_code" });
  }

  const supabase = createOAuthClient({ request, response });
  if (!supabase) return errorRedirect({ url, flow, error: "unavailable" });
  const result = await supabase.auth.exchangeCodeForSession(code);
  if (result.error) {
    return errorRedirect({ url, flow, error: "exchange_failed" });
  }

  try {
    if (!flow) {
      await bootstrapSupabaseNativeAccount({ userId: result.data?.user?.id });
      return noStore(response);
    }

    const roleSession = await resolveRoleSession({ flow, user: result.data?.user });
    if (!roleSession.cookie) {
      return errorRedirect({ url, flow, error: roleSession.error || "unlinked" });
    }
    const sameAccount = roleSession.account.user_id === result.data?.user?.id;
    if (sameAccount) {
      await bootstrapSupabaseNativeAccount({ userId: result.data.user.id });
    }
    const roleResponse = sameAccount
      ? response
      : NextResponse.redirect(target, { status: 303 });
    roleResponse.cookies.set(roleSession.cookie);
    return noStore(roleResponse);
  } catch {
    return errorRedirect({ url, flow, error: "unavailable" });
  }
}
