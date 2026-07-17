import crypto from "node:crypto";

import { createSupabaseAdminClient } from "./adminClient.js";

export const REAUTH_COOKIE = "roo_reauth_grant";
export const REAUTH_PRIMARY_COOKIE = "roo_reauth_primary";
export const REAUTH_SECONDARY_COOKIE = "roo_reauth_secondary";
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;

export const hashReauthToken = (token) =>
  crypto.createHash("sha256").update(String(token || "")).digest("hex");

export const createReauthToken = () => crypto.randomBytes(32).toString("base64url");

export const reauthCookieName = (slot = "") => {
  if (slot === "primary") return REAUTH_PRIMARY_COOKIE;
  if (slot === "secondary") return REAUTH_SECONDARY_COOKIE;
  return REAUTH_COOKIE;
};

export const reauthCookie = (token, slot = "", env = process.env) => ({
  name: reauthCookieName(slot),
  value: String(token || ""),
  httpOnly: true,
  maxAge: REAUTH_MAX_AGE_SECONDS,
  path: "/",
  sameSite: "lax",
  secure: env.NODE_ENV === "production",
});

export const clearReauthCookie = (slot = "", env = process.env) => ({
  ...reauthCookie("", slot, env),
  maxAge: 0,
});

export const readRequestCookie = (request, name) => {
  const structured = request?.cookies?.get?.(name)?.value;
  if (structured) return structured;
  const cookieHeader =
    request?.headers?.get?.("cookie") || request?.headers?.cookie || "";
  const match = String(cookieHeader)
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return "";
  const raw = match.slice(name.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const readReauthToken = (request, slot = "") =>
  readRequestCookie(request, reauthCookieName(slot));

export const readReauthGrantStatus = async ({
  adminClient = createSupabaseAdminClient(),
  purpose,
  token,
  userId,
} = {}) => {
  if (!token || !userId || !purpose) return null;
  const result = await adminClient.rpc("roo_read_reauth_grant", {
    p_purpose: String(purpose).trim().toLowerCase(),
    p_token_hash: hashReauthToken(token),
    p_user_id: String(userId).trim(),
  });
  if (result.error) throw result.error;
  return result.data || null;
};
