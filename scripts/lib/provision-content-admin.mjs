import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.js`, context);
    throw error;
  }
} });
const { createSupabaseAdminClient, resolveSupabaseAdminEnv } = await import("../../src/server/supabase/adminClient.js");
const { bootstrapSupabaseNativeAccount, resolveSupabaseAccountByUserId } = await import("../../src/server/supabase/accounts.js");
const { isValidNewPassword, NEW_PASSWORD_REQUIREMENT } = await import("../../src/lib/passwordPolicy.js");
const { isContentAdministrator } = await import("../../src/server/cms/adminSession.js");
export const provisionContentAdmin = async ({ email, password, resetPassword = false, grantExisting = false, adminClient = createSupabaseAdminClient() }) => {
  if (typeof email !== "string" || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email is required.");
  let user;
  for (let page = 1; ; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error("Admin user lookup failed.");
    user = data.users.find(entry => entry.email?.toLowerCase() === email.toLowerCase());
    if (user || data.users.length < 1000) break;
  }
  const resetting = Boolean(user && resetPassword);
  if (user && !resetting && !grantExisting) throw new Error(`An auth user for ${email} already exists (created ${user.created_at}). Re-run with --grant-existing to make that account an administrator with its current password, or --reset-password to set a new one.`);
  if (!user || resetting) {
    const value = typeof password === "function" ? await password() : password;
    if (!isValidNewPassword(value)) throw new Error(NEW_PASSWORD_REQUIREMENT);
    const result = user
      ? await adminClient.auth.admin.updateUserById(user.id, { password: value })
      : await adminClient.auth.admin.createUser({ email, password: value, email_confirm: true });
    if (result.error || !result.data?.user?.id) throw new Error("Admin user provisioning failed.");
    user = result.data.user;
  }
  const userId = user.id;
  await bootstrapSupabaseNativeAccount({ userId, adminClient });
  const grant = await adminClient.rpc("roo_grant_account_role", { p_user_id: userId, p_role: "administrator" });
  if (grant.error) throw new Error("Admin role grant failed.");
  let account = await resolveSupabaseAccountByUserId({ userId, adminClient });
  if (resetting) {
    const rotation = await adminClient.rpc("roo_rotate_principal_sessions", { p_principal_id: account?.principal_id });
    if (rotation.error) throw new Error("Admin sessions could not be rotated.");
    account = await resolveSupabaseAccountByUserId({ userId, adminClient });
  }
  if (!isContentAdministrator(account)) throw new Error("An active administrator account could not be verified.");
  return { principalId: account.principal_id, roles: account.roles, status: account.status };
};
export { resolveSupabaseAdminEnv };
