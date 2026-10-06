import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.js`, context);
    throw error;
  }
} });
const { createSupabaseAdminClient } = await import("../src/server/supabase/adminClient.js");
const { bootstrapSupabaseNativeAccount, resolveSupabaseAccountByUserId } = await import("../src/server/supabase/accounts.js");
const { isValidNewPassword, NEW_PASSWORD_REQUIREMENT } = await import("../src/lib/passwordPolicy.js");
const { isContentAdministrator } = await import("../src/server/cms/adminSession.js");

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

const hiddenPassword = () => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY) { reject(new Error("Set CONTENT_ADMIN_PASSWORD or use an interactive terminal.")); return; }
  let value = "";
  const raw = process.stdin.isRaw;
  process.stdout.write("Password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const finish = () => { process.stdin.removeListener("data", read); process.stdin.setRawMode(raw); process.stdin.pause(); process.stdout.write("\n"); };
  const read = chunk => {
    for (const char of chunk.toString("utf8")) {
      if (char === "\u0003") { finish(); reject(new Error("Provisioning cancelled.")); return; }
      if (char === "\r" || char === "\n") { finish(); resolve(value); return; }
      if (char === "\u007f" || char === "\b") value = Array.from(value).slice(0, -1).join("");
      else if (char >= " ") value += char;
    }
  };
  process.stdin.on("data", read);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !/^--(?:email|target)=/.test(arg) && !/^--(?:reset-password|grant-existing)$/.test(arg))) throw new Error("Use --email=<address>, --target=local|production and optional --grant-existing or --reset-password. Passwords must use CONTENT_ADMIN_PASSWORD or the hidden prompt.");
    const email = args.find(arg => arg.startsWith("--email="))?.slice(8);
    const target = args.find(arg => arg.startsWith("--target="))?.slice(9) || "local";
    if (!["local", "production"].includes(target)) throw new Error("Target must be local or production.");
    const host = new URL(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).hostname;
    if (target === "local" && !["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new Error("Local provisioning requires a local Supabase URL. Production requires --target=production.");
    if (target === "production") {
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`Supabase project host: ${host}\nType yes to provision production: `);
      prompt.close();
      if (answer !== "yes") throw new Error("Provisioning cancelled.");
    }
    const password = () => process.env.CONTENT_ADMIN_PASSWORD || hiddenPassword();
    process.stdout.write(`${JSON.stringify(await provisionContentAdmin({ email, password, resetPassword: args.includes("--reset-password"), grantExisting: args.includes("--grant-existing") }))}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
