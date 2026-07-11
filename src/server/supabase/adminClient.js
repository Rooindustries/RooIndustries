import { createClient } from "@supabase/supabase-js";

const readFirst = (env, keys) =>
  keys
    .map((key) => String(env?.[key] || "").trim())
    .find(Boolean) || "";

export const resolveSupabaseAdminEnv = (env = process.env) => {
  const url = readFirst(env, ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  const secretKey = readFirst(env, [
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  if (!url) {
    throw new Error("SUPABASE_URL is required for server-side Supabase access.");
  }
  if (!secretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required for server-side Supabase access."
    );
  }

  return { url, secretKey };
};

export const isSupabaseAdminConfigured = (env = process.env) => {
  try {
    resolveSupabaseAdminEnv(env);
    return true;
  } catch {
    return false;
  }
};

let cachedClient = null;
let cachedUrl = "";

export const createSupabaseAdminClient = ({ env = process.env } = {}) => {
  const { url, secretKey } = resolveSupabaseAdminEnv(env);
  if (env === process.env && cachedClient && cachedUrl === url) {
    return cachedClient;
  }

  const client = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    db: { schema: "public" },
    global: {
      headers: { "X-Client-Info": "roo-industries-server" },
    },
  });

  if (env === process.env) {
    cachedClient = client;
    cachedUrl = url;
  }
  return client;
};
