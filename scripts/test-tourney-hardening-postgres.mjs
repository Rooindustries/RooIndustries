#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import postgres from "postgres";
import { assertLegacyConnectionTarget, LEGACY_TABLES } from "./tourney-cutover.mjs";
import {
  buildPostgresConnectionEnv,
  buildPostgresSessionArgs,
} from "./lib/postgres-connection-env.mjs";
import migrationTargetSafety from "../src/server/supabase/migrationTargetSafety.cjs";
import {
  checkTourneyManualFailoverReadiness,
  completeRecoveredTourneyCommandReceipts,
  executeTourneyCommand,
  reconcileTourneyMirror,
  runTourneyParity,
} from "../src/server/tourney/store.js";
import { TOURNEY_MIRROR_CONTRACT } from "../src/server/tourney/mirrorContract.js";
import { getTourneySql } from "../src/server/tourney/sqlClient.js";
import {
  enqueueTourneyExternalOperation,
  claimTourneyExternalOperations,
  rearmTourneyExternalOperation,
  reconcileTourneyExternalOperations,
} from "../src/server/tourney/externalOperations.js";
import { appendTourneyAccountPrincipalSnapshot } from "../src/server/tourney/accountStore.js";
import {
  getTourneyDiscordStatusForPlayer,
  projectTourneyDiscordOAuthDesiredState,
  recordTourneyDiscordDesiredState,
  resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure,
} from "../src/server/tourney/discordDesiredState.js";
import { upsertTourneyPayoutWithTransition } from "../src/server/tourney/appealPayoutStore.js";
import {
  enqueueTourneyEmailDispatch,
  reconcileTourneyEmailDispatches,
} from "../src/server/tourney/emailDispatch.js";
import { claimSupabaseRegistrationDecision } from "../src/server/tourney/supabaseAuthOperations.js";
import { seedTourneyDiscordDesiredStateV4 } from "../src/server/tourney/activation.js";
import {
  applyRegistrationDecision,
  getTourneyRoleCapacitySnapshot,
  updateTourneyPlayerApprovedRole,
  updateTourneyPlayerDetails,
  updateTourneyRegistrationConfig,
} from "../src/server/tourney/playerStore.js";
import {
  applyLiveDriftSourceRepair,
  assertConnectedDatabaseIdentity,
  assertLiveDriftLegacyDatabaseGate,
  EXPECTED_LIVE_DRIFT,
} from "./tourney-live-drift-repair.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const configuredPgBin = String(process.env.PG_BIN || "").trim();
const pgConfig = spawnSync(process.env.PG_CONFIG || "pg_config", ["--bindir"], {
  encoding: "utf8",
});
const pgBin = configuredPgBin || (pgConfig.status === 0
  ? pgConfig.stdout.trim()
  : "/opt/homebrew/bin");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-tourney-v4-"));
const dataDir = path.join(tempRoot, "pgdata");
const socketDir = path.join(tempRoot, "socket");
const port = 55432 + Math.floor(Math.random() * 900);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
};

const writeTemp = (name, contents) => {
  const file = path.join(tempRoot, name);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
};

const psql = (database, ...files) => {
  const args = ["-h", "127.0.0.1", "-p", String(port), "-d", database, "-v", "ON_ERROR_STOP=1"];
  for (const file of files) args.push("-f", file);
  run(path.join(pgBin, "psql"), args);
};

const psqlFails = (database, file) => spawnSync(path.join(pgBin, "psql"), [
  "-h", "127.0.0.1", "-p", String(port), "-d", database,
  "-v", "ON_ERROR_STOP=1", "-f", file,
], { cwd: root, encoding: "utf8", env: process.env });

const readFallbackSnapshot = async (sql) => {
  const snapshot = {};
  for (const [logicalTable, contract] of Object.entries(TOURNEY_MIRROR_CONTRACT)) {
    const [result] = await sql`
      select coalesce(
        jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text),
        '[]'::jsonb
      ) rows
      from ${sql(contract.relations.legacy)} source_row
    `;
    snapshot[logicalTable] = result.rows;
  }
  return snapshot;
};

const SNAPSHOT_TABLES = Object.freeze([
  "tourney_players", "tourney_player_tokens", "tourney_registration_config",
  "tourney_bracket_teams", "tourney_bracket_team_members", "tourney_bracket_meta",
  "tourney_bracket_entities", "tourney_bracket_counters", "tourney_bracket_audit",
  "tourney_bracket_lock", "tourney_appeals", "tourney_payouts",
]);

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};
const snapshotHash = (snapshot) => crypto
  .createHash("sha256")
  .update(stableJson(snapshot))
  .digest("hex");

const commonBootstrap = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create schema if not exists accounts;
create schema if not exists migration;
create schema if not exists extensions;
create schema if not exists vault;
create extension if not exists pgcrypto with schema extensions;
create table vault.secrets(
  id uuid primary key,
  secret text not null,
  name text,
  description text
);
create or replace function vault.create_secret(
  new_secret text,
  new_name text default null,
  new_description text default null
)
returns uuid
language plpgsql
security definer
set search_path=''
as $$
declare v_id uuid:=extensions.gen_random_uuid();
begin
  insert into vault.secrets(id,secret,name,description)
  values(v_id,new_secret,new_name,new_description);
  return v_id;
