#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pgBin = String(process.env.PG_BIN || "").trim() || spawnSync(
  process.env.PG_CONFIG || "pg_config",
  ["--bindir"],
  { encoding: "utf8" }
).stdout.trim();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-backend-integrity-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 57300 + Math.floor(Math.random() * 500);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result.stdout;
};

const applyMigration = (name) => run(path.join(pgBin, "psql"), [
  "-h", "127.0.0.1",
  "-p", String(port),
  "-d", "postgres",
  "-v", "ON_ERROR_STOP=1",
  "-f", path.join(root, "supabase/migrations", name),
]);

const bootstrap = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema migration;
create schema commerce;
create schema auth;
create schema accounts;
create schema licensing;
create schema tourney;
create function migration.try_timestamptz(p_value text) returns timestamptz
language plpgsql stable as $$ begin return p_value::timestamptz; exception when others then return null; end $$;
create table migration.source_documents(
  legacy_sanity_id text primary key,
  payload jsonb not null default '{}'::jsonb
);
create table commerce.bookings(
  id uuid primary key,
  legacy_sanity_id text unique
);
create table commerce.slot_holds(
  id uuid primary key,
  legacy_sanity_id text unique,
  start_time_utc timestamptz not null,
  phase text not null,
  expires_at timestamptz not null,
  source_created_at timestamptz,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'supabase'
);
create table commerce.booking_slots(
  id uuid primary key,
  legacy_sanity_id text unique,
  booking_id uuid not null references commerce.bookings(id),
  start_time_utc timestamptz not null,
  status text not null,
  locked_at timestamptz not null default now(),
  source_revision text,
  source_hash text,
  backend_owner text not null default 'supabase'
);
create table commerce.slot_claims(
  start_time_utc timestamptz primary key,
  claim_type text not null,
  hold_id uuid references commerce.slot_holds(id),
  booking_id uuid references commerce.bookings(id),
  expires_at timestamptz,
  claimed_at timestamptz not null default now(),
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'supabase'
);
create function migration.project_commerce_document_ids(p_document_ids text[])
returns jsonb language sql security definer set search_path=''
as $$ select jsonb_build_object('projected', cardinality(p_document_ids)) $$;
create function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
) returns jsonb language sql security definer set search_path=''
as $$ select jsonb_build_object('ok', true, 'count', jsonb_array_length(p_mutations)) $$;

create table auth.users(
  id uuid primary key,
  banned_until timestamptz,
  updated_at timestamptz not null default now()
);
create table auth.sessions(user_id uuid not null);
create table auth.refresh_tokens(user_id text not null, token text not null);
create table accounts.principals(
  id uuid primary key,
  status text not null default 'active',
  session_version bigint not null default 1
);
create table accounts.principal_auth_users(
  principal_id uuid not null references accounts.principals(id),
  user_id uuid not null unique references auth.users(id)
);
create function public.roo_claim_entitlement(uuid, text, text default null)
returns jsonb language sql security definer set search_path=''
as $$ select '{"status":"claimed"}'::jsonb $$;
create function public.roo_activate_device(uuid, uuid, text, text, text default null, text default null)
returns jsonb language sql security definer set search_path=''
as $$ select '{"status":"active"}'::jsonb $$;
create function public.roo_revoke_device(uuid, text, text, uuid default null)
returns jsonb language sql security definer set search_path=''
as $$ select '{"status":"revoked"}'::jsonb $$;
create function public.roo_entitlement_status(uuid)
returns jsonb language sql stable security definer set search_path=''
as $$ select '[]'::jsonb $$;

