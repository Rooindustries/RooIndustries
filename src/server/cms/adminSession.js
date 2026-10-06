import crypto from "node:crypto";
import { cmsError } from "./errors.js";
import { resolveSupabaseAccountByUserId } from "../supabase/accounts.js";

export const ADMIN_SESSION_COOKIE = "roo_admin_session";
export const ADMIN_SESSION_TTL = 43200;
export const assertAdminSessionConfigured = (env = process.env) => {
  if (typeof env.REF_SESSION_SECRET !== "string" || !env.REF_SESSION_SECRET.length) throw cmsError("Admin access is not configured.", 503, "ADMIN_NOT_CONFIGURED");
};
const signature = (value, env) => {
  assertAdminSessionConfigured(env);
  return crypto.createHmac("sha256", env.REF_SESSION_SECRET).update(value).digest("base64url");
};
export const assertAdminKey = (request, env = process.env) => {
  const expected = env.REF_ADMIN_KEY;
  if (typeof expected !== "string" || !expected.length) throw cmsError("Admin access is not configured.", 503, "ADMIN_NOT_CONFIGURED");
  const provided = request.headers.get("x-admin-key") || "";
  const digest = value => crypto.createHash("sha256").update(value).digest();
  if (!crypto.timingSafeEqual(digest(expected), digest(provided)) || !provided.length) throw cmsError("Admin access is required.", 401, "ADMIN_UNAUTHORIZED");
  return "admin:key";
};
export const issueAdminSessionCookie = ({ principalId, userId, sessionVersion, env = process.env }) => {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, pid: principalId, uid: userId, sv: Number(sessionVersion), iat, exp: iat + ADMIN_SESSION_TTL })).toString("base64url");
  const token = `v1.${payload}`;
  return { cookie: `${ADMIN_SESSION_COOKIE}=${token}.${signature(token, env)}; HttpOnly;${env.NODE_ENV === "production" ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL}`, expiresAt: new Date((iat + ADMIN_SESSION_TTL) * 1000).toISOString() };
};
export const clearAdminSessionCookie = () => `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
export const verifyAdminSessionCookie = (request, env = process.env) => {
  assertAdminSessionConfigured(env);
  const token = (request.headers.get("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))?.slice(ADMIN_SESSION_COOKIE.length + 1);
  if (!token || token.length > 4096) return null;
  const [version, encoded, supplied, extra] = token.split(".");
  if (version !== "v1" || !encoded || !supplied || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return null;
  const digest = value => crypto.createHash("sha256").update(value).digest();
  if (!crypto.timingSafeEqual(digest(signature(`${version}.${encoded}`, env)), digest(supplied))) return null;
  try {
    const { v, pid, uid, sv, iat, exp } = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (v !== 1 || typeof pid !== "string" || !pid || typeof uid !== "string" || !uid || !Number.isSafeInteger(sv) || sv < 0 || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= now || iat > now + 60) return null;
    return { pid, uid, sv };
  } catch { return null; }
};
export const isContentAdministrator = account => Boolean(account && account.status === "active" && Array.isArray(account.roles) && account.roles.includes("administrator") && typeof account.principal_id === "string" && account.principal_id && Number.isSafeInteger(Number(account.session_version)) && Number(account.session_version) >= 0);
export const assertAdminOrigin = request => {
  if (["GET", "HEAD"].includes(request.method)) return;
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return;
  if (site === null) {
    try { if (new URL(request.headers.get("origin")).host === request.headers.get("host")) return; } catch {}
  }
  throw cmsError("Cross-site admin requests are refused.", 403, "ADMIN_ORIGIN_REJECTED");
};
export const resolveAdminActor = async (request, { env = process.env, adminClient } = {}) => {
  if (request.headers.has("x-admin-key")) return { actor: assertAdminKey(request, env), account: null };
  const cookie = verifyAdminSessionCookie(request, env);
  if (!cookie) throw cmsError("Admin access is required.", 401, "ADMIN_UNAUTHORIZED");
  const account = await resolveSupabaseAccountByUserId({ userId: cookie.uid, adminClient });
  if (!isContentAdministrator(account) || account.principal_id !== cookie.pid || Number(account.session_version) !== cookie.sv) throw cmsError("Admin access is required.", 401, "ADMIN_UNAUTHORIZED");
  assertAdminOrigin(request);
  return { actor: `admin:${account.principal_id}`, account };
};
