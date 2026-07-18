import { createBrowserClient } from "@supabase/ssr";

let browserClient = null;

export const getSupabaseBrowserCookieOptions = (env = process.env) => ({
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export const getSupabaseBrowserClient = () => {
  if (browserClient) return browserClient;
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const publishableKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
  ).trim();
  if (!url || !publishableKey) {
    throw new Error("Supabase browser Auth is not configured.");
  }
  browserClient = createBrowserClient(url, publishableKey, {
    cookieOptions: getSupabaseBrowserCookieOptions(),
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
  });
  return browserClient;
};
