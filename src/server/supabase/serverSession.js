import { createServerClient } from "@supabase/ssr";
import { resolveSupabaseAuthEnv } from "./authClient.js";

const parseCookies = (header = "") =>
  String(header || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) return [];
      const name = entry.slice(0, separator).trim();
      const rawValue = entry.slice(separator + 1);
      try {
        return [{ name, value: decodeURIComponent(rawValue) }];
      } catch {
        return [{ name, value: rawValue }];
      }
    });

const sameSiteValue = (value) => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "none") return "None";
  return "Lax";
};

export const getSupabaseSessionCookieOptions = (env = process.env) => ({
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

const serializeCookie = ({ name, value, options = {} }) => {
  const parts = [`${name}=${encodeURIComponent(String(value || ""))}`];
  parts.push(`Path=${options.path || "/"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAge) || 0))}`);
  }
  if (options.expires instanceof Date) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${sameSiteValue(options.sameSite)}`);
  return parts.join("; ");
};

const appendLegacyCookie = (res, cookie) => {
  const existing = res.getHeader?.("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  res.setHeader(
    "Set-Cookie",
    Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]
  );
};

const createCookieClient = ({
  cookieHeader = "",
  env = process.env,
  setCookies,
  setHeaders = () => {},
} = {}) => {
  const { url, publishableKey } = resolveSupabaseAuthEnv(env);
  const cookieOptions = getSupabaseSessionCookieOptions(env);
  return createServerClient(url, publishableKey, {
    cookieOptions,
    cookies: {
      getAll: () => parseCookies(cookieHeader),
      setAll: (cookies, headers = {}) => {
        for (const cookie of cookies || []) {
          setCookies({
            ...cookie,
            options: {
              ...cookieOptions,
              ...(cookie.options || {}),
              ...(cookieOptions.secure ? { secure: true } : {}),
            },
          });
        }
        for (const [name, value] of Object.entries(headers || {})) {
          setHeaders(name, value);
        }
      },
    },
  });
};

export const createLegacySupabaseSessionClient = ({
  req,
  res,
  env = process.env,
} = {}) =>
  createCookieClient({
    cookieHeader: req?.headers?.cookie || "",
    env,
    setCookies: (cookie) => appendLegacyCookie(res, serializeCookie(cookie)),
    setHeaders: (name, value) => res.setHeader?.(name, value),
  });

export const createNextSupabaseSessionClient = ({
  request,
  response,
  env = process.env,
} = {}) =>
  createCookieClient({
    cookieHeader: request?.headers?.get?.("cookie") || "",
    env,
    setCookies: ({ name, value, options }) =>
      response.cookies.set(name, value, options),
    setHeaders: (name, value) => response.headers.set(name, value),
  });

export const installLegacySupabaseSession = async ({
  req,
  res,
  session,
  env = process.env,
} = {}) => {
  if (!session?.access_token || !session?.refresh_token) return false;
  const client = createLegacySupabaseSessionClient({ req, res, env });
  const result = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (result.error) throw new Error("Supabase browser session could not be established.");
  return true;
};

export const installNextSupabaseSession = async ({
  request,
  response,
  session,
  env = process.env,
} = {}) => {
  if (!session?.access_token || !session?.refresh_token) return false;
  const client = createNextSupabaseSessionClient({ request, response, env });
  const result = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (result.error) throw new Error("Supabase browser session could not be established.");
  return true;
};

export const clearLegacySupabaseSession = async ({
  req,
  res,
  env = process.env,
} = {}) => {
  const client = createLegacySupabaseSessionClient({ req, res, env });
  await client.auth.signOut({ scope: "local" }).catch(() => {});
};

export const clearNextSupabaseSession = async ({
  request,
  response,
  env = process.env,
} = {}) => {
  const client = createNextSupabaseSessionClient({ request, response, env });
  await client.auth.signOut({ scope: "local" }).catch(() => {});
};

export const getNextSupabaseUser = async ({
  request,
  response,
  env = process.env,
} = {}) => {
  const client = createNextSupabaseSessionClient({ request, response, env });
  const result = await client.auth.getUser();
  return result.error ? null : result.data?.user || null;
};

export const getLegacySupabaseUser = async ({
  req,
  res,
  env = process.env,
} = {}) => {
  const client = createLegacySupabaseSessionClient({ req, res, env });
  const result = await client.auth.getUser();
  return result.error ? null : result.data?.user || null;
};