end
$$;
create view vault.decrypted_secrets as
select id,secret as decrypted_secret from vault.secrets;
create table auth.users(id uuid primary key, email text);
create table auth.identities(
  id uuid primary key,
  user_id uuid not null references auth.users(id)
);
create table accounts.principals(id uuid primary key default gen_random_uuid(), status text not null default 'active');
create table accounts.login_aliases(
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references accounts.principals(id),
  alias_type text not null,
  normalized_value text not null
);
create table accounts.principal_auth_users(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null references accounts.principals(id),
  is_primary boolean not null default true,
  source text not null default 'fixture'
);
create table accounts.oauth_intents(
  id uuid primary key,
  status text not null,
  expires_at timestamptz not null,
  provider text not null,
  flow text not null,
  action text not null,
  target_user_id uuid references auth.users(id),
  claimed_user_id uuid references auth.users(id),
  principal_id uuid references accounts.principals(id)
);
create table accounts.tourney_accounts(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null unique references accounts.principals(id),
  username text not null unique,
  role text not null,
  active boolean not null default true,
  lifecycle_status text not null default 'approved',
  credential_version text not null default '1',
  legacy_sanity_id text unique,
  source_hash text,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table accounts.identity_links(
  id uuid not null unique default gen_random_uuid(),
  principal_id uuid not null references accounts.principals(id),
  provider text not null,
  provider_subject text not null,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  primary key(principal_id,provider)
);
create table accounts.discord_role_assignments(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null unique references accounts.principals(id),
  discord_user_id text not null unique,
  previous_discord_user_id text,
  guild_id text not null,
  tourney_role text,
  desired_role text not null default 'none' check(desired_role in ('none','participant','host')),
  applied_role text not null default 'none' check(applied_role in ('none','participant','host')),
  generation bigint not null default 1,
  applied_generation bigint not null default 0,
  status text not null default 'pending' check(status in ('pending','processing','applied','retry','blocked')),
  attempt_count integer not null default 0,
  last_error text,
  joined_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

const extractSupabaseBusinessBase = () => {
  const source = fs.readFileSync(
    path.join(root, "supabase/migrations/20260710223408_create_tourney_shadow_foundation.sql"),
    "utf8"
  );
  const end = source.indexOf("\ndo $$", source.indexOf("create table migration.tourney_sync_runs"));
  assert(end > 0, "Supabase Tourney base marker was not found");
  return source.slice(0, end);
};

const extractSupabaseControlBase = () => {
  const source = fs.readFileSync(
    path.join(root, "supabase/migrations/20260712180401_close_tourney_cutover_gaps.sql"),
    "utf8"
  );
  const end = source.indexOf("create or replace function public.roo_capture_tourney_pre_cutover_snapshot");
  assert(end > 0, "Supabase Tourney control marker was not found");
  return source.slice(0, end);
};

const authOperations = `
create table tourney.schema_metadata(
  schema_name text primary key,
  schema_version integer not null,
  updated_at timestamptz not null default now()
);
insert into tourney.schema_metadata values('tourney',3,now());
create table tourney.tourney_player_auth_operations(
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  player_id text not null references tourney.tourney_players(id),
  token_id text,
  operation_kind text not null,
  desired_status text,
  desired_role text,
  desired_registration_pool text,
  desired_credential_version text,
  password_hash text,
  operation_payload jsonb not null default '{}'::jsonb,
  operation_status text not null default 'pending',
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create or replace function tourney.upsert_snapshot_rows(p_table_name text,p_rows jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer:=0; v_table regclass; v_conflict text; v_updates text;
begin
  v_table:=format('tourney.%I',p_table_name)::regclass;
  select string_agg(format('%I',a.attname),', ' order by k.ordinality)
  into v_conflict from pg_index i
  join lateral unnest(i.indkey) with ordinality k(attnum,ordinality) on true
  join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
  where i.indrelid=v_table and i.indisprimary;
  select string_agg(format('%I=excluded.%I',a.attname,a.attname),', ' order by a.attnum)
  into v_updates from pg_attribute a where a.attrelid=v_table and a.attnum>0
    and not a.attisdropped and not (a.attname=any(string_to_array(v_conflict,', ')));
  if jsonb_array_length(coalesce(p_rows,'[]'::jsonb))=0 then return 0; end if;
  execute format('insert into %s select * from jsonb_populate_recordset(null::%s,$1) on conflict (%s) do update set %s',v_table,v_table,v_conflict,v_updates) using p_rows;
  get diagnostics v_count=row_count; return v_count;
end $$;
`;

const legacyBusinessBase = () => {
  const source = extractSupabaseBusinessBase();
  const start = source.indexOf("create table tourney.tourney_players");
  const end = source.indexOf("create table migration.tourney_sync_runs");
  assert(start >= 0 && end > start, "Legacy business base markers were not found");
  return source.slice(start, end).replaceAll("tourney.", "");
};

const seedSql = `
insert into tourney.tourney_registration_config(id,team_count) values('legacy-series-2026',8);
insert into tourney.tourney_bracket_meta(id,status,published) values('legacy-series-2026','draft',false);
`;

const supabaseActivationControls = `
update tourney.cutover_metadata set
  primary_backend='supabase',generation=1,writes_paused=true,fallback_read_only=false
where id='tourney';
`;
const legacyActivationControls = `
update tourney_cutover_metadata set
  primary_backend='supabase',generation=1,writes_paused=true,fallback_read_only=false
where id='tourney';
`;

const assertSql = async (sql, query, message) => {
  const rows = await sql.unsafe(query);
  assert.equal(rows[0]?.ok, true, message);
};

const drainTourneyMirror = async ({ env, maxPasses = 10 } = {}) => {
  let failed = 0;
  const sql = await getTourneySql(env);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = await reconcileTourneyMirror({ env, limit: 250 });
    failed += result.failed;
    const [backlog] = await sql`
      select count(*)::integer pending
      from tourney.mirror_outbox
      where status in ('pending','retry','processing')
    `;
    if (Number(backlog?.pending || 0) === 0) return { failed };
    if (result.applied + result.failed === 0) {
      throw new Error("Tourney mirror fixture stalled with dependency-blocked work.");
    }
  }
  throw new Error("Tourney mirror fixture did not drain within the pass limit.");
};

let started = false;
let summary = null;
try {
  const version = run(path.join(pgBin, "postgres"), ["--version"]);
  assert.match(version, /PostgreSQL\) 17\./, "PostgreSQL 17 is required");
  fs.mkdirSync(socketDir, { mode: 0o700 });
  run(path.join(pgBin, "initdb"), ["-D", dataDir, "--auth=trust", "--no-locale"]);
  run(path.join(pgBin, "pg_ctl"), [
    "-D", dataDir, "-o", `-p ${port} -h 127.0.0.1 -k ${socketDir}`, "-w", "start",
  ], { stdio: "ignore" });
  started = true;
  for (const database of [
    "supabase_unsafe", "legacy_unsafe", "supabase_fixture", "legacy_fixture",
  ]) {
    run(path.join(pgBin, "createdb"), [
      "-h", "127.0.0.1", "-p", String(port), database,
    ]);
  }

  const databaseUser = os.userInfo().username;
  const quotedDatabaseUser = databaseUser.replaceAll('"', '""');
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c",
    `alter role "${quotedDatabaseUser}" in database legacy_fixture set search_path=attacker`,
  ]);
  const connectionProbeEnv = buildPostgresConnectionEnv(
    `postgresql://${encodeURIComponent(databaseUser)}:fixture@127.0.0.1:${port}/legacy_fixture?sslmode=disable&channel_binding=disable`,
    {
      PATH: process.env.PATH,
      PGOPTIONS: "-csearch_path=attacker -cstatement_timeout=0 -clock_timeout=0",
      TOURNEY_DATABASE_URL: "must-not-propagate",
    }
  );
  const connectionProbeArgs = buildPostgresSessionArgs([
    "-Atq", "-v", "ON_ERROR_STOP=1", "-c",
    "select current_database()='legacy_fixture' and current_user=current_setting('session_authorization') and current_schemas(false)=array['pg_catalog','public']::name[] and current_setting('statement_timeout')='2min' and current_setting('lock_timeout')='5s'",
  ]);
  const connectionProbe = spawnSync(path.join(pgBin, "psql"), connectionProbeArgs, {
    cwd: root,
    encoding: "utf8",
    env: connectionProbeEnv,
  });
  assert.equal(connectionProbe.status, 0, connectionProbe.stderr);
  assert.equal(connectionProbe.stdout.trim(), "t", "libpq session controls were not pinned");
  assert.equal(connectionProbeArgs.includes("legacy_fixture"), false);
  assert.equal("TOURNEY_DATABASE_URL" in connectionProbeEnv, false);
  const legacyProbeUrl = `postgresql://${encodeURIComponent(databaseUser)}:fixture@127.0.0.1:${port}/legacy_fixture?sslmode=disable&channel_binding=disable`;
  const previousLegacyUrl = process.env.TOURNEY_DATABASE_URL;
  const previousLegacyFingerprint = process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT;
  const previousPath = process.env.PATH;
  try {
    process.env.TOURNEY_DATABASE_URL = legacyProbeUrl;
    process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT =
      migrationTargetSafety.computeTourneyCutoverLegacyTargetFingerprint(legacyProbeUrl);
    process.env.PATH = `${pgBin}${path.delimiter}${previousPath}`;
    assert.equal(
      await assertLegacyConnectionTarget(),
      process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT,
      "central legacy connection target gate rejected the pinned database"
    );
    process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT = "0".repeat(64);
    await assert.rejects(
      assertLegacyConnectionTarget(),
      { code: "TOURNEY_CUTOVER_LEGACY_TARGET_MISMATCH" }
    );
  } finally {
    if (previousLegacyUrl === undefined) delete process.env.TOURNEY_DATABASE_URL;
    else process.env.TOURNEY_DATABASE_URL = previousLegacyUrl;
    if (previousLegacyFingerprint === undefined) {
      delete process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT;
    } else {
      process.env.TOURNEY_CUTOVER_EXPECTED_LEGACY_FINGERPRINT = previousLegacyFingerprint;
    }
    process.env.PATH = previousPath;
  }
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-c",
    `alter role "${quotedDatabaseUser}" in database legacy_fixture reset search_path`,
  ]);

  const supabaseBootstrap = writeTemp(
    "supabase-bootstrap.sql",
    commonBootstrap + extractSupabaseBusinessBase() + extractSupabaseControlBase() + authOperations + seedSql
  );
  const legacyBootstrap = writeTemp("legacy-bootstrap.sql", legacyBusinessBase());
  const supabaseControls = writeTemp("supabase-activation-controls.sql", supabaseActivationControls);
  const legacyControls = writeTemp("legacy-activation-controls.sql", legacyActivationControls);
  const legacyUnpaused = writeTemp(
    "legacy-unpaused-controls.sql",
    "update tourney_cutover_metadata set writes_paused=false where id='tourney';\n"
  );
  const supabaseActivation = path.join(
    root,
    "supabase/migrations/20260712224034_activate_tourney_schema_v4.sql"
  );
  const supabaseHardening = path.join(
    root,
    "supabase/migrations/20260714000000_harden_tourney_external_authority.sql"
  );
  const supabaseBaselineRestore = path.join(
    root,
    "supabase/migrations/20260715010000_restore_tourney_shadow_latency_baselines.sql"
  );
  const supabaseRepair = path.join(
    root,
    "supabase/migrations/20260714010000_repair_tourney_cutover_safety.sql"
  );
  const supabaseCutoverOperationMarkers = path.join(
    root,
    "supabase/migrations/20260715000000_add_tourney_cutover_operation_markers.sql"
  );
  const supabaseSnapshotRpcRepair = path.join(
    root,
    "supabase/migrations/20260715020000_repair_tourney_hardening_snapshot_rpc.sql"
  );
  const supabaseSnapshotRpcTimeout = path.join(
    root,
    "supabase/migrations/20260715050000_set_tourney_snapshot_rpc_timeout.sql"
  );
  const supabaseCompactSnapshotPayload = path.join(
    root,
    "supabase/migrations/20260715070000_return_compact_tourney_snapshot_payload.sql"
  );
  const supabaseBaselineRecovery = path.join(
    root,
    "supabase/migrations/20260715030000_allow_paused_tourney_baseline_recovery.sql"
  );
  const supabaseBaselineClockReset = path.join(
    root,
    "supabase/migrations/20260715040000_reset_tourney_hardening_clock_for_baseline_recovery.sql"
  );
  const supabaseTriggerBindingRepair = path.join(
    root,
    "supabase/migrations/20260715060000_repair_tourney_mirror_trigger_bindings.sql"
  );
  const legacyActivation = path.join(root, "scripts/tourney-schema-v4-activate-legacy.sql");
  const legacyRepair = path.join(root, "scripts/tourney-schema-v4-repair-legacy.sql");
  const legacyTriggerBindingRepair = path.join(
    root,
    "scripts/tourney-schema-v4-trigger-binding-repair-legacy.sql"
  );
  const activateSupabaseV4 = writeTemp(
    "activate-supabase-v4.sql",
    "select public.roo_activate_tourney_schema_v4('postgres17-fixture');\n"
  );
  const removeSupabaseActivationRpc = writeTemp(
    "remove-supabase-activation-rpc.sql",
    "drop function public.roo_activate_tourney_schema_v4(text);\n"
  );
  const captureLatencyBaseline = writeTemp(
    "capture-latency-baseline.sql",
    `insert into tourney.shadow_observations(
      route,shape_match,value_match,ordering_match,error_match,
      primary_latency_ms,shadow_latency_ms,primary_status,shadow_status,observed_at
    )
    select route,true,true,true,true,100,100,200,200,
      now()-(sample||' seconds')::interval
    from unnest(array[
      'public_roster','public_bracket','admin_players','appeals','payouts'
    ]) route cross join generate_series(1,30) sample;
    select public.roo_capture_tourney_shadow_latency_baseline('postgres17-fixture');\n`
  );
  const supabaseOldWriter = writeTemp("supabase-old-writer.sql", `
insert into tourney.command_receipts(command_id,purpose,request_hash)
values('old-writer-supabase','identity:old-writer',repeat('a',64));
insert into tourney.external_operations(
  operation_key,command_id,operation_kind,entity_type,entity_id,
  desired_state,desired_state_hash
) values(
  'old-writer-supabase:auth','old-writer-supabase','supabase_player_auth',
  'player','old-writer-player','{}'::jsonb,repeat('b',64)
);
`);
  const legacyOldWriter = writeTemp("legacy-old-writer.sql", `
insert into tourney_command_receipts(command_id,purpose,request_hash)
values('old-writer-legacy','identity:old-writer',repeat('a',64));
insert into tourney_external_operations(
  operation_key,command_id,operation_kind,entity_type,entity_id,
  desired_state,desired_state_hash
) values(
  'old-writer-legacy:auth','old-writer-legacy','supabase_player_auth',
  'player','old-writer-player','{}'::jsonb,repeat('b',64)
);
`);
  const supabasePostInstallOldWriter = writeTemp(
    "supabase-post-install-old-writer.sql",
    `insert into tourney.command_receipts(command_id,purpose,request_hash)
     values('old-writer-supabase-post-install','identity:old-writer',repeat('c',64));
     insert into tourney.external_operations(
       operation_key,command_id,operation_kind,entity_type,entity_id,
       desired_state,desired_state_hash
     ) values(
       'old-writer-supabase-post-install:auth','old-writer-supabase-post-install',
       'supabase_player_auth','player','old-writer-player-post-install',
       '{}'::jsonb,repeat('d',64)
     );`
  );
  const supabaseMissingBaselineDrift = writeTemp(
    "supabase-missing-baseline-drift.sql",
    "drop table tourney.shadow_latency_baselines;\n"
  );
  const legacyMissingSerializationDrift = writeTemp(
    "legacy-missing-serialization-drift.sql",
    "alter table if exists tourney_external_operations drop column if exists serialization_key cascade;\n"
  );
  const supabaseTriggerBindingDrift = writeTemp(
    "supabase-trigger-binding-drift.sql",
    `create or replace function tourney.capture_mirror_event_fail_open_fixture()
     returns trigger language plpgsql security definer set search_path=''
     as $$ begin
       if tg_op='DELETE' then return old; end if;
       return new;
     end $$;
     create or replace function tourney.capture_mirror_event_v4()
     returns trigger language plpgsql security definer set search_path=''
     as $$ begin
       if tg_op='DELETE' then return old; end if;
       return new;
     end $$;
     do $$
     declare v_contract record;
     begin
       for v_contract in
         select supabase_relation from tourney.mirror_contracts where enabled
       loop
         execute pg_catalog.format(
           'drop trigger if exists capture_tourney_mirror_event on %s',
           v_contract.supabase_relation::pg_catalog.regclass
         );
         execute pg_catalog.format(
           'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function tourney.capture_mirror_event_fail_open_fixture()',
           v_contract.supabase_relation::pg_catalog.regclass
         );
       end loop;
     end $$;`
  );
  const legacyTriggerBindingDrift = writeTemp(
    "legacy-trigger-binding-drift.sql",
    `create or replace function public.capture_tourney_mirror_event_fail_open_fixture()
     returns trigger language plpgsql set search_path=''
     as $$ begin
       if tg_op='DELETE' then return old; end if;
       return new;
     end $$;
     create or replace function public.capture_tourney_mirror_event()
     returns trigger language plpgsql set search_path=''
     as $$ begin
       if tg_op='DELETE' then return old; end if;
       return new;
     end $$;
     do $$
     declare v_contract record;
     begin
       for v_contract in
         select legacy_relation from public.tourney_mirror_contracts where enabled
       loop
         execute pg_catalog.format(
           'drop trigger if exists capture_tourney_mirror_event on %s',
           v_contract.legacy_relation::pg_catalog.regclass
         );
         execute pg_catalog.format(
           'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function public.capture_tourney_mirror_event_fail_open_fixture()',
           v_contract.legacy_relation::pg_catalog.regclass
         );
       end loop;
     end $$;`
  );

  psql(
    "supabase_unsafe",
    supabaseBootstrap,
    path.join(root, "supabase/migrations/20260712224033_expand_tourney_schema_v4.sql")
  );
  psql("supabase_unsafe", supabaseOldWriter);
  psql(
    "supabase_unsafe",
    supabaseActivation,
    supabaseHardening,
    supabaseMissingBaselineDrift,
    supabaseBaselineRestore,
    supabaseRepair,
    supabaseCutoverOperationMarkers,
    supabaseSnapshotRpcRepair,
    supabaseSnapshotRpcTimeout,
    supabaseCompactSnapshotPayload,
    supabaseBaselineRecovery,
    supabaseTriggerBindingRepair
  );
  psql("supabase_unsafe", supabasePostInstallOldWriter);
  const unsafeSupabase = postgres(
    `postgres://127.0.0.1:${port}/supabase_unsafe`,
    { max: 1, prepare: false }
  );
  await assertSql(
    unsafeSupabase,
    `select to_regclass('tourney.cutover_control_operations') is not null
       and to_regclass('tourney.shadow_latency_baselines') is not null
       and (select count(*) = 2 from information_schema.columns
         where table_schema = 'tourney' and table_name = 'cutover_metadata'
           and column_name in (
             'last_pause_operation_id','last_resume_operation_id'
           ))
       and to_regprocedure(
         'public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb)'
       ) is null
       and to_regprocedure(
         'public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)'
       ) is not null
       and to_regprocedure(
         'tourney.capture_tourney_hardening_snapshot_payload_v4(jsonb,jsonb,text)'
       ) is not null
       and (
         select 'statement_timeout=120s'=any(coalesce(proconfig,array[]::text[]))
         from pg_catalog.pg_proc
         where oid='public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)'::regprocedure
       )
       and not has_function_privilege(
         'anon',
         'public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)',
         'execute'
       )
       and not has_function_privilege(
         'authenticated',
         'public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)',
         'execute'
       )
       and has_function_privilege(
         'service_role',
         'public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)',
         'execute'
       )
       and not has_function_privilege(
         'service_role',
         'tourney.capture_tourney_hardening_snapshot_payload_v4(jsonb,jsonb,text)',
         'execute'
       ) ok`,
    "Supabase cutover operation ledger was unavailable before activation"
  );
  await assert.rejects(
    unsafeSupabase`
      select public.roo_capture_tourney_hardening_snapshot(
        '{}'::jsonb,'{"_id":"tourneyAuthStore"}'::jsonb,null::text
      )
    `,
    (error) => error.code === "22023",
    "Supabase snapshot RPC accepted missing exact legacy text"
  );
  await assert.rejects(
    unsafeSupabase`
      select public.roo_capture_tourney_hardening_snapshot(
        '{}'::jsonb,'{"_id":"tourneyAuthStore"}'::jsonb,'{}'::text
      )
    `,
    (error) => error.code === "55000",
    "Supabase snapshot RPC accepted unpaused controls"
  );
  await unsafeSupabase.begin(async (sql) => {
    await sql`
      update tourney.cutover_metadata set writes_paused = true where id = 'tourney'
    `;
    await sql`
      insert into tourney.cutover_control_operations(
        operation_kind,operation_id,primary_backend,generation,
        target_writes_paused,actor
      ) values(
        'pause','preactivation:pause-0001','legacy',0,true,
        'schema-v4-pause:preactivation:pause-0001'
      )
    `;
  });
  const unsafeSupabaseActivation = psqlFails("supabase_unsafe", activateSupabaseV4);
  assert.notEqual(unsafeSupabaseActivation.status, 0, "unsafe Supabase activation succeeded");
  await assertSql(
    unsafeSupabase,
    `select
      to_regclass('tourney.tourney_account_snapshots_supersedes_v4_idx') is not null
      and (select schema_version from tourney.schema_metadata where schema_name='tourney')=3
      and not (select hardened_active from tourney.cutover_metadata where id='tourney') ok`,
    "additive Supabase install activated schema v4"
  );
  await assertSql(
    unsafeSupabase,
    "select serialization_key='supabase_player_auth:player:old-writer-player' ok from tourney.external_operations where operation_key='old-writer-supabase:auth'",
    "Supabase expand was not compatible with an old external-operation writer"
  );
  await assertSql(
    unsafeSupabase,
    "select serialization_key='supabase_player_auth:player:old-writer-player-post-install' ok from tourney.external_operations where operation_key='old-writer-supabase-post-install:auth'",
    "Supabase install replaced the pre-activation mirror trigger"
  );
  psql("supabase_unsafe", supabaseControls, captureLatencyBaseline, activateSupabaseV4);
  await assertSql(
    unsafeSupabase,
    `select
      (select schema_version from tourney.schema_metadata where schema_name='tourney')=4
      and (select hardened_active from tourney.cutover_metadata where id='tourney')
      and (tourney.mirror_trigger_binding_status_v4()->>'ready')::boolean
      and (tourney.mirror_trigger_binding_status_v4()->>'correctly_bound')::integer=17
      and to_regprocedure(
        'public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)'
      ) is not null
      and public.roo_activate_tourney_schema_v4(
        'postgres17-present-rpc-validation'
      )->>'compatibility_mode'='trigger-binding-live-schema-compat-v1' ok`,
    "explicit Supabase activation did not activate schema v4"
  );
  const [supabaseTriggerBeforeUnsafeRepair] = await unsafeSupabase`
    select pg_get_functiondef(
      'tourney.capture_mirror_event_v4()'::regprocedure
    ) definition
  `;
  await unsafeSupabase`
    update tourney.cutover_metadata set writes_paused=false where id='tourney'
  `;
  const unsafeActiveSupabaseRepair = psqlFails(
    "supabase_unsafe",
    supabaseTriggerBindingRepair
  );
  assert.notEqual(
    unsafeActiveSupabaseRepair.status,
    0,
    "unpaused active Supabase trigger-binding repair succeeded"
  );
  const [supabaseTriggerAfterUnsafeRepair] = await unsafeSupabase`
    select pg_get_functiondef(
      'tourney.capture_mirror_event_v4()'::regprocedure
    ) definition
  `;
  assert.equal(
    supabaseTriggerAfterUnsafeRepair.definition,
    supabaseTriggerBeforeUnsafeRepair.definition,
    "unsafe active Supabase repair replaced the trigger function"
  );
  await unsafeSupabase`
    update tourney.cutover_metadata set writes_paused=true where id='tourney'
  `;
  await assert.rejects(
    unsafeSupabase`
      select public.roo_capture_tourney_hardening_snapshot(
        null::jsonb,'{"_id":"tourneyAuthStore"}'::jsonb,'[]'::text
      )
    `,
    (error) => error.code === "22023" &&
      error.message === "Legacy Tourney snapshot is incomplete or malformed",
    "Supabase snapshot RPC iterated a non-object legacy snapshot"
  );
  const legacySnapshot = Object.fromEntries(
    LEGACY_TABLES.map((relation) => [relation, []])
  );
  legacySnapshot.tourney_cutover_metadata = [{
    id: "tourney",
    primary_backend: "supabase",
    generation: 1,
    writes_paused: true,
    fallback_read_only: false,
  }];
  const legacySnapshotText = JSON.stringify(legacySnapshot);
  const sanitySnapshot = { _id: "tourneyAuthStore", version: 1 };
  const [snapshotRow] = await unsafeSupabase`
    select public.roo_capture_tourney_hardening_snapshot(
      ${unsafeSupabase.json(legacySnapshot)},
      ${unsafeSupabase.json(sanitySnapshot)},
      ${legacySnapshotText}::text
    ) proof
  `;
  const snapshotProof = snapshotRow.proof;
  assert.equal("payload" in snapshotProof, false, "snapshot RPC returned duplicate payload JSON");
  assert.equal(snapshotProof.hosted_roundtrip_verified, true);
  assert.equal(
    crypto.createHash("sha256").update(snapshotProof.payload_text).digest("hex"),
    snapshotProof.payload_sha256,
    "snapshot RPC payload text hash did not match"
  );
  const parsedSnapshotPayload = JSON.parse(snapshotProof.payload_text);
  assert.deepEqual(parsedSnapshotPayload.legacy, legacySnapshot);
  assert.deepEqual(parsedSnapshotPayload.sanity_account, sanitySnapshot);
  for (const [relation, count] of Object.entries(snapshotProof.table_counts)) {
    assert.equal(Array.isArray(parsedSnapshotPayload[relation]), true);
    assert.equal(parsedSnapshotPayload[relation].length, Number(count));
  }
  await unsafeSupabase.begin(async (sql) => {
    await sql`
      update tourney.cutover_metadata set
        natural_mutation_verified_at=now()-interval '2 minutes',
        first_zero_drift_at=now()-interval '1 minute'
      where id='tourney'
    `;
    await sql`
      insert into tourney.cutover_gate_events(
        event_kind,generation,actor,evidence,created_at
      ) values(
        'natural_mirror_verified',1,'postgres17-existing-window',
        '{"table":"tourney_players"}'::jsonb,now()-interval '2 minutes'
      ),(
        'clock_reset',1,'postgres17-existing-window',
        '{"reason":"discord_overdue"}'::jsonb,now()-interval '1 minute'
      )
    `;
    await sql`truncate table tourney.shadow_latency_baselines`;
  });
  const unsafeClockReset = psqlFails(
    "supabase_unsafe",
    supabaseBaselineClockReset
  );
  assert.notEqual(
    unsafeClockReset.status,
    0,
    "unsafe Supabase baseline clock reset succeeded"
  );
  await unsafeSupabase`
    update tourney.cutover_metadata set first_zero_drift_at=null
    where id='tourney'
  `;
  await assert.rejects(
    unsafeSupabase`
      select public.roo_capture_tourney_shadow_latency_baseline(
        'postgres17-pre-reset-recovery'
      )
    `,
    (error) => error.code === "55000",
    "Supabase baseline recovery accepted the stale mutation window"
  );
  psql("supabase_unsafe", supabaseBaselineClockReset);
  await assertSql(
    unsafeSupabase,
    `select natural_mutation_verified_at is null
       and clean_since is null
       and first_zero_drift_at is null
       and second_zero_drift_at is null
       and clock_last_reset_reason='fresh_hardening_window'
       and (select count(*)=1 from tourney.cutover_gate_events
         where event_kind='clock_reset'
           and evidence @> '{"baseline_recovery_clock_reset":true}'::jsonb) ok
     from tourney.cutover_metadata where id='tourney'`,
    "Supabase baseline clock recovery was not reset and audited"
  );
  psql("supabase_unsafe", captureLatencyBaseline);
  await assertSql(
    unsafeSupabase,
    `select count(*)=5
       and (select hardened_active from tourney.cutover_metadata where id='tourney') ok
     from tourney.shadow_latency_baselines`,
    "paused active Supabase baseline recovery failed"
  );
  await assertSql(
    unsafeSupabase,
    `select count(*)=1 ok from tourney.cutover_gate_events
     where event_kind='hardened_activated'
       and evidence @> '{"baseline_recovery":true}'::jsonb`,
    "Supabase baseline recovery marker was not retained"
  );
  await unsafeSupabase`truncate table tourney.shadow_latency_baselines`;
  await assert.rejects(
    unsafeSupabase`
      select public.roo_capture_tourney_shadow_latency_baseline(
        'postgres17-recovery-repeat'
      )
    `,
    (error) => error.code === "55000",
    "Supabase baseline recovery overwrote an existing active baseline set"
  );
  await unsafeSupabase.end({ timeout: 5 });

  psql(
    "legacy_unsafe",
    legacyBootstrap,
    path.join(root, "scripts/tourney-cutover-legacy.sql"),
    path.join(root, "scripts/tourney-schema-v4-expand-legacy.sql"),
    legacyMissingSerializationDrift,
    path.join(root, "scripts/tourney-schema-v4-expand-legacy.sql")
  );
  psql("legacy_unsafe", legacyOldWriter);
  const unsafeLegacy = postgres(
    `postgres://127.0.0.1:${port}/legacy_unsafe`,
    { max: 1, prepare: false }
  );
  await assertSql(
    unsafeLegacy,
    `select to_regclass('public.tourney_cutover_control_operations') is not null
       and (select is_nullable = 'NO' from information_schema.columns
         where table_schema = 'public'
           and table_name = 'tourney_external_operations'
           and column_name = 'serialization_key')
       and (select count(*) = 2 from information_schema.columns
         where table_schema = 'public'
           and table_name = 'tourney_cutover_metadata'
           and column_name in (
             'last_pause_operation_id','last_resume_operation_id'
           )) ok`,
    "fallback cutover operation ledger was unavailable before activation"
  );
  await unsafeLegacy.begin(async (sql) => {
    await sql`
      update tourney_cutover_metadata set writes_paused = true where id = 'tourney'
    `;
    await sql`
      insert into tourney_cutover_control_operations(
        operation_kind,operation_id,primary_backend,generation,
        target_writes_paused,actor
      ) values(
        'pause','preactivation:pause-0001','legacy',0,true,
        'schema-v4-pause:preactivation:pause-0001'
      )
    `;
  });
  const unsafeLegacyActivation = psqlFails("legacy_unsafe", legacyActivation);
  assert.notEqual(unsafeLegacyActivation.status, 0, "unsafe legacy activation succeeded");
  await assertSql(
    unsafeLegacy,
    "select serialization_key='supabase_player_auth:player:old-writer-player' ok from tourney_external_operations where operation_key='old-writer-legacy:auth'",
    "legacy expand was not compatible with an old external-operation writer"
  );
  await assertSql(
    unsafeLegacy,
    "select to_regclass('public.tourney_account_snapshots_supersedes_v4_idx') is null ok",
    "unsafe legacy activation performed DDL"
  );
  psql(
    "legacy_unsafe",
    legacyControls,
    legacyActivation,
    legacyUnpaused
  );
  const [legacyTriggerBeforeRepair] = await unsafeLegacy`
    select pg_get_functiondef(
      'public.capture_tourney_mirror_event()'::regprocedure
    ) definition
  `;
  const unsafeLegacyRepair = psqlFails("legacy_unsafe", legacyRepair);
  assert.notEqual(unsafeLegacyRepair.status, 0, "unsafe legacy repair succeeded");
  const unsafeLegacyTriggerRepair = psqlFails(
    "legacy_unsafe",
    legacyTriggerBindingRepair
  );
  assert.notEqual(
    unsafeLegacyTriggerRepair.status,
    0,
    "unsafe legacy trigger-binding repair succeeded"
  );
  const [legacyTriggerAfterRepair] = await unsafeLegacy`
    select pg_get_functiondef(
      'public.capture_tourney_mirror_event()'::regprocedure
    ) definition
  `;
  assert.equal(
    legacyTriggerAfterRepair.definition,
    legacyTriggerBeforeRepair.definition,
    "unsafe legacy repair replaced the trigger function"
  );
  await unsafeLegacy.end({ timeout: 5 });
  process.stderr.write("[postgres17] additive install and explicit activation gates verified\n");

  psql(
    "supabase_fixture",
    supabaseBootstrap,
    path.join(root, "supabase/migrations/20260712224033_expand_tourney_schema_v4.sql"),
    supabaseActivation
  );
  const migrationFixture = writeTemp("discord-migration-fixture.sql", `
insert into auth.users(id,email)
values('31000000-0000-4000-8000-000000000001','migration-fixture@example.com');
insert into accounts.principals(id)
values('41000000-0000-4000-8000-000000000001');
insert into accounts.principal_auth_users(user_id,principal_id)
values(
  '31000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001'
);
insert into accounts.tourney_accounts(
  user_id,principal_id,username,role,legacy_sanity_id
) values(
  '31000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  'migration-player','tourney_player','migration-player-1'
);
insert into accounts.discord_role_assignments(
  user_id,principal_id,discord_user_id,guild_id,tourney_role,desired_role,status
) values(
  '31000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  '510000000000000001','610000000000000001','tourney_player',
  'participant','blocked'
);
`);
  psql(
    "supabase_fixture",
    migrationFixture,
    supabaseHardening,
    supabaseBaselineRestore,
    supabaseRepair,
    supabaseCutoverOperationMarkers,
    supabaseSnapshotRpcRepair,
    supabaseSnapshotRpcTimeout,
    supabaseCompactSnapshotPayload,
    supabaseBaselineRecovery,
    supabaseBaselineClockReset
  );
  process.stderr.write("[postgres17] Supabase schema-v4 install remained inactive\n");
  psql("supabase_fixture", supabaseControls, captureLatencyBaseline);

  psql(
    "legacy_fixture",
    legacyBootstrap,
    path.join(root, "scripts/tourney-cutover-legacy.sql"),
    path.join(root, "scripts/tourney-schema-v4-expand-legacy.sql"),
    legacyControls,
    legacyActivation,
    legacyRepair,
    legacyTriggerBindingDrift,
    legacyTriggerBindingRepair
  );
  process.stderr.write("[postgres17] legacy schema v4 and forward repair applied\n");

  psql(
    "supabase_fixture",
    activateSupabaseV4,
    removeSupabaseActivationRpc
  );
  psql(
    "supabase_fixture",
    supabaseTriggerBindingDrift,
    supabaseTriggerBindingRepair
  );
  process.stderr.write("[postgres17] schema v4 trigger bindings repaired\n");

  const supabaseUrl = `postgres://127.0.0.1:${port}/supabase_fixture`;
  const legacyUrl = `postgres://127.0.0.1:${port}/legacy_fixture`;
  const source = postgres(supabaseUrl, { max: 5, prepare: false });
  const target = postgres(legacyUrl, { max: 5, prepare: false });
  const env = {
    NODE_ENV: "production",
    TOURNEY_DATABASE_MODE: "supabase",
    SUPABASE_DATABASE_URL: supabaseUrl,
    TOURNEY_DATABASE_URL: legacyUrl,
    TOURNEY_MIRROR_ENABLED: "1",
    TOURNEY_FAILOVER_GENERATION: "1",
    TOURNEY_HARDENING_V4_ENABLED: "1",
    TOURNEY_WRITES_PAUSED: "1",
    TOURNEY_SESSION_SECRET: "postgres17-fixture-idempotency-secret-32-bytes-minimum",
    DISCORD_BOT_TOKEN: "fixture-bot-token",
    DISCORD_GUILD_ID: "610000000000000001",
    DISCORD_PARTICIPANT_ROLE_ID: "710000000000000001",
    DISCORD_HOST_ROLE_ID: "710000000000000002",
  };

  await assertSql(
    source,
    `select
      to_regprocedure(
        'public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)'
      ) is null
      and to_regprocedure('public.roo_activate_tourney_schema_v4(text)') is not null
      and public.roo_activate_tourney_schema_v4(
        'postgres17-absent-rpc-validation'
      ) @> '{"activated":true,"already_active":true,"validation_only":true,"mirror_trigger_bindings_verified":true,"compatibility_mode":"trigger-binding-live-schema-compat-v1"}'::jsonb ok`,
    "missing live activation RPC was not replaced with validation-only compatibility"
  );
  await source`
    update tourney.cutover_metadata set hardened_active=false where id='tourney'
  `;
  await assert.rejects(
    source`select public.roo_activate_tourney_schema_v4(
      'postgres17-absent-rpc-inactive-rejection'
    )`,
    (error) => error.code === "55000",
    "validation-only activation RPC activated an inactive schema"
  );
  await assertSql(
    source,
    "select not hardened_active ok from tourney.cutover_metadata where id='tourney'",
    "validation-only activation RPC changed hardened controls"
  );
  await source`
    update tourney.cutover_metadata set hardened_active=true where id='tourney'
  `;

  await assertSql(
    source,
    `select
      (status->>'ready')::boolean
      and (status->>'enabled_contracts')::integer=17
      and (status->>'correctly_bound')::integer=17
      and (status->>'function_body_matches')::boolean ok
     from (select tourney.mirror_trigger_binding_status_v4() status) binding`,
    "Supabase trigger-binding repair did not verify the fail-closed contract"
  );
  await assertSql(
    target,
    `select
      (status->>'ready')::boolean
      and (status->>'enabled_contracts')::integer=17
      and (status->>'correctly_bound')::integer=17
      and (status->>'function_body_matches')::boolean ok
     from (select public.tourney_mirror_trigger_binding_status_v4() status) binding`,
    "legacy trigger-binding repair did not verify the fail-closed contract"
  );
  await assertSql(
    source,
    `select count(*)=17 ok
     from tourney.mirror_contracts contract
     join pg_catalog.pg_trigger trigger
       on trigger.tgrelid=contract.supabase_relation::pg_catalog.regclass
      and trigger.tgname='capture_tourney_mirror_event'
     where contract.enabled
       and trigger.tgfoid='tourney.capture_mirror_event_v4()'::regprocedure
       and trigger.tgtype=29 and trigger.tgenabled='O' and not trigger.tgisinternal`,
    "Supabase trigger OIDs were not bound to the canonical v4 function"
  );
  await assertSql(
    target,
    `select count(*)=17 ok
     from public.tourney_mirror_contracts contract
     join pg_catalog.pg_trigger trigger
       on trigger.tgrelid=contract.legacy_relation::pg_catalog.regclass
      and trigger.tgname='capture_tourney_mirror_event'
     where contract.enabled
       and trigger.tgfoid='public.capture_tourney_mirror_event()'::regprocedure
       and trigger.tgtype=29 and trigger.tgenabled='O' and not trigger.tgisinternal`,
    "legacy trigger OIDs were not bound to the canonical v4 function"
  );
  await assertSql(
    source,
    `select clean_since is null
       and natural_mutation_verified_at is null
       and first_zero_drift_at is null
       and second_zero_drift_at is null
       and clock_last_reset_reason='mirror_trigger_binding_repaired' ok
     from tourney.cutover_metadata where id='tourney'`,
    "Supabase trigger-binding repair did not reset the hardening clock"
  );
  await assertSql(
    target,
    `select clean_since is null
       and natural_mutation_verified_at is null
       and first_zero_drift_at is null
       and second_zero_drift_at is null
       and clock_last_reset_reason='mirror_trigger_binding_repaired' ok
     from public.tourney_cutover_metadata where id='tourney'`,
    "legacy trigger-binding repair did not reset the hardening clock"
  );
  await assertSql(
    source,
    `select count(*)=1 ok from tourney.cutover_gate_events
     where event_kind='clock_reset'
       and evidence @> '{"reason":"mirror_trigger_binding_repaired","correctly_bound":17}'::jsonb`,
    "Supabase trigger-binding clock reset was not audited"
  );
  await assertSql(
    target,
    `select count(*)=1 ok from public.tourney_cutover_gate_events
     where event_kind='clock_reset'
       and evidence @> '{"reason":"mirror_trigger_binding_repaired","correctly_bound":17}'::jsonb`,
    "legacy trigger-binding clock reset was not audited"
  );
  await assertSql(
    source,
    `select
      (select count(*)=5 from jsonb_object_keys(readiness->'shadow_reads'))
      and readiness->'shadow_reads_since_natural_mutation'='{}'::jsonb ok
     from (select public.roo_tourney_readiness() readiness) state`,
    "Supabase readiness did not expose the latest real shadow-read summaries"
  );

  const [canonicalSupabaseTrigger] = await source`
    select pg_get_functiondef(
      'tourney.capture_mirror_event_v4()'::regprocedure
    ) definition
  `;
  await source.unsafe(`
    create or replace function tourney.capture_mirror_event_v4()
    returns trigger language plpgsql security definer set search_path=''
    as $$ begin
      if tg_op='DELETE' then return old; end if;
      return new;
    end $$
  `);
  await assertSql(
    source,
    `select not (status->>'ready')::boolean
       and not (status->>'function_body_matches')::boolean ok
     from (select tourney.mirror_trigger_binding_status_v4() status) binding`,
    "Supabase trigger status accepted a fail-open function body"
  );
  await assertSql(
    source,
    `select readiness->'clock_blockers' ? 'mirror_trigger_binding_drift' ok
     from (select public.roo_tourney_readiness() readiness) state`,
    "Supabase readiness accepted a fail-open function body"
  );
  await assert.rejects(
    source`select public.roo_activate_tourney_schema_v4('postgres17-body-drift')`,
    (error) => error.code === "55000",
    "Supabase activation accepted a fail-open function body"
  );
  await source.unsafe(canonicalSupabaseTrigger.definition);

  await source.unsafe(`
    drop trigger capture_tourney_mirror_event on tourney.tourney_players;
    create trigger capture_tourney_mirror_event
    after insert or update or delete on tourney.tourney_players
    for each row execute function tourney.capture_mirror_event_fail_open_fixture()
  `);
  await assertSql(
    source,
    `select not (status->>'ready')::boolean
       and (status->>'correctly_bound')::integer=16
       and status->'drifted_tables' ? 'tourney_players' ok
     from (select tourney.mirror_trigger_binding_status_v4() status) binding`,
    "Supabase trigger status accepted a wrong trigger function OID"
  );
  await assert.rejects(
    source`select public.roo_activate_tourney_schema_v4('postgres17-oid-drift')`,
    (error) => error.code === "55000",
    "Supabase activation accepted a wrong trigger function OID"
  );
  await source.unsafe(`
    drop trigger capture_tourney_mirror_event on tourney.tourney_players;
    create trigger capture_tourney_mirror_event
    after insert or update or delete on tourney.tourney_players
    for each row execute function tourney.capture_mirror_event_v4()
  `);
  await assertSql(
    source,
    "select (tourney.mirror_trigger_binding_status_v4()->>'ready')::boolean ok",
    "Supabase trigger status did not recover after restoring the canonical binding"
  );

  const cutoverOperationFixtures = [
    ["pause", "fixture:pause-0001", true],
    ["resume", "fixture:resume-0001", false],
    ["pause", "fixture:pause-0002", true],
    ["resume", "fixture:resume-0002", false],
  ];
  for (const [sql, relation] of [
    [source, "tourney.cutover_control_operations"],
    [target, "tourney_cutover_control_operations"],
  ]) {
    for (const [operationKind, operationId, targetWritesPaused] of
      cutoverOperationFixtures) {
      await sql`
        insert into ${sql(relation)}(
          operation_kind,operation_id,primary_backend,generation,
          target_writes_paused,actor
        ) values(
          ${operationKind},${operationId},'supabase',1,
          ${targetWritesPaused},${`schema-v4-${operationKind}:${operationId}`}
        )
      `;
    }
    await assertSql(
      sql,
      `select count(*) = 4
         and count(*) filter (where operation_kind = 'pause') = 2
         and count(*) filter (where operation_kind = 'resume') = 2 ok
       from ${relation}`,
      `${relation} did not retain independent pause and resume operations`
    );
    await assert.rejects(
      sql`
        insert into ${sql(relation)}(
          operation_kind,operation_id,primary_backend,generation,
          target_writes_paused,actor
        ) values(
          'pause','fixture:pause-0001','supabase',1,true,
          'schema-v4-pause:fixture:pause-0001'
        )
      `,
      (error) => error.code === "23505",
      `${relation} accepted a duplicate operation`
    );
    await assert.rejects(
      sql`update ${sql(relation)} set actor = 'changed'`,
      (error) => error.code === "55000",
      `${relation} allowed an operation to be updated`
    );
    await assert.rejects(
      sql`delete from ${sql(relation)} where operation_kind = 'pause'`,
      (error) => error.code === "55000",
      `${relation} allowed an operation to be deleted`
    );
    await sql`
      insert into ${sql(relation)}(
        operation_kind,operation_id,primary_backend,generation,
        target_writes_paused,actor
      ) values(
        'pause','fixture:compensate-0001','supabase',1,true,
        'schema-v4-pause:fixture:compensate-0001'
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        select set_config('roo.tourney_cutover_compensation','1',true)
      `;
      await transaction`
        delete from ${transaction(relation)}
        where operation_kind = 'pause'
          and operation_id = 'fixture:compensate-0001'
      `;
    });
    await assertSql(
      sql,
      `select not exists(
         select 1 from ${relation}
         where operation_kind = 'pause'
           and operation_id = 'fixture:compensate-0001'
       ) ok`,
      `${relation} blocked a transaction-gated compensation delete`
    );
  }

  await assertSql(
    source,
    `select count(*) = 2 ok
     from information_schema.columns
     where table_schema = 'tourney'
       and table_name = 'cutover_metadata'
       and column_name in (
         'last_pause_operation_id', 'last_resume_operation_id'
       )`,
    "Supabase cutover operation marker columns are missing"
  );
  await assertSql(
    target,
    `select count(*) = 2 ok
     from information_schema.columns
     where table_schema = 'public'
       and table_name = 'tourney_cutover_metadata'
       and column_name in (
         'last_pause_operation_id', 'last_resume_operation_id'
       )`,
    "fallback cutover operation marker columns are missing"
  );
  await Promise.all([
    source`update tourney.cutover_metadata set writes_paused = false where id = 'tourney'`,
    target`update tourney_cutover_metadata set writes_paused = false where id = 'tourney'`,
  ]);
  await Promise.all([
    source`update tourney.cutover_metadata set
      writes_paused = true,
      last_pause_operation_id = 'fixture:pause-0001'
      where id = 'tourney'`,
    target`update tourney_cutover_metadata set
      writes_paused = true,
      last_pause_operation_id = 'fixture:pause-0001'
      where id = 'tourney'`,
  ]);
  await Promise.all([
    source`update tourney.cutover_metadata set
      writes_paused = false,
      last_resume_operation_id = 'fixture:resume-0001'
      where id = 'tourney'`,
    target`update tourney_cutover_metadata set
      writes_paused = false,
      last_resume_operation_id = 'fixture:resume-0001'
      where id = 'tourney'`,
  ]);
  await assertSql(
    source,
    `select not writes_paused
       and last_pause_operation_id = 'fixture:pause-0001'
       and last_resume_operation_id = 'fixture:resume-0001' ok
     from tourney.cutover_metadata where id = 'tourney'`,
    "Supabase pause and resume operation markers did not remain independent"
  );
  await assertSql(
    target,
    `select not writes_paused
       and last_pause_operation_id = 'fixture:pause-0001'
       and last_resume_operation_id = 'fixture:resume-0001' ok
     from tourney_cutover_metadata where id = 'tourney'`,
    "fallback pause and resume operation markers did not remain independent"
  );
  for (const [sql, relation] of [
    [source, "tourney.cutover_metadata"],
    [target, "tourney_cutover_metadata"],
  ]) {
    await assert.rejects(
      sql.unsafe(`update ${relation}
        set last_pause_operation_id = 'Fixture:pause-0002'
        where id = 'tourney'`),
      (error) => error.code === "23514",
      `${relation} accepted an uppercase pause operation ID`
    );
    await assert.rejects(
      sql.unsafe(`update ${relation}
        set last_resume_operation_id = 'fixture.resume-0002'
        where id = 'tourney'`),
      (error) => error.code === "23514",
      `${relation} accepted a dotted resume operation ID`
    );
  }
  await Promise.all([
    source`update tourney.cutover_metadata set writes_paused = true where id = 'tourney'`,
    target`update tourney_cutover_metadata set writes_paused = true where id = 'tourney'`,
  ]);

  await assertSql(
    source,
    `select not pg_catalog.has_function_privilege(
       'service_role','tourney.upsert_snapshot_rows(text,jsonb)','EXECUTE'
     ) and not pg_catalog.has_function_privilege(
       'service_role','tourney.delete_snapshot_missing_rows(text,jsonb)','EXECUTE'
     ) and not pg_catalog.has_function_privilege(
       'service_role','tourney.capture_mirror_event_v4()','EXECUTE'
     ) ok`,
    "private Tourney snapshot or trigger helpers remained executable by service_role"
  );

  const activationDiscord = await seedTourneyDiscordDesiredStateV4({ env });
  assert.equal(activationDiscord.normalized, 1);

  await assertSql(
    source,
    "select player_id='migration-player-1' and status='blocked_reauth' and blocked_at is not null ok from accounts.discord_role_assignments where principal_id='41000000-0000-4000-8000-000000000001'",
    "Discord assignment migration did not backfill player identity and reauthorization state"
  );
  await assertSql(
    source,
    "select exists(select 1 from tourney.mirror_outbox where command_id='discord-state-normalize:g1:v4' and table_name='discord_role_assignments' and record_data->>'player_id'='migration-player-1' and record_data->>'status'='blocked_reauth') ok",
    "Discord assignment migration did not enqueue its mirrored backfill"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','schema-v4:discord-player-backfill-cleanup',true)`;
    await sql`
      delete from accounts.discord_role_assignments
      where principal_id='41000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from accounts.tourney_accounts
      where principal_id='41000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from accounts.principal_auth_users
      where principal_id='41000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from accounts.principals
      where id='41000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from auth.users
      where id='31000000-0000-4000-8000-000000000001'
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_command_receipts(
        command_id,purpose,request_hash,status,result_status,result_body,generation,
        committed_at
      ) values
        ('fixture:serialized-provider:0001','players:sync',${"1".repeat(64)},
          'committed',200,'{}'::jsonb,1,now()),
        ('fixture:serialized-provider:0002','players:sync',${"2".repeat(64)},
          'committed',200,'{}'::jsonb,1,now())
    `;
  });

  await target.begin(async (sql) => {
    await sql`
      update tourney_cutover_metadata set primary_backend='legacy'
      where id='tourney'
    `;
    await sql`
      select set_config('roo.tourney_backend','legacy',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:legacy-trigger:0001',true)
    `;
    await sql`
      insert into tourney_registration_config(id,team_count)
      values('legacy-trigger-probe',8)
    `;
  });
  const [legacyTriggerEvent] = await target`
    select record_hash from tourney_mirror_outbox
    where command_id='fixture:legacy-trigger:0001'
  `;
  assert.match(
    legacyTriggerEvent.record_hash,
    /^[0-9a-f]{64}$/,
    "legacy empty-search-path trigger did not hash the row"
  );
  await target`
    update tourney_cutover_metadata set primary_backend='supabase'
    where id='tourney'
  `;
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney_registration_config where id='legacy-trigger-probe'`;
    await sql`delete from tourney_mirror_outbox where command_id='fixture:legacy-trigger:0001'`;
  });

  const preflightSnapshotImport = async (snapshot, allowTombstones) => {
    const [row] = await source`
      select public.roo_preflight_tourney_snapshot_v4(
        ${source.json(snapshot)},${snapshotHash(snapshot)},${allowTombstones}
      ) result
    `;
    return row.result;
  };
  const incompleteSnapshot = { tourney_players: [], _counts: { tourney_players: 0 } };
  await assert.rejects(
    preflightSnapshotImport(incompleteSnapshot,false),
    (error) => error.code === "55000",
    "generation-1 non-destructive snapshot import was accepted"
  );

  const emptySnapshot = {
    ...Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []])),
    _counts: Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, 0])),
  };
  await assert.rejects(
    preflightSnapshotImport(emptySnapshot,true),
    (error) => error.code === "55000",
    "generation-1 destructive reconciliation was not rejected"
  );
  await source`
    update tourney.cutover_metadata set
      primary_backend='legacy',generation=0,writes_paused=true
    where id='tourney'
  `;
  await assert.rejects(
    preflightSnapshotImport(incompleteSnapshot,false),
    (error) => error.code === "22023",
    "incomplete generation-0 snapshot was accepted"
  );

  const collisionSnapshot = {
    ...Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, []])),
    tourney_players: [
      { id: "collision-1", username: "same", email: "one@example.com", discord_key: "one" },
      { id: "collision-2", username: "same", email: "two@example.com", discord_key: "two" },
    ],
    _counts: Object.fromEntries(SNAPSHOT_TABLES.map((table) => [
      table,
      table === "tourney_players" ? 2 : 0,
    ])),
  };
  const collisionHash = snapshotHash(collisionSnapshot);
  await assert.rejects(
    source`
      select public.roo_preflight_tourney_snapshot_v4(
        ${source.json(collisionSnapshot)},${"f".repeat(64)},false
      )
    `,
    (error) => error.code === "22023",
    "tampered snapshot hash was accepted"
  );
  const collisionPreflight = await preflightSnapshotImport(collisionSnapshot,false);
  const [collisionResult] = await source`
    select public.roo_import_tourney_snapshot_v4(
      ${source.json(collisionSnapshot)},${collisionHash},false,
      ${collisionPreflight.preflight_id}::uuid
    ) result
  `;
  assert.equal(collisionResult.result.status, "quarantined", "unique collision was not quarantined");
  await source`delete from migration.tourney_import_quarantine where source_hash=${collisionHash}`;
  await assert.rejects(
    source`
      select public.roo_preflight_tourney_snapshot_v4(
        null::jsonb,${"0".repeat(64)},true
      )
    `,
    (error) => error.code === "22023",
    "null destructive snapshot was accepted"
  );
  await assertSql(
    source,
    "select exists(select 1 from tourney.tourney_registration_config where id='legacy-series-2026') ok",
    "invalid destructive snapshot deleted source rows"
  );
  const destructiveSnapshot = Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [table, []])
  );
  destructiveSnapshot.tourney_registration_config = JSON.parse(JSON.stringify(
    await source`select * from tourney.tourney_registration_config order by id`
  ));
  destructiveSnapshot.tourney_bracket_meta = JSON.parse(JSON.stringify(
    await source`select * from tourney.tourney_bracket_meta order by id`
  ));
  destructiveSnapshot.tourney_players = [{
    id: "semantic-player",
    username: "semantic-player",
    email: "semantic-player@example.com",
    password_hash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    status: "approved",
    discord: "Semantic Player",
    display_name: "Semantic Player",
    discord_key: "semantic-player",
    battlenet: "Semantic#1",
    rank_name: "Master",
    role_play: "Tank",
    secondary_role_play: "",
    approved_role_play: "Tank",
    registration_pool: "main",
    time_zone: "UTC",
    twitch_username: null,
    team_name: null,
    available_aug_1_2: true,
    accepted_rules: true,
    accepted_roo_visibility: true,
    notes: null,
    version: 1,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    approved_at: "2026-07-14T00:00:00.000Z",
    approved_by: "fixture",
    denied_at: null,
    denied_by: null,
    removed_at: null,
    removed_by: null,
    withdrawn_at: null,
    withdrawn_by: null,
    discord_invite_sent_at: null,
    discord_invite_email_id: null,
    discord_invite_last_error: null,
    discord_user_id: null,
    discord_oauth_username: null,
    discord_oauth_global_name: null,
    discord_linked_at: null,
    discord_role_assigned_at: null,
    discord_role_last_error: null,
    principal_id: null,
  }];
  destructiveSnapshot.tourney_payouts = [{
    id: "semantic-payout",
    player_id: "semantic-player",
    display_name: "Semantic Player",
    team_name: null,
    payout_type: "placement",
    amount_usd: "12.30",
    status: "pending",
    payout_email: null,
    notes: null,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
    updated_by: null,
  }];
  destructiveSnapshot._counts = Object.fromEntries(
    SNAPSHOT_TABLES.map((table) => [table, destructiveSnapshot[table].length])
  );
  const destructiveHash = snapshotHash(destructiveSnapshot);
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.tourney_bracket_lock(id,locked_until,locked_by)
      values('target-only-import-row',now()+interval '1 minute','fixture')
    `;
  });
  const destructivePreflight = await preflightSnapshotImport(destructiveSnapshot,true);
  await source.unsafe(`
    create or replace function tourney.sleep_semantic_import()
    returns trigger language plpgsql set search_path='' as $$
    begin
      if new.id='semantic-player' then perform pg_catalog.pg_sleep(1); end if;
      return new;
    end;
    $$;
    create trigger sleep_semantic_import
    before insert or update on tourney.tourney_players
    for each row execute function tourney.sleep_semantic_import();
  `);
  const destructiveImportPromise = Promise.resolve(source`
    select public.roo_import_tourney_snapshot_v4(
      ${source.json(destructiveSnapshot)},${destructiveHash},true,
      ${destructivePreflight.preflight_id}::uuid
    ) result
  `);
  await new Promise((resolve) => setTimeout(resolve,100));
  let concurrentImportWriteFinished = false;
  const concurrentImportWrite = source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_mirror_apply','1',true)
    `;
    await sql`
      insert into tourney.tourney_players(
        id,username,email,password_hash,status,discord,discord_key,battlenet,
        rank_name,role_play
      ) values(
        'concurrent-import-row','concurrent-import-row',
        'concurrent-import-row@example.com',
        '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'pending','ConcurrentImport','concurrent-import-row','Concurrent#1',
        'Master','Tank'
      )
    `;
  }).then(() => { concurrentImportWriteFinished=true; });
  await new Promise((resolve) => setTimeout(resolve,200));
  assert.equal(
    concurrentImportWriteFinished,false,
    "managed-table DML bypassed the importer preflight lock"
  );
  const [destructiveImport] = await destructiveImportPromise;
  await concurrentImportWrite;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.tourney_players where id='concurrent-import-row'`;
  });
  await source.unsafe(`
    drop trigger sleep_semantic_import on tourney.tourney_players;
    drop function tourney.sleep_semantic_import();
  `);
  assert.equal(destructiveImport.result.status, "completed");
  assert.equal(
    destructiveImport.result.deleted_counts.tourney_bracket_lock,
    1,
    "tombstone import did not delete the target-only row"
  );
  assert.equal(
    destructiveImport.result.source_canonical_hashes.tourney_payouts,
    destructiveImport.result.target_canonical_hashes.tourney_payouts,
    "PostgreSQL-normalized timestamp and numeric values drifted"
  );
  await assertSql(
    source,
    "select not exists(select 1 from tourney.tourney_bracket_lock where id='target-only-import-row') ok",
    "target-only import row survived tombstone reconciliation"
  );
  await source`
    update tourney.cutover_metadata set
      primary_backend='supabase',generation=1,writes_paused=true
    where id='tourney'
  `;
  process.stderr.write("[postgres17] semantic import and tombstone pruning verified\n");

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:player:0001',true)`;
    await sql`insert into tourney.tourney_players(
      id,username,email,password_hash,status,discord,discord_key,battlenet,
      rank_name,role_play
    ) values(
      'player-1','player-one','player@example.com','$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
      'PlayerOne','playerone','Player#1','Master','Tank'
    )`;
    await sql`insert into tourney.tourney_player_tokens(
      id,player_id,token_hash,purpose,recipient_version,expires_at
    ) values('token-1','player-1',${"b".repeat(64)},'reset','1',now()+interval '1 day')`;
    await sql`update tourney.tourney_registration_config set team_count=10 where id='legacy-series-2026'`;
    await sql`insert into tourney.tourney_bracket_teams(id,name) values('team-1','Team One')`;
    await sql`insert into tourney.tourney_bracket_team_members(
      id,team_id,player_id,display_name,role_play
    ) values('member-1','team-1','player-1','Player One','Tank')`;
    await sql`update tourney.tourney_bracket_meta set stage_id=1 where id='legacy-series-2026'`;
    await sql`insert into tourney.tourney_bracket_entities(entity_type,entity_id,data)
      values('match',1,'{"status":"pending"}'::jsonb)`;
    await sql`insert into tourney.tourney_bracket_counters(entity_type,next_id) values('match',2)`;
    await sql`insert into tourney.tourney_bracket_audit(id,action,actor_username)
      values('audit-1','seed','fixture')`;
    await sql`insert into tourney.tourney_bracket_lock(id,locked_until,locked_by)
      values('lock-1',now()+interval '1 minute','fixture')`;
    await sql`insert into tourney.tourney_appeals(
      id,type,status,submitter_username,title,details
    ) values('appeal-1','team-appeal','open','player-one','Fixture','Fixture details')`;
    await sql`insert into tourney.tourney_payouts(
      id,player_id,display_name,payout_type,status
    ) values('payout-1','player-1','Player One','placement','pending')`;
    await sql`insert into tourney.email_dispatches(
      id,idempotency_key,command_id,dispatch_kind,recipient,recipient_hash,payload
    ) values(
      '10000000-0000-4000-8000-000000000001','fixture:email:0001',
      'fixture:player:0001','discord_invite','player@example.com',${"c".repeat(64)},'{}'::jsonb
    )`;
  });
  const [counterEvent] = await source`
    select record_key from tourney.mirror_outbox
    where table_name='tourney_bracket_counters' order by sequence desc limit 1
  `;
  assert.deepEqual(counterEvent.record_key, { entity_type: "match" }, "bracket counter key must be entity_type");

  const firstMirror = await reconcileTourneyMirror({ env, limit: 100 });
  process.stderr.write("[postgres17] initial mirror verified\n");
  if (firstMirror.failed) {
    const failures = await source`
      select table_name,status,last_error_code from tourney.mirror_outbox
      where status in ('retry','dead_letter') order by sequence
    `;
    process.stderr.write(`[postgres17] mirror failures ${JSON.stringify(failures)}\n`);
  }
  assert.equal(firstMirror.failed, 0);
  await assertSql(target, "select exists(select 1 from tourney_players where id='player-1') ok", "player insert was not mirrored");
  await assertSql(target, "select exists(select 1 from tourney_bracket_counters where entity_type='match' and next_id=2) ok", "counter insert was not mirrored");
  await assertSql(target, "select (select count(*) from tourney_player_tokens)=1 and (select count(*) from tourney_bracket_teams)=1 and (select count(*) from tourney_bracket_team_members)=1 and (select count(*) from tourney_bracket_entities)=1 and (select count(*) from tourney_bracket_audit)=1 and (select count(*) from tourney_bracket_lock)=1 and (select count(*) from tourney_appeals)=1 and (select count(*) from tourney_payouts)=1 and (select count(*) from tourney_email_dispatches)=1 ok", "registered business tables were not mirrored");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.tourney_players(
        id,username,email,password_hash,status,discord,display_name,discord_key,
        battlenet,rank_name,role_play
      ) values(
        'mirror-race','mirror-race','mirror-race@example.com',
        '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'approved','MirrorRace','new-race','mirror-race','Mirror#1','Master','Tank'
      )
    `;
  });
  const raceEvents = await source`
    with current_row as (
      select to_jsonb(player) data
      from tourney.tourney_players player where id='mirror-race'
    ), versions as (
      select 1 ordinal,
        jsonb_set(data,'{display_name}','"old-race"'::jsonb) data
      from current_row
      union all
      select 2,data from current_row
    )
    insert into tourney.mirror_outbox(
      command_id,source_backend,generation,table_name,operation,
      record_key,record_data,record_hash,status
    )
    select 'fixture:mirror-race:'||ordinal,'supabase',1,'tourney_players',
      'upsert','{"id":"mirror-race"}'::jsonb,data,
      encode(extensions.digest(convert_to(data::text,'UTF8'),'sha256'),'hex'),
      'pending'
    from versions order by ordinal
    returning sequence,record_data->>'display_name' display_name
  `;
  const oldRaceSequence = Number(
    raceEvents.find((event) => event.display_name === "old-race")?.sequence
  );
  const newRaceSequence = Number(
    raceEvents.find((event) => event.display_name === "new-race")?.sequence
  );
  assert.ok(oldRaceSequence < newRaceSequence, "mirror race fixture order is invalid");
  await target.unsafe(`
    create or replace function public.sleep_old_mirror_race()
    returns trigger language plpgsql set search_path='' as $$
    begin
      if new.id='mirror-race' and new.display_name='old-race' then
        perform pg_catalog.pg_sleep(1);
      end if;
      return new;
    end;
    $$;
    create trigger sleep_old_mirror_race
    before insert or update on public.tourney_players
    for each row execute function public.sleep_old_mirror_race();
  `);
  const olderMirrorWorker = reconcileTourneyMirror({ env, limit: 1 });
  await new Promise((resolve) => setTimeout(resolve,100));
  const newerMirrorWorker = reconcileTourneyMirror({ env, limit: 1 });
  const raceResults = await Promise.all([olderMirrorWorker,newerMirrorWorker]);
  await target.unsafe(`
    drop trigger sleep_old_mirror_race on public.tourney_players;
    drop function public.sleep_old_mirror_race();
  `);
  assert.equal(
    raceResults.reduce((total,result) => total+result.failed,0),
    0,
    "concurrent same-record mirror workers failed"
  );
  await assertSql(
    target,
    `select player.display_name='new-race'
      and checkpoint.source_sequence=${newRaceSequence} ok
     from tourney_players player
     join tourney_mirror_checkpoints checkpoint
       on checkpoint.table_name='tourney_players'
      and checkpoint.record_key_hash=encode(public.digest(
        convert_to('{"id":"mirror-race"}','UTF8'),'sha256'
      ),'hex')
     where player.id='mirror-race'`,
    "same-record mirror race allowed stale state to win"
  );
  await Promise.all([
    source`update tourney.cutover_metadata set writes_paused=false where id='tourney'`,
    target`update tourney_cutover_metadata set writes_paused=false where id='tourney'`,
  ]);
  env.TOURNEY_WRITES_PAUSED = "0";

  const capacityPlayerIds = [
    "capacity-main-2",
    "capacity-main-3",
    "capacity-substitute",
    "capacity-damage",
    "capacity-pending",
  ];
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`update tourney.tourney_registration_config set team_count=3 where id='legacy-series-2026'`;
    await sql`
      insert into tourney.tourney_players(
        id,username,email,password_hash,status,discord,display_name,discord_key,
        battlenet,rank_name,role_play,approved_role_play,registration_pool,
        twitch_username,version
      ) values
        ('capacity-main-2','capacity-main-2','capacity-main-2@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'CapacityMain2','Capacity Main 2','capacity-main-2','Capacity#2','Master',
          'Tank','Tank','main','capacitymain2',1),
        ('capacity-main-3','capacity-main-3','capacity-main-3@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'CapacityMain3','Capacity Main 3','capacity-main-3','Capacity#3','Master',
          'Tank','Tank','main','capacitymain3',1),
        ('capacity-substitute','capacity-substitute','capacity-substitute@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'CapacitySubstitute','Capacity Substitute','capacity-substitute','Capacity#4','Master',
          'Tank','Tank','substitute','capacitysubstitute',1),
        ('capacity-damage','capacity-damage','capacity-damage@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'CapacityDamage','Capacity Damage','capacity-damage','Capacity#5','Master',
          'Damage','Damage','main','capacitydamage',1)
    `;
  });
  const capacityPoolMove = executeTourneyCommand({
    commandId: "fixture:capacity:pool-move",
    purpose: "players:update-details",
    requestPayload: { playerId: "capacity-substitute", registrationPool: "main" },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await updateTourneyPlayerDetails({
        playerId: "capacity-substitute",
        payload: {
          displayName: "Capacity Substitute",
          twitchUsername: "capacitysubstitute",
          teamName: "",
          registrationPool: "main",
        },
        actorUsername: "fixture",
        env,
      }),
    }),
  });
  const capacityRoleMove = executeTourneyCommand({
    commandId: "fixture:capacity:role-move",
    purpose: "players:update-role",
    requestPayload: { playerId: "capacity-damage", rolePlay: "Tank" },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await updateTourneyPlayerApprovedRole({
        playerId: "capacity-damage",
        rolePlay: "Tank",
        actorUsername: "fixture",
        env,
      }),
    }),
  });
  const capacityMoveResults = await Promise.allSettled([
    capacityPoolMove,
    capacityRoleMove,
  ]);
  assert.equal(
    capacityMoveResults.filter((result) => result.status === "fulfilled").length,
    1,
    "two capacity mutations consumed the same final Tank slot"
  );
  assert.equal(
    capacityMoveResults.filter((result) =>
      result.status === "rejected" &&
      result.reason?.code === "TOURNEY_ROLE_CAPACITY_FULL"
    ).length,
    1,
    "losing capacity mutation did not fail with the role-cap conflict"
  );
  await assertSql(
    source,
    "select count(*)=6 ok from tourney.tourney_players where status='approved' and registration_pool='main' and coalesce(nullif(approved_role_play,''),role_play)='Tank'",
    "concurrent pool/role moves overfilled Tank capacity"
  );

  await executeTourneyCommand({
    commandId: "fixture:capacity:expand",
    purpose: "registration:capacity",
    requestPayload: { teamCount: 3 },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await updateTourneyRegistrationConfig({
        teamCount: 3,
        actorUsername: "fixture",
        env,
      }),
    }),
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.tourney_players(
        id,username,email,password_hash,status,discord,display_name,discord_key,
        battlenet,rank_name,role_play,approved_role_play,registration_pool,
        twitch_username,version
      ) values(
        'capacity-pending','capacity-pending','capacity-pending@example.com',
        '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pending',
        'CapacityPending','Capacity Pending','capacity-pending','Capacity#6','Master',
        'Tank','','main','capacitypending',1
      )
    `;
  });
  const preApprovalCapacity = await getTourneyRoleCapacitySnapshot({ env });
  const preApprovalTank = preApprovalCapacity.roles.find((role) => role.role === "Tank");
  assert.deepEqual(
    {
      teamCount: preApprovalCapacity.teamCount,
      mainCount: preApprovalTank?.mainCount,
      cap: preApprovalTank?.cap,
      isFull: preApprovalTank?.isFull,
    },
    { teamCount: 3, mainCount: 6, cap: 6, isFull: true },
    "capacity fixture did not present a full Tank pool before approval"
  );
  const capacityApproval = executeTourneyCommand({
    commandId: "fixture:capacity:approve",
    purpose: "players:approve",
    requestPayload: { playerId: "capacity-pending" },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await applyRegistrationDecision({
        tokenHash: "",
        playerId: "capacity-pending",
        purpose: "approve",
        actorUsername: "fixture",
        approvedRolePlay: "Tank",
        env,
      }),
    }),
  });
  const capacityReduction = executeTourneyCommand({
    commandId: "fixture:capacity:reduce",
    purpose: "registration:capacity",
    requestPayload: { teamCount: 2 },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await updateTourneyRegistrationConfig({
        teamCount: 2,
        actorUsername: "fixture",
        env,
      }),
    }),
  });
  const [approvalResult, reductionResult] = await Promise.allSettled([
    capacityApproval,
    capacityReduction,
  ]);
  assert.equal(approvalResult.status, "fulfilled", "concurrent approval did not settle safely");
  if (reductionResult.status === "rejected") {
    assert.equal(reductionResult.reason?.code, "TOURNEY_ROLE_CAPACITY_FULL");
  }
  const [capacityState] = await source`
    select
      (select count(*)::integer from tourney.tourney_players
       where status='approved' and registration_pool='main'
         and coalesce(nullif(approved_role_play,''),role_play)='Tank') main_count,
      (select team_count from tourney.tourney_registration_config
       where id='legacy-series-2026') team_count,
      (select registration_pool from tourney.tourney_players
       where id='capacity-pending') approval_pool,
      (select operation_payload from tourney.tourney_player_auth_operations
       where operation_key='decision:capacity-pending') decision_payload
  `;
  assert.ok(
    capacityState.main_count <= capacityState.team_count * 2,
    `approval and cap reduction committed an over-cap state: ${JSON.stringify({
      capacityState,
      approval: approvalResult.status,
      approvalError: approvalResult.reason?.code,
      reduction: reductionResult.status,
      reductionError: reductionResult.reason?.code,
    })}`
  );

  await source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:capacity:cleanup',true)
    `;
    await sql`
      delete from tourney.external_operations
      where command_id like 'fixture:capacity:%'
    `;
    await sql`
      delete from tourney.tourney_player_auth_operations
      where player_id in ${sql(capacityPlayerIds)}
    `;
    await sql`
      delete from tourney.tourney_players where id in ${sql(capacityPlayerIds)}
    `;
    await sql`
      update tourney.tourney_registration_config set team_count=10,updated_at=now()
      where id='legacy-series-2026'
    `;
    await sql`
      delete from tourney.command_receipts
      where command_id like 'fixture:capacity:%'
    `;
  });
  const capacityCleanup = await reconcileTourneyMirror({ env, limit: 250 });
  assert.equal(capacityCleanup.failed, 0, "capacity concurrency cleanup did not mirror");

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,result_status,result_body,generation,
        committed_at
      ) values
        ('fixture:serialized-provider:0001','players:sync',${"1".repeat(64)},
          'committed',200,'{}'::jsonb,1,now()),
        ('fixture:serialized-provider:0002','players:sync',${"2".repeat(64)},
          'committed',200,'{}'::jsonb,1,now())
    `;
    await sql`
      insert into tourney.external_operations(
        operation_key,command_id,operation_kind,entity_type,entity_id,
        serialization_key,desired_state,desired_state_hash,created_at
      ) values
        ('fixture:serialized-provider:op1','fixture:serialized-provider:0001',
          'supabase_player_auth','player','serialized-player',
          'supabase_player_auth:player:serialized-player','{}'::jsonb,
          ${"3".repeat(64)},now()-interval '1 second'),
        ('fixture:serialized-provider:op2','fixture:serialized-provider:0002',
          'supabase_player_auth','player','serialized-player',
          'supabase_player_auth:player:serialized-player','{}'::jsonb,
          ${"4".repeat(64)},now())
    `;
  });
  const serializedClaims = await Promise.all([
    claimTourneyExternalOperations({
      env,
      limit: 1,
      commandId: "fixture:serialized-provider:0001",
    }),
    claimTourneyExternalOperations({
      env,
      limit: 1,
      commandId: "fixture:serialized-provider:0002",
    }),
  ]);
  assert.equal(
    serializedClaims.flat().length,
    1,
    "same-authority provider operations were claimed concurrently"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:serialized-provider:cleanup',true)`;
    await sql`
      delete from tourney.external_operations
      where operation_key like 'fixture:serialized-provider:%'
    `;
    await sql`
      delete from tourney.command_receipts
      where command_id like 'fixture:serialized-provider:%'
    `;
  });

  const failedReceiptPurpose = "players:failed-replay";
  const failedReceiptPayload = { test: true };
  const failedReceiptHash = crypto.createHash("sha256")
    .update(stableJson({
      purpose: failedReceiptPurpose,
      requestPayload: failedReceiptPayload,
    }))
    .digest("hex");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,generation,failed_at
      ) values(
        'fixture:failed-receipt:0001',${failedReceiptPurpose},
        ${failedReceiptHash},'failed',1,now()
      )
    `;
  });
  let failedReceiptCallbackRan = false;
  const failedReceiptReplay = await executeTourneyCommand({
    commandId: "fixture:failed-receipt:0001",
    purpose: failedReceiptPurpose,
    requestPayload: failedReceiptPayload,
    env,
    callback: async () => {
      failedReceiptCallbackRan = true;
      return { body: { ok: true } };
    },
  });
  assert.equal(failedReceiptCallbackRan, false, "failed receipt reran business work");
  assert.equal(failedReceiptReplay.status, 503);
  assert.equal(
    failedReceiptReplay.body.code,
    "TOURNEY_COMMAND_TERMINAL_FAILURE"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney.command_receipts
      where command_id='fixture:failed-receipt:0001'
    `;
  });

  await source`
    insert into tourney.tourney_player_auth_operations(
      operation_key,player_id,operation_kind,desired_status,operation_status
    ) values('decision:player-1','player-1','decision','approved','completed')
  `;
  await assert.rejects(
    claimSupabaseRegistrationDecision({
      playerId: "player-1",
      purpose: "deny",
      actorUsername: "fixture",
      resolveDecision: async () => ({ status: "denied" }),
      env,
    }),
    (error) => error.code === "TOURNEY_DECISION_CHANGED" && error.status === 409,
    "opposite terminal registration decision did not conflict"
  );
  await source`
    delete from tourney.tourney_player_auth_operations
    where operation_key='decision:player-1'
  `;

  const payoutPayload = {
    payoutId: "payout-1",
    playerId: "player-1",
    payoutType: "placement",
    amountUsd: 25,
    status: "ready",
    payoutEmail: "player@example.com",
  };
  const runPayoutTransition = (commandId) => executeTourneyCommand({
    commandId,
    purpose: "payouts:upsert",
    requestPayload: payoutPayload,
    attemptExternalWork: false,
    env,
    callback: async () => {
      const result = await upsertTourneyPayoutWithTransition({
        payload: payoutPayload,
        session: { username: "fixture", role: "caster" },
        env,
      });
      if (result.previousStatus !== result.payout.status) {
        await enqueueTourneyEmailDispatch({
          commandId,
          dispatchKind: "payout",
          recipient: result.payout.payoutEmail,
          idempotencyKey: `payout-transition:${result.payout.id}:${result.payout.status}`,
          entityType: "payout",
          entityId: result.payout.id,
          entityVersion: result.payout.status,
          audience: result.payout.status,
          payload: { payout: result.payout, transition: result.payout.status },
          env,
        });
      }
      return { body: result };
    },
  });
  const payoutTransitions = await Promise.all([
    runPayoutTransition("fixture:payout-transition:0001"),
    runPayoutTransition("fixture:payout-transition:0002"),
  ]);
  assert.deepEqual(
    payoutTransitions.map((result) => result.body.previousStatus).sort(),
    ["pending", "ready"],
    "concurrent payout transitions were not serialized"
  );
  await assertSql(
    source,
    "select count(*)=1 ok from tourney.email_dispatches where dispatch_kind='payout' and payload->>'transition'='ready' and payload#>>'{payout,id}'='payout-1'",
    "concurrent payout transition queued duplicate emails"
  );
  const pendingPayoutPayload = { ...payoutPayload, status: "pending" };
  await assert.rejects(
    executeTourneyCommand({
      commandId: "fixture:payout-transition:ready-regression",
      purpose: "payouts:upsert",
      requestPayload: pendingPayoutPayload,
      attemptExternalWork: false,
      env,
      callback: async () => ({
        body: await upsertTourneyPayoutWithTransition({
          payload: pendingPayoutPayload,
          session: { username: "fixture", role: "caster" },
          env,
        }),
      }),
    }),
    (error) =>
      error.code === "TOURNEY_PAYOUT_STATUS_REGRESSION" && error.status === 409,
    "ready payout regressed to pending before financial mutation"
  );
  await assert.rejects(
    source`update tourney.tourney_payouts set status='pending' where id='payout-1'`,
    (error) => error.code === "23514",
    "database trigger allowed a ready payout to regress"
  );

  const paidPayoutPayload = { ...payoutPayload, status: "paid" };
  const paidPayout = await executeTourneyCommand({
    commandId: "fixture:payout-transition:paid",
    purpose: "payouts:upsert",
    requestPayload: paidPayoutPayload,
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await upsertTourneyPayoutWithTransition({
        payload: paidPayoutPayload,
        session: { username: "fixture", role: "caster" },
        env,
      }),
    }),
  });
  assert.equal(paidPayout.body.previousStatus, "ready");
  assert.equal(paidPayout.body.payout.status, "paid");
  await assert.rejects(
    executeTourneyCommand({
      commandId: "fixture:payout-transition:regression",
      purpose: "payouts:upsert",
      requestPayload: payoutPayload,
      attemptExternalWork: false,
      env,
      callback: async () => ({
        body: await upsertTourneyPayoutWithTransition({
          payload: payoutPayload,
          session: { username: "fixture", role: "caster" },
          env,
        }),
      }),
    }),
    (error) => error.code === "TOURNEY_PAYOUT_TERMINAL" && error.status === 409,
    "paid payout regressed to a sendable status"
  );

  const expiredResetCommandId = "fixture:expired-reset:0001";
  await executeTourneyCommand({
    commandId: expiredResetCommandId,
    purpose: "tokens:reset-request",
    requestPayload: { login: "player@example.com" },
    attemptExternalWork: false,
    env,
    callback: async () => {
      await enqueueTourneyEmailDispatch({
        commandId: expiredResetCommandId,
        dispatchKind: "reset",
        recipient: "player@example.com",
        idempotencyKey: "fixture:expired-reset-dispatch:0001",
        payload: {
          player: { id: "player-1", email: "player@example.com" },
          token: "expired-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
        env,
      });
      return { body: { ok: true } };
    },
  });
  const expiredReset = await reconcileTourneyEmailDispatches({
    commandId: expiredResetCommandId,
    env,
    limit: 1,
  });
  assert.deepEqual(
    expiredReset,
    { claimed: 1, sent: 0, retried: 0, expired: 1 },
    "expired reset dispatch was not blocked"
  );
  await assertSql(
    source,
    "select status='expired' and last_error_code='TOURNEY_RESET_DISPATCH_EXPIRED' ok from tourney.email_dispatches where command_id='fixture:expired-reset:0001' and dispatch_kind='reset'",
    "expired reset dispatch did not reach its terminal state"
  );
  const expiredReceiptRecovery = await completeRecoveredTourneyCommandReceipts({ env });
  assert.ok(expiredReceiptRecovery.completed >= 1, "expired reset receipt was not completed");
  await assertSql(
    source,
    "select status='completed' ok from tourney.command_receipts where command_id='fixture:expired-reset:0001'",
    "expired reset receipt remained a readiness blocker"
  );

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:account-email-probe-cleanup',true)`;
    await sql`delete from tourney.email_dispatches where command_id in ('fixture:payout-transition:0001','fixture:payout-transition:0002','fixture:expired-reset:0001')`;
    await sql`delete from tourney.command_receipts where command_id in ('fixture:payout-transition:0001','fixture:payout-transition:0002','fixture:payout-transition:paid','fixture:expired-reset:0001')`;
  });
  const accountEmailProbeMirror = await reconcileTourneyMirror({ env, limit: 250 });
  if (accountEmailProbeMirror.failed > 0) {
    const failures = await source`
      select sequence,table_name,operation,last_error_code
      from tourney.mirror_outbox
      where status in ('retry','dead_letter')
      order by sequence
    `;
    process.stderr.write(`[postgres17] mirror cleanup failures ${JSON.stringify(failures)}\n`);
  }
  assert.equal(accountEmailProbeMirror.failed, 0, "account and email probe cleanup mirroring failed");

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`insert into tourney.tourney_players(
      id,username,email,password_hash,status,discord,discord_key,battlenet,
      rank_name,role_play
    ) values(
      'bootstrap-only','bootstrap-only','bootstrap@example.com',
      '$2b$12$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'approved','BootstrapOnly','bootstraponly','Bootstrap#1','Master','Support'
    )`;
  });
  await source`
    update tourney.cutover_metadata set
      primary_backend='supabase', generation=1, writes_paused=true
    where id='tourney'
  `;
  await assert.rejects(
    source`
      select public.roo_enqueue_tourney_fallback_bootstrap(
        'postgres17-null-snapshot',null::jsonb
      )
    `,
    (error) => error.code === "22023",
    "null fallback snapshot was accepted"
  );
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_bracket_lock(id,locked_until,locked_by)
      values('fallback-target-only',now()+interval '1 minute','fixture')
    `;
  });
  const fallbackSnapshot = await readFallbackSnapshot(target);
  const [bootstrapResult] = await source`
    select public.roo_enqueue_tourney_fallback_bootstrap(
      'postgres17-fixture',${source.json(fallbackSnapshot)}
    ) result
  `;
  assert.ok(bootstrapResult.result.upserts_queued >= 1, "fallback bootstrap did not enqueue missing state");
  assert.ok(bootstrapResult.result.deletes_queued >= 1, "fallback bootstrap did not enqueue target-only deletes");
  await reconcileTourneyMirror({ env, limit: 250 });
  await assertSql(target, "select exists(select 1 from tourney_players where id='bootstrap-only') ok", "fallback bootstrap row was not mirrored");
  await assertSql(target, "select not exists(select 1 from tourney_bracket_lock where id='fallback-target-only') ok", "fallback bootstrap target-only row was not deleted");
  const fallbackReplaySnapshot = await readFallbackSnapshot(target);
  const [bootstrapReplay] = await source`
    select public.roo_enqueue_tourney_fallback_bootstrap(
      'postgres17-fixture',${source.json(fallbackReplaySnapshot)}
    ) result
  `;
  if (bootstrapReplay.result.queued > 0) {
    const replayEvents = await source`
      select table_name,operation,record_key
      from tourney.mirror_outbox
      where command_id='fallback-bootstrap:g1:postgres17-fixture'
        and status='pending'
      order by sequence
    `;
    process.stderr.write(`[postgres17] unexpected bootstrap replay ${JSON.stringify(replayEvents)}\n`);
  }
  assert.equal(bootstrapReplay.result.queued, 0, "fallback bootstrap replay was not idempotent");

  let pausedCommandExecutions = 0;
  await assert.rejects(
    executeTourneyCommand({
      commandId: "fixture:database-paused:0001",
      purpose: "players:update-role",
      requestPayload: { fixture: true },
      env,
      callback: async () => {
        pausedCommandExecutions += 1;
        return { body: { ok: true } };
      },
    }),
    (error) => error.code === "TOURNEY_WRITES_PAUSED",
    "database-authoritative pause did not reject an ordinary command"
  );
  assert.equal(pausedCommandExecutions, 0, "paused command executed business work");

  const pausedMaintenance = await executeTourneyCommand({
    commandId: "fixture:paused-maintenance:0001",
    purpose: "accounts:seed",
    requestPayload: { fixture: true },
    env: { ...env, TOURNEY_WRITES_PAUSED: "1" },
    maintenanceWhilePaused: true,
    callback: async () => ({ body: { ok: true } }),
  });
  assert.equal(pausedMaintenance.status, 200, "paused maintenance command was rejected");
  await Promise.all([
    source`
      update tourney.cutover_metadata set writes_paused=false where id='tourney'
    `,
    target`
      update tourney_cutover_metadata set writes_paused=false where id='tourney'
    `,
  ]);

  let commandExecutions = 0;
  const runDuplicateCommand = () => executeTourneyCommand({
    commandId: "fixture:duplicate:0001",
    purpose: "registration:capacity",
    requestPayload: { teamCount: 11 },
    env,
    callback: async () => {
      commandExecutions += 1;
      const sql = await getTourneySql(env);
      const [row] = await sql`
        update tourney_registration_config set team_count=11,updated_at=now()
        where id='legacy-series-2026' returning team_count
      `;
      return { body: { ok: true, teamCount: row.team_count } };
    },
  });
  const duplicateResults = await Promise.all([runDuplicateCommand(), runDuplicateCommand()]);
  assert.equal(commandExecutions, 1, "duplicate command executed business work twice");
  assert.equal(duplicateResults.filter((result) => result.replayed).length, 1);
  assert.deepEqual(duplicateResults[0].body.teamCount, duplicateResults[1].body.teamCount);
  await executeTourneyCommand({
    commandId: "fixture:receipt-recovery:0001",
    purpose: "accounts:seed",
    requestPayload: { fixture: "receipt-recovery" },
    attemptExternalWork: false,
    env,
    callback: async () => ({ body: { ok: true } }),
  });
  const receiptRecovery = await completeRecoveredTourneyCommandReceipts({ env });
  assert.ok(receiptRecovery.completed >= 1, "recovered receipts were not completed");
  await assertSql(
    source,
    "select status='completed' ok from tourney.command_receipts where command_id='fixture:receipt-recovery:0001'",
    "recovered command receipt remained committed"
  );
  await reconcileTourneyMirror({ env, limit: 100 });
  await Promise.all([
    source`update tourney.cutover_metadata set primary_backend='legacy' where id='tourney'`,
    target`update tourney_cutover_metadata set primary_backend='legacy' where id='tourney'`,
  ]);
  const fallbackReplay = await executeTourneyCommand({
    commandId: "fixture:duplicate:0001",
    purpose: "registration:capacity",
    requestPayload: { teamCount: 11 },
    env: { ...env, TOURNEY_DATABASE_MODE: "legacy" },
    callback: async () => {
      commandExecutions += 1;
      throw new Error("fallback replay executed business work");
    },
  });
  assert.equal(fallbackReplay.replayed, true);
  assert.equal(commandExecutions, 1, "manual failover replay executed twice");
  await Promise.all([
    source`update tourney.cutover_metadata set primary_backend='supabase' where id='tourney'`,
    target`update tourney_cutover_metadata set primary_backend='supabase' where id='tourney'`,
  ]);

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:receipt:0001',true)`;
    await sql`insert into tourney.command_receipts(command_id,purpose,request_hash,status,generation,committed_at)
      values('fixture:receipt:0001','players:update',${"a".repeat(64)},'committed',1,now())`;
    await sql`insert into tourney.account_snapshots(
      snapshot_id,version,accounts_json,canonical_hash,generation,created_by
    ) values(
      '20000000-0000-4000-8000-000000000001',1,'[]'::jsonb,${"d".repeat(64)},1,'fixture'
    )`;
    await sql`insert into tourney.external_operations(
      operation_key,command_id,operation_kind,entity_type,entity_id,
      desired_state,desired_state_hash,status,completed_at
    ) values(
      'fixture:external:0001','fixture:receipt:0001','sanity_account_projection',
      'account_snapshot','20000000-0000-4000-8000-000000000001','{}'::jsonb,
      ${"e".repeat(64)},'applied',now()
    )`;
    await sql`insert into tourney.external_operations(
      operation_key,command_id,operation_kind,entity_type,entity_id,
      desired_state,desired_state_hash,status,max_attempts,lease_id,lease_expires_at
    ) values(
      'fixture:external:expired','fixture:receipt:0001','supabase_identity_unlink',
      'account','expired','{}'::jsonb,${"9".repeat(64)},'processing',1,
      '90000000-0000-4000-8000-000000000001',now()-interval '1 minute'
    )`;
    await sql`insert into auth.users(id,email)
      values('30000000-0000-4000-8000-000000000001','fixture@example.com')`;
    await sql`insert into accounts.principals(id)
      values('40000000-0000-4000-8000-000000000001')`;
    await sql`insert into accounts.principal_auth_users(user_id,principal_id)
      values('30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001')`;
    await sql`insert into accounts.tourney_accounts(
      user_id,principal_id,username,role,legacy_sanity_id
    ) values(
      '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
      'player-one','tourney_player','player-1'
    )`;
    await sql`
      update tourney.tourney_players
      set principal_id='40000000-0000-4000-8000-000000000001'
      where id='player-1'
    `;
    await sql`insert into accounts.identity_links(
      principal_id,provider,provider_subject,metadata,last_seen_at
    ) values(
      '40000000-0000-4000-8000-000000000001','discord','500000000000000002',
      '{"username":"fixture"}'::jsonb,now()
    )`;
    await sql`insert into accounts.discord_role_assignments(
      user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
      desired_role,status
    ) values(
      '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
      'player-1','500000000000000001','600000000000000001','tourney_player',
      'participant','pending'
    )`;
  });
  await source`
    update accounts.tourney_accounts set
      credential_version='4', lifecycle_status='removed', active=false
    where user_id='30000000-0000-4000-8000-000000000001'
  `;
  const [staleImport] = await source`
    select public.roo_import_tourney_player_account_v2(${source.json({
      user_id: "30000000-0000-4000-8000-000000000001",
      player_id: "player-1",
      credential_version: "3",
      source_hash: "a".repeat(64),
      status: "approved",
    })}) result
  `;
  assert.equal(staleImport.result.stale, true, "stale player account import was accepted");
  await assertSql(
    source,
    "select credential_version='4' and lifecycle_status='removed' and not active ok from accounts.tourney_accounts where user_id='30000000-0000-4000-8000-000000000001'",
    "stale player account import regressed lifecycle state"
  );
  const [conflictingImport] = await source`
    select public.roo_import_tourney_player_account_v2(${source.json({
      user_id: "30000000-0000-4000-8000-000000000001",
      player_id: "player-1",
      credential_version: "4",
      source_hash: "b".repeat(64),
      status: "removed",
    })}) result
  `;
  assert.equal(
    conflictingImport.result.stale,
    true,
    "same-version player account conflict was accepted"
  );
  await source`
    update accounts.tourney_accounts set
      credential_version='1', lifecycle_status='approved', active=true
    where user_id='30000000-0000-4000-8000-000000000001'
  `;
  const typedDiscordCommand = await executeTourneyCommand({
    commandId: "fixture:discord-typed-inputs",
    purpose: "discord:backfill",
    requestPayload: { playerId: "player-1" },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await recordTourneyDiscordDesiredState({
        player: { id: "player-1" },
        discordUser: { id: "500000000000000002" },
        guildId: "600000000000000001",
        env,
      }),
    }),
  });
  assert.equal(
    typedDiscordCommand.body.discord_user_id,
    "500000000000000002",
    "nullable Discord identity inputs were not typed"
  );
  const delay = (milliseconds) => new Promise((resolve) =>
    setTimeout(resolve, milliseconds)
  );
  const deferred = () => {
    let resolve;
    const promise = new Promise((settle) => { resolve = settle; });
    return { promise, resolve };
  };
  const readDiscordAssignment = async () => {
    const [row] = await source`
      select discord_user_id,previous_discord_user_id,stale_discord_user_ids,
        generation,status,updated_at
      from accounts.discord_role_assignments
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    return row;
  };
  const runScopedDiscordRepair = ({ commandId, beforeEnqueue } = {}) =>
    executeTourneyCommand({
      commandId,
      purpose: "discord:backfill",
      requestPayload: { playerId: "player-1", discordUserId: "500000000000000002" },
      attemptExternalWork: false,
      env,
      callback: async () => {
        const assignment = await recordTourneyDiscordDesiredState({
          player: { id: "player-1" },
          discordUser: { id: "500000000000000002" },
          guildId: "600000000000000001",
          expectedPrincipalId: "40000000-0000-4000-8000-000000000001",
          forceRepair: true,
          env,
        });
        await beforeEnqueue?.(assignment);
        await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "discord_role_reconcile",
          entityType: "player",
          entityId: "player-1",
          desiredState: { assignment: {
            principalId: assignment.principal_id,
            discordUserId: assignment.discord_user_id,
            desiredRole: assignment.desired_role,
            generation: Number(assignment.generation),
          } },
          env,
        });
        return { body: { ok: true, assignment } };
      },
    });
  const assertRejectedRepair = async ({ commandId, result, assignmentBefore }) => {
    assert.ok(
      ["TOURNEY_DISCORD_IDENTITY_CHANGED", "TOURNEY_IDENTITY_SYNC_PENDING"]
        .includes(result?.error?.code),
      `${commandId} accepted a stale Discord authority snapshot`
    );
    await assertSql(
      source,
      `select not exists(select 1 from tourney.command_receipts where command_id='${commandId}') and not exists(select 1 from tourney.external_operations where command_id='${commandId}') ok`,
      `${commandId} left a receipt or external operation after authority rejection`
    );
    assert.deepEqual(
      await readDiscordAssignment(),
      assignmentBefore,
      `${commandId} mutated desired state after authority rejection`
    );
  };
  const runIdentityFirstRace = async ({ commandId, mutateIdentity, restoreIdentity }) => {
    const assignmentBefore = await readDiscordAssignment();
    const mutationReady = deferred();
    const releaseMutation = deferred();
    const mutation = source.begin(async (sql) => {
      await mutateIdentity(sql);
      mutationReady.resolve();
      await releaseMutation.promise;
    });
    await mutationReady.promise;
    let repairSettled = false;
    const repair = runScopedDiscordRepair({ commandId })
      .then((value) => ({ value }), (error) => ({ error }))
      .finally(() => { repairSettled = true; });
    await delay(150);
    assert.equal(repairSettled, false, `${commandId} bypassed the identity row lock`);
    releaseMutation.resolve();
    await mutation;
    const result = await repair;
    await assertRejectedRepair({ commandId, result, assignmentBefore });
    await restoreIdentity();
  };
  await runIdentityFirstRace({
    commandId: "fixture:discord-concurrent-relink-first",
    mutateIdentity: (sql) => sql`
      update accounts.identity_links set provider_subject='500000000000000003'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `,
    restoreIdentity: () => source`
      update accounts.identity_links set provider_subject='500000000000000002'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `,
  });
  await runIdentityFirstRace({
    commandId: "fixture:discord-concurrent-unlink-first",
    mutateIdentity: (sql) => sql`
      delete from accounts.identity_links
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `,
    restoreIdentity: () => source`
      insert into accounts.identity_links(
        principal_id,provider,provider_subject,metadata,last_seen_at
      ) values(
        '40000000-0000-4000-8000-000000000001','discord','500000000000000002',
        '{"username":"fixture"}'::jsonb,now()
      )
    `,
  });

  const principalMismatchBefore = await readDiscordAssignment();
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`update tourney.tourney_players set principal_id=null where id='player-1'`;
  });
  const mismatchCommandId = "fixture:discord-player-principal-mismatch";
  const mismatchResult = await runScopedDiscordRepair({ commandId: mismatchCommandId })
    .then((value) => ({ value }), (error) => ({ error }));
  await assertRejectedRepair({
    commandId: mismatchCommandId,
    result: mismatchResult,
    assignmentBefore: principalMismatchBefore,
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.tourney_players
      set principal_id='40000000-0000-4000-8000-000000000001'
      where id='player-1'
    `;
  });

  const repairFirstBaseline = await readDiscordAssignment();
  const repairLocked = deferred();
  const releaseRepair = deferred();
  let lockedAssignment;
  const repairFirstCommandId = "fixture:discord-concurrent-repair-first";
  const repairFirst = runScopedDiscordRepair({
    commandId: repairFirstCommandId,
    beforeEnqueue: async (assignment) => {
      lockedAssignment = assignment;
      repairLocked.resolve();
      await releaseRepair.promise;
    },
  });
  await repairLocked.promise;
  let relinkSettled = false;
  const relinkAfterRepair = source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:discord-relink-after-repair',true)
    `;
    await sql`
      update accounts.identity_links set provider_subject='500000000000000004'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `;
    const [refreshed] = await sql`
      select public.roo_refresh_discord_role_assignment(
        '30000000-0000-4000-8000-000000000001',
        '600000000000000001'
      ) assignment
    `;
    return refreshed.assignment;
  }).finally(() => { relinkSettled = true; });
  await delay(150);
  assert.equal(relinkSettled, false, "Discord relink bypassed the repair identity lock");
  releaseRepair.resolve();
  await repairFirst;
  const relinkedAssignment = await relinkAfterRepair;
  assert.equal(relinkedAssignment.discord_user_id, "500000000000000004");
  assert.ok(
    Number(relinkedAssignment.generation) > Number(lockedAssignment.generation),
    "post-repair relink did not supersede the locked repair generation"
  );

  const staleRepairMethods = [];
  const staleRepairServer = createServer((request, response) => {
    staleRepairMethods.push(request.method);
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ roles: [] }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    staleRepairServer.once("error", reject);
    staleRepairServer.listen(0, "127.0.0.1", resolve);
  });
  const staleRepairAddress = staleRepairServer.address();
  try {
    const reconciled = await reconcileTourneyExternalOperations({
      env: {
        ...env,
        DISCORD_API_BASE_URL: `http://127.0.0.1:${staleRepairAddress.port}`,
        DISCORD_PARTICIPANT_ROLE_ID: "700000000000000001",
        DISCORD_HOST_ROLE_ID: "700000000000000002",
      },
      commandId: repairFirstCommandId,
      limit: 10,
    });
    assert.equal(reconciled.applied, 1, "superseded repair operation was not retired");
  } finally {
    await new Promise((resolve) => staleRepairServer.close(resolve));
  }
  assert.ok(
    staleRepairMethods.every((method) => method === "GET"),
    "superseded repair generation reached a Discord mutation"
  );
  await source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:discord-relink-reset',true)
    `;
    await sql`
      update accounts.identity_links set provider_subject='500000000000000002'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `;
    await sql`
      select public.roo_refresh_discord_role_assignment(
        '30000000-0000-4000-8000-000000000001',
        '600000000000000001'
      )
    `;
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        previous_discord_user_id=${repairFirstBaseline.previous_discord_user_id || null},
        stale_discord_user_ids=${repairFirstBaseline.stale_discord_user_ids}::text[]
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:discord-race-cleanup',true)
    `;
    await sql`
      delete from tourney.external_operations
      where command_id=${repairFirstCommandId}
    `;
    await sql`
      delete from tourney.command_receipts
      where command_id=${repairFirstCommandId}
    `;
  });
  process.stderr.write("[postgres17] Discord identity transaction fencing verified\n");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='blocked_reauth', applied_role='participant',
        applied_generation=generation, blocked_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      insert into auth.users(id,email)
      values('30000000-0000-4000-8000-000000000002','fixture-secondary@example.com')
    `;
    await sql`
      insert into accounts.principal_auth_users(user_id,principal_id,is_primary)
      values(
        '30000000-0000-4000-8000-000000000002',
        '40000000-0000-4000-8000-000000000001',false
      )
    `;
    await sql`
      insert into accounts.oauth_intents(
        id,status,expires_at,provider,flow,action,target_user_id,claimed_user_id,principal_id
      ) values(
        '10000000-0000-4000-8000-000000000098','completed',now()+interval '5 minutes',
        'discord','tourney','link','30000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        '40000000-0000-4000-8000-000000000001'
      )
    `;
  });
  const projectedDiscordAssignment = await projectTourneyDiscordOAuthDesiredState({
    claimedUserId: "30000000-0000-4000-8000-000000000002",
    commandId: "fixture:discord-principal-reauth",
    intentId: "10000000-0000-4000-8000-000000000098",
    userId: "30000000-0000-4000-8000-000000000001",
    env: {
      ...env,
      DISCORD_BOT_TOKEN: "fixture-bot-token",
      DISCORD_GUILD_ID: "600000000000000001",
      DISCORD_PARTICIPANT_ROLE_ID: "700000000000000001",
      DISCORD_HOST_ROLE_ID: "700000000000000002",
    },
  });
  assert.equal(
    projectedDiscordAssignment.status,
    "pending",
    "same-principal Discord reauthentication did not rearm membership"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='blocked_reauth', blocked_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,result_status,result_body,
        generation,failed_at,failure_code,failure_evidence
      ) values(
        'fixture:discord-old-deadletter','discord:backfill',${"8".repeat(64)},
        'failed',200,'{"ok":true}'::jsonb,1,now()-interval '1 day',
        'side_effect_terminal',
        '{"externalOperations":["fixture:discord-old-deadletter:op"],"emailDispatches":[]}'::jsonb
      )
    `;
    await sql`
      insert into tourney.external_operations(
        operation_key,command_id,operation_kind,entity_type,entity_id,
        serialization_key,desired_state,desired_state_hash,status,
        attempt_count,max_attempts,created_at,updated_at
      ) values(
        'fixture:discord-old-deadletter:op','fixture:discord-old-deadletter',
        'discord_role_reconcile','player','player-1',
        'discord:40000000-0000-4000-8000-000000000001','{}'::jsonb,
        ${"9".repeat(64)},'dead_letter',12,12,
        now()-interval '1 day',now()-interval '1 day'
      )
    `;
  });
  const freshDiscordCommand = await executeTourneyCommand({
    commandId: "fixture:discord-fresh-oauth",
    purpose: "discord:link",
    requestPayload: { playerId: "player-1", freshCredentials: true },
    attemptExternalWork: false,
    env,
    callback: async () => ({
      body: await recordTourneyDiscordDesiredState({
        player: { id: "player-1" },
        discordUser: { id: "500000000000000002" },
        guildId: "600000000000000001",
        freshCredentials: true,
        env,
      }),
    }),
  });
  assert.equal(
    freshDiscordCommand.body.status,
    "pending",
    "fresh same-identity OAuth did not rearm blocked membership"
  );
  const pendingDiscordStatus = await getTourneyDiscordStatusForPlayer({
    playerId: "player-1",
    env,
  });
  assert.deepEqual(
    {
      linked: pendingDiscordStatus.linked,
      roleAssigned: pendingDiscordStatus.roleAssigned,
      state: pendingDiscordStatus.state,
    },
    { linked: true, roleAssigned: false, state: "pending" },
    "pending Discord role state was reported as ready"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied', applied_role='participant',
        applied_generation=generation-1
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const mismatchedDiscordStatus = await getTourneyDiscordStatusForPlayer({
    playerId: "player-1",
    env,
  });
  assert.deepEqual(
    {
      linked: mismatchedDiscordStatus.linked,
      roleAssigned: mismatchedDiscordStatus.roleAssigned,
      state: mismatchedDiscordStatus.state,
    },
    { linked: true, roleAssigned: false, state: "pending" },
    "stale applied Discord generation was reported as ready"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        applied_generation=generation
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      update accounts.identity_links set provider_subject='500000000000000003'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `;
  });
  const staleIdentityDiscordStatus = await getTourneyDiscordStatusForPlayer({
    playerId: "player-1",
    env,
  });
  assert.deepEqual(
    {
      linked: staleIdentityDiscordStatus.linked,
      roleAssigned: staleIdentityDiscordStatus.roleAssigned,
      state: staleIdentityDiscordStatus.state,
    },
    { linked: true, roleAssigned: false, state: "pending" },
    "role on a superseded Discord identity was reported as ready"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.identity_links set provider_subject='500000000000000002'
      where principal_id='40000000-0000-4000-8000-000000000001'
        and provider='discord'
    `;
    await sql`
      update accounts.discord_role_assignments set status='pending'
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const deferredUntil = new Date(Date.now() + 60_000).toISOString();
  await executeTourneyCommand({
    commandId: "fixture:discord-oauth-deferred",
    purpose: "discord:link",
    requestPayload: { intentId: "10000000-0000-4000-8000-000000000099" },
    attemptExternalWork: false,
    env,
    callback: async () => {
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-oauth-deferred",
        operationKind: "discord_membership",
        entityType: "account",
        entityId: "30000000-0000-4000-8000-000000000001",
        desiredState: {
          oauthProjection: {
            intentId: "10000000-0000-4000-8000-000000000099",
            userId: "30000000-0000-4000-8000-000000000001",
          },
        },
        nextAttemptAt: deferredUntil,
        env,
      });
      return { body: { ok: true } };
    },
  });
  await assertSql(
    source,
    "select next_attempt_at > now()+interval '30 seconds' ok from tourney.external_operations where command_id='fixture:discord-oauth-deferred'",
    "recoverable OAuth work was claimable before finalization"
  );
  assert.equal(
    await rearmTourneyExternalOperation({
      commandId: "fixture:discord-oauth-deferred",
      operationKind: "discord_membership",
      entityType: "account",
      entityId: "30000000-0000-4000-8000-000000000001",
      env,
    }),
    true,
    "finalized OAuth did not rearm its durable operation"
  );
  await assertSql(
    source,
    "select status='pending' and next_attempt_at <= now() ok from tourney.external_operations where command_id='fixture:discord-oauth-deferred'",
    "finalized OAuth operation was not made immediately claimable"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:discord-oauth-deferred',true)`;
    await sql`delete from tourney.external_operations where command_id='fixture:discord-oauth-deferred'`;
  });

  await source`
    insert into accounts.oauth_intents(
      id,status,expires_at,provider,flow,action,target_user_id
    ) values(
      '10000000-0000-4000-8000-000000000097','pending',
      now()+interval '5 minutes','discord','tourney','link',
      '30000000-0000-4000-8000-000000000001'
    )
  `;
  await executeTourneyCommand({
    commandId: "fixture:discord-oauth-finalize-failed",
    purpose: "discord:link",
    requestPayload: { intentId: "10000000-0000-4000-8000-000000000097" },
    attemptExternalWork: false,
    env,
    callback: async () => {
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-oauth-finalize-failed",
        operationKind: "discord_membership",
        entityType: "account",
        entityId: "30000000-0000-4000-8000-000000000001",
        desiredState: {
          oauthProjection: {
            intentId: "10000000-0000-4000-8000-000000000097",
            userId: "30000000-0000-4000-8000-000000000001",
          },
        },
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        env,
      });
      return { body: { ok: true } };
    },
  });
  const failedFinalizeResolution =
    await resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure({
      commandId: "fixture:discord-oauth-finalize-failed",
      intentId: "10000000-0000-4000-8000-000000000097",
      userId: "30000000-0000-4000-8000-000000000001",
      env,
    });
  assert.deepEqual(
    failedFinalizeResolution,
    { finalized: false, resolved: true },
    "failed OAuth finalization left its projection unresolved"
  );
  await assertSql(
    source,
    "select operation.status='applied' and receipt.status='completed' ok from tourney.external_operations operation join tourney.command_receipts receipt using(command_id) where operation.command_id='fixture:discord-oauth-finalize-failed'",
    "failed OAuth finalization left pending operation or receipt work"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:discord-oauth-finalize-cleanup',true)`;
    await sql`delete from tourney.external_operations where command_id='fixture:discord-oauth-finalize-failed'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:discord-oauth-finalize-failed'`;
    await sql`delete from accounts.oauth_intents where id='10000000-0000-4000-8000-000000000097'`;
  });
  const failedFinalizeCleanup = await reconcileTourneyMirror({ env, limit: 100 });
  const failedFinalizeErrors = failedFinalizeCleanup.failed > 0
    ? await source`
        select table_name,last_error_code,status
        from tourney.mirror_outbox
        where status in ('retry','dead_letter')
        order by sequence desc limit 10
      `
    : [];
  assert.equal(
    failedFinalizeCleanup.failed,
    0,
    `failed OAuth fixture cleanup did not mirror: ${JSON.stringify(failedFinalizeErrors)}`
  );

  await source`
    insert into auth.users(id,email)
    values('30000000-0000-4000-8000-000000000003','delayed-signup@example.com')
  `;
  await source`
    insert into accounts.principals(id)
    values('40000000-0000-4000-8000-000000000003')
  `;
  await source`
    insert into accounts.principal_auth_users(user_id,principal_id,is_primary)
    values(
      '30000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000003',true
    )
  `;
  await source`
    insert into accounts.oauth_intents(
      id,status,expires_at,provider,flow,action,claimed_user_id,principal_id
    ) values(
      '10000000-0000-4000-8000-000000000096','completed',
      now()-interval '15 minutes','discord','tourney','signup',
      '30000000-0000-4000-8000-000000000003',
      '40000000-0000-4000-8000-000000000003'
    )
  `;
  let delayedSignupOperationKey = "";
  await executeTourneyCommand({
    commandId: "fixture:discord-signup-delayed",
    purpose: "discord:link",
    requestPayload: { intentId: "10000000-0000-4000-8000-000000000096" },
    attemptExternalWork: false,
    env,
    callback: async () => {
      const operation = await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-signup-delayed",
        operationKind: "discord_membership",
        entityType: "account",
        entityId: "30000000-0000-4000-8000-000000000003",
        desiredState: {
          oauthProjection: {
            intentId: "10000000-0000-4000-8000-000000000096",
            userId: "30000000-0000-4000-8000-000000000003",
            claimedUserId: "30000000-0000-4000-8000-000000000003",
          },
        },
        env,
      });
      delayedSignupOperationKey = operation.operation_key;
      return { body: { ok: true } };
    },
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.external_operations set
        status='pending',attempt_count=max_attempts,next_attempt_at=now(),
        lease_id=null,lease_expires_at=null
      where operation_key=${delayedSignupOperationKey}
    `;
    await sql`
      insert into tourney.external_operation_secrets(
        operation_key,encrypted_payload,expires_at
      ) values(
        ${delayedSignupOperationKey},${"e".repeat(64)},now()+interval '1 hour'
      )
    `;
  });
  const delayedSignupRetry = await reconcileTourneyExternalOperations({
    commandId: "fixture:discord-signup-delayed",
    env,
    limit: 1,
  });
  assert.deepEqual(
    delayedSignupRetry,
    { claimed: 1, applied: 0, retried: 1, deadLettered: 0 },
    "live delayed-signup credential dead-lettered at the generic attempt limit"
  );
  await assertSql(
    source,
    `select operation.status='retry'
       and operation.serialization_key='discord:40000000-0000-4000-8000-000000000003'
       and secret.operation_key is not null ok
     from tourney.external_operations operation
     left join tourney.external_operation_secrets secret using(operation_key)
     where operation.operation_key='${delayedSignupOperationKey}'`,
    "live delayed-signup credential was not preserved or canonicalized to its principal"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.external_operation_secrets set expires_at=now()-interval '1 second'
      where operation_key=${delayedSignupOperationKey}
    `;
    await sql`
      update tourney.external_operations set next_attempt_at=now()
      where operation_key=${delayedSignupOperationKey}
    `;
  });
  const delayedSignupExpired = await reconcileTourneyExternalOperations({
    commandId: "fixture:discord-signup-delayed",
    env,
    limit: 1,
  });
  assert.deepEqual(
    delayedSignupExpired,
    { claimed: 1, applied: 0, retried: 0, deadLettered: 1 },
    "expired delayed-signup credential did not become terminal"
  );
  await assertSql(
    source,
    `select operation.status='dead_letter' and secret.operation_key is null ok
     from tourney.external_operations operation
     left join tourney.external_operation_secrets secret using(operation_key)
     where operation.operation_key='${delayedSignupOperationKey}'`,
    "expired delayed-signup credential was not cleaned up"
  );
  await source.begin(async (sql) => {
    await sql`
      select set_config('roo.tourney_backend','supabase',true),
        set_config('roo.tourney_mirror_enabled','1',true),
        set_config('roo.tourney_generation','1',true),
        set_config('roo.tourney_command_id','fixture:discord-signup-delayed-cleanup',true)
    `;
    await sql`delete from tourney.external_operations where operation_key=${delayedSignupOperationKey}`;
    await sql`delete from tourney.command_receipts where command_id='fixture:discord-signup-delayed'`;
    await sql`delete from accounts.oauth_intents where id='10000000-0000-4000-8000-000000000096'`;
    await sql`delete from accounts.principal_auth_users where user_id='30000000-0000-4000-8000-000000000003'`;
    await sql`delete from accounts.principals where id='40000000-0000-4000-8000-000000000003'`;
    await sql`delete from auth.users where id='30000000-0000-4000-8000-000000000003'`;
  });
  const delayedSignupCleanup = await reconcileTourneyMirror({ env, limit: 100 });
  assert.equal(
    delayedSignupCleanup.failed,
    0,
    "delayed Discord signup cleanup did not mirror"
  );

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied', applied_role='participant',
        applied_generation=generation, previous_discord_user_id=null,
        lease_id=null, lease_expires_at=null
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await executeTourneyCommand({
    commandId: "fixture:discord-repeat-repair",
    purpose: "discord:backfill",
    requestPayload: { playerId: "player-1", forceRepair: true },
    attemptExternalWork: false,
    env,
    callback: async () => {
      const assignment = await recordTourneyDiscordDesiredState({
        player: { id: "player-1" },
        discordUser: { id: "500000000000000002" },
        guildId: "600000000000000001",
        forceRepair: true,
        env,
      });
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-repeat-repair",
        operationKind: "discord_role_reconcile",
        entityType: "player",
        entityId: "player-1",
        desiredState: { assignment: {
          principalId: assignment.principal_id,
          discordUserId: assignment.discord_user_id,
          previousDiscordUserId: assignment.previous_discord_user_id || "",
          desiredRole: assignment.desired_role,
          generation: Number(assignment.generation),
        } },
        env,
      });
      return { body: { status: assignment.status } };
    },
  });
  const repeatMethods = [];
  const repeatServer = createServer((request, response) => {
    repeatMethods.push(request.method);
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ roles: [] }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    repeatServer.once("error", reject);
    repeatServer.listen(0, "127.0.0.1", resolve);
  });
  const repeatAddress = repeatServer.address();
  const repeatWorkerEnv = {
    ...env,
    TOURNEY_MIRROR_ENABLED: "0",
    DISCORD_API_BASE_URL: `http://127.0.0.1:${repeatAddress.port}`,
    DISCORD_BOT_TOKEN: "fixture-bot-token",
    DISCORD_GUILD_ID: "600000000000000001",
    DISCORD_PARTICIPANT_ROLE_ID: "700000000000000001",
    DISCORD_HOST_ROLE_ID: "700000000000000002",
  };
  try {
    const repeated = await reconcileTourneyExternalOperations({
      env: repeatWorkerEnv,
      commandId: "fixture:discord-repeat-repair",
      limit: 10,
    });
    assert.equal(repeated.applied, 1, "repeat repair was not applied");
  } finally {
    await new Promise((resolve) => repeatServer.close(resolve));
  }
  assert.deepEqual(
    repeatMethods,
    ["GET", "PUT", "GET"],
    "repeat repair did not verify the current and superseded Discord identities"
  );
  await assertSql(
    source,
    "select status='applied' and last_error_code='superseded_by_applied_authoritative_projection' ok from tourney.external_operations where operation_key='fixture:discord-old-deadletter:op'",
    "authoritative Discord repair did not retire the older same-state dead letter"
  );
  const repairedDeadLetterReceipt = await completeRecoveredTourneyCommandReceipts({ env });
  assert.ok(repairedDeadLetterReceipt.recovered >= 1);
  await assertSql(
    source,
    "select status='completed' and recovered_at is not null ok from tourney.command_receipts where command_id='fixture:discord-old-deadletter'",
    "repaired Discord dead-letter receipt did not recover"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.external_operations where operation_key='fixture:discord-old-deadletter:op'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:discord-old-deadletter'`;
  });
  const appliedDiscordStatus = await getTourneyDiscordStatusForPlayer({
    playerId: "player-1",
    env,
  });
  assert.deepEqual(
    {
      linked: appliedDiscordStatus.linked,
      roleAssigned: appliedDiscordStatus.roleAssigned,
      state: appliedDiscordStatus.state,
    },
    { linked: true, roleAssigned: true, state: "applied" },
    "applied Discord role state was not reported as ready"
  );

  await executeTourneyCommand({
    commandId: "fixture:discord-generation-fence",
    purpose: "discord:backfill",
    requestPayload: { playerId: "player-1", forceRepair: true },
    attemptExternalWork: false,
    env,
    callback: async () => {
      const assignment = await recordTourneyDiscordDesiredState({
        player: { id: "player-1" },
        discordUser: { id: "500000000000000002" },
        guildId: "600000000000000001",
        forceRepair: true,
        env,
      });
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-generation-fence",
        operationKind: "discord_role_reconcile",
        entityType: "player",
        entityId: "player-1",
        desiredState: { assignment: {
          principalId: assignment.principal_id,
          discordUserId: assignment.discord_user_id,
          previousDiscordUserId: assignment.previous_discord_user_id || "",
          desiredRole: assignment.desired_role,
          generation: Number(assignment.generation),
        } },
        env,
      });
      return { body: { ok: true } };
    },
  });
  const fenceMethods = [];
  const fenceServer = createServer(async (request, response) => {
    fenceMethods.push(request.method);
    if (request.method !== "GET") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      await source.begin(async (sql) => {
        await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
        await sql`
          update accounts.discord_role_assignments set
            generation=generation+1, status='pending',
            lease_id=null, lease_expires_at=null, updated_at=now()
          where principal_id='40000000-0000-4000-8000-000000000001'
        `;
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ roles: [] }));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    fenceServer.once("error", reject);
    fenceServer.listen(0, "127.0.0.1", resolve);
  });
  const fenceAddress = fenceServer.address();
  try {
    const fenced = await reconcileTourneyExternalOperations({
      env: {
        ...repeatWorkerEnv,
        DISCORD_API_BASE_URL: `http://127.0.0.1:${fenceAddress.port}`,
      },
      commandId: "fixture:discord-generation-fence",
      limit: 10,
    });
    assert.equal(fenced.applied, 1, "superseded Discord generation was not retired");
  } finally {
    await new Promise((resolve) => fenceServer.close(resolve));
  }
  assert.deepEqual(fenceMethods, ["GET"], "stale Discord generation reached a provider mutation");

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied', applied_role=desired_role,
        applied_generation=generation, lease_id=null, lease_expires_at=null
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      update accounts.tourney_accounts set active=false,lifecycle_status='withdrawn'
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await executeTourneyCommand({
    commandId: "fixture:discord-role-removal",
    purpose: "discord:backfill",
    requestPayload: { playerId: "player-1", desiredRole: "none" },
    attemptExternalWork: false,
    env,
    callback: async () => {
      const sql = await getTourneySql(env);
      const [refreshed] = await sql`
        select public.roo_refresh_discord_role_assignment(
          '30000000-0000-4000-8000-000000000001',
          '600000000000000001'
        ) result
      `;
      const assignment = refreshed.result;
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-role-removal",
        operationKind: "discord_role_reconcile",
        entityType: "player",
        entityId: "player-1",
        desiredState: { assignment: {
          principalId: assignment.principal_id,
          discordUserId: assignment.discord_user_id,
          previousDiscordUserId: assignment.previous_discord_user_id || "",
          desiredRole: assignment.desired_role,
          generation: Number(assignment.generation),
        } },
        env,
      });
      return { body: assignment };
    },
  });
  const removalMethods = [];
  const removalServer = createServer((request, response) => {
    removalMethods.push(request.method);
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ roles: ["700000000000000001"] }));
      return;
    }
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve, reject) => {
    removalServer.once("error", reject);
    removalServer.listen(0, "127.0.0.1", resolve);
  });
  const removalAddress = removalServer.address();
  try {
    const removed = await reconcileTourneyExternalOperations({
      env: {
        ...repeatWorkerEnv,
        DISCORD_API_BASE_URL: `http://127.0.0.1:${removalAddress.port}`,
      },
      commandId: "fixture:discord-role-removal",
      limit: 10,
    });
    assert.equal(removed.applied, 1, "Discord managed-role removal was not applied");
  } finally {
    await new Promise((resolve) => removalServer.close(resolve));
  }
  assert.deepEqual(removalMethods, ["GET", "DELETE"], "Discord managed role was not removed");
  await assertSql(
    source,
    "select player_id='player-1' and status='applied' and desired_role='none' and applied_role='none' ok from accounts.discord_role_assignments where principal_id='40000000-0000-4000-8000-000000000001'",
    "durable Discord role removal state was not accurate"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.tourney_accounts set active=true,lifecycle_status='approved'
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      update accounts.discord_role_assignments set
        desired_role='participant', applied_role='participant',
        generation=generation+1, applied_generation=generation+1,
        status='pending', previous_discord_user_id=null,
        lease_id=null, lease_expires_at=null, last_error=null, blocked_at=null
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const [rateAssignment] = await source`
    select generation from accounts.discord_role_assignments
    where principal_id='40000000-0000-4000-8000-000000000001'
  `;

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,generation,committed_at
      ) values
        ('fixture:discord-rate:0001','discord:backfill',${"1".repeat(64)},'committed',1,now()),
        ('fixture:discord-rate:0002','discord:backfill',${"2".repeat(64)},'committed',1,now())
    `;
    const desiredState = { assignment: {
      principalId: "40000000-0000-4000-8000-000000000001",
      discordUserId: "500000000000000002",
      previousDiscordUserId: "",
      desiredRole: "participant",
      generation: Number(rateAssignment.generation),
    } };
    await sql`
      insert into tourney.external_operations(
        operation_key,command_id,operation_kind,entity_type,entity_id,
        desired_state,desired_state_hash,status
      ) values
        ('fixture:discord-rate-operation:0001','fixture:discord-rate:0001',
          'discord_role_reconcile','player','player-1',${sql.json(desiredState)},
          ${"3".repeat(64)},'pending'),
        ('fixture:discord-rate-operation:0002','fixture:discord-rate:0002',
          'discord_role_reconcile','player','player-1',${sql.json(desiredState)},
          ${"4".repeat(64)},'pending')
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_command_receipts(
        command_id,purpose,request_hash,status,generation,committed_at
      ) values
        ('fixture:discord-rate:0001','discord:backfill',${"1".repeat(64)},'committed',1,now()),
        ('fixture:discord-rate:0002','discord:backfill',${"2".repeat(64)},'committed',1,now())
      on conflict(command_id) do nothing
    `;
  });
  let discordRequests = 0;
  const discordServer = createServer((_request, response) => {
    discordRequests += 1;
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "1.5",
      "X-RateLimit-Global": "true",
    });
    response.end(JSON.stringify({ retry_after: 1.5, global: true }));
  });
  await new Promise((resolve, reject) => {
    discordServer.once("error", reject);
    discordServer.listen(0, "127.0.0.1", resolve);
  });
  const discordAddress = discordServer.address();
  const workerEnv = {
    ...env,
    TOURNEY_MIRROR_ENABLED: "0",
    DISCORD_API_BASE_URL: `http://127.0.0.1:${discordAddress.port}`,
    DISCORD_BOT_TOKEN: "fixture-bot-token",
    DISCORD_GUILD_ID: "600000000000000001",
    DISCORD_PARTICIPANT_ROLE_ID: "700000000000000001",
    DISCORD_HOST_ROLE_ID: "700000000000000002",
  };
  let externalFailure;
  try {
    externalFailure = await reconcileTourneyExternalOperations({
      env: workerEnv,
      limit: 10,
    });
  } finally {
    await new Promise((resolve) => discordServer.close(resolve));
  }
  assert.equal(externalFailure.deadLettered, 1, "invalid exhausted work did not dead-letter safely");
  assert.equal(externalFailure.retried, 1, "Discord global rate limit was not durably retried");
  assert.equal(discordRequests, 1, "global Discord rate limit did not fence the remaining worker batch");
  await assertSql(
    source,
    "select count(*)=2 and count(*) filter(where status='retry')=1 and count(*) filter(where status='pending')=1 and bool_and(last_error_code='discord_global_rate_limited') and bool_and(next_attempt_at >= now()+interval '1 second') ok from tourney.external_operations where operation_key like 'fixture:discord-rate-operation:%'",
    "Discord Retry-After was not preserved in durable scheduling"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.external_operations set next_attempt_at=now()+interval '1 hour'
      where operation_key='fixture:discord-rate-operation:0002'
    `;
  });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  await executeTourneyCommand({
    commandId: "fixture:discord-global-expiry",
    purpose: "discord:backfill",
    requestPayload: { playerId: "player-1", forceRepair: true },
    attemptExternalWork: false,
    env,
    callback: async () => {
      const assignment = await recordTourneyDiscordDesiredState({
        player: { id: "player-1" },
        discordUser: { id: "500000000000000002" },
        guildId: "600000000000000001",
        forceRepair: true,
        env,
      });
      await enqueueTourneyExternalOperation({
        commandId: "fixture:discord-global-expiry",
        operationKind: "discord_role_reconcile",
        entityType: "player",
        entityId: "player-1",
        desiredState: { assignment: {
          principalId: assignment.principal_id,
          discordUserId: assignment.discord_user_id,
          previousDiscordUserId: assignment.previous_discord_user_id || "",
          desiredRole: assignment.desired_role,
          generation: Number(assignment.generation),
        } },
        env,
      });
      return { body: { ok: true } };
    },
  });
  let postLimitRequests = 0;
  const postLimitServer = createServer((_request, response) => {
    postLimitRequests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ roles: ["700000000000000001"] }));
  });
  await new Promise((resolve, reject) => {
    postLimitServer.once("error", reject);
    postLimitServer.listen(0, "127.0.0.1", resolve);
  });
  const postLimitAddress = postLimitServer.address();
  try {
    const resumed = await reconcileTourneyExternalOperations({
      env: {
        ...workerEnv,
        DISCORD_API_BASE_URL: `http://127.0.0.1:${postLimitAddress.port}`,
      },
      commandId: "fixture:discord-global-expiry",
      limit: 10,
    });
    assert.equal(resumed.applied, 1, "Discord work did not resume after the global window");
  } finally {
    await new Promise((resolve) => postLimitServer.close(resolve));
  }
  assert.equal(postLimitRequests, 1, "an unrelated future retry extended the global rate limit");
  await assertSql(
    source,
    "select count(*)=0 ok from tourney.external_operations where last_error_code='discord_global_rate_limited'",
    "expired Discord global rate limit remained active"
  );
  await assertSql(source, "select status='dead_letter' ok from tourney.external_operations where operation_key='fixture:external:expired'", "external operation was not dead-lettered");
  const terminalReceiptRecovery = await completeRecoveredTourneyCommandReceipts({ env });
  assert.equal(terminalReceiptRecovery.failed, 1, "dead-lettered work did not fail its receipt");
  await assertSql(
    source,
    "select status='failed' and failed_at is not null ok from tourney.command_receipts where command_id='fixture:receipt:0001'",
    "terminal command receipt remained committed"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:external-cleanup',true)`;
    await sql`
      delete from tourney.external_operations
      where operation_key='fixture:external:expired'
         or command_id in (
           'fixture:discord-repeat-repair',
           'fixture:discord-generation-fence',
           'fixture:discord-role-removal',
           'fixture:discord-global-expiry'
         )
    `;
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney.external_operations
      where operation_key like 'fixture:discord-rate-operation:%'
    `;
    await sql`
      delete from tourney.command_receipts
      where command_id in ('fixture:discord-rate:0001','fixture:discord-rate:0002')
    `;
    await sql`
      delete from tourney.mirror_outbox
      where table_name='external_operations'
        and record_key->>'operation_key' like 'fixture:discord-rate-operation:%'
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney_external_operations
      where operation_key like 'fixture:discord-rate-operation:%'
    `;
    await sql`
      delete from tourney_command_receipts
      where command_id in ('fixture:discord-rate:0001','fixture:discord-rate:0002')
    `;
  });
  const receiptDependencyMirror = await reconcileTourneyMirror({ env, limit: 1 });
  assert.equal(receiptDependencyMirror.failed, 0, "receipt dependency mirroring failed");
  await assertSql(target, "select exists(select 1 from tourney_command_receipts where command_id='fixture:receipt:0001') ok", "receipt was not mirrored");
  const concurrentMirrors = await Promise.all([
    reconcileTourneyMirror({ env, limit: 1 }),
    reconcileTourneyMirror({ env, limit: 100 }),
  ]);
  if (concurrentMirrors.some((result) => result.failed > 0)) {
    const failures = await source`
      select sequence,command_id,table_name,operation,last_error_code
      from tourney.mirror_outbox
      where status in ('retry','dead_letter')
      order by sequence
    `;
    process.stderr.write(`[postgres17] concurrent mirror failures ${JSON.stringify(failures)}\n`);
  }
  assert.equal(
    concurrentMirrors.reduce((count, result) => count + result.failed, 0),
    0,
    "concurrent mirror workers left retryable failures"
  );
  process.stderr.write("[postgres17] concurrent claims verified\n");
  const [mirroredControlCounts] = await target`
    select
      (select count(*)::integer from tourney_account_snapshots) account_snapshots,
      (select count(*)::integer from tourney_external_operations) external_operations,
      (select count(*)::integer from tourney_discord_role_assignments) discord_assignments
  `;
  assert.deepEqual(
    mirroredControlCounts,
    { account_snapshots: 1, external_operations: 1, discord_assignments: 1 },
    "control, account snapshot, external operation, or Discord state was not mirrored"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney.external_operations
      where command_id='fixture:receipt:0001'
    `;
    await sql`
      delete from tourney.command_receipts
      where command_id='fixture:receipt:0001'
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney_external_operations
      where command_id='fixture:receipt:0001'
    `;
    await sql`
      delete from tourney_command_receipts
      where command_id='fixture:receipt:0001'
    `;
  });

  const playerRecordKeyHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ id: "player-1" }))
    .digest("hex");
  const [checkpoint] = await target`
    select record_key_hash from tourney_mirror_checkpoints
    where table_name='tourney_players'
      and record_key_hash=${playerRecordKeyHash}
    limit 1
  `;
  assert.ok(checkpoint?.record_key_hash, "player mirror checkpoint was not found");
  await target`
    update tourney_mirror_checkpoints set generation=2,source_sequence=1
    where table_name='tourney_players' and record_key_hash=${checkpoint.record_key_hash}
  `;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:stale:0001',true)`;
    await sql`update tourney.tourney_players set display_name='stale-value' where id='player-1'`;
  });
  await reconcileTourneyMirror({ env, limit: 100 });
  process.stderr.write("[postgres17] stale generation verified\n");
  const [staleTarget] = await target`select display_name from tourney_players where id='player-1'`;
  assert.notEqual(staleTarget.display_name, "stale-value", "lower generation overwrote newer state");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.tourney_players set display_name=${staleTarget.display_name}
      where id='player-1'
    `;
  });

  await source`
    update tourney.cutover_metadata set
      primary_backend = 'supabase', generation = 1,
      natural_mutation_verified_at = now() - interval '21 minutes'
    where id = 'tourney'
  `;
  const receiptParityRows = JSON.parse(JSON.stringify(
    await source`select * from tourney.command_receipts order by command_id`
  ));
  const externalOperationParityRows = JSON.parse(JSON.stringify(
    await source`select * from tourney.external_operations order by operation_key`
  ));
  const discordParityRows = JSON.parse(JSON.stringify(
    await source`select * from accounts.discord_role_assignments order by principal_id`
  ));
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney_external_operations`;
    await sql`
      insert into tourney_command_receipts
      select * from jsonb_populate_recordset(
        null::tourney_command_receipts,${sql.json(receiptParityRows)}
      )
      on conflict(command_id) do update set
        purpose=excluded.purpose,request_hash=excluded.request_hash,
        status=excluded.status,result_status=excluded.result_status,
        result_body=excluded.result_body,generation=excluded.generation,
        created_at=excluded.created_at,committed_at=excluded.committed_at,
        completed_at=excluded.completed_at,failed_at=excluded.failed_at,
        updated_at=excluded.updated_at
    `;
    await sql`
      delete from tourney_command_receipts
      where command_id not in ${sql(receiptParityRows.map((row) => row.command_id))}
    `;
    if (externalOperationParityRows.length > 0) {
      await sql`
        insert into tourney_external_operations
        select * from jsonb_populate_recordset(
          null::tourney_external_operations,${sql.json(externalOperationParityRows)}
        )
      `;
    }
    await sql`delete from tourney_discord_role_assignments`;
    await sql`
      insert into tourney_discord_role_assignments
      select * from jsonb_populate_recordset(
        null::tourney_discord_role_assignments,${sql.json(discordParityRows)}
      )
    `;
  });
  await source`delete from tourney.parity_runs`;
  const firstClockParity = await runTourneyParity({ env });
  assert.equal(
    firstClockParity.status,
    "clean",
    `first clock parity was not actually clean: ${JSON.stringify(firstClockParity.drift)}`
  );
  await source`
    update tourney.parity_runs set created_at=now()-interval '20 minutes'
    where id=(select id from tourney.parity_runs order by created_at desc limit 1)
  `;
  const secondClockParity = await runTourneyParity({ env });
  assert.equal(secondClockParity.status, "clean", "second clock parity was not actually clean");
  await source`
    insert into tourney.shadow_observations(
      route,shape_match,value_match,ordering_match,error_match,
      primary_latency_ms,shadow_latency_ms,primary_status,shadow_status,observed_at
    )
    select route,true,true,true,true,10,12,200,200,now()-interval '1 minute'
    from unnest(array[
      'public_roster','public_bracket','admin_players','appeals','payouts'
    ]) route cross join generate_series(1,30)
  `;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='blocked_reauth',blocked_at=now(),updated_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const [reauthClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(reauthClock.result.blocker, "discord_blocker", "blocked reauth did not block the clock");
  const [reauthReadiness] = await source`
    select public.roo_tourney_readiness() result
  `;
  assert.ok(
    reauthReadiness.result.clock_blockers.includes("discord_blocker"),
    "blocked reauth did not block readiness"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied',applied_role=desired_role,blocked_at=null,updated_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from tourney.cutover_gate_events
      where event_kind='clock_reset' and evidence->>'reason'='discord_blocker'
    `;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.tourney_player_auth_operations(
        operation_key,player_id,operation_kind,desired_status,
        operation_status,created_at,updated_at
      ) values(
        'clock:auth-overdue','player-1','decision','approved',
        'retry',now()-interval '10 minutes',now()
      )
    `;
  });
  const [authClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(
    authClock.result.blocker,
    "auth_operation_overdue",
    "overdue Supabase Auth operation did not block the clock"
  );
  const [authReadiness] = await source`
    select public.roo_tourney_readiness() result
  `;
  assert.equal(authReadiness.result.auth_operations.overdue, 1);
  assert.ok(
    authReadiness.result.clock_blockers.includes("auth_operation_overdue"),
    "overdue Supabase Auth operation did not block readiness"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney.tourney_player_auth_operations
      where operation_key='clock:auth-overdue'
    `;
    await sql`
      delete from tourney.cutover_gate_events
      where event_kind='clock_reset'
        and evidence->>'reason'='auth_operation_overdue'
    `;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,result_status,result_body,
        generation,committed_at
      ) values(
        'clock:external-overdue','accounts:sync',${"a".repeat(64)},
        'committed',200,'{}'::jsonb,1,now()
      )
    `;
    await sql`
      insert into tourney.external_operations(
        operation_key,command_id,operation_kind,entity_type,entity_id,
        desired_state,desired_state_hash,status,created_at,updated_at
      ) values(
        'clock:external-overdue:operation','clock:external-overdue',
        'sanity_account_projection','account_snapshot','clock',
        '{}'::jsonb,${"b".repeat(64)},'pending',
        now()-interval '10 minutes',now()
      )
    `;
  });
  const [externalClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(externalClock.result.blocker,"external_overdue");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.external_operations where operation_key='clock:external-overdue:operation'`;
    await sql`delete from tourney.command_receipts where command_id='clock:external-overdue'`;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.email_dispatches(
        id,idempotency_key,dispatch_kind,recipient,recipient_hash,payload,
        status,created_at,updated_at
      ) values(
        '91000000-0000-4000-8000-000000000001','clock:email-overdue',
        'registration','clock@example.com',${"c".repeat(64)},'{}'::jsonb,
        'pending',now()-interval '10 minutes',now()
      )
    `;
  });
  const [emailClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(emailClock.result.blocker,"email_overdue");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.email_dispatches where id='91000000-0000-4000-8000-000000000001'`;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='retry',pending_since=now()-interval '10 minutes',updated_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const [discordOverdueClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(
    discordOverdueClock.result.blocker,"discord_overdue",
    "Discord retries masked their original pending age"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied',pending_since=null,updated_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.command_receipts(
        command_id,purpose,request_hash,status,result_status,result_body,
        generation,committed_at
      ) values(
        'clock:receipt-overdue','accounts:sync',${"d".repeat(64)},
        'committed',200,'{}'::jsonb,1,now()-interval '10 minutes'
      )
    `;
  });
  const [receiptClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(receiptClock.result.blocker,"command_receipt_overdue");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update tourney.command_receipts set status='failed',failed_at=now(),updated_at=now()
      where command_id='clock:receipt-overdue'
    `;
  });
  const [failedReceiptClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(failedReceiptClock.result.blocker,"command_receipt_failed");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.command_receipts where command_id='clock:receipt-overdue'`;
    await sql`delete from tourney.cutover_gate_events where event_kind='clock_reset'`;
  });
  await source`
    insert into tourney.shadow_observations(
      route,shape_match,value_match,ordering_match,error_match,
      primary_latency_ms,shadow_latency_ms,primary_status,shadow_status,observed_at
    )
    select route,true,true,true,true,130,130,200,200,now()
    from unnest(array[
      'public_roster','public_bracket','admin_players','appeals','payouts'
    ]) route cross join generate_series(1,30)
  `;
  const [latencyRegressionClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(latencyRegressionClock.result.blocker,"shadow_latency_regression");
  await source`delete from tourney.shadow_observations where primary_latency_ms=130`;
  await source`delete from tourney.cutover_gate_events where event_kind='clock_reset'`;
  const [clockStarted] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(clockStarted.result.blocker, null, "clean clock did not start");
  assert.ok(clockStarted.result.clean_since, "clean clock timestamp is missing");
  const originalCleanSince = clockStarted.result.clean_since;
  await source`
    insert into tourney.mirror_outbox(
      source_backend,generation,table_name,operation,record_key,status,record_hash
    ) values(
      'supabase',1,'tourney_players','upsert',
      '{"id":"clock-in-transit"}'::jsonb,'pending',${"e".repeat(64)}
    )
  `;
  const [inTransitClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(inTransitClock.result.blocker,"mirror_in_transit");
  assert.equal(inTransitClock.result.held,true);
  assert.equal(String(inTransitClock.result.clean_since),String(originalCleanSince));
  await source`
    update tourney.mirror_outbox set occurred_at=now()-interval '10 minutes'
    where record_key->>'id'='clock-in-transit'
  `;
  const [overdueTransitClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(overdueTransitClock.result.blocker,"mirror_overdue");
  await source`delete from tourney.mirror_outbox where record_key->>'id'='clock-in-transit'`;
  await source`delete from tourney.cutover_gate_events where event_kind='clock_reset'`;
  await source`select tourney.refresh_cutover_clock('postgres17-fixture')`;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='blocked_reauth', blocked_at=now()
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  const [discordClockReset] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(
    discordClockReset.result.blocker,
    "discord_blocker",
    "blocked Discord reauthorization did not reset the clean clock"
  );
  const [blockedReadiness] = await source`
    select public.roo_tourney_readiness() result
  `;
  assert.ok(
    blockedReadiness.result.clock_blockers.includes("discord_blocker"),
    "blocked Discord reauthorization was absent from readiness blockers"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      update accounts.discord_role_assignments set
        status='applied', blocked_at=null
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
    await sql`
      delete from tourney.cutover_gate_events
      where event_kind='clock_reset' and evidence->>'reason'='discord_blocker'
    `;
  });
  await source`
    insert into tourney.shadow_observations(
      route,shape_match,value_match,ordering_match,error_match,
      primary_latency_ms,shadow_latency_ms,primary_status,shadow_status
    ) values('public_roster',true,true,true,true,10,12,503,503)
  `;
  const [non2xxClock] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(
    non2xxClock.result.blocker,
    "shadow_samples_not_clean",
    "stored non-2xx shadow observation counted as clean"
  );
  const [non2xxReadiness] = await source`
    select public.roo_tourney_readiness() result
  `;
  assert.ok(
    non2xxReadiness.result.clock_blockers.includes("shadow_mismatch"),
    "stored non-2xx shadow observation did not block readiness"
  );
  await source`
    delete from tourney.shadow_observations
    where route='public_roster' and primary_status=503 and shadow_status=503
  `;
  await source`select tourney.refresh_cutover_clock('postgres17-fixture')`;
  await source`
    insert into tourney.mirror_outbox(
      source_backend,generation,table_name,operation,record_key,status,
      record_hash,dead_lettered_at
    ) values(
      'supabase',1,'tourney_players','upsert','{"id":"clock-fixture"}'::jsonb,
      'dead_letter',${"8".repeat(64)},now()
    )
  `;
  const [clockReset] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(clockReset.result.blocker, "mirror_dead_letter", "critical blocker did not reset clock");
  assert.equal(clockReset.result.clean_since, null, "critical blocker retained clean clock");
  await source`delete from tourney.mirror_outbox where record_key->>'id'='clock-fixture'`;

  await target`
    update tourney_mirror_checkpoints set generation=1,source_sequence=0
    where table_name='tourney_players' and record_key_hash=${checkpoint.record_key_hash}
  `;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:delete:0001',true)`;
    await sql`delete from tourney.external_operations where operation_key='fixture:external:0001'`;
    await sql`delete from accounts.discord_role_assignments where principal_id='40000000-0000-4000-8000-000000000001'`;
    await sql`delete from tourney.account_snapshots where snapshot_id='20000000-0000-4000-8000-000000000001'`;
    await sql`delete from tourney.email_dispatches where id='10000000-0000-4000-8000-000000000001'`;
    await sql`delete from tourney.tourney_payouts where id='payout-1'`;
    await sql`delete from tourney.tourney_appeals where id='appeal-1'`;
    await sql`delete from tourney.tourney_bracket_lock where id='lock-1'`;
    await sql`delete from tourney.tourney_bracket_audit where id='audit-1'`;
    await sql`delete from tourney.tourney_bracket_entities where entity_type='match' and entity_id=1`;
    await sql`delete from tourney.tourney_bracket_counters where entity_type='match'`;
    await sql`delete from tourney.tourney_bracket_meta where id='legacy-series-2026'`;
    await sql`delete from tourney.tourney_bracket_teams where id='team-1'`;
    await sql`delete from tourney.tourney_registration_config where id='legacy-series-2026'`;
    await sql`delete from tourney.tourney_players where id='player-1'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:receipt:0001'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:duplicate:0001'`;
  });
  const deleteMirror = await drainTourneyMirror({ env });
  assert.equal(deleteMirror.failed, 0, "delete mirroring failed");
  await assertSql(target, "select not exists(select 1 from tourney_players where id='player-1') and not exists(select 1 from tourney_command_receipts where command_id='fixture:receipt:0001') and not exists(select 1 from tourney_account_snapshots) and not exists(select 1 from tourney_external_operations) and not exists(select 1 from tourney_discord_role_assignments) ok", "registered deletes were not mirrored");

  const [queueState] = await source`
    select count(*) filter(where status in ('pending','retry','processing'))::integer pending,
      count(*) filter(where status='dead_letter')::integer dead
    from tourney.mirror_outbox
  `;
  assert.deepEqual({ pending: queueState.pending, dead: queueState.dead }, { pending: 0, dead: 0 });

  const fallbackAccounts = [{
    username: "owner",
    role: "owner",
    passwordHash: "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    active: true,
    version: "1",
  }];
  await Promise.all([
    source.begin(async (sql) => {
      await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
      await sql`
        insert into tourney.account_snapshots(
          snapshot_id,version,accounts_json,canonical_hash,generation,created_by
        ) values(
          '20000000-0000-4000-8000-000000000002',2,
          ${sql.json(fallbackAccounts)},${"6".repeat(64)},1,'fixture'
        )
      `;
    }),
    target.begin(async (sql) => {
      await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
      await sql`
        insert into tourney_account_snapshots(
          snapshot_id,version,accounts_json,canonical_hash,generation,created_by
        ) values(
          '20000000-0000-4000-8000-000000000002',2,
          ${sql.json(fallbackAccounts)},${"6".repeat(64)},1,'fixture'
        )
      `;
    }),
  ]);
  const principalId = "40000000-0000-4000-8000-000000000001";
  const principalCommand = await executeTourneyCommand({
    commandId: `account-principal:owner:${principalId}`,
    purpose: "identity:account-principal",
    requestPayload: { username: "owner", principalId },
    maintenanceWhilePaused: true,
    env,
    callback: async () => ({
      body: await appendTourneyAccountPrincipalSnapshot({
        username: "owner",
        principalId,
        env,
      }),
    }),
  });
  assert.equal(principalCommand.body.updated, true, "principal snapshot was not versioned");
  const principalMirror = await reconcileTourneyMirror({ env, limit: 250 });
  assert.equal(principalMirror.failed, 0, "principal snapshot mirroring failed");
  await assertSql(source, "select accounts_json->0->>'principalId'='40000000-0000-4000-8000-000000000001' ok from tourney.account_snapshots order by version desc limit 1", "source principal snapshot is incomplete");
  await assertSql(target, "select accounts_json->0->>'principalId'='40000000-0000-4000-8000-000000000001' ok from tourney_account_snapshots order by version desc limit 1", "target principal snapshot is incomplete");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:principal-cleanup',true)`;
    await sql`delete from tourney.external_operations where command_id=${`account-principal:owner:${principalId}`}`;
    await sql`
      delete from tourney.tourney_payouts
      where player_id in (
        select id from tourney.tourney_players where principal_id is null
      )
    `;
    await sql`delete from tourney.tourney_players where principal_id is null`;
  });
  const principalCleanup = await reconcileTourneyMirror({ env, limit: 250 });
  assert.equal(principalCleanup.failed, 0, "principal operation cleanup mirroring failed");

  await Promise.all([
    source`
      update tourney.cutover_metadata set writes_paused=true where id='tourney'
    `,
    target`
      update tourney_cutover_metadata set writes_paused=true where id='tourney'
    `,
  ]);
  const finalFallbackSnapshot = await readFallbackSnapshot(target);
  await source`
    select public.roo_enqueue_tourney_fallback_bootstrap(
      'postgres17-failover',${source.json(finalFallbackSnapshot)}
    )
  `;
  const finalBootstrapMirror = await reconcileTourneyMirror({ env, limit: 250 });
  assert.equal(finalBootstrapMirror.failed, 0, "final fallback coverage mirror failed");
  const finalParity = await runTourneyParity({ env });
  assert.equal(
    finalParity.status,
    "clean",
    `fresh fallback parity was not clean: ${JSON.stringify(finalParity.drift)}`
  );

  await Promise.all([
    source`
      update tourney.cutover_metadata set
        primary_backend='legacy', generation=2, writes_paused=true
      where id='tourney'
    `,
    target`
      update tourney_cutover_metadata set
        primary_backend='legacy', generation=2, writes_paused=true
      where id='tourney'
    `,
  ]);
  const failoverEnv = {
    ...env,
    TOURNEY_DATABASE_MODE: "legacy",
    TOURNEY_FAILOVER_GENERATION: "2",
    TOURNEY_WRITES_PAUSED: "1",
  };

  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_players(
        id,username,email,password_hash,status,discord,display_name,discord_key,
        battlenet,rank_name,role_play,approved_role_play,registration_pool,
        twitch_username,version
      ) values(
        'legacy-decision-atomic','legacy-decision-atomic',
        'legacy-decision-atomic@example.com',
        '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','pending',
        'LegacyDecisionAtomic','Legacy Decision Atomic','legacy-decision-atomic',
        'LegacyDecision#1','Master','Damage','','main','legacydecisionatomic',1
      )
    `;
    await sql`
      insert into tourney_player_tokens(
        id,player_id,token_hash,purpose,expires_at
      ) values(
        'legacy-decision-atomic-token','legacy-decision-atomic',
        ${"a".repeat(64)},'approve','9999-12-31T23:59:59.999Z'
      )
    `;
  });
  const legacyQueueFailureUrl = new URL(legacyUrl);
  legacyQueueFailureUrl.searchParams.set(
    "options",
    "-c roo.tourney_mirror_apply=1"
  );
  await assert.rejects(
    applyRegistrationDecision({
      tokenHash: "a".repeat(64),
      playerId: "legacy-decision-atomic",
      purpose: "approve",
      actorUsername: "fixture",
      approvedRolePlay: "Damage",
      env: {
        ...failoverEnv,
        TOURNEY_DATABASE_URL: legacyQueueFailureUrl.toString(),
      },
    }),
    (error) => error?.code === "TOURNEY_COMMAND_CONTEXT_REQUIRED",
    "legacy decision queue failure did not reject"
  );
  await assertSql(
    target,
    `select player.status='pending' and player.version=1 and token.used_at is null ok
     from tourney_players player
     join tourney_player_tokens token on token.player_id=player.id
     where player.id='legacy-decision-atomic'`,
    "legacy decision queue failure committed player or token state"
  );
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney_player_tokens where player_id='legacy-decision-atomic'`;
    await sql`delete from tourney_players where id='legacy-decision-atomic'`;
  });

  const [legacyCapacityConfig] = await target`
    select team_count,updated_at,updated_by from tourney_registration_config
    where id='legacy-series-2026'
  `;
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_registration_config(id,team_count,updated_by)
      values('legacy-series-2026',2,'fixture')
      on conflict(id) do update set team_count=excluded.team_count
    `;
    await sql`
      insert into tourney_players(
        id,username,email,password_hash,status,discord,display_name,discord_key,
        battlenet,rank_name,role_play,approved_role_play,registration_pool,
        twitch_username,version
      ) values
        ('legacy-capacity-main','legacy-capacity-main','legacy-capacity-main@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'LegacyCapacityMain','Legacy Capacity Main','legacy-capacity-main',
          'LegacyCapacity#1','Master','Tank','Tank','main','legacycapacitymain',1),
        ('legacy-capacity-main-2','legacy-capacity-main-2','legacy-capacity-main-2@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'LegacyCapacityMain2','Legacy Capacity Main 2','legacy-capacity-main-2',
          'LegacyCapacity#4','Master','Tank','Tank','main','legacycapacitymain2',1),
        ('legacy-capacity-main-3','legacy-capacity-main-3','legacy-capacity-main-3@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'LegacyCapacityMain3','Legacy Capacity Main 3','legacy-capacity-main-3',
          'LegacyCapacity#5','Master','Tank','Tank','main','legacycapacitymain3',1),
        ('legacy-capacity-sub','legacy-capacity-sub','legacy-capacity-sub@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'LegacyCapacitySub','Legacy Capacity Sub','legacy-capacity-sub',
          'LegacyCapacity#2','Master','Tank','Tank','substitute','legacycapacitysub',1),
        ('legacy-capacity-damage','legacy-capacity-damage','legacy-capacity-damage@example.com',
          '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
          'LegacyCapacityDamage','Legacy Capacity Damage','legacy-capacity-damage',
          'LegacyCapacity#3','Master','Damage','Damage','main','legacycapacitydamage',1)
    `;
  });
  const legacyDirectUrl = new URL(legacyUrl);
  legacyDirectUrl.searchParams.set(
    "options",
    "-c roo.tourney_command_id=fixture:legacy-direct-capacity " +
      "-c roo.tourney_mirror_apply=1"
  );
  const directLegacyEnv = {
    ...failoverEnv,
    TOURNEY_DATABASE_URL: legacyDirectUrl.toString(),
  };
  const directCapacityResults = await Promise.allSettled([
    updateTourneyPlayerDetails({
      playerId: "legacy-capacity-sub",
      payload: {
        displayName: "Legacy Capacity Sub",
        twitchUsername: "legacycapacitysub",
        teamName: "",
        registrationPool: "main",
      },
      actorUsername: "fixture",
      env: directLegacyEnv,
    }),
    updateTourneyPlayerApprovedRole({
      playerId: "legacy-capacity-damage",
      rolePlay: "Tank",
      actorUsername: "fixture",
      env: directLegacyEnv,
    }),
  ]);
  const [directCapacityState] = await target`
    select
      (select team_count from tourney_registration_config
       where id='legacy-series-2026') team_count,
      count(*) filter (
        where status='approved' and registration_pool='main'
          and coalesce(nullif(approved_role_play,''),role_play)='Tank'
          and id like 'legacy-capacity-%'
      )::integer main_count,
      jsonb_object_agg(id, jsonb_build_object(
        'pool',registration_pool,
        'role',coalesce(nullif(approved_role_play,''),role_play)
      )) states
    from tourney_players where id like 'legacy-capacity-%'
  `;
  assert.equal(
    directCapacityResults.filter((result) => result.status === "fulfilled").length,
    1,
    `direct legacy capacity mutations consumed the same final slot: ${JSON.stringify(
      directCapacityState
    )}`
  );
  assert.equal(
    directCapacityResults.filter((result) =>
      result.status === "rejected" &&
      result.reason?.code === "TOURNEY_ROLE_CAPACITY_FULL"
    ).length,
    1,
    "direct legacy capacity loser did not report the role-cap conflict"
  );
  await assertSql(
    target,
    `select count(*)<=4 ok from tourney_players
     where status='approved' and registration_pool='main'
       and coalesce(nullif(approved_role_play,''),role_play)='Tank'
       and id like 'legacy-capacity-%'`,
    "direct legacy capacity mutations overfilled Tank capacity"
  );
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney_players where id like 'legacy-capacity-%'`;
    if (legacyCapacityConfig) {
      await sql`
        update tourney_registration_config set
          team_count=${legacyCapacityConfig.team_count},
          updated_at=${legacyCapacityConfig.updated_at},
          updated_by=${legacyCapacityConfig.updated_by}
        where id='legacy-series-2026'
      `;
    } else {
      await sql`
        delete from tourney_registration_config where id='legacy-series-2026'
      `;
    }
  });

  const failoverReady = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.equal(failoverReady.ready, true, `manual failover was blocked: ${failoverReady.blockers.join(",")}`);

  const [coveredEvent] = await source`
    select event_id from tourney.mirror_outbox event
    where event.table_name='account_snapshots'
      and event.source_backend='supabase' and event.generation=1
      and event.operation='upsert' and event.status='applied'
      and exists(
        select 1 from tourney.account_snapshots snapshot
        where snapshot.snapshot_id::text=event.record_key->>'snapshot_id'
      )
    order by sequence desc limit 1
  `;
  const [removedCheckpoint] = await target`
    delete from tourney_mirror_checkpoints
    where target_backend='legacy' and table_name='account_snapshots'
      and event_id=${coveredEvent.event_id}
    returning *
  `;
  assert.ok(removedCheckpoint, "fallback checkpoint coverage fixture is missing");
  const incompleteCoverage = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.ok(
    incompleteCoverage.blockers.includes("fallback_checkpoint_incomplete"),
    `one remaining max-generation checkpoint masked incomplete fallback coverage: ${JSON.stringify(incompleteCoverage.state.fallbackCoverage)}`
  );
  await target`
    insert into tourney_mirror_checkpoints(
      target_backend,source_backend,table_name,record_key_hash,
      source_sequence,event_id,generation,applied_at
    ) values(
      ${removedCheckpoint.target_backend},${removedCheckpoint.source_backend},
      ${removedCheckpoint.table_name},${removedCheckpoint.record_key_hash},
      ${removedCheckpoint.source_sequence},${removedCheckpoint.event_id},
      ${removedCheckpoint.generation},${removedCheckpoint.applied_at}
    )
  `;

  await source`
    update tourney.parity_runs set created_at=now()-interval '10 minutes'
    where source_backend='supabase' and target_backend='legacy' and generation=1
  `;
  const staleParity = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.ok(
    staleParity.blockers.includes("fallback_parity_stale"),
    `stale fallback parity did not block manual failover: ${JSON.stringify(staleParity.state.fallbackParity)}`
  );
  await source`
    update tourney.parity_runs set created_at=now()
    where source_backend='supabase' and target_backend='legacy' and generation=1
  `;

  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_discord_role_assignments(
        principal_id,discord_user_id,guild_id,desired_role,applied_role,status
      ) values(
        '70000000-0000-4000-8000-000000000001','700000000000000001',
        '600000000000000001','participant','none','blocked_reauth'
      )
    `;
  });
  const reauthFailover = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.ok(
    reauthFailover.blockers.includes("discord_operations_pending"),
    "blocked reauth did not block manual failover"
  );
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney_discord_role_assignments
      where principal_id='70000000-0000-4000-8000-000000000001'
    `;
  });

  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into accounts.discord_role_assignments(
        user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
        desired_role,status,blocked_at
      ) values(
        '30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001','player-1',
        '500000000000000002','600000000000000001','tourney_player',
        'participant','blocked_reauth',now()
      )
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney_discord_role_assignments(
        user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
        desired_role,status,blocked_at
      ) values(
        '30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001','player-1',
        '500000000000000002','600000000000000001','tourney_player',
        'participant','blocked_reauth',now()
      )
    `;
  });
  const failoverDiscordBlocked = await checkTourneyManualFailoverReadiness({
    env: failoverEnv,
  });
  assert.equal(
    failoverDiscordBlocked.ready,
    false,
    "blocked Discord reauthorization did not block manual failover"
  );
  assert.ok(
    failoverDiscordBlocked.blockers.includes("discord_operations_pending"),
    "manual failover omitted the blocked Discord reauthorization"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from accounts.discord_role_assignments
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      delete from tourney_discord_role_assignments
      where principal_id='40000000-0000-4000-8000-000000000001'
    `;
  });
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`
      insert into tourney.external_operations(
        operation_key,command_id,operation_kind,entity_type,entity_id,
        desired_state,desired_state_hash,status
      ) values(
        'fixture:failover:blocker','fixture:paused-maintenance:0001',
        'sanity_account_projection','account_snapshot','fixture','{}'::jsonb,
        ${"7".repeat(64)},'pending'
      )
    `;
  });
  const failoverBlocked = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.equal(failoverBlocked.ready, false, "pending Supabase external work did not block failover");
  assert.ok(
    failoverBlocked.blockers.includes("external_operations_pending"),
    "failover did not report the pending external-operation blocker"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.external_operations where operation_key='fixture:failover:blocker'`;
  });

  const [sourceConnectionIdentity] = await source`
    select current_database() database,current_user username
  `;
  const [targetConnectionIdentity] = await target`
    select current_database() database,current_user username
  `;
  await assertConnectedDatabaseIdentity(
    source,
    sourceConnectionIdentity,
    "LIVE_DRIFT_SOURCE_CONNECTION_IDENTITY_INVALID"
  );
  await assertConnectedDatabaseIdentity(
    target,
    targetConnectionIdentity,
    "LIVE_DRIFT_LEGACY_CONNECTION_IDENTITY_INVALID"
  );
  await assert.rejects(
    assertConnectedDatabaseIdentity(
      target,
      { ...targetConnectionIdentity, username: "wrong-live-repair-user" },
      "LIVE_DRIFT_LEGACY_CONNECTION_IDENTITY_INVALID"
    ),
    (error) => error.code === "LIVE_DRIFT_LEGACY_CONNECTION_IDENTITY_INVALID",
    "live repair accepted a connected database user that did not match its pinned URL identity"
  );

  await target`
    update tourney_cutover_metadata set
      primary_backend='supabase',generation=1,writes_paused=true,
      fallback_read_only=false,hardened_active=true
    where id='tourney'
  `;
  await assertLiveDriftLegacyDatabaseGate(target);
  await target`update tourney_cutover_metadata set writes_paused=false where id='tourney'`;
  await assert.rejects(
    assertLiveDriftLegacyDatabaseGate(target),
    (error) => error.code === "LIVE_DRIFT_LEGACY_GATE_INVALID",
    "live repair accepted unpaused fallback controls"
  );
  await target`update tourney_cutover_metadata set writes_paused=true where id='tourney'`;
  await target`
    alter table tourney_players disable trigger capture_tourney_mirror_event
  `;
  await assert.rejects(
    assertLiveDriftLegacyDatabaseGate(target),
    (error) => error.code === "LIVE_DRIFT_LEGACY_TRIGGER_INVALID",
    "live repair accepted a drifted fallback mirror trigger"
  );
  await target`
    alter table tourney_players enable trigger capture_tourney_mirror_event
  `;
  await target`
    insert into tourney_mirror_outbox(
      command_id,source_backend,generation,table_name,operation,record_key,status
    ) values(
      'fixture:live-repair-legacy-backlog','legacy',1,'tourney_players','upsert',
      '{"id":"fixture:live-repair-legacy-backlog"}'::jsonb,'pending'
    )
  `;
  await assert.rejects(
    assertLiveDriftLegacyDatabaseGate(target),
    (error) => error.code === "LIVE_DRIFT_LEGACY_BACKLOG",
    "live repair accepted a fallback mirror backlog"
  );
  await target`
    delete from tourney_mirror_outbox where command_id='fixture:live-repair-legacy-backlog'
  `;
  await assertLiveDriftLegacyDatabaseGate(target);

  const liveRepairPlayerId = "live-repair-player";
  const liveRepairDiscordId = "910000000000000001";
  const liveRepairIdentityId = "85000000-0000-4000-8000-000000000001";
  const liveRepairCanonicalPrincipal = "84000000-0000-4000-8000-000000000001";
  const liveRepairPrincipals = Array.from({ length: 25 }, (_, index) =>
    `82000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  );
  const liveRepairUsers = Array.from({ length: 25 }, (_, index) =>
    `81000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
  );
  await source`
    update tourney.cutover_metadata set
      primary_backend='supabase',generation=1,writes_paused=true,hardened_active=true
    where id='tourney'
  `;
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    for (let index = 0; index < liveRepairPrincipals.length; index += 1) {
      await sql`insert into auth.users(id,email) values(
        ${liveRepairUsers[index]}::uuid,${`live-repair-${index + 1}@example.invalid`}
      )`;
      await sql`insert into accounts.principals(id) values(${liveRepairPrincipals[index]}::uuid)`;
      await sql`insert into accounts.discord_role_assignments(
        user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
        desired_role,status
      ) values(
        ${liveRepairUsers[index]}::uuid,${liveRepairPrincipals[index]}::uuid,
        ${index === 0 ? liveRepairPlayerId : null},
        ${`9100000000000000${String(index + 1).padStart(2, "0")}`},
        '610000000000000001','tourney_player','participant','pending'
      )`;
    }
    await sql`insert into accounts.principals(id) values(${liveRepairCanonicalPrincipal}::uuid)`;
    await sql`insert into accounts.identity_links(
      id,principal_id,provider,provider_subject,metadata,last_seen_at
    ) values(
      ${liveRepairIdentityId}::uuid,${liveRepairCanonicalPrincipal}::uuid,
      'discord',${liveRepairDiscordId},'{}'::jsonb,now()
    )`;
    await sql`insert into tourney.tourney_players(
      id,username,email,password_hash,status,discord,discord_key,battlenet,
      rank_name,role_play,version,discord_user_id,discord_linked_at,principal_id
    ) values(
      ${liveRepairPlayerId},'live-repair-player','live-repair-player@example.invalid',
      '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
      'live-repair-player','live-repair-player','live-repair-player','Master',
      'Tank',3,${liveRepairDiscordId},now(),${liveRepairPrincipals[0]}::uuid
    )`;
    for (let index = 0; index < 3; index += 1) {
      await sql`insert into tourney.tourney_player_tokens(
        id,player_id,token_hash,purpose,recipient_version,expires_at
      ) values(
        ${`live-repair-token-${index + 1}`},${liveRepairPlayerId},
        ${crypto.createHash("sha256").update(`live-repair-token-${index + 1}`).digest("hex")},
        'approve','3',now()+interval '1 day'
      )`;
    }
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`insert into tourney_players(
      id,username,email,password_hash,status,discord,discord_key,battlenet,
      rank_name,role_play,version,discord_user_id,discord_linked_at,principal_id
    ) values(
      ${liveRepairPlayerId},'live-repair-player','live-repair-player@example.invalid',
      '$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','approved',
      'live-repair-player','live-repair-player','live-repair-player','Master',
      'Tank',3,${liveRepairDiscordId},now(),${liveRepairPrincipals[0]}::uuid
    )`;
    for (let index = 0; index < 3; index += 1) {
      await sql`insert into tourney_player_tokens(
        id,player_id,token_hash,purpose,recipient_version,expires_at
      ) values(
        ${`live-repair-token-${index + 1}`},${liveRepairPlayerId},
        ${crypto.createHash("sha256").update(`live-repair-token-${index + 1}`).digest("hex")},
        'approve',null,now()+interval '1 day'
      )`;
    }
    for (let index = 0; index < 24; index += 1) {
      await sql`insert into tourney_discord_role_assignments(
        user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
        desired_role,status
      ) values(
        ${liveRepairUsers[index]}::uuid,${liveRepairPrincipals[index]}::uuid,
        ${index === 0 ? liveRepairPlayerId : null},
        ${`9100000000000000${String(index + 1).padStart(2, "0")}`},
        '610000000000000001','tourney_player','none','applied'
      )`;
    }
  });
  const [repairTokenRows, repairAssignmentRows, repairPlayerRows, repairIdentityRows] =
    await Promise.all([
      source`select to_jsonb(row_value) row from tourney.tourney_player_tokens row_value
        where id like 'live-repair-token-%' order by id`,
      source`select to_jsonb(row_value) row from accounts.discord_role_assignments row_value
        where principal_id::text in ${source(liveRepairPrincipals)} order by principal_id`,
      source`select to_jsonb(row_value) row from tourney.tourney_players row_value
        where id=${liveRepairPlayerId}`,
      source`select to_jsonb(row_value) row from accounts.identity_links row_value
        where id=${liveRepairIdentityId}::uuid`,
    ]);
  const liveRepairAuthorization = "a".repeat(64);
  const liveRepairState = {
    tokens: {
      diffs: Array.from({ length: 3 }, (_, index) => ({
        id: `live-repair-token-${index + 1}`,
      })),
    },
    discord: { source_principal_ids: liveRepairPrincipals },
    collision: {
      source_hash: "b".repeat(64),
      player_id: liveRepairPlayerId,
      linked_principal_id: liveRepairPrincipals[0],
      canonical_principal_id: liveRepairCanonicalPrincipal,
      discord_user_id: liveRepairDiscordId,
      identity_link_id: liveRepairIdentityId,
    },
    sourceRows: {
      tokens: repairTokenRows.map(({ row }) => row),
      assignments: repairAssignmentRows.map(({ row }) => row),
      players: repairPlayerRows.map(({ row }) => row),
      identities: repairIdentityRows.map(({ row }) => row),
    },
  };
  const liveRepair = await applyLiveDriftSourceRepair({
    source,
    state: liveRepairState,
    authorizationHash: liveRepairAuthorization,
    expected: { events: EXPECTED_LIVE_DRIFT.events },
  });
  const [liveRepairEventCounts] = await source`
    select count(*)::integer total,
      count(*) filter(where table_name='tourney_player_tokens')::integer tokens,
      count(*) filter(where table_name='discord_role_assignments')::integer assignments,
      count(*) filter(where table_name='tourney_players')::integer players,
      bool_and(status='pending' and generation=1)::boolean valid
    from tourney.mirror_outbox where command_id=${liveRepair.commandId}
  `;
  assert.deepEqual(liveRepairEventCounts, {
    total: 29,
    tokens: 3,
    assignments: 25,
    players: 1,
    valid: true,
  });
  assert.equal(
    await source`select count(*)::integer count from tourney.external_operations
      where command_id=${liveRepair.commandId}`.then(([row]) => row.count),
    0,
    "live drift repair queued external Discord work"
  );
  await reconcileTourneyMirror({ env, limit: 100 });
  await assertSql(
    target,
    `select count(*)=3 and bool_and(recipient_version='3') ok
      from tourney_player_tokens where id like 'live-repair-token-%'`,
    "live drift token repair did not mirror"
  );
  await assertSql(
    target,
    `select count(*)=25
      and count(*) filter(where status='blocked_reauth'
        and desired_role='none' and last_error='identity_principal_collision')=1 ok
      from tourney_discord_role_assignments
      where principal_id::text like '82000000-0000-4000-8000-%'`,
    "live drift Discord repair did not mirror"
  );
  await assertSql(
    target,
    `select discord_user_id is null
      and discord_linked_at is null
      and discord_role_last_error='identity_principal_collision' ok
      from tourney_players where id='live-repair-player'`,
    "live drift stale player link was not cleared"
  );
  await assertSql(
    source,
    `select principal_id='84000000-0000-4000-8000-000000000001'::uuid ok
      from accounts.identity_links where id='85000000-0000-4000-8000-000000000001'::uuid`,
    "live drift repair changed the canonical Discord principal"
  );
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney.identity_conflicts where id=${liveRepair.conflictId}::uuid`;
    await sql`delete from accounts.identity_links where id=${liveRepairIdentityId}::uuid`;
    await sql`delete from accounts.discord_role_assignments
      where principal_id::text in ${sql(liveRepairPrincipals)}`;
    await sql`delete from tourney.tourney_player_tokens where id like 'live-repair-token-%'`;
    await sql`delete from tourney.tourney_players where id=${liveRepairPlayerId}`;
    await sql`delete from accounts.principals
      where id::text in ${sql([...liveRepairPrincipals,liveRepairCanonicalPrincipal])}`;
    await sql`delete from auth.users where id::text in ${sql(liveRepairUsers)}`;
  });
  await target.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply','1',true)`;
    await sql`delete from tourney_discord_role_assignments
      where principal_id::text in ${sql(liveRepairPrincipals)}`;
    await sql`delete from tourney_player_tokens where id like 'live-repair-token-%'`;
    await sql`delete from tourney_players where id=${liveRepairPlayerId}`;
  });

  await assertSql(
    source,
    "select count(*) = 4 ok from tourney.cutover_control_operations",
    "Supabase cutover operation history was not retained"
  );
  await assertSql(
    target,
    "select count(*) = 4 ok from tourney_cutover_control_operations",
    "fallback cutover operation history was not retained"
  );

  summary = {
    ok: true,
    postgres: version.trim(),
    databases: 4,
    mirrorApplied: firstMirror.applied,
    verified: [
      "URI-derived isolated libpq environment connection",
      "pre-DDL activation safety on both databases",
      "legacy empty-search-path trigger repair",
      "fail-closed mirror trigger bodies and 17-table OID bindings",
      "present and absent activation RPC compatibility",
      "trigger-drift readiness and activation rejection",
      "latest shadow-read summaries before the natural mutation window",
      "registry composite keys",
      "collision quarantine and guarded destructive import",
      "semantic timestamp and numeric canonical hashes",
      "target-only snapshot pruning",
      "independent constrained pause and resume operation markers",
      "append-only pre-activation cutover operation history",
      "insert mirroring",
      "idempotent fallback upserts and target-only deletes",
      "database-authoritative write pause with maintenance bypass",
      "update and delete mirroring for every registered domain",
      "receipt mirroring",
      "atomic legacy registration decision and token rollback",
      "direct capacity mutation serialization",
      "opposite terminal registration decision conflict",
      "serialized payout transition email deduplication",
      "expired reset dispatch suppression",
      "concurrent duplicate Idempotency-Key replay",
      "recovered committed receipt completion",
      "Idempotency-Key replay after manual failover",
      "versioned mirrored fallback account principal",
      "typed nullable Discord desired-state lookup",
      "transaction-fenced Discord relink and unlink rejection",
      "monotonic player account import",
      "recoverable pre-provider OAuth scheduling",
      "failed OAuth finalization queue resolution",
      "same-principal Discord OAuth projection",
      "fresh same-identity Discord reauthorization",
      "repeat Discord repair batches",
      "pre-provider Discord generation fencing",
      "managed Discord role removal",
      "accurate Discord role and identity status",
      "blocked Discord reauthorization cutover gating",
      "durable Discord global Retry-After scheduling",
      "atomic leases with concurrent workers",
      "expired lease recovery and dead-letter exhaustion",
      "dead-lettered command receipt terminalization",
      "generation tuple ordering",
      "non-2xx and blocked-reauth clock/readiness blockers",
      "fresh clean failover parity and per-record checkpoint coverage",
      "manual failover backlog and blocked-reauth gates",
      "connected database identity and independent legacy live-repair gates",
      "audited deterministic live-drift repair and canonical identity preservation",
      "zero pending and dead letters",
    ],
  };
} finally {
  if (started) {
    spawnSync(path.join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
      encoding: "utf8",
    });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(0);
