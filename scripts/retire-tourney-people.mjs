#!/usr/bin/env node
// Manual cutover tool. Nothing here runs during a build or deployment.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import dotenv from "dotenv";
import { createClient } from "@sanity/client";

const PROJECT = "ntezmxzaibrrsgtujgxu";
const SANITY_PROJECT = "9g42k3ur";
const SANITY_DATASET = "production";
const PEOPLE_ROLES = ["tourney_player", "tourney_viewer", "tourney_caster", "tourney_owner"];
const PRIVATE_TABLES = [
  "tourney.external_operation_secrets", "tourney.external_operations",
  "tourney.email_dispatches", "tourney.command_receipts",
  "tourney.tourney_player_auth_operations", "tourney.tourney_player_tokens",
  "tourney.tourney_session_entitlements", "tourney.tourney_bracket_team_members",
  "tourney.tourney_appeals", "tourney.tourney_payouts", "tourney.tourney_players",
  "tourney.tourney_bracket_audit", "tourney.identity_conflicts",
  "tourney.mirror_outbox", "tourney.mirror_checkpoints", "tourney.mirror_tombstones",
  "tourney.parity_runs", "tourney.shadow_observations", "tourney.cutover_gate_events",
  "tourney.cutover_control_operations",
  "tourney.account_snapshots",
  "migration.tourney_pre_cutover_snapshots", "migration.tourney_import_quarantine",
  "migration.tourney_import_preflights", "migration.tourney_sync_runs",
];
const PROTECTED_TABLES = [
  "auth.users", "auth.identities", "auth.sessions", "auth.refresh_tokens", "public.profiles",
  "accounts.principals", "accounts.principal_auth_users",
  "accounts.identity_links", "accounts.creator_profiles", "accounts.creator_fallback_authorities",
  "accounts.credential_migrations", "accounts.credential_operations",
  "commerce.bookings", "commerce.payment_records", "commerce.payment_events",
  "commerce.refunds", "commerce.coupons", "commerce.coupon_redemptions",
  "commerce.referral_ledger", "commerce.slot_claims", "commerce.slot_holds",
];
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const rowDigest = rows => digest(rows.map(stable).sort().join("\n"));
const validateLegacyAccounts = value => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const rows = Array.isArray(parsed) ? parsed : parsed?.accounts;
  if (!Array.isArray(rows)) throw new Error("Unknown tournament account snapshot format; refusing to remove data.");
  if (rows.some(row => !["owner", "caster", "viewer", "player"].includes(row.role))) {
    throw new Error("Unknown tournament role; review the private backup before proceeding.");
  }
  return rows;
};
const exists = async (sql, relation) => Boolean((await sql`select to_regclass(${relation}) relation`)[0].relation);
const rows = async (sql, relation) => (await sql`select to_jsonb(t) data from ${sql(relation)} t`).map(r => r.data);

export function resolveRetirementSanityToken(env = {}, apply = false) {
  const writeToken = String(env.SANITY_WRITE_TOKEN || "").trim();
  const token = apply ? writeToken : writeToken || String(env.SANITY_READ_TOKEN || "").trim();
  if (!token || token === "[SENSITIVE]") {
    throw new Error(apply
      ? "SANITY_WRITE_TOKEN is required for --apply before backing up or retiring records."
      : "Configure a real private Sanity token so the legacy staff copy can also be backed up.");
  }
  return token;
}

export async function protectedState(sql) {
  const state = {};
  for (const table of PROTECTED_TABLES) if (await exists(sql, table)) state[table] = rowDigest(await rows(sql, table));
  for (const [table, column, prefix] of [
    ["accounts.account_roles", "role", "tourney_%"],
    ["accounts.login_aliases", "alias_type", "tourney_%"],
    ["accounts.oauth_intents", "flow", "tourney"],
  ]) if (await exists(sql, table)) {
    const result = await sql`select to_jsonb(t) data from ${sql(table)} t where ${sql(column)} not like ${prefix}`;
    state[table] = rowDigest(result.map(r => r.data));
  }
  return state;
}

