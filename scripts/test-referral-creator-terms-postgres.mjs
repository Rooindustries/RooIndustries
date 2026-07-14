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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-referral-terms-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 56332 + Math.floor(Math.random() * 500);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([`${command} ${args.join(" ")} failed`, result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n"));
  }
  return result.stdout;
};

const bootstrap = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema accounts;
create schema migration;
create schema extensions;
create extension pgcrypto with schema extensions;
create table accounts.creator_profiles (
  user_id uuid primary key,
  referral_code text not null unique,
  paypal_email text,
  contact_discord text,
  commission_basis_points integer not null default 1000,
  discount_basis_points integer not null default 0,
  successful_referrals integer not null default 0,
  payout_details jsonb not null default '{}'::jsonb,
  accounting_totals jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'sanity',
  updated_at timestamptz not null default now()
);
create table migration.source_documents (
  legacy_sanity_id text primary key,
  document_type text not null,
  source_revision text not null,
  source_hash text not null,
  payload jsonb not null,
  tombstoned boolean not null default false,
  backend_owner text not null default 'sanity'
);
create table migration.commerce_mirror_outbox (
  command_id text primary key,
  documents jsonb not null
);
create or replace function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document jsonb := p_mutations->0->'document';
  v_id text := v_document->>'_id';
  v_revision text := replace(extensions.gen_random_uuid()::text, '-', '');
begin
  update migration.source_documents
  set payload = v_document,
      source_revision = v_revision,
      source_hash = encode(extensions.digest(v_document::text, 'sha256'), 'hex'),
      backend_owner = 'supabase'
  where legacy_sanity_id = v_id
    and source_revision = p_mutations->0->>'expected_revision';
  if not found then
    raise exception 'document revision conflict' using errcode = '40001';
  end if;
  perform public.roo_project_referral_account_shadow(array[v_id]);
  insert into migration.commerce_mirror_outbox(command_id, documents)
  values(p_command_id, jsonb_build_array(v_document));
  return jsonb_build_object('event_key', 'fixture:' || p_command_id);
