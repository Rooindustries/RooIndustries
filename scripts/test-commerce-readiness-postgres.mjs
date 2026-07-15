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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-commerce-readiness-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 56800 + Math.floor(Math.random() * 500);

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

const bootstrap = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema migration;
create schema commerce;
create table migration.sync_runs(
  direction text not null,
  status text not null,
  completed_at timestamptz,
  counters jsonb not null default '{}'::jsonb
);
create table migration.commerce_mirror_checkpoints(
  id bigint generated always as identity primary key,
  event_key text,
  cutover_generation integer,
  mirrored_at timestamptz
);
create table migration.commerce_mirror_outbox(
  status text not null,
  created_at timestamptz not null default now()
);
create table migration.source_documents(
  document_type text not null,
  tombstoned boolean not null default false,
  payload jsonb not null default '{}'::jsonb
);
create table migration.commerce_request_metrics(
  route text not null,
  duration_ms integer not null,
  status_code integer not null,
  response_bytes integer not null default 0,
  recorded_at timestamptz not null default now()
);
create table commerce.payment_records(
  booking_id text,
  status text not null,
  provider_payment_id text
);
create table commerce.email_dispatches(
  status text not null,
  next_attempt_at timestamptz,
  updated_at timestamptz not null default now()
);
create table commerce.coupons(
  consumed_uses integer not null default 0,
  reserved_uses integer not null default 0,
  maximum_uses integer
);
create table commerce.booking_slots(
  start_time_utc timestamptz,
  status text not null
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
  for (const migration of [
    "20260712121529_fix_commerce_readiness_mirror_states.sql",
    "20260715115000_harden_commerce_readiness_evidence.sql",
    "20260715180100_filter_commerce_traffic_metrics.sql",
  ]) {
    run(path.join(pgBin, "psql"), [
      "-h", "127.0.0.1",
      "-p", String(port),
      "-d", "postgres",
      "-v", "ON_ERROR_STOP=1",
      "-f", path.join(root, "supabase/migrations", migration),
    ]);
  }

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 2,
    prepare: false,
  });
  const parity = {
    ok: true,
    failures: 0,
    compared: 10,
    mirrorPending: 0,
    capturedWithoutBooking: 0,
  };
  await sql`
    insert into migration.sync_runs(direction, status, completed_at, counters)
    values
      ('sanity_to_supabase', 'completed', now() - interval '1 hour',
        ${sql.json({ mode: "apply", parity })}),
      ('compare', 'completed', now() - interval '1 minute', ${sql.json({})}),
      ('compare', 'completed', now() - interval '2 minutes',
        ${sql.json({ mode: "verify", parity })})
  `;
  await sql`
    insert into migration.commerce_mirror_checkpoints(
      event_key, cutover_generation, mirrored_at
    ) values('checkpoint-1', 1, now() - interval '3 minutes')
  `;
  await sql`
    insert into migration.commerce_request_metrics(
      route, duration_ms, status_code, response_bytes
    )
    select 'booking/availability', 100, 200, 512 from generate_series(1, 30)
  `;
  await sql`
    insert into migration.commerce_request_metrics(
      route, duration_ms, status_code, response_bytes
    ) values
      ('payment/reconcile', 50000, 500, 1024),
      ('ref/cronsyncall', 50000, 500, 1024)
  `;

  const [row] = await sql`select public.roo_commerce_readiness() readiness`;
  assert.equal(row.readiness.last_parity.direction, "compare");
  assert.equal(row.readiness.last_parity.counters.parity.ok, true);
  assert.equal(row.readiness.last_parity.counters.parity.compared, 10);
  assert.equal(row.readiness.last_mirror_checkpoint.generation, 1);
  assert.deepEqual(row.readiness.recent_metrics, {
    sample_count: 30,
    p95_ms: 100,
    error_rate: 0,
    max_response_bytes: 512,
  });

  await sql`
    insert into migration.sync_runs(direction, status, completed_at, counters)
    values(
      'compare',
      'failed',
      now(),
      ${sql.json({
        mode: "verify",
        parity: { ...parity, ok: false, failures: 1 },
      })}
    )
  `;
  const [failedParity] = await sql`select public.roo_commerce_readiness() readiness`;
  assert.equal(failedParity.readiness.last_parity.counters.parity.ok, false);
  assert.equal(failedParity.readiness.last_parity.counters.parity.failures, 1);

  await sql`
    insert into migration.sync_runs(direction, status, completed_at, counters)
    values(
      'compare',
      'failed',
      now() + interval '1 second',
      ${sql.json({ mode: "verify", parity: { ok: true } })}
    )
  `;
  const [malformedParity] = await sql`select public.roo_commerce_readiness() readiness`;
  assert.deepEqual(malformedParity.readiness.last_parity.counters.parity, {
    ok: true,
  });

  await sql`
    insert into migration.sync_runs(direction, status, completed_at, counters)
    values(
      'compare',
      'failed',
      now() + interval '2 seconds',
      ${sql.json({ mode: "verify" })}
    )
  `;
  const [earlyFailure] = await sql`select public.roo_commerce_readiness() readiness`;
  assert.equal(earlyFailure.readiness.last_parity.status, "failed");
  assert.deepEqual(earlyFailure.readiness.last_parity.counters, {
    mode: "verify",
  });

  await sql.end();
  sql = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
    checks: 11,
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