// Caller holds a transaction. Compare all protected rows, not only their counts.
// Principal/Auth records and creator login aliases are deliberately retained.
export async function applySqlRetirement(sql) {
  // Workers must finish before their receipts can be removed. These locks also
  // stop new leases from racing the backup and retirement transaction.
  await sql`lock table tourney.external_operations,tourney.tourney_player_auth_operations,accounts.credential_operations in share row exclusive mode`;
  const pending = (await sql`select
    (select count(*) from tourney.external_operations where status <> 'applied')::int external,
    (select count(*) from tourney.tourney_player_auth_operations where operation_status <> 'completed')::int player_auth,
    (select count(*) from accounts.credential_operations operation
      where operation.status in ('prepared','auth_applied') and exists (
        select 1 from accounts.tourney_accounts account
        where account.principal_id=operation.principal_id and account.role in ${sql(PEOPLE_ROLES)}
      ))::int credentials`)[0];
  if (Object.values(pending).some(count => count > 0)) {
    throw Object.assign(new Error(`Unfinished tournament operations must be resolved before retirement: ${JSON.stringify(pending)}`), {
      code: "TOURNEY_RETIREMENT_PENDING_OPERATIONS",
    });
  }
  const before = await protectedState(sql);
  await sql`select set_config('roo.tourney_command_id', ${'retirement:' + crypto.randomUUID()}, true)`;
  const accounts = await sql`select principal_id, user_id,accounts.principal_domain(principal_id) domain
    from accounts.tourney_accounts where role in ${sql(PEOPLE_ROLES)}`;
  const principalIds = accounts.map(a => a.principal_id).filter(Boolean);
  if (principalIds.length) {
    // Requires 20260914010000_preserve_retired_tourney_identity_domains.sql.
    // Existing cross-domain social links must never be reclassified as orphan
    // referral users or merged into another principal after profile deletion.
    await sql`insert into accounts.account_roles(user_id,principal_id,role,source_backend,backend_owner)
      select account.user_id,account.principal_id,'tourney_retired','supabase','supabase'
      from accounts.tourney_accounts account
      join accounts.principal_auth_users mapping on mapping.user_id=account.user_id and mapping.principal_id=account.principal_id
      where account.role in ${sql(PEOPLE_ROLES)}
      on conflict (user_id,role) do nothing`;
    await sql`delete from accounts.discord_role_assignments where principal_id in ${sql(principalIds)}`;
    await sql`delete from accounts.login_aliases where principal_id in ${sql(principalIds)} and alias_type like 'tourney_%'`;
    await sql`delete from accounts.account_roles where principal_id in ${sql(principalIds)} and role in ${sql(PEOPLE_ROLES)}`;
  }
  await sql`delete from accounts.oauth_intents where flow = 'tourney'`;
  await sql`delete from accounts.tourney_accounts where role in ${sql(PEOPLE_ROLES)}`;
  for (const table of PRIVATE_TABLES) if (await exists(sql, table)) await sql`delete from ${sql(table)}`;
  for (const account of accounts) {
    const [retired] = await sql`select accounts.principal_domain(${account.principal_id}) domain,
      exists(select 1 from accounts.account_roles where user_id=${account.user_id} and principal_id=${account.principal_id} and role='tourney_retired') marker`;
    if (!retired.marker || retired.domain !== account.domain) throw new Error("Historical account domain changed; retirement must roll back.");
  }
  // Preserve team names, match results, and event configuration. Broadcast rows
  // can contain staff camera URLs; audit actors are no longer needed publicly.
  if (await exists(sql, "tourney.tourney_bracket_entities")) await sql`delete from tourney.tourney_bracket_entities where entity_type='broadcast'`;
  for (const table of ["tourney.tourney_bracket_teams", "tourney.tourney_bracket_meta", "tourney.tourney_registration_config"]) {
    if (await exists(sql, table)) await sql`update ${sql(table)} set updated_by='retirement'`;
  }
  await sql`update tourney.cutover_metadata set writes_paused=true,generation=generation+1,updated_at=now(),updated_by='retirement' where id='tourney'`;
  const after = await protectedState(sql);
  if (stable(before) !== stable(after)) throw new Error("Protected Auth, creator, or commerce records changed; the transaction must roll back.");
  return { tournamentAccountsRemoved: accounts.length, protectedRecordsUnchanged: true };
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurableJson(file, value) {
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}

export async function completeRetirement({ commitSql, commitLegacy, recordPhase }) {
  let sqlCommitted = false;
  try {
    const result = await commitSql();
    sqlCommitted = true;
    await recordPhase("sql-completed");
    await commitLegacy();
    await recordPhase("completed");
    return result;
  } catch (error) {
    if (sqlCommitted) {
      throw new Error(`Native SQL retirement committed; legacy cleanup or completion receipt remains incomplete. Keep the verified backup and retry with a new backup directory. ${error.message}`, { cause: error });
    }
    throw error;
  }
}

async function writeVerifiedBackup(directory, snapshot) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
    throw new Error("Backups must be outside every Git repository.");
  } catch (error) { if (!Number.isInteger(error.status)) throw error; }
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "tournament-private-backup.json");
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const verified = await fs.readFile(file);
  if (digest(verified) !== digest(bytes)) throw new Error("Backup readback failed; no records may be deleted.");
  const manifest = { file, bytes: bytes.length, sha256: digest(bytes), verifiedReadback: true,
    counts: Object.fromEntries(Object.entries(snapshot.tables).map(([table, data]) => [table, data.length])) };
  await writeDurableJson(path.join(directory, "manifest.json"), manifest);
  await syncDirectory(path.dirname(directory));
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => args.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
  const apply = args.includes("--apply");
  const file = value("--env-file");
  const env = { ...process.env, ...(file ? dotenv.parse(await fs.readFile(file)) : {}) };
  const url = new URL(String(env.SUPABASE_DATABASE_URL || "").trim());
  if (!(url.hostname === `db.${PROJECT}.supabase.co` || (url.hostname.endsWith(".pooler.supabase.com") && decodeURIComponent(url.username) === `postgres.${PROJECT}`))) {
    throw new Error("The database does not identify the Roo Industries project.");
  }
  const sanityToken = resolveRetirementSanityToken(env, apply);
  if (env.SANITY_PROJECT_ID !== SANITY_PROJECT || env.SANITY_DATASET !== SANITY_DATASET) {
    throw new Error("The legacy store does not identify the Roo Industries production dataset.");
  }
  const sanity = createClient({ projectId: env.SANITY_PROJECT_ID, dataset: env.SANITY_DATASET, token: sanityToken, useCdn: false, apiVersion: "2026-01-01" });
  const legacyDocuments = await sanity.fetch('*[_type == "tourneyAuthStore"]');
  for (const document of legacyDocuments) validateLegacyAccounts(document.accountsJson);
  if (apply) {
    const origin = "https://www.rooindustries.com";
    const page = await fetch(origin + "/tourney", { redirect: "error", signal: AbortSignal.timeout(15000) });
    const retired = await fetch(origin + "/api/tourney/v1/bracket", { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!page.ok || !(await page.text()).includes('data-tourney-state="results"') || ![404, 410].includes(retired.status)) {
      throw new Error("Production has not retired tournament access. Deploy and verify the results page before applying cleanup.");
    }
  }
  const sql = postgres(url.href, { ssl: "require", prepare: false, max: 1, connect_timeout: 10 });
  const directory = value("--backup-dir") || path.join(os.homedir(), ".local/share/roo-tourney-retirement", new Date().toISOString().replace(/[:.]/g, "-"));
  try {
    const commitSql = () => sql.begin(apply ? "isolation level serializable" : "isolation level repeatable read read only", async tx => {
      if (apply) {
        await tx`set local lock_timeout='10s'`;
        await tx`select pg_advisory_xact_lock(hashtextextended('roo-tourney-retirement',0))`;
        // Stop concurrent tournament and shared-account changes while backing up.
        await tx`lock table accounts.tourney_accounts,accounts.account_roles,accounts.login_aliases,accounts.principals,accounts.creator_profiles,auth.users in share row exclusive mode`;
        await tx`lock table tourney.tourney_players,tourney.account_snapshots in share row exclusive mode`;
        await tx`lock table tourney.external_operations,tourney.tourney_player_auth_operations,accounts.credential_operations in share row exclusive mode`;
      }
      const snapshot = { version: 1, project: PROJECT, sanityProject: SANITY_PROJECT, sanityDataset: SANITY_DATASET, createdAt: new Date().toISOString(), legacyDocuments, tables: {}, protected: await protectedState(tx) };
      const inventory = await tx`select table_schema,table_name from information_schema.tables where table_type='BASE TABLE' and (table_schema='tourney' or (table_schema='migration' and table_name like 'tourney_%')) order by 1,2`;
      for (const { table_schema, table_name } of inventory) snapshot.tables[`${table_schema}.${table_name}`] = await rows(tx, `${table_schema}.${table_name}`);
      for (const table of ["accounts.tourney_accounts", "accounts.account_roles", "accounts.login_aliases", "accounts.discord_role_assignments", "accounts.oauth_intents"]) snapshot.tables[table] = await rows(tx, table);
      // The private source-document mirror is another potential staff-data copy.
      const sourceCopies = await tx`select to_jsonb(t) data from migration.source_documents t where payload->>'_type'='tourneyAuthStore'`;
      snapshot.tables["migration.source_documents:tourneyAuthStore"] = sourceCopies.map(r => r.data);
      const manifest = await writeVerifiedBackup(directory, snapshot);
      console.log(JSON.stringify({ mode: apply ? "apply" : "plan", backup: manifest, legacyStaffDocuments: legacyDocuments.length }, null, 2));
      if (!apply) return;
      const result = await applySqlRetirement(tx);
      await tx`delete from migration.source_documents where payload->>'_type'='tourneyAuthStore'`;
      console.log(JSON.stringify(result));
    });
    if (!apply) await commitSql();
    else await completeRetirement({
      commitSql,
      recordPhase: phase => writeDurableJson(path.join(directory, `${phase}.json`), { completedAt: new Date().toISOString(), project: PROJECT }),
      commitLegacy: async () => {
        let transaction = sanity.transaction();
        for (const document of legacyDocuments) transaction = transaction.patch(document._id, patch => patch.ifRevisionId(document._rev).set({ accountsJson: "[]" }));
        if (legacyDocuments.length) await transaction.commit();
      },
    });
  } finally { await sql.end(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
