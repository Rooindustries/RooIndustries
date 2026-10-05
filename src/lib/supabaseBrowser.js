import { createBrowserClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";

let browserClient = null;
let recoveryQueue = Promise.resolve();
const RECOVERY_ACTION_TIMEOUT_MS = 15_000;

export const getSupabaseBrowserCookieOptions = (env = process.env) => ({
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

const createConfiguredClient = (options = {}) => {
  const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const publishableKey = String(
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
  ).trim();
  if (!url || !publishableKey) {
    throw new Error("Supabase browser Auth is not configured.");
  }
  return createBrowserClient(url, publishableKey, {
    ...options,
    cookieOptions: getSupabaseBrowserCookieOptions(),
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
  });
};

export const getSupabaseBrowserClient = () => {
  if (!browserClient) browserClient = createConfiguredClient();
  return browserClient;
};

const recoveryFetch = async (signal, input, options = {}) => {
  const cancelled = () => new Response(JSON.stringify({ msg: "Recovery request cancelled." }), {
    status: 400, headers: { "Content-Type": "application/json" },
  });
  if (signal.aborted) return cancelled();
  try {
    const response = await fetch(input, { ...options, signal });
    const body = await response.arrayBuffer();
    if (signal.aborted) return cancelled();
    return new Response([204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    if (signal.aborted) return cancelled();
    throw error;
  }
};

export const runSupabaseBrowserRecovery = (signal, action) => {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(
    new DOMException("Recovery verification took too long.", "TimeoutError")
  ), RECOVERY_ACTION_TIMEOUT_MS);
  const promise = recoveryQueue.then(async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    let client;
    try {
      client = createConfiguredClient({
        isSingleton: false,
        global: { fetch: (input, options) => recoveryFetch(controller.signal, input, options) },
        cookies: {
          getAll: () => parseCookieHeader(document.cookie),
          setAll: cookies => {
            if (controller.signal.aborted) return;
            cookies.forEach(({ name, value, options }) => {
              document.cookie = serializeCookieHeader(name, value, options);
            });
          },
        },
      });
      const result = await action(client);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      controller.abort();
      if (client) await client.auth.dispose();
    }
  }).finally(() => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
  });
  recoveryQueue = promise.catch(() => {});
  return promise;
};