end;
$$;
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
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1",
    "-p", String(port),
    "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-f", path.join(
      root,
      "supabase/migrations/20260715080000_add_referral_creator_terms_editor.sql"
    ),
  ]);

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 2,
    prepare: false,
  });
  const creatorId = "10000000-0000-4000-8000-000000000001";
  const legacyId = "referral.fixture";
  const payload = {
    _id: legacyId,
    _type: "referral",
    name: "Fixture Creator",
    creatorEmail: "fixture@example.com",
    slug: { current: "fixture" },
    currentCommissionPercent: 10,
    currentDiscountPercent: 0,
    maxCommissionPercent: 15,
    successfulReferrals: 0,
    bypassUnlock: false,
  };
  await sql.begin(async (transaction) => {
    await transaction`
      insert into migration.source_documents(
        legacy_sanity_id, document_type, source_revision, source_hash, payload
      ) values(${legacyId}, 'referral', 'revision-1', ${"a".repeat(64)}, ${transaction.json(payload)})
    `;
    await transaction`
      insert into accounts.creator_profiles(
        user_id, referral_code, legacy_sanity_id, source_revision, source_hash
      ) values(${creatorId}, 'fixture', ${legacyId}, 'revision-1', ${"a".repeat(64)})
    `;
    await transaction`
      insert into accounts.creator_profiles(
        user_id, referral_code, commission_basis_points, discount_basis_points
      ) values(
        '10000000-0000-4000-8000-000000000002', 'imported-fixture', 2000, 1000
      )
    `;
  });

  const [imported] = await sql`
    select total_basis_points
    from accounts.creator_profiles
    where user_id='10000000-0000-4000-8000-000000000002'
  `;
  assert.equal(imported.total_basis_points, 3000);

  const [updated] = await sql`
    select public.roo_admin_update_creator_terms(
      'terms-fixture-0001', ${creatorId}, 1, 2000, 1000, 1000, true,
      'Fixture creator agreement', 0
    ) result
  `;
  assert.equal(updated.result.terms_version, 2);
  assert.equal(updated.result.total_basis_points, 2000);
  assert.equal(updated.result.bypass_referral_requirement, true);

  const [creator] = await sql`
    select total_basis_points, commission_basis_points, discount_basis_points,
      bypass_referral_requirement, terms_version
    from accounts.creator_profiles where user_id=${creatorId}
  `;
  assert.deepEqual(creator, {
    total_basis_points: 2000,
    commission_basis_points: 1000,
    discount_basis_points: 1000,
    bypass_referral_requirement: true,
    terms_version: "2",
  });

  const [source] = await sql`
    select payload->>'maxCommissionPercent' total,
      payload->>'currentCommissionPercent' commission,
      payload->>'currentDiscountPercent' discount,
      payload->>'bypassUnlock' bypass
    from migration.source_documents where legacy_sanity_id=${legacyId}
  `;
  assert.deepEqual(source, {
    total: "20.0000000000000000",
    commission: "10.0000000000000000",
    discount: "10.0000000000000000",
    bypass: "true",
  });

  const [counts] = await sql`
    select
      (select count(*)::integer from accounts.creator_terms_audit) audit_count,
      (select count(*)::integer from migration.commerce_mirror_outbox) mirror_count
  `;
  assert.deepEqual(counts, { audit_count: 1, mirror_count: 1 });

  const [replayed] = await sql`
    select public.roo_admin_update_creator_terms(
      'terms-fixture-0001', ${creatorId}, 1, 2000, 1000, 1000, true,
      'Fixture creator agreement', 0
    ) result
  `;
  assert.equal(replayed.result.replayed, true);
  const [afterReplay] = await sql`
    select terms_version,
      (select count(*)::integer from accounts.creator_terms_audit) audit_count
    from accounts.creator_profiles where user_id=${creatorId}
  `;
  assert.deepEqual(afterReplay, { terms_version: "2", audit_count: 1 });

  const concurrent = await Promise.all([
    sql`select public.roo_admin_update_creator_terms(
      'terms-fixture-0004', ${creatorId}, 2, 2000, 1200, 800, true,
      'Concurrent fixture replay', 0
    ) result`,
    sql`select public.roo_admin_update_creator_terms(
      'terms-fixture-0004', ${creatorId}, 2, 2000, 1200, 800, true,
      'Concurrent fixture replay', 0
    ) result`,
  ]);
  assert.deepEqual(
    concurrent.map(([row]) => row.result.replayed).sort(),
    [false, true]
  );
  const [afterConcurrent] = await sql`
    select terms_version,
      (select count(*)::integer from accounts.creator_terms_audit) audit_count,
      (select count(*)::integer from migration.commerce_mirror_outbox) mirror_count
    from accounts.creator_profiles where user_id=${creatorId}
  `;
  assert.deepEqual(afterConcurrent, {
    terms_version: "3",
    audit_count: 2,
    mirror_count: 2,
  });

  await assert.rejects(
    sql`select public.roo_admin_update_creator_terms(
      'terms-fixture-0002', ${creatorId}, 2, 2000, 1000, 1000, false,
      'Stale fixture update', 0
    )`,
    (error) => error.code === "40001"
  );
  await assert.rejects(
    sql`select public.roo_admin_update_creator_terms(
      'terms-fixture-0003', ${creatorId}, 3, 1500, 1000, 1000, false,
      'Invalid fixture allocation', 0
    )`,
    (error) => error.code === "22023"
  );
  await assert.rejects(
    sql`update accounts.creator_terms_audit set reason='mutated history'`,
    (error) => error.code === "55000"
  );

  const [privileges] = await sql`
    select
      has_function_privilege(
        'anon',
        'public.roo_admin_update_creator_terms(text,uuid,bigint,integer,integer,integer,boolean,text,integer)',
        'execute'
      ) anon_execute,
      has_function_privilege(
        'authenticated',
        'public.roo_admin_list_creator_terms(text,integer)',
        'execute'
      ) authenticated_execute,
      has_function_privilege(
        'service_role',
        'public.roo_admin_update_creator_terms(text,uuid,bigint,integer,integer,integer,boolean,text,integer)',
        'execute'
      ) service_execute
  `;
  assert.deepEqual(privileges, {
    anon_execute: false,
    authenticated_execute: false,
    service_execute: true,
  });

  await sql.end();
  sql = null;
  process.stdout.write(JSON.stringify({
    ok: true,
    postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
    checks: 15,
  }, null, 2) + "\n");
} finally {
  if (sql) await sql.end({ timeout: 1 });
  if (started) {
    spawnSync(path.join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
      encoding: "utf8",
    });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
