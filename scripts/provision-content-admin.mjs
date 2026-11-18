import readline from "node:readline/promises";
import { provisionContentAdmin, resolveSupabaseAdminEnv } from "./lib/provision-content-admin.mjs";

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

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(?:email|target)=/.test(arg) && !/^--(?:reset-password|grant-existing)$/.test(arg))) throw new Error("Use --email=<address>, --target=local|production and optional --grant-existing or --reset-password. Passwords must use CONTENT_ADMIN_PASSWORD or the hidden prompt.");
  const email = args.find(arg => arg.startsWith("--email="))?.slice(8);
  const target = args.find(arg => arg.startsWith("--target="))?.slice(9) || "local";
  if (!["local", "production"].includes(target)) throw new Error("Target must be local or production.");
  const host = new URL(resolveSupabaseAdminEnv().url).hostname;
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
