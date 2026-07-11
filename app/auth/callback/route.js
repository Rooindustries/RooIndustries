import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { bootstrapSupabaseNativeAccount } from "@/src/server/supabase/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const safeNextPath = (value) => {
  const path = String(value || "/").trim();
  if (
    !/^\/(?!\/)[^\\\u0000-\u001f]*$/.test(path) ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/callback")
  ) {
    return "/";
  }
  return path;
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

export async function GET(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(url.searchParams.get("next"));
  const target = new URL(next, url.origin);
  const response = NextResponse.redirect(target, { status: 303 });

  if (!code) {
    target.pathname = "/";
    target.search = "auth_error=missing_code";
    return NextResponse.redirect(target, { status: 303 });
  }

  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const publishableKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
  ).trim();
  if (!supabaseUrl || !publishableKey) {
    target.pathname = "/";
    target.search = "auth_error=unavailable";
    return NextResponse.redirect(target, { status: 303 });
  }

  const supabase = createServerClient(supabaseUrl, publishableKey, {
    cookies: {
      getAll: () => requestCookies(request),
      setAll: (cookies) => {
        for (const cookie of cookies) response.cookies.set(cookie);
      },
    },
  });
  const result = await supabase.auth.exchangeCodeForSession(code);
  if (result.error) {
    target.pathname = "/";
    target.search = "auth_error=exchange_failed";
    return NextResponse.redirect(target, { status: 303 });
  }

  try {
    await bootstrapSupabaseNativeAccount({ userId: result.data?.user?.id });
  } catch {
    const setupError = new URL("/account/login", url.origin);
    setupError.searchParams.set("error", "account_setup_failed");
    return NextResponse.redirect(setupError, { status: 303 });
  }

  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
