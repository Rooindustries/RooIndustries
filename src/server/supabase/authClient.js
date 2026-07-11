import { createClient } from "@supabase/supabase-js";

const readFirst = (env, keys) =>
  keys
    .map((key) => String(env?.[key] || "").trim())
    .find(Boolean) || "";

export const resolveSupabaseAuthEnv = (env = process.env) => {
  const url = readFirst(env, ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  const publishableKey = readFirst(env, [
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]);

  if (!url) {
    throw new Error("SUPABASE_URL is required for Supabase Auth.");
  }
  if (!publishableKey) {
    throw new Error("A Supabase publishable key is required for Supabase Auth.");
  }

  return { url, publishableKey };
};

export const createSupabaseAuthClient = ({ env = process.env } = {}) => {
  const { url, publishableKey } = resolveSupabaseAuthEnv(env);
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "roo-industries-auth-server" },
    },
  });
};
