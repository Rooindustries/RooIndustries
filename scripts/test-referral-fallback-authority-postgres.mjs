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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-ref-authority-"));
const dataDir = path.join(tempRoot, "pgdata");
const port = 56832 + Math.floor(Math.random() * 500);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
    );
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
create table accounts.principals (
  id uuid primary key,
  status text not null check(status in ('active','disabled','deleted')),
  session_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table accounts.creator_profiles (
  user_id uuid primary key,
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  referral_code text not null unique,
  active boolean not null default true,
  legacy_sanity_id text unique
);
create table accounts.account_roles (
  user_id uuid not null,
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  role text not null,
  primary key(user_id, role)
);
create table accounts.credential_migrations (
  user_id uuid primary key,
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  imported_at timestamptz,
  upgraded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table migration.source_documents (
  legacy_sanity_id text primary key,
  document_type text not null,
  source_revision text not null,
  source_hash text not null,
  payload jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  operational_imported boolean not null default false,
  cms_imported boolean not null default false,
  tombstoned boolean not null default false,
  backend_owner text not null default 'supabase'
);
create table migration.document_mutation_mirror_outbox (
  sequence_no bigint generated always as identity primary key,
  event_key uuid not null default extensions.gen_random_uuid() unique,
  document_ids text[] not null,
  documents jsonb not null default '[]'::jsonb,
  deleted_documents jsonb not null default '[]'::jsonb,
  canonical_hash text not null,
  status text not null default 'pending'
    check(status in ('pending','processing','retry','applied','dead_letter')),
  created_at timestamptz not null default now()
);
create or replace function public.roo_apply_document_mutations(p_mutations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_document jsonb;
  v_id text;
  v_operation text;
  v_revision text;
  v_hash text;
  v_existing migration.source_documents%rowtype;
  v_results jsonb := '[]'::jsonb;
begin
  for v_mutation in select value from jsonb_array_elements(p_mutations)
  loop
    v_id := v_mutation->>'id';
    v_operation := v_mutation->>'operation';
    v_document := v_mutation->'document';
    select * into v_existing
    from migration.source_documents source
    where source.legacy_sanity_id = v_id
    for update;
    if v_operation = 'replace' then
      if not found or v_existing.source_revision is distinct from v_mutation->>'expected_revision' then
        raise exception 'document revision conflict' using errcode='40001';
      end if;
    elsif v_operation = 'create_if_missing' and found then
      v_results := v_results || jsonb_build_array(v_existing.payload);
      continue;
    end if;
    v_revision := replace(extensions.gen_random_uuid()::text, '-', '');
    v_document := v_document || jsonb_build_object(
      '_rev', v_revision,
      '_createdAt', coalesce(v_existing.payload->'_createdAt', to_jsonb(now())),
      '_updatedAt', now()
    );
    v_hash := encode(extensions.digest(v_document::text, 'sha256'), 'hex');
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, backend_owner
    ) values(
      v_id, v_document->>'_type', v_revision, v_hash, v_document,
      now(), now(), 'supabase'
    ) on conflict(legacy_sanity_id) do update set
      document_type=excluded.document_type,
      source_revision=excluded.source_revision,
      source_hash=excluded.source_hash,
      payload=excluded.payload,
      source_updated_at=excluded.source_updated_at,
      tombstoned=false,
      backend_owner='supabase';
    insert into migration.document_mutation_mirror_outbox(
      document_ids, documents, canonical_hash
    ) values(
      array[v_id], jsonb_build_array(v_document),
      encode(extensions.digest(jsonb_build_object(
        'documents', jsonb_build_array(v_document),
        'deleted_documents', '[]'::jsonb
      )::text, 'sha256'), 'hex')
    );
    v_results := v_results || jsonb_build_array(v_document);
  end loop;
  return v_results;
end;
$$;
create or replace function public.roo_supabase_port_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'documentMutationMirror', jsonb_build_object('ready', true),
    'credentialRecovery', jsonb_build_object('pending', 0),
    'identityDrift', jsonb_build_object('missing', 0, 'stale', 0)
  );
$$;
insert into accounts.principals(id,status,session_version,created_at,updated_at)
values
  ('10000000-0000-4000-8000-000000000001','active',1,'2026-01-01','2026-01-01'),
  ('20000000-0000-4000-8000-000000000002','active',4,'2026-02-01','2026-02-02');
insert into accounts.creator_profiles(user_id,principal_id,referral_code,active,legacy_sanity_id)
values
  ('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','alpha',true,'referral.alpha'),
  ('22000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','beta',true,'referral.beta');
insert into accounts.account_roles(user_id,principal_id,role)
values
  ('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','creator'),
  ('22000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','creator');
insert into accounts.credential_migrations(user_id,principal_id,upgraded_at)
values
  ('11000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-01-02'),
  ('22000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','2026-02-02');
`;

let started = false;
let sql = null;
try {
  run(path.join(pgBin, "initdb"), ["-D", dataDir, "--auth=trust", "--no-locale"]);
  run(path.join(pgBin, "pg_ctl"), [
    "-D",
    dataDir,
    "-o",
    `-p ${port} -h 127.0.0.1`,
    "-w",
    "start",
  ], { stdio: "ignore" });
  started = true;
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    bootstrap,
  ]);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    path.join(
      root,
      "supabase/migrations/20260715100000_add_referral_fallback_authority.sql"
    ),
  ]);

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 4,
    prepare: false,
  });

  const authorities = await sql`
    select legacy_creator_id, principal_id::text, referral_code,
      principal_session_version, principal_status, creator_active,
      creator_role_present, credential_version, current_record, authority_version
    from accounts.creator_fallback_authorities
    order by legacy_creator_id
  `;
  assert.deepEqual([...authorities], [
    {
      legacy_creator_id: "referral.alpha",
      principal_id: "10000000-0000-4000-8000-000000000001",
      referral_code: "alpha",
      principal_session_version: "1",
      principal_status: "active",
      creator_active: true,
      creator_role_present: true,
      credential_version: "1",
      current_record: true,
      authority_version: "1",
    },
    {
      legacy_creator_id: "referral.beta",
      principal_id: "20000000-0000-4000-8000-000000000002",
      referral_code: "beta",
      principal_session_version: "4",
      principal_status: "active",
      creator_active: true,
      creator_role_present: true,
      credential_version: "4",
      current_record: true,
      authority_version: "1",
    },
  ]);

  const [documentCheck] = await sql`
    select
      count(*)::integer document_count,
      bool_and(not (payload ? 'creatorEmail')) no_email,
      bool_and(not (payload ? 'creatorPassword')) no_password,
      bool_and(payload->>'_type'='referralAuthAuthority') correct_type
    from migration.source_documents
    where document_type='referralAuthAuthority'
  `;
  assert.deepEqual(documentCheck, {
    document_count: 2,
    no_email: true,
    no_password: true,
    correct_type: true,
  });

  const [initialReadiness] = await sql`
    select public.roo_referral_fallback_authority_readiness() result
  `;
  assert.equal(initialReadiness.result.healthy, true);
  assert.equal(initialReadiness.result.ready, false);
  assert.equal(initialReadiness.result.mirror.pending, 2);

  const [composedReadiness] = await sql`
    select public.roo_supabase_release_readiness() result
  `;
  assert.deepEqual(composedReadiness.result.documentMutationMirror, {
    ready: true,
  });
  assert.deepEqual(composedReadiness.result.credentialRecovery, { pending: 0 });
  assert.deepEqual(composedReadiness.result.identityDrift, {
    missing: 0,
    stale: 0,
  });
  assert.equal(
    composedReadiness.result.referralFallbackAuthority.ready,
    false
  );

  await sql`
    update migration.document_mutation_mirror_outbox set status='applied'
  `;
  const [ready] = await sql`
    select public.roo_referral_fallback_authority_readiness() result
  `;
  assert.equal(ready.result.ready, true);

  const beforeRollback = await sql`
    select authority_version from accounts.creator_fallback_authorities
    where legacy_creator_id='referral.alpha'
  `;
  const eventsBeforeRollback = await sql`
    select count(*)::integer count from migration.document_mutation_mirror_outbox
  `;
  await assert.rejects(
    sql.begin(async (transaction) => {
      await transaction`
        update accounts.principals
        set session_version=session_version+1, updated_at=now()
        where id='10000000-0000-4000-8000-000000000001'
      `;
      throw new Error("rollback fixture");
    }),
    /rollback fixture/
  );
  assert.deepEqual(
    await sql`
      select authority_version from accounts.creator_fallback_authorities
      where legacy_creator_id='referral.alpha'
    `,
    beforeRollback
  );
  assert.deepEqual(
    await sql`
      select count(*)::integer count from migration.document_mutation_mirror_outbox
    `,
    eventsBeforeRollback
  );

  await Promise.all([
    sql`
      update accounts.principals
      set session_version=session_version+1, updated_at=clock_timestamp()
      where id='10000000-0000-4000-8000-000000000001'
    `,
    sql`
      update accounts.principals
      set session_version=session_version+1, updated_at=clock_timestamp()
      where id='10000000-0000-4000-8000-000000000001'
    `,
  ]);
  const [rotated] = await sql`
    select principal_session_version, credential_version, authority_version,
      credential_changed_at > '2026-01-02'::timestamptz changed_after_import
    from accounts.creator_fallback_authorities
    where legacy_creator_id='referral.alpha'
  `;
  assert.deepEqual(rotated, {
    principal_session_version: "3",
    credential_version: "3",
    authority_version: "3",
    changed_after_import: true,
  });

  await sql`
    delete from accounts.account_roles
    where principal_id='10000000-0000-4000-8000-000000000001'
      and role='creator'
  `;
  const [roleRemoved] = await sql`
    select creator_role_present from accounts.creator_fallback_authorities
    where legacy_creator_id='referral.alpha'
  `;
  assert.equal(roleRemoved.creator_role_present, false);

  await sql`
    update accounts.creator_profiles
    set legacy_sanity_id='referral.alpha-renamed', referral_code='alpha-new'
    where principal_id='10000000-0000-4000-8000-000000000001'
  `;
  const renamed = await sql`
    select legacy_creator_id, referral_code, creator_active, current_record
    from accounts.creator_fallback_authorities
    where principal_id='10000000-0000-4000-8000-000000000001'
    order by legacy_creator_id
  `;
  assert.deepEqual([...renamed], [
    {
      legacy_creator_id: "referral.alpha",
      referral_code: "alpha",
      creator_active: false,
      current_record: false,
    },
    {
      legacy_creator_id: "referral.alpha-renamed",
      referral_code: "alpha-new",
      creator_active: true,
      current_record: true,
    },
  ]);

  await sql`
    insert into accounts.principals(id,status,session_version,created_at,updated_at)
    values ('30000000-0000-4000-8000-000000000003','active',3,'2026-03-01','2026-03-01')
  `;
  await sql`
    insert into accounts.account_roles(user_id,principal_id,role)
    values (
      '33000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000003',
      'creator'
    )
  `;
  await sql`
    insert into accounts.credential_migrations(user_id,principal_id,upgraded_at)
    values (
      '33000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000003',
      '2026-03-02'
    )
  `;
  await sql`
    update accounts.creator_profiles
    set principal_id='30000000-0000-4000-8000-000000000003'
    where user_id='11000000-0000-4000-8000-000000000001'
  `;
  const [transferred] = await sql`
    select principal_id::text, credential_version,
      credential_changed_at = '2026-03-01'::timestamptz changed_for_new_principal
    from accounts.creator_fallback_authorities
    where legacy_creator_id='referral.alpha-renamed'
  `;
  assert.deepEqual(transferred, {
    principal_id: "30000000-0000-4000-8000-000000000003",
    credential_version: "3",
    changed_for_new_principal: true,
  });

  const [authoritySource] = await sql`
    select source.legacy_sanity_id document_id, source.payload
    from migration.source_documents source
    join accounts.creator_fallback_authorities authority
      on authority.document_id=source.legacy_sanity_id
    where authority.legacy_creator_id='referral.alpha-renamed'
  `;
  for (const tamper of [
    { authoritySchemaVersion: 2 },
    { creatorActive: false },
    { creatorRolePresent: false },
    { credentialChangedAt: "2025-01-01T00:00:00.000Z" },
    { currentRecord: false },
    { authorityVersion: 999 },
  ]) {
    await sql`
      update migration.source_documents
      set payload=payload || ${sql.json(tamper)}::jsonb
      where legacy_sanity_id=${authoritySource.document_id}
    `;
    const [tamperedReadiness] = await sql`
      select public.roo_referral_fallback_authority_readiness() result
    `;
    assert.equal(tamperedReadiness.result.sourceDrift, 1);
    await sql`
      update migration.source_documents
      set payload=${sql.json(authoritySource.payload)}::jsonb
      where legacy_sanity_id=${authoritySource.document_id}
    `;
  }

  const [eventsBeforeRepair] = await sql`
    select count(*)::integer count
    from migration.document_mutation_mirror_outbox
  `;
  await sql`
    update migration.source_documents
    set payload=payload || '{"authoritySchemaVersion":2}'::jsonb
    where legacy_sanity_id=${authoritySource.document_id}
  `;
  const [repair] = await sql`
    select accounts.refresh_creator_fallback_authority(
      '30000000-0000-4000-8000-000000000003'::uuid,
      'referral.alpha-renamed'
    ) repaired
  `;
  assert.equal(repair.repaired, 1);
  const [repairedSource] = await sql`
    select
      payload->>'authoritySchemaVersion' schema_version,
      (select count(*)::integer
       from migration.document_mutation_mirror_outbox) event_count
    from migration.source_documents
    where legacy_sanity_id=${authoritySource.document_id}
  `;
  assert.deepEqual(repairedSource, {
    schema_version: "1",
    event_count: eventsBeforeRepair.count + 1,
  });

  await sql`
    delete from accounts.principals
    where id='20000000-0000-4000-8000-000000000002'
  `;
  const [deletedPrincipal] = await sql`
    select principal_status, creator_active, creator_role_present, current_record
    from accounts.creator_fallback_authorities
    where legacy_creator_id='referral.beta'
  `;
  assert.deepEqual(deletedPrincipal, {
    principal_status: "deleted",
    creator_active: false,
    creator_role_present: false,
    current_record: false,
  });

  const [privileges] = await sql`
    select
      has_table_privilege('anon','accounts.creator_fallback_authorities','select') anon_table,
      has_table_privilege('authenticated','accounts.creator_fallback_authorities','select') authenticated_table,
      has_table_privilege('service_role','accounts.creator_fallback_authorities','select') service_table,
      has_function_privilege('anon','public.roo_referral_fallback_authority_readiness()','execute') anon_rpc,
      has_function_privilege('authenticated','public.roo_referral_fallback_authority_readiness()','execute') authenticated_rpc,
      has_function_privilege('service_role','public.roo_referral_fallback_authority_readiness()','execute') service_rpc,
      has_function_privilege('anon','public.roo_supabase_release_readiness()','execute') anon_release_rpc,
      has_function_privilege('authenticated','public.roo_supabase_release_readiness()','execute') authenticated_release_rpc,
      has_function_privilege('service_role','public.roo_supabase_release_readiness()','execute') service_release_rpc
  `;
  assert.deepEqual(privileges, {
    anon_table: false,
    authenticated_table: false,
    service_table: false,
    anon_rpc: false,
    authenticated_rpc: false,
    service_rpc: true,
    anon_release_rpc: false,
    authenticated_release_rpc: false,
    service_release_rpc: true,
  });

  await sql`
    update migration.document_mutation_mirror_outbox
    set status='dead_letter'
    where sequence_no=(select max(sequence_no) from migration.document_mutation_mirror_outbox)
  `;
  const [blocked] = await sql`
    select public.roo_referral_fallback_authority_readiness() result
  `;
  assert.equal(blocked.result.ready, false);
  assert.equal(blocked.result.healthy, false);
  assert.equal(blocked.result.mirror.deadLetter, 1);

  await sql.end();
  sql = null;
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
      checks: 41,
    }, null, 2)}\n`
  );
} finally {
  if (sql) await sql.end({ timeout: 1 });
  if (started) {
    spawnSync(
      path.join(pgBin, "pg_ctl"),
      ["-D", dataDir, "-m", "fast", "-w", "stop"],
      { encoding: "utf8" }
    );
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
