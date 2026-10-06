import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
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
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const rowDigest = rows => digest(rows.sort().join("\n"));
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
export const readDatabaseRowJson = async (sql, relation) => (await sql`select to_jsonb(t)::text data from ${sql(relation)} t`).map(r => r.data);

export async function readRetirementAccountRows(sql) {
  const accounts = await sql`select principal_id,to_jsonb(t)::text data
    from accounts.tourney_accounts t where role in ${sql(PEOPLE_ROLES)}`;
  const principalIds = accounts.map(account => account.principal_id).filter(Boolean);
  const tables = {
    "accounts.tourney_accounts": accounts.map(account => account.data),
    "accounts.account_roles": [],
    "accounts.login_aliases": [],
    "accounts.discord_role_assignments": [],
    "accounts.oauth_intents": (await sql`select to_jsonb(t)::text data
      from accounts.oauth_intents t where flow='tourney'`).map(row => row.data),
    "accounts.reauth_grants": (await sql`select to_jsonb(t)::text data
      from accounts.reauth_grants t where exists (
        select 1 from accounts.oauth_intents intent where intent.id=t.bound_intent_id and intent.flow='tourney'
      )`).map(row => row.data),
  };
  if (principalIds.length) {
    tables["accounts.account_roles"] = (await sql`select to_jsonb(t)::text data
      from accounts.account_roles t where principal_id in ${sql(principalIds)}
      and role in ${sql(PEOPLE_ROLES)}`).map(row => row.data);
    tables["accounts.login_aliases"] = (await sql`select to_jsonb(t)::text data
      from accounts.login_aliases t where principal_id in ${sql(principalIds)}
      and alias_type like 'tourney_%'`).map(row => row.data);
    tables["accounts.discord_role_assignments"] = (await sql`select to_jsonb(t)::text data
      from accounts.discord_role_assignments t where principal_id in ${sql(principalIds)}`).map(row => row.data);
  }
  return tables;
}

export async function protectedState(sql) {
  const state = {};
  for (const table of PROTECTED_TABLES) if (await exists(sql, table)) state[table] = rowDigest(await readDatabaseRowJson(sql, table));
  for (const [table, column, prefix] of [
    ["accounts.account_roles", "role", "tourney_%"],
    ["accounts.login_aliases", "alias_type", "tourney_%"],
    ["accounts.oauth_intents", "flow", "tourney"],
  ]) if (await exists(sql, table)) {
    const result = await sql`select to_jsonb(t)::text data from ${sql(table)} t where ${sql(column)} not like ${prefix}`;
    state[table] = rowDigest(result.map(r => r.data));
  }
  return state;
}

export async function applySqlRetirement(sql) {
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
  if (await exists(sql, "tourney.tourney_bracket_entities")) await sql`delete from tourney.tourney_bracket_entities where entity_type='broadcast'`;
  for (const table of ["tourney.tourney_bracket_teams", "tourney.tourney_bracket_meta", "tourney.tourney_registration_config"]) {
    if (await exists(sql, table)) await sql`update ${sql(table)} set updated_by='retirement'`;
  }
  await sql`update tourney.cutover_metadata set writes_paused=true,generation=generation+1,updated_at=now(),updated_by='retirement' where id='tourney'`;
  const after = await protectedState(sql);
  if (!isDeepStrictEqual(before, after)) throw new Error("Protected Auth, creator, or commerce records changed; the transaction must roll back.");
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

export async function writeVerifiedBackup(directory, snapshot) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directory = await fs.realpath(directory);
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
    throw new Error("Backups must be outside every Git repository.");
  } catch (error) { if (!Number.isInteger(error.status)) throw error; }
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "tournament-private-backup.json");
  const { tables, ...metadata } = snapshot;
  const metadataJson = JSON.stringify(metadata).slice(1, -1);
  const tablesJson = Object.entries(tables)
    .map(([table, data]) => `${JSON.stringify(table)}:[${data.join(",")}]`).join(",");
  const bytes = Buffer.from(`{${metadataJson ? metadataJson + "," : ""}"tables":{${tablesJson}}}`);
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const verified = await fs.readFile(file);
  if (digest(verified) !== digest(bytes)) throw new Error("Backup readback failed; no records may be deleted.");
  const readback = JSON.parse(verified.toString("utf8"));
  for (const [table, data] of Object.entries(tables)) {
    const restored = readback.tables[table];
    if (!Array.isArray(restored) || restored.length !== data.length ||
      restored.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("Backup contains invalid database rows; no records may be deleted.");
    }
  }
  const manifest = { file, bytes: bytes.length, sha256: digest(bytes), verifiedReadback: true,
    counts: Object.fromEntries(Object.entries(tables).map(([table, data]) => [table, data.length])) };
  await writeDurableJson(path.join(directory, "manifest.json"), manifest);
  await syncDirectory(path.dirname(directory));
  return manifest;
}

