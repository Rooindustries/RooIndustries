import { createSupabaseAdminClient } from "@/src/server/supabase/adminClient.js";
import { createSupabaseAuthClient, resolveSupabaseAuthEnv } from "@/src/server/supabase/authClient.js";
import { resolveSupabaseAccountByUserId } from "@/src/server/supabase/accounts.js";
import { ADMIN_SESSION_COOKIE, assertAdminSessionConfigured, clearAdminSessionCookie, isContentAdministrator, issueAdminSessionCookie } from "@/src/server/cms/adminSession.js";
import { CMS_PRIVATE_HEADERS, handleCmsRequest, limitAdminFailure, readCmsBody } from "@/src/server/cms/http.js";
import { cmsError } from "@/src/server/cms/errors.js";
import { logSafeError } from "@/src/server/safeErrorLog.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = async request => {
  const env = process.env;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20000)]);
  let authClient, adminClient;
  try {
    resolveSupabaseAuthEnv(env);
    assertAdminSessionConfigured(env);
    adminClient = createSupabaseAdminClient({ env, signal });
    authClient = createSupabaseAuthClient({ env, signal });
  } catch {
    return Response.json({ ok: false, error: "Admin access is not configured.", code: "ADMIN_NOT_CONFIGURED" }, { status: 503, headers: CMS_PRIVATE_HEADERS });
  }
  try {
    const body = await readCmsBody(request, signal);
    if (!body || typeof body.email !== "string" || !body.email.trim() || body.email.length > 254 || typeof body.password !== "string" || body.password.length < 1 || body.password.length > 128) throw cmsError("Email or password was not accepted.", 401, "ADMIN_UNAUTHORIZED");
    const limited = await limitAdminFailure(request, "admin-content-login");
    if (limited) return limited;
    const { data, error } = await authClient.auth.signInWithPassword({ email: body.email, password: body.password });
    try {
      if (error) {
        if (error.name === "AuthInvalidTokenResponseError" && !data?.user?.id) throw cmsError("Email or password was not accepted.", 401, "ADMIN_UNAUTHORIZED");
        if (Number(error.status) < 500 && (Number(error.status) === 400 || error.code === "invalid_credentials")) throw cmsError("Email or password was not accepted.", 401, "ADMIN_UNAUTHORIZED");
        throw error;
      }
      if (!data?.user?.id) throw cmsError("Email or password was not accepted.", 401, "ADMIN_UNAUTHORIZED");
      const account = await resolveSupabaseAccountByUserId({ userId: data.user.id, adminClient });
      if (!isContentAdministrator(account) || data.user.id !== account.user_id) throw cmsError("Email or password was not accepted.", 401, "ADMIN_UNAUTHORIZED");
      const { cookie, expiresAt } = issueAdminSessionCookie({ principalId: account.principal_id, userId: data.user.id, sessionVersion: account.session_version, env });
      return Response.json({ ok: true, data: { email: account.primary_email, expiresAt } }, { headers: { ...CMS_PRIVATE_HEADERS, "Set-Cookie": cookie } });
    } finally {
      if (data?.session) {
        try {
          const logout = await authClient.auth.signOut({ scope: "local" });
          if (logout.error) throw logout.error;
        } catch (error) { logSafeError("Admin login unavailable", error); }
      }
    }
  } catch (error) {
    if (error.code === "ADMIN_UNAUTHORIZED" || error.code === "CMS_VALIDATION_FAILED") return Response.json({ ok: false, error: "Email or password was not accepted.", code: "ADMIN_UNAUTHORIZED" }, { status: 401, headers: CMS_PRIVATE_HEADERS });
    logSafeError("Admin login unavailable", error);
    return Response.json({ ok: false, error: "Admin sign-in is temporarily unavailable. Please try again later.", code: "ADMIN_UNAVAILABLE" }, { status: 503, headers: CMS_PRIVATE_HEADERS });
  }
};

export const GET = (request, context) => {
  if (!request.headers.has("x-admin-key") && !(request.headers.get("cookie") || "").split(";").some(part => part.trim().startsWith(`${ADMIN_SESSION_COOKIE}=`))) return Response.json({ ok: true, data: { signedIn: false } }, { headers: CMS_PRIVATE_HEADERS });
  return handleCmsRequest(request, context, ({ actor, account }) => ({ signedIn: true, actor, email: account?.primary_email || null }), { sessionProbe: true });
};

export const DELETE = (request, context) => handleCmsRequest(request, context, async ({ headers, client, account }) => {
  if (account?.principal_id) {
    const rotation = await client.rpc("roo_rotate_principal_sessions", { p_principal_id: account.principal_id });
    if (rotation.error) throw cmsError("Sign-out could not be completed. Please try again.", 503, "ADMIN_SIGNOUT_FAILED");
  }
  headers["Set-Cookie"] = clearAdminSessionCookie();
  return { signedOut: true };
});
