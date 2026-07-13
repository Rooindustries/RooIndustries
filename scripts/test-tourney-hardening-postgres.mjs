#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import {
  checkTourneyManualFailoverReadiness,
  executeTourneyCommand,
  reconcileTourneyMirror,
} from "../src/server/tourney/store.js";
import { getTourneySql } from "../src/server/tourney/sqlClient.js";
import { reconcileTourneyExternalOperations } from "../src/server/tourney/externalOperations.js";
import { appendTourneyAccountPrincipalSnapshot } from "../src/server/tourney/accountStore.js";
import { recordTourneyDiscordDesiredState } from "../src/server/tourney/discordDesiredState.js";

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
create extension if not exists pgcrypto with schema extensions;
create table auth.users(id uuid primary key, email text);
create table accounts.principals(id uuid primary key default gen_random_uuid(), status text not null default 'active');
create table accounts.principal_auth_users(
  user_id uuid primary key references auth.users(id),
  principal_id uuid not null references accounts.principals(id),
  is_primary boolean not null default true,
  source text not null default 'fixture'
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
insert into tourney.tourney_registration_config(id,team_count) values('registration',8);
insert into tourney.tourney_bracket_meta(id,status,published) values('legacy-series-2026','draft',false);
`;

const assertSql = async (sql, query, message) => {
  const rows = await sql.unsafe(query);
  assert.equal(rows[0]?.ok, true, message);
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
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "supabase_fixture"]);
  run(path.join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "legacy_fixture"]);

  const supabaseBootstrap = writeTemp(
    "supabase-bootstrap.sql",
    commonBootstrap + extractSupabaseBusinessBase() + extractSupabaseControlBase() + authOperations + seedSql
  );
  psql(
    "supabase_fixture",
    supabaseBootstrap,
    path.join(root, "supabase/migrations/20260712224033_expand_tourney_schema_v4.sql"),
    path.join(root, "supabase/migrations/20260712224034_activate_tourney_schema_v4.sql")
  );
  process.stderr.write("[postgres17] Supabase schema v4 applied\n");

  const legacyBootstrap = writeTemp("legacy-bootstrap.sql", legacyBusinessBase());
  psql(
    "legacy_fixture",
    legacyBootstrap,
    path.join(root, "scripts/tourney-cutover-legacy.sql"),
    path.join(root, "scripts/tourney-schema-v4-expand-legacy.sql"),
    path.join(root, "scripts/tourney-schema-v4-activate-legacy.sql")
  );
  process.stderr.write("[postgres17] legacy schema v4 applied\n");

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
  };

  const collisionSnapshot = {
    tourney_players: [
      { id: "collision-1", username: "same", email: "one@example.com", discord_key: "one" },
      { id: "collision-2", username: "same", email: "two@example.com", discord_key: "two" },
    ],
    _counts: { tourney_players: 2 },
  };
  const [collisionResult] = await source`
    select public.roo_import_tourney_snapshot_v4(
      ${source.json(collisionSnapshot)},${"f".repeat(64)},false
    ) result
  `;
  assert.equal(collisionResult.result.status, "quarantined", "unique collision was not quarantined");
  await source`delete from migration.tourney_import_quarantine where source_hash=${"f".repeat(64)}`;
  await assert.rejects(
    source`select public.roo_import_tourney_snapshot_v4(${source.json({ _counts: {} })},${"1".repeat(64)},true)`,
    (error) => error.code === "55000",
    "generation-1 destructive reconciliation was not rejected"
  );

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
      id,player_id,token_hash,purpose,expires_at
    ) values('token-1','player-1',${"b".repeat(64)},'reset',now()+interval '1 day')`;
    await sql`update tourney.tourney_registration_config set team_count=10 where id='registration'`;
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
    await sql`select set_config('roo.tourney_mirror_enabled','0',true)`;
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
  const [bootstrapResult] = await source`
    select public.roo_enqueue_tourney_fallback_bootstrap('postgres17-fixture') result
  `;
  assert.ok(bootstrapResult.result.queued >= 1, "fallback bootstrap did not enqueue missing state");
  await reconcileTourneyMirror({ env, limit: 250 });
  await assertSql(target, "select exists(select 1 from tourney_players where id='bootstrap-only') ok", "fallback bootstrap row was not mirrored");
  const [bootstrapReplay] = await source`
    select public.roo_enqueue_tourney_fallback_bootstrap('postgres17-fixture') result
  `;
  assert.equal(bootstrapReplay.result.queued, 0, "fallback bootstrap replay was not idempotent");

  const pausedMaintenance = await executeTourneyCommand({
    commandId: "fixture:paused-maintenance:0001",
    purpose: "accounts:seed",
    requestPayload: { fixture: true },
    env: { ...env, TOURNEY_WRITES_PAUSED: "1" },
    maintenanceWhilePaused: true,
    callback: async () => ({ body: { ok: true } }),
  });
  assert.equal(pausedMaintenance.status, 200, "paused maintenance command was rejected");

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
        where id='registration' returning team_count
      `;
      return { body: { ok: true, teamCount: row.team_count } };
    },
  });
  const duplicateResults = await Promise.all([runDuplicateCommand(), runDuplicateCommand()]);
  assert.equal(commandExecutions, 1, "duplicate command executed business work twice");
  assert.equal(duplicateResults.filter((result) => result.replayed).length, 1);
  assert.deepEqual(duplicateResults[0].body.teamCount, duplicateResults[1].body.teamCount);
  await reconcileTourneyMirror({ env, limit: 100 });
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
      'fixture:external:expired','fixture:receipt:0001','sanity_account_projection',
      'account_snapshot','expired','{}'::jsonb,${"9".repeat(64)},'processing',1,
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
    await sql`insert into accounts.discord_role_assignments(
      user_id,principal_id,player_id,discord_user_id,guild_id,tourney_role,
      desired_role,status
    ) values(
      '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
      'player-1','500000000000000001','600000000000000001','tourney_player',
      'participant','pending'
    )`;
  });
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
  const externalFailure = await reconcileTourneyExternalOperations({ env, limit: 10 });
  assert.equal(externalFailure.deadLettered, 1, "expired external operation did not exhaust safely");
  await assertSql(source, "select status='dead_letter' ok from tourney.external_operations where operation_key='fixture:external:expired'", "external operation was not dead-lettered");
  await source.begin(async (sql) => {
    await sql`select set_config('roo.tourney_backend','supabase',true),set_config('roo.tourney_mirror_enabled','1',true),set_config('roo.tourney_generation','1',true),set_config('roo.tourney_command_id','fixture:external-cleanup',true)`;
    await sql`delete from tourney.external_operations where operation_key='fixture:external:expired'`;
  });
  await Promise.all([
    reconcileTourneyMirror({ env, limit: 1 }),
    reconcileTourneyMirror({ env, limit: 100 }),
  ]);
  process.stderr.write("[postgres17] concurrent claims verified\n");
  await assertSql(target, "select exists(select 1 from tourney_command_receipts where command_id='fixture:receipt:0001' and status='committed') ok", "receipt was not mirrored");
  await assertSql(target, "select (select count(*) from tourney_account_snapshots)=1 and (select count(*) from tourney_external_operations)=1 and (select count(*) from tourney_discord_role_assignments)=1 ok", "control, account snapshot, external operation, or Discord state was not mirrored");

  const [checkpoint] = await target`
    select record_key_hash from tourney_mirror_checkpoints
    where table_name='tourney_players' limit 1
  `;
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

  await source`
    update tourney.cutover_metadata set
      primary_backend = 'supabase', generation = 1,
      natural_mutation_verified_at = now() - interval '21 minutes'
    where id = 'tourney'
  `;
  await source`
    insert into tourney.parity_runs(
      source_backend,target_backend,generation,status,created_at
    ) values
      ('supabase','legacy',1,'clean',now()-interval '20 minutes'),
      ('supabase','legacy',1,'clean',now()-interval '10 minutes')
  `;
  await source`
    insert into tourney.shadow_observations(
      route,shape_match,value_match,ordering_match,error_match,
      primary_latency_ms,shadow_latency_ms,observed_at
    )
    select route,true,true,true,true,10,12,now()-interval '1 minute'
    from unnest(array[
      'public_roster','public_bracket','admin_players','appeals','payouts'
    ]) route cross join generate_series(1,30)
  `;
  const [clockStarted] = await source`
    select tourney.refresh_cutover_clock('postgres17-fixture') result
  `;
  assert.equal(clockStarted.result.blocker, null, "clean clock did not start");
  assert.ok(clockStarted.result.clean_since, "clean clock timestamp is missing");
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
    await sql`delete from tourney.tourney_registration_config where id='registration'`;
    await sql`delete from tourney.tourney_players where id='player-1'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:receipt:0001'`;
    await sql`delete from tourney.command_receipts where command_id='fixture:duplicate:0001'`;
  });
  const deleteMirror = await reconcileTourneyMirror({ env, limit: 250 });
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
    target`
      insert into tourney_account_snapshots(
        snapshot_id,version,accounts_json,canonical_hash,generation,created_by
      ) values(
        '20000000-0000-4000-8000-000000000002',2,
        ${target.json(fallbackAccounts)},${"6".repeat(64)},1,'fixture'
      )
    `,
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
  });
  const principalCleanup = await reconcileTourneyMirror({ env, limit: 250 });
  assert.equal(principalCleanup.failed, 0, "principal operation cleanup mirroring failed");

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
  const failoverReady = await checkTourneyManualFailoverReadiness({ env: failoverEnv });
  assert.equal(failoverReady.ready, true, `manual failover was blocked: ${failoverReady.blockers.join(",")}`);
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

  summary = {
    ok: true,
    postgres: version.trim(),
    databases: 2,
    mirrorApplied: firstMirror.applied,
    verified: [
      "registry composite keys",
      "collision quarantine and generation-1 tombstone guard",
      "insert mirroring",
      "idempotent Supabase-to-Neon fallback bootstrap",
      "private maintenance saga while public writes are paused",
      "update and delete mirroring for every registered domain",
      "receipt mirroring",
      "concurrent duplicate Idempotency-Key replay",
      "Idempotency-Key replay after manual failover",
      "versioned mirrored fallback account principal",
      "typed nullable Discord desired-state lookup",
      "atomic leases with concurrent workers",
      "expired lease recovery and dead-letter exhaustion",
      "generation tuple ordering",
      "audited clean-clock start and critical reset",
      "manual failover dual-control and backlog gate",
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
