import fs from "node:fs";
import process from "node:process";
import envValue from "../src/server/supabase/envValue.cjs";

if (envValue.readEnvValue(process.env, "VERCEL_ENV").toLowerCase() !== "production") process.exit(0);

const { createSupabaseAdminClient } = await import("../src/server/supabase/adminClient.js");

const block = (reason) => {
  console.error(`[migrations] Production build blocked: ${reason}`);
  process.exit(1);
};

let client;
try {
  client = createSupabaseAdminClient();
} catch (error) {
  block(error.message);
}

const { data, error, status } = await client.rpc("roo_migration_history");
if (error) {
  if (status === 0) {
    const cause = String(error.details).match(/^Caused by: (.+)$/m)?.[1];
    block(`Supabase could not be reached (${cause || error.message}).`);
  }
  if (error.code === "PGRST202") {
    block(`public.roo_migration_history() is missing. Apply supabase/migrations/20261128000000_expose_migration_history_to_service_role.sql to production first.`);
  }
  if (status === 401 || status === 403) block(`Supabase refused the service key (HTTP ${status}: ${error.message}).`);
  block(`production's migration history could not be read (HTTP ${status} ${error.code}: ${error.message}).`);
}
const validRow = (row) =>
  typeof row?.version === "string" && /^\d+$/.test(row.version) && (row.name === null || typeof row.name === "string");
if (!Array.isArray(data) || !data.every(validRow)) block("Supabase returned an unexpected migration history.");

const hostedByVersion = new Map(data.map((row) => [row.version, row.name]));
const hostedNames = new Set(data.map((row) => row.name));
const files = fs
  .readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const missing = files.flatMap((file) => {
  const version = file.slice(0, 14);
  const name = file.slice(15, -4);
  if (!hostedByVersion.has(version)) return hostedNames.has(name) ? [] : [file];
  const hostedName = hostedByVersion.get(version);
  return hostedName === name ? [] : [`${file} (production records ${version} as ${hostedName})`];
});
if (missing.length > 0) {
  block(
    `these migrations are not in production's history:\n- ${missing.join("\n- ")}\n` +
      "Apply each one to production with its supabase_migrations.schema_migrations row, then deploy again.",
  );
}
console.log(`[migrations] All ${files.length} migrations are in production's history.`);