create table tourney.cutover_metadata(
  id text primary key,
  natural_mutation_verified_at timestamptz,
  clock_last_reset_reason text,
  clock_last_evaluated_at timestamptz,
  updated_at timestamptz,
  updated_by text
);
create table tourney.shadow_observations(
  id bigint generated always as identity primary key,
  route text not null,
  shape_match boolean not null,
  value_match boolean not null,
  ordering_match boolean not null,
  error_match boolean not null,
  primary_status integer,
  shadow_status integer,
  primary_latency_ms integer not null,
  shadow_latency_ms integer not null,
  observed_at timestamptz not null
);
create table tourney.shadow_latency_baselines(
  route text primary key,
  primary_p95_ms integer not null
);
`;

let started = false;
let sql = null;
try {
  run(path.join(pgBin, "initdb"), ["-D", dataDir, "--auth=trust", "--no-locale"]);
  run(path.join(pgBin, "pg_ctl"), [
    "-D", dataDir,
    "-o", `-p ${port} -h 127.0.0.1`,
    "-w", "start",
  ], { stdio: "ignore" });
  started = true;
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1",
    "-p", String(port),
    "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-c", bootstrap,
  ]);

  applyMigration("20260718010000_serialize_commerce_slot_claims.sql");
  applyMigration("20260718011000_bound_commerce_mutations.sql");
  applyMigration("20260718012000_require_active_licensing_principals.sql");

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 8,
    prepare: false,
  });

  const holdId = "10000000-0000-4000-8000-000000000001";
  const paymentTime = "2099-01-01T00:00:00.000Z";
  await sql.begin(async (tx) => {
    await tx`insert into commerce.slot_holds(
      id,legacy_sanity_id,start_time_utc,phase,expires_at
    ) values(${holdId}::uuid,'slotHold.payment',${paymentTime}::timestamptz,'active','2099-01-01T01:00:00Z')`;
    await tx`select migration.reconcile_slot_claims_for_times(array[${paymentTime}::timestamptz])`;
  });
  await sql`update commerce.slot_holds set phase='payment' where id=${holdId}::uuid`;
  await sql`update commerce.slot_holds set phase='active' where id=${holdId}::uuid`;
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`delete from commerce.slot_claims where hold_id=${holdId}::uuid`;
      await tx`update commerce.slot_holds set phase='payment' where id=${holdId}::uuid`;
    }),
    /payment start requires an owned slot claim/
  );

  const missingBookingId = "20000000-0000-4000-8000-000000000001";
  const missingTime = "2099-01-02T00:00:00.000Z";
  await sql.begin(async (tx) => {
    await tx`insert into commerce.bookings(id,legacy_sanity_id)
      values(${missingBookingId}::uuid,'booking.missing-hold')`;
    await tx`insert into commerce.booking_slots(
      id,legacy_sanity_id,booking_id,start_time_utc,status
    ) values(
      '30000000-0000-4000-8000-000000000001','bookingSlot.missing-hold',
      ${missingBookingId}::uuid,${missingTime}::timestamptz,'active'
    )`;
    await tx`select migration.reconcile_slot_claims_for_times(array[${missingTime}::timestamptz])`;
  });
  const [missingClaim] = await sql`select claim_type,booking_id
    from commerce.slot_claims where start_time_utc=${missingTime}::timestamptz`;
  assert.equal(missingClaim.claim_type, "booking");
  assert.equal(missingClaim.booking_id, missingBookingId);

  await sql.begin(async (tx) => {
    await tx`delete from commerce.slot_claims where start_time_utc=${missingTime}::timestamptz`;
    await tx`select migration.project_commerce_document_ids(array['booking.missing-hold'])`;
  });
  assert.equal((await sql`select count(*)::integer count from commerce.slot_claims
    where start_time_utc=${missingTime}::timestamptz`)[0].count, 1);

  const transitionHoldId = "10000000-0000-4000-8000-000000000002";
  const transitionBookingId = "20000000-0000-4000-8000-000000000002";
  const transitionTime = "2099-01-03T00:00:00.000Z";
  await sql.begin(async (tx) => {
    await tx`insert into commerce.slot_holds(
      id,legacy_sanity_id,start_time_utc,phase,expires_at
    ) values(${transitionHoldId}::uuid,'slotHold.transition',${transitionTime}::timestamptz,'active','2099-01-03T01:00:00Z')`;
    await tx`select migration.reconcile_slot_claims_for_times(array[${transitionTime}::timestamptz])`;
  });
  await sql.begin(async (tx) => {
    await tx`update commerce.slot_holds set phase='consumed' where id=${transitionHoldId}::uuid`;
    await tx`insert into commerce.bookings(id,legacy_sanity_id)
      values(${transitionBookingId}::uuid,'booking.transition')`;
    await tx`insert into commerce.booking_slots(
      id,legacy_sanity_id,booking_id,start_time_utc,status
    ) values(
      '30000000-0000-4000-8000-000000000002','bookingSlot.transition',
      ${transitionBookingId}::uuid,${transitionTime}::timestamptz,'active'
    )`;
    await tx`select migration.reconcile_slot_claims_for_times(array[${transitionTime}::timestamptz])`;
  });
  const [transitionClaim] = await sql`select claim_type,booking_id
    from commerce.slot_claims where start_time_utc=${transitionTime}::timestamptz`;
  assert.equal(transitionClaim.claim_type, "booking");
  assert.equal(transitionClaim.booking_id, transitionBookingId);

  const runRace = async ({ time, winnerType }) => {
    let releaseWinner;
    let markWinnerReady;
    const winnerReady = new Promise((resolve) => { markWinnerReady = resolve; });
    const winnerRelease = new Promise((resolve) => { releaseWinner = resolve; });
    const winnerId = winnerType === "hold"
      ? "10000000-0000-4000-8000-000000000010"
      : "20000000-0000-4000-8000-000000000010";
    const loserType = winnerType === "hold" ? "booking" : "hold";
    const loserId = loserType === "hold"
      ? "10000000-0000-4000-8000-000000000011"
      : "20000000-0000-4000-8000-000000000011";

    const writeOwner = async (tx, type, id, suffix) => {
      if (type === "hold") {
        await tx`insert into commerce.slot_holds(
          id,legacy_sanity_id,start_time_utc,phase,expires_at
        ) values(${id}::uuid,${`slotHold.race-${suffix}`},${time}::timestamptz,'active','2099-02-01T01:00:00Z')`;
      } else {
        await tx`insert into commerce.bookings(id,legacy_sanity_id)
          values(${id}::uuid,${`booking.race-${suffix}`})`;
        await tx`insert into commerce.booking_slots(
          id,legacy_sanity_id,booking_id,start_time_utc,status
        ) values(
          ${`30000000-0000-4000-8000-0000000000${suffix === "winner" ? "10" : "11"}`}::uuid,
          ${`bookingSlot.race-${suffix}`},${id}::uuid,${time}::timestamptz,'active'
        )`;
      }
      await tx`select migration.reconcile_slot_claims_for_times(array[${time}::timestamptz])`;
    };

    const winner = sql.begin(async (tx) => {
      await writeOwner(tx, winnerType, winnerId, "winner");
      markWinnerReady();
      await winnerRelease;
    });
    await winnerReady;
    const loserOutcome = sql.begin(async (tx) => {
      await writeOwner(tx, loserType, loserId, "loser");
      await tx`set constraints all immediate`;
    }).then(() => null, (error) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseWinner();
    await winner;
    const loserError = await loserOutcome;
    assert.ok(loserError, `${loserType} unexpectedly won the occupied slot`);
    const [claim] = await sql`select claim_type from commerce.slot_claims
      where start_time_utc=${time}::timestamptz`;
    assert.equal(claim.claim_type, winnerType);
  };

  await runRace({ time: "2099-01-10T00:00:00.000Z", winnerType: "hold" });
  await runRace({ time: "2099-01-11T00:00:00.000Z", winnerType: "booking" });

  await assert.rejects(
    sql`select public.roo_apply_commerce_document_mutations(
      'fixture:invalid-id',
      '[{"operation":"delete","id":"booking..invalid"}]'::jsonb,
      1
    )`,
    /invalid id/
  );
  await assert.rejects(
    sql`select public.roo_apply_commerce_document_mutations(
      'fixture:too-many',
      (select jsonb_agg(jsonb_build_object('operation','delete','id','booking.'||item))
       from generate_series(1,101) item),
      1
    )`,
    /between 1 and 100/
  );

  const licensingUserId = "40000000-0000-4000-8000-000000000001";
  const licensingPrincipalId = "50000000-0000-4000-8000-000000000001";
  await sql`insert into auth.users(id) values(${licensingUserId}::uuid)`;
  await sql`insert into accounts.principals(id) values(${licensingPrincipalId}::uuid)`;
  await sql`insert into accounts.principal_auth_users(principal_id,user_id)
    values(${licensingPrincipalId}::uuid,${licensingUserId}::uuid)`;
  await sql`insert into auth.sessions(user_id) values(${licensingUserId}::uuid)`;
  await sql`insert into auth.refresh_tokens(user_id,token)
    values(${licensingUserId},'refresh-token')`;
  assert.deepEqual(
    (await sql`select public.roo_entitlement_status(${licensingUserId}::uuid) value`)[0].value,
    []
  );
  await sql`update accounts.principals set status='disabled'
    where id=${licensingPrincipalId}::uuid`;
  const [revocation] = await sql`select
    (select count(*)::integer from auth.sessions where user_id=${licensingUserId}::uuid) sessions,
    (select count(*)::integer from auth.refresh_tokens where user_id=${licensingUserId}) refresh_tokens,
    (select banned_until='infinity'::timestamptz from auth.users where id=${licensingUserId}::uuid) banned`;
  assert.deepEqual(revocation, { sessions: 0, refresh_tokens: 0, banned: true });
  await assert.rejects(
    sql`select public.roo_entitlement_status(${licensingUserId}::uuid)`,
    /active licensing principal not found/
  );

  await sql.end();
  sql = null;

  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1",
    "-p", String(port),
    "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-c", `
      insert into tourney.cutover_metadata(
        id,natural_mutation_verified_at,clock_last_reset_reason
      ) values('tourney',now()-interval '1 hour','shadow_acceptance_gate_failed');
      insert into tourney.shadow_latency_baselines(route,primary_p95_ms)
      values
        ('public_roster',100),('public_bracket',100),('admin_players',100),
        ('appeals',100),('payouts',100);
      insert into tourney.shadow_observations(
        route,shape_match,value_match,ordering_match,error_match,
        primary_status,shadow_status,primary_latency_ms,shadow_latency_ms,observed_at
      ) select route,true,true,true,true,200,200,100,110,now()
      from (values
        ('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')
      ) routes(route), generate_series(1,30);
    `,
  ]);
  applyMigration("20260718013000_refresh_tourney_shadow_acceptance.sql");
  const tourneySql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 1,
    prepare: false,
  });
  const [acceptance] = await tourneySql`select
    tourney.current_shadow_acceptance_gate_passes() passes,
    clock_last_reset_reason
    from tourney.cutover_metadata where id='tourney'`;
  assert.deepEqual(acceptance, { passes: true, clock_last_reset_reason: null });
  await tourneySql`delete from tourney.shadow_observations
    where id=(select min(id) from tourney.shadow_observations where route='payouts')`;
  assert.equal(
    (await tourneySql`select tourney.current_shadow_acceptance_gate_passes() passes`)[0].passes,
    false
  );
  await tourneySql.end();

  process.stdout.write(`${JSON.stringify({
    ok: true,
    postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
    checks: 20,
  }, null, 2)}\n`);
} finally {
  if (sql) await sql.end({ timeout: 1 });
  if (started) {
    spawnSync(path.join(pgBin, "pg_ctl"), [
      "-D", dataDir,
      "-m", "fast",
      "-w", "stop",
    ], { encoding: "utf8" });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
