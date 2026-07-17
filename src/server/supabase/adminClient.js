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
let cachedSecretKey = "";

const postgrestErrorCode = async (response) => {
  if (!response || Number(response.status) < 400) return "";
  try {
    const payload = await response.clone().json();
    return String(payload?.code || "");
  } catch {
    return "";
  }
};

export const createSupabaseAdminFetch = ({
  signal,
  fetchImpl = fetch,
} = {}) => {
  const request = (input, init = {}) => fetchImpl(input, {
    ...init,
    signal: init.signal && signal
      ? AbortSignal.any([init.signal, signal])
      : init.signal || signal,
  });
  return async (input, init = {}) => {
    const retryInput =
      typeof Request !== "undefined" && input instanceof Request
        ? input.clone()
        : input;
    const response = await request(input, init);
    if (
      signal?.aborted ||
      init.signal?.aborted ||
      await postgrestErrorCode(response) !== "PGRST303"
    ) {
      return response;
    }
    return request(retryInput, init);
  };
};

export const createSupabaseAdminClient = ({ env = process.env, signal } = {}) => {
  const { url, secretKey } = resolveSupabaseAdminEnv(env);
  if (
    !signal &&
    env === process.env &&
    cachedClient &&
    cachedUrl === url &&
    cachedSecretKey === secretKey
  ) {
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
      fetch: createSupabaseAdminFetch({ signal }),
    },
  });

  if (!signal && env === process.env) {
    cachedClient = client;
    cachedUrl = url;
    cachedSecretKey = secretKey;
  }
  return client;
};
