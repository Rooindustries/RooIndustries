#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const pgBin = String(
  process.env.PG_BIN || "/opt/homebrew/opt/postgresql@17/bin",
);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roo-document-outbox-"));
const dataDir = path.join(tempRoot, "pgdata");
const socketDir = path.join(tempRoot, "socket");
const port = 56000 + Math.floor(Math.random() * 900);
const database = "document_outbox_test";
const username = os.userInfo().username;
const databaseUrl = `postgresql://${username}@127.0.0.1:${port}/${database}`;
let started = false;

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
        .join("\n"),
    );
  }
  return result.stdout;
};

const writeTemp = (name, contents) => {
  const file = path.join(tempRoot, name);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return file;
};

const bootstrap = `
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema extensions;
create schema migration;
create schema cms;
create schema accounts;
create schema auth;
create schema commerce;
create extension pgcrypto with schema extensions;

create table migration.source_documents (
  legacy_sanity_id text primary key,
  document_type text not null,
  source_revision text,
  source_hash text not null,
  payload jsonb not null,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  operational_imported boolean not null default false,
  cms_imported boolean not null default false,
  tombstoned boolean not null default false,
  tombstoned_at timestamptz,
  backend_owner text not null default 'sanity',
  cutover_generation integer not null default 0
);
create table migration.sync_runs (
  direction text not null,
  status text not null,
  completed_at timestamptz
);
create table cms.documents (
  id uuid primary key default extensions.gen_random_uuid(),
  legacy_sanity_id text not null unique,
  document_type text not null,
  payload jsonb not null,
  content_hash text not null
);
create table cms.assets (
  id uuid primary key default extensions.gen_random_uuid(),
  legacy_sanity_asset_id text not null unique,
  source_url text not null,
  storage_bucket text not null,
  storage_path text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  sha256 text not null,
  width integer,
  height integer,
  metadata jsonb not null default '{}'::jsonb,
  migration_status text not null default 'verified',
  copied_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);
create table cms.document_assets (
  document_id uuid not null references cms.documents(id) on delete cascade,
  asset_id uuid not null references cms.assets(id) on delete restrict,
  field_path text not null,
  primary key(document_id, asset_id, field_path)
);
create or replace function cms.sync_document_from_source(
  p_document jsonb,
  p_hash text
)
returns void language sql set search_path='' as $$
  insert into cms.documents(legacy_sanity_id,document_type,payload,content_hash)
  values(p_document->>'_id',p_document->>'_type',p_document,p_hash)
  on conflict(legacy_sanity_id) do update
  set document_type=excluded.document_type,payload=excluded.payload,content_hash=excluded.content_hash;
$$;

create or replace function public.roo_upsert_asset(p_asset jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  insert into cms.assets(
    legacy_sanity_asset_id,source_url,storage_bucket,storage_path,mime_type,
    byte_size,sha256,width,height,metadata,migration_status,copied_at,verified_at
  ) values (
    p_asset->>'legacy_sanity_asset_id',p_asset->>'source_url',
    p_asset->>'storage_bucket',p_asset->>'storage_path',p_asset->>'mime_type',
    (p_asset->>'byte_size')::bigint,p_asset->>'sha256',
    nullif(p_asset->>'width','')::integer,nullif(p_asset->>'height','')::integer,
    coalesce(p_asset->'metadata','{}'::jsonb),'verified',now(),now()
  ) on conflict(legacy_sanity_asset_id) do update set
    source_url=excluded.source_url,storage_bucket=excluded.storage_bucket,
    storage_path=excluded.storage_path,mime_type=excluded.mime_type,
    byte_size=excluded.byte_size,sha256=excluded.sha256,
    migration_status='verified',verified_at=now(),updated_at=now()
  returning id into v_id;
  return jsonb_build_object('asset_id',v_id,'verified',true);
end;
$$;

create table auth.users (
  id uuid primary key,
  encrypted_password text not null default ''
);
create table auth.sessions (
  user_id uuid not null
);
create table auth.identities (
  user_id uuid not null,
  provider text not null,
  provider_id text not null
);
create table accounts.principals (
  id uuid primary key,
  status text not null default 'active',
  session_version bigint not null default 1,
  updated_at timestamptz not null default now()
);
create table accounts.principal_auth_users (
  user_id uuid primary key,
  principal_id uuid not null
);
create table accounts.identity_links (
  user_id uuid not null,
  principal_id uuid not null,
  provider text not null,
  provider_subject text not null
);
create table accounts.credential_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  operation_key text not null unique,
  user_id uuid not null,
  principal_id uuid not null,
  password_hash text not null,
  status text not null default 'prepared'
    check (status in ('prepared', 'auth_applied', 'mirrored', 'failed')),
  source_revision text,
  attempt_count integer not null default 0,
  last_error_code text,
  auth_applied_at timestamptz,
  mirrored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table accounts.credential_migrations (
  user_id uuid primary key,
  credential_kind text not null default 'bcrypt',
  status text not null default 'imported',
  upgraded_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  failure_reason text,
  updated_at timestamptz not null default now()
);
create or replace function public.roo_complete_credential_migration(
  p_user_id uuid
)
returns void language sql security definer set search_path='' as $$
  update accounts.credential_migrations
  set
    credential_kind='bcrypt',
    status='upgraded',
    upgraded_at=coalesce(upgraded_at,now()),
    last_attempt_at=now(),
    attempt_count=attempt_count+1,
    failure_reason=null,
    updated_at=now()
  where user_id=p_user_id;
$$;
create table accounts.creator_profiles (
  principal_id uuid,
  user_id uuid,
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  backend_owner text
);
create table accounts.discord_role_assignments (status text not null, updated_at timestamptz not null default now());
create table accounts.oauth_intents (status text not null, expires_at timestamptz not null, updated_at timestamptz not null default now());

create table commerce.payment_records (
  id text primary key,
  status text not null,
  updated_at timestamptz not null default now(),
  next_recovery_at timestamptz,
  booking_id text,
  requires_reschedule boolean not null default false,
  duplicate_payment_record boolean not null default false,
  canonical_payment_record_id text
);
create table commerce.bookings (id text primary key, payment_record_id text);
create table commerce.recovery_cases (
  case_type text not null,
  status text not null,
  requires_reschedule boolean not null default false
);
create table migration.commerce_control (
  singleton boolean primary key default true check(singleton),
  primary_backend text not null,
  generation integer not null,
  starts_paused boolean not null default false
);
insert into migration.commerce_control values(true,'supabase',1,false);
create table migration.commerce_commands (
  command_id text primary key,
  request_hash text not null,
  cutover_generation integer not null,
  operation text not null default 'document_mutation',
  result jsonb not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);
create table migration.commerce_mirror_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence_no bigint generated always as identity unique,
  command_id text not null references migration.commerce_commands(command_id),
  event_key text not null unique,
  document_ids text[] not null,
  documents jsonb not null default '[]'::jsonb,
  deleted_ids text[] not null default '{}'::text[],
  canonical_hash text not null,
  cutover_generation integer not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  mirrored_at timestamptz
);
create table commerce.booking_settings (
  id text primary key default 'default',
  payload jsonb not null,
  legacy_sanity_id text unique,
  source_backend text not null default 'sanity',
  updated_at timestamptz not null default now()
);
create table commerce.coupons (
  legacy_sanity_id text primary key,
  active boolean not null default false,
  backend_owner text not null default 'sanity',
  updated_at timestamptz not null default now()
);
create table migration.cms_projection_calls (
  document_id text not null,
  operation text not null,
  called_at timestamptz not null default now()
);
create or replace function migration.commerce_command_hash(text,jsonb,integer)
returns text language sql immutable strict set search_path='' as $$
  select encode(extensions.digest(
    jsonb_build_object('operation',$1,'payload',$2,'generation',$3)::text,'sha256'
  ),'hex');
$$;
create or replace function migration.assert_commerce_write_fence(p_generation integer)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not exists(
    select 1 from migration.commerce_control
    where singleton and primary_backend='supabase' and generation=p_generation
  ) then raise exception 'Commerce generation is stale' using errcode='40001'; end if;
end;
$$;
create or replace function migration.canonical_business_document(p_payload jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select p_payload - array['_rev','_createdAt','_updatedAt','_supabaseSequence'];
$$;
create or replace function migration.project_commerce_document_ids(p_ids text[])
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  insert into commerce.booking_settings(id,payload,legacy_sanity_id,source_backend)
  select 'default',payload,legacy_sanity_id,'sanity'
  from migration.source_documents
  where legacy_sanity_id=any(p_ids) and document_type='bookingSettings' and not tombstoned
  on conflict(id) do update set payload=excluded.payload,legacy_sanity_id=excluded.legacy_sanity_id;
  insert into commerce.coupons(legacy_sanity_id,active,backend_owner)
  select legacy_sanity_id,coalesce((payload->>'isActive')::boolean,false),'sanity'
  from migration.source_documents
  where legacy_sanity_id=any(p_ids) and document_type='coupon' and not tombstoned
  on conflict(legacy_sanity_id) do update set active=excluded.active;
  return '{}'::jsonb;
end;
$$;
create or replace function migration.project_commerce_extensions(text[])
returns jsonb language sql security definer set search_path='' as $$ select '{}'::jsonb $$;
create or replace function migration.restore_commerce_owners(p_ids text[])
returns void language plpgsql security definer set search_path='' as $$
begin
  update commerce.coupons target set backend_owner=source.backend_owner
  from migration.source_documents source
  where target.legacy_sanity_id=source.legacy_sanity_id and source.legacy_sanity_id=any(p_ids);
end;
$$;
create or replace function migration.project_commerce_recovery_fields(text[])
returns integer language sql security definer set search_path='' as $$ select 0 $$;
create or replace function migration.cleanup_commerce_document_ids(p_ids text[])
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  insert into migration.cms_projection_calls(document_id,operation)
  select id,'cleanup' from unnest(p_ids) id;
  return '{}'::jsonb;
end;
$$;

insert into auth.users(id, encrypted_password)
values(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  '$2b$12$ddddddddddddddddddddddddddddddddddddddddddddddddddddd'
);
insert into accounts.principals(id)
values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid);
insert into accounts.principal_auth_users(user_id, principal_id)
values(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
);
insert into accounts.creator_profiles(
  principal_id, user_id, legacy_sanity_id, source_revision,
  source_hash, backend_owner
) values(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'referral.missing-recovery-source',
  'missing-revision',
  '${"d".repeat(64)}',
  'supabase'
);
insert into accounts.credential_operations(
  operation_key, user_id, principal_id, password_hash, status, source_revision
) values(
  'credential:reset:missing-source',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
  '$2b$12$ddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  'auth_applied',
  'missing-revision'
);
`;

const triggerFailure = `
create or replace function migration.reject_document_outbox()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'forced outbox failure';
end;
$$;
create trigger reject_document_outbox
before insert on migration.document_mutation_mirror_outbox
for each row execute function migration.reject_document_outbox();
`;

const mutation = ({ operation, id, document, expectedRevision }) => ({
  operation,
  id,
  ...(document ? { document } : {}),
  ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
});

const claim = async (sql, leaseId, limit = 10, preferredIds = null) => {
  const [row] = await sql`
    select public.roo_claim_document_mutation_mirror_events(
      ${leaseId}::uuid,
      ${limit}::integer,
      120::integer,
      ${preferredIds}::text[]
    ) events
  `;
  return row.events;
};

const complete = async (sql, eventKey, leaseId, success, errorCode = null) => {
  const [row] = await sql`
    select public.roo_complete_document_mutation_mirror_event(
      ${eventKey}::uuid,
      ${leaseId}::uuid,
      ${success}::boolean,
      ${errorCode}::text
    ) result
  `;
  return row.result;
};

const apply = async (sql, mutations) => {
  const [row] = await sql`
    select public.roo_apply_document_mutations(${sql.json(mutations)}::jsonb) result
  `;
  return row.result;
};

const applyCms = async ({
  sql,
  commandId,
  requestHash,
  actor = "sanity:postgres-test",
  mutations,
  assets = [],
  assetLinks = [],
}) => {
  const [row] = await sql`
    select public.roo_apply_cms_publish_command(
      ${commandId},
      ${requestHash},
      ${actor},
      ${sql.json(mutations)}::jsonb,
      ${sql.json(assets)}::jsonb,
      ${sql.json(assetLinks)}::jsonb
    ) result
  `;
  return row.result;
};

const cmsIdentity = (seed) => {
  const requestHash = crypto.createHash("sha256").update(seed).digest("hex");
  return { requestHash, commandId: `cms:${requestHash}` };
};

let sql;
let summary;
try {
  fs.mkdirSync(socketDir);
  run(path.join(pgBin, "initdb"), [
    "-D",
    dataDir,
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run(
    path.join(pgBin, "pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -k ${socketDir}`, "-w", "start"],
    { stdio: "ignore" },
  );
  started = true;
  run(path.join(pgBin, "createdb"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    database,
  ]);
  const bootstrapFile = writeTemp("bootstrap.sql", bootstrap);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    bootstrapFile,
  ]);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    path.join(
      root,
      "supabase/migrations/20260715090000_add_document_mutation_mirror_outbox.sql",
    ),
  ]);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    path.join(
      root,
      "supabase/migrations/20260715120000_add_global_cms_publish_authority.sql",
    ),
  ]);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f",
    path.join(root, "supabase/migrations/20260715130000_harden_credential_recovery_saga.sql"),
  ]);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f",
    path.join(root, "supabase/migrations/20260715130100_add_credential_recovery_queue_index.sql"),
  ]);
  run(path.join(pgBin, "psql"), [
    "-h", "127.0.0.1", "-p", String(port), "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f",
    path.join(
      root,
      "supabase/migrations/20260718023317_harden_credential_reconciliation_retry.sql",
    ),
  ]);
  sql = postgres(databaseUrl, { max: 8 });

  const [credentialSchema] = await sql`
    select
      (select count(*)::integer
       from pg_attribute
       where attrelid='accounts.credential_operations'::regclass
         and attname in (
           'last_error',
           'last_error_class',
           'consecutive_error_count',
           'next_retry_at',
           'source_recovery_blocked_at'
         )
         and not attisdropped) retry_column_count,
      (select count(*)::integer
       from pg_constraint
       where conrelid='accounts.credential_operations'::regclass
         and conname in (
           'credential_operations_source_backend_check',
           'credential_operations_source_document_id_check',
           'credential_operations_source_mutation_check',
           'credential_operations_source_preconditions_check',
           'credential_operations_source_applied_check',
           'credential_operations_last_error_class_check',
           'credential_operations_consecutive_error_count_check'
         )
         and convalidated) validated_constraints,
      (select indisvalid
       from pg_index
       where indexrelid='accounts.credential_operations_source_recovery_idx'::regclass) recovery_index_valid,
      (select indisvalid
       from pg_index
       where indexrelid='accounts.credential_operations_retry_ready_idx'::regclass) retry_index_valid,
      to_regclass('ops.credential_failures') is not null ops_view_exists
  `;
  assert.deepEqual(credentialSchema, {
    retry_column_count: 5,
    validated_constraints: 7,
    recovery_index_valid: true,
    retry_index_valid: true,
    ops_view_exists: true,
  });

  const [blockedCredentialRecovery] = await sql`
    select source_recovery_blocked, last_error_code
    from accounts.credential_operations
    where operation_key='credential:reset:missing-source'
  `;
  assert.deepEqual(blockedCredentialRecovery, {
    source_recovery_blocked: true,
    last_error_code: "CREDENTIAL_SOURCE_REPAIR_REQUIRED",
  });
  await assert.rejects(
    sql`select public.roo_complete_credential_operation(
      'credential:reset:missing-source'
    )`,
    (error) => error.code === "55000"
  );
  await sql`
    update accounts.credential_operations
    set status='failed'
    where operation_key='credential:reset:missing-source'
  `;

  const triggerFile = writeTemp("reject-outbox.sql", triggerFailure);
  run(path.join(pgBin, "psql"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    triggerFile,
  ]);
  await assert.rejects(
    apply(sql, [
      mutation({
        operation: "create",
        id: "atomic.failure",
        document: { _id: "atomic.failure", _type: "siteSettings" },
      }),
    ]),
  );
  const [atomicCounts] = await sql`
    select
      (select count(*)::integer from migration.source_documents
        where legacy_sanity_id='atomic.failure') source_count,
      (select count(*)::integer from cms.documents
        where legacy_sanity_id='atomic.failure') cms_count,
      (select count(*)::integer from migration.document_mutation_mirror_outbox) outbox_count
  `;
  assert.deepEqual(atomicCounts, {
    source_count: 0,
    cms_count: 0,
    outbox_count: 0,
  });
  await sql`drop trigger reject_document_outbox on migration.document_mutation_mirror_outbox`;

  await assert.rejects(
    apply(sql, [
      mutation({
        operation: "create",
        id: "invalid/id",
        document: { _id: "invalid/id", _type: "siteSettings" },
      }),
    ]),
    /invalid id/,
  );
  for (const invalidId of [
    "-leading",
    ".leading",
    "double..dot",
    " leading-space",
    "trailing-space ",
    `a${"b".repeat(128)}`,
  ]) {
    await assert.rejects(
      apply(sql, [
        mutation({
          operation: "create",
          id: invalidId,
          document: { _id: invalidId, _type: "siteSettings" },
        }),
      ]),
      /invalid id/,
    );
  }
  await assert.rejects(
    apply(sql, [
      mutation({
        operation: "create",
        id: "identity.one",
        document: { _id: "identity.two", _type: "siteSettings" },
      }),
    ]),
    /identity mismatch/,
  );
  await assert.rejects(
    apply(sql, [
      mutation({
        operation: "create",
        id: "identity.exact",
        document: { _id: " identity.exact", _type: "siteSettings" },
      }),
    ]),
    /identity mismatch/,
  );

  for (const validId of [
    "_leading",
    "drafts.valid-id",
    "versions.release.valid",
    `a${"b".repeat(127)}`,
  ]) {
    await apply(sql, [
      mutation({
        operation: "create",
        id: validId,
        document: { _id: validId, _type: "siteSettings" },
      }),
    ]);
  }
  await assert.rejects(
    claim(sql, crypto.randomUUID(), 1, [".leading"]),
    /invalid preferred document mirror input/,
  );
  await assert.rejects(
    sql`select public.roo_document_mutation_mirror_status_for_ids(
      ${["double..dot"]}::text[]
    )`,
    /invalid document mirror status input/,
  );
  const validLease = crypto.randomUUID();
  const validClaims = await claim(sql, validLease, 4);
  assert.equal(validClaims.length, 4);
  for (const validClaim of validClaims) {
    await complete(sql, validClaim.event_key, validLease, true);
  }

  const concurrentId = "concurrent.missing";
  const [concurrentLeft, concurrentRight] = await Promise.all([
    apply(sql, [
      mutation({
        operation: "create_if_missing",
        id: concurrentId,
        document: {
          _id: concurrentId,
          _type: "siteSettings",
          title: "Left",
        },
      }),
    ]),
    apply(sql, [
      mutation({
        operation: "create_if_missing",
        id: concurrentId,
        document: {
          _id: concurrentId,
          _type: "siteSettings",
          title: "Right",
        },
      }),
    ]),
  ]);
  assert.deepEqual(concurrentLeft, concurrentRight);
  const [concurrentCounts] = await sql`
    select
      (select count(*)::integer from migration.source_documents
        where legacy_sanity_id=${concurrentId}) source_count,
      (select count(*)::integer from migration.document_mutation_mirror_outbox
        where document_ids=array[${concurrentId}]::text[]) outbox_count
  `;
  assert.deepEqual(concurrentCounts, { source_count: 1, outbox_count: 1 });
  const concurrentLease = crypto.randomUUID();
  const [concurrentClaim] = await claim(sql, concurrentLease, 1);
  assert.deepEqual(concurrentClaim.document_ids, [concurrentId]);
  await complete(sql, concurrentClaim.event_key, concurrentLease, true);

  await apply(sql, [
    mutation({
      operation: "create",
      id: "settings.site",
      document: { _id: "settings.site", _type: "siteSettings", title: "First" },
    }),
  ]);
  const [source] = await sql`
    select source_revision from migration.source_documents
    where legacy_sanity_id='settings.site'
  `;
  const beforeNoop = await sql`
    select count(*)::integer count from migration.document_mutation_mirror_outbox
  `.then(([row]) => row.count);
  await apply(sql, [
    mutation({
      operation: "create_if_missing",
      id: "settings.site",
      document: {
        _id: "settings.site",
        _type: "siteSettings",
        title: "Ignored",
      },
    }),
  ]);
  const afterNoop = await sql`
    select count(*)::integer count from migration.document_mutation_mirror_outbox
  `.then(([row]) => row.count);
  assert.equal(afterNoop, beforeNoop);

  await apply(sql, [
    mutation({
      operation: "replace",
      id: "settings.site",
      expectedRevision: source.source_revision,
      document: {
        _id: "settings.site",
        _type: "siteSettings",
        title: "Second",
      },
    }),
  ]);
  await apply(sql, [
    mutation({
      operation: "create",
      id: "settings.other",
      document: {
        _id: "settings.other",
        _type: "siteSettings",
        title: "Other",
      },
    }),
  ]);

  const leaseOne = crypto.randomUUID();
  const leaseTwo = crypto.randomUUID();
  const [claimedOne, claimedTwo] = await Promise.all([
    claim(sql, leaseOne, 1),
    claim(sql, leaseTwo, 1),
  ]);
  const concurrentClaims = [...claimedOne, ...claimedTwo];
  assert.equal(concurrentClaims.length, 2);
  assert.equal(new Set(concurrentClaims.map((item) => item.event_key)).size, 2);
  assert.deepEqual(
    new Set(concurrentClaims.flatMap((item) => item.document_ids)),
    new Set(["settings.site", "settings.other"]),
  );
  for (const claimed of concurrentClaims) {
    const lease = claimedOne.some(
      (item) => item.event_key === claimed.event_key,
    )
      ? leaseOne
      : leaseTwo;
    await complete(sql, claimed.event_key, lease, true);
  }

  const orderedLease = crypto.randomUUID();
  const [ordered] = await claim(sql, orderedLease, 1);
  assert.deepEqual(ordered.document_ids, ["settings.site"]);
  await assert.rejects(
    complete(sql, ordered.event_key, crypto.randomUUID(), true),
    /lease conflict/,
  );
  await complete(sql, ordered.event_key, orderedLease, true);

  await apply(sql, [
    mutation({
      operation: "create",
      id: "expired.lease",
      document: { _id: "expired.lease", _type: "siteSettings" },
    }),
  ]);
  const expiredLease = crypto.randomUUID();
  const [expiredClaim] = await claim(sql, expiredLease, 1);
  await sql`
    update migration.document_mutation_mirror_outbox
    set lease_expires_at=now()-interval '1 second'
    where event_key=${expiredClaim.event_key}::uuid
  `;
  const replacementLease = crypto.randomUUID();
  const [replacementClaim] = await claim(sql, replacementLease, 1);
  assert.equal(replacementClaim.event_key, expiredClaim.event_key);
  assert.equal(replacementClaim.attempt_count, 2);
  await complete(sql, replacementClaim.event_key, replacementLease, true);

  await apply(sql, [
    mutation({
      operation: "create",
      id: "expired.exhausted",
      document: { _id: "expired.exhausted", _type: "siteSettings" },
    }),
  ]);
  await sql`
    update migration.document_mutation_mirror_outbox
    set max_attempts=1
    where document_ids=array['expired.exhausted']::text[] and status='pending'
  `;
  const exhaustedLease = crypto.randomUUID();
  const [exhaustedClaim] = await claim(sql, exhaustedLease, 1);
  await sql`
    update migration.document_mutation_mirror_outbox
    set lease_expires_at=now()-interval '1 second'
    where event_key=${exhaustedClaim.event_key}::uuid
  `;
  assert.deepEqual(await claim(sql, crypto.randomUUID(), 1), []);
  const [expiredExhausted] = await sql`
    select status, attempt_count, lease_id, lease_expires_at, last_error_code,
      dead_lettered_at is not null dead_lettered
    from migration.document_mutation_mirror_outbox
    where event_key=${exhaustedClaim.event_key}::uuid
  `;
  assert.deepEqual(expiredExhausted, {
    status: "dead_letter",
    attempt_count: 1,
    lease_id: null,
    lease_expires_at: null,
    last_error_code: "LEASE_EXPIRED_MAX_ATTEMPTS",
    dead_lettered: true,
  });
  await sql`
    select public.roo_requeue_document_mutation_mirror_event(
      ${exhaustedClaim.event_key}::uuid,
      1::integer,
      'service_role_admin',
      'verified retry after expired worker lease'
    )
  `;
  const expiredRetryLease = crypto.randomUUID();
  const [expiredRetry] = await claim(sql, expiredRetryLease, 1);
  assert.equal(expiredRetry.event_key, exhaustedClaim.event_key);
  await complete(sql, expiredRetry.event_key, expiredRetryLease, true);

  await apply(sql, [
    mutation({
      operation: "create",
      id: "dead.letter",
      document: { _id: "dead.letter", _type: "siteSettings" },
    }),
  ]);
  await sql`
    update migration.document_mutation_mirror_outbox
    set max_attempts=1
    where document_ids=array['dead.letter']::text[] and status='pending'
  `;
  const deadLease = crypto.randomUUID();
  const [deadClaim] = await claim(sql, deadLease, 1);
  const deadResult = await complete(
    sql,
    deadClaim.event_key,
    deadLease,
    false,
    "SANITY_TIMEOUT",
  );
  assert.equal(deadResult.status, "dead_letter");
  const [blockedBacklog] = await sql`
    select public.roo_document_mutation_mirror_backlog() backlog
  `;
  assert.equal(blockedBacklog.backlog.ready, false);
  assert.equal(blockedBacklog.backlog.dead_letters, 1);
  const [requeued] = await sql`
    select public.roo_requeue_document_mutation_mirror_event(
      ${deadClaim.event_key}::uuid,
      1::integer,
      'service_role_admin',
      'verified retry after provider recovery'
    ) result
  `;
  assert.equal(requeued.result.status, "retry");
  const retryLease = crypto.randomUUID();
  const [retryClaim] = await claim(sql, retryLease, 1);
  await complete(sql, retryClaim.event_key, retryLease, true);
  const [action] = await sql`
    select count(*)::integer count, min(actor) actor
    from migration.document_mutation_mirror_actions
    where event_key=${deadClaim.event_key}::uuid and action='requeue'
  `;
  assert.deepEqual(action, { count: 1, actor: "service_role_admin" });

  await apply(sql, [
    mutation({
      operation: "create",
      id: "stale.multi.a",
      document: { _id: "stale.multi.a", _type: "siteSettings", title: "A" },
    }),
    mutation({
      operation: "create",
      id: "stale.multi.b",
      document: { _id: "stale.multi.b", _type: "siteSettings", title: "B" },
    }),
  ]);
  await sql`
    update migration.document_mutation_mirror_outbox
    set max_attempts=1
    where document_ids=${["stale.multi.a", "stale.multi.b"]}::text[]
      and status='pending'
  `;
  const staleLease = crypto.randomUUID();
  const [staleClaim] = await claim(sql, staleLease, 1);
  await complete(sql, staleClaim.event_key, staleLease, false, "SANITY_TIMEOUT");

  const [staleA] = await sql`
    select source_revision from migration.source_documents
    where legacy_sanity_id='stale.multi.a'
  `;
  await apply(sql, [mutation({
    operation: "delete",
    id: "stale.multi.a",
    expectedRevision: staleA.source_revision,
  })]);
  const deleteStaleLease = crypto.randomUUID();
  const [deleteStaleClaim] = await claim(sql, deleteStaleLease, 1);
  await complete(sql, deleteStaleClaim.event_key, deleteStaleLease, true);
  await assert.rejects(
    sql`select public.roo_requeue_document_mutation_mirror_event(
      ${staleClaim.event_key}::uuid,
      1::integer,
      'service_role_admin',
      'retry mixed event after a newer deletion'
    )`,
    (error) => error.code === "40001"
  );
  const [stillDead] = await sql`
    select status from migration.document_mutation_mirror_outbox
    where event_key=${staleClaim.event_key}::uuid
  `;
  assert.equal(stillDead.status, "dead_letter");

  const [staleB] = await sql`
    select source_revision, payload from migration.source_documents
    where legacy_sanity_id='stale.multi.b'
  `;
  await apply(sql, [mutation({
    operation: "replace",
    id: "stale.multi.b",
    expectedRevision: staleB.source_revision,
    document: { ...staleB.payload, title: "B repaired explicitly" },
  })]);
  const repairStaleLease = crypto.randomUUID();
  const [repairStaleClaim] = await claim(sql, repairStaleLease, 1);
  const repairCompletion = await complete(
    sql,
    repairStaleClaim.event_key,
    repairStaleLease,
    true
  );
  assert.equal(repairCompletion.resolved_older_dead_letters, 1);
  const [resolvedStale] = await sql`
    select status, last_error_code from migration.document_mutation_mirror_outbox
    where event_key=${staleClaim.event_key}::uuid
  `;
  assert.deepEqual(resolvedStale, {
    status: "applied",
    last_error_code: "SUPERSEDED_BY_NEWER_SEQUENCE",
  });

  await apply(sql, [mutation({
    operation: "create",
    id: "delete.target",
    document: { _id: "delete.target", _type: "siteSettings", title: "Delete" },
  })]);
  const createDeleteLease = crypto.randomUUID();
  const [createDeleteClaim] = await claim(sql, createDeleteLease, 1);
  await complete(sql, createDeleteClaim.event_key, createDeleteLease, true);
  await apply(sql, [mutation({ operation: "delete", id: "delete.target" })]);
  const deleteLease = crypto.randomUUID();
  const [deleteClaim] = await claim(sql, deleteLease, 1);
  assert.equal(deleteClaim.documents.length, 0);
  assert.equal(deleteClaim.deleted_documents[0]._id, "delete.target");
  assert.match(deleteClaim.canonical_hash, /^[0-9a-f]{64}$/);
  await complete(sql, deleteClaim.event_key, deleteLease, true);

  await apply(sql, [
    mutation({
      operation: "create",
      id: "priority.old",
      document: { _id: "priority.old", _type: "siteSettings" },
    }),
  ]);
  await apply(sql, [
    mutation({
      operation: "create",
      id: "priority.target",
      document: { _id: "priority.target", _type: "siteSettings" },
    }),
  ]);
  const priorityLease = crypto.randomUUID();
  const [priorityClaim] = await claim(sql, priorityLease, 1, [
    "priority.target",
  ]);
  assert.deepEqual(priorityClaim.document_ids, ["priority.target"]);
  await complete(sql, priorityClaim.event_key, priorityLease, true);
  const remainingLease = crypto.randomUUID();
  const [remainingClaim] = await claim(sql, remainingLease, 1);
  assert.deepEqual(remainingClaim.document_ids, ["priority.old"]);
  await complete(sql, remainingClaim.event_key, remainingLease, true);

  const contentIdentity = cmsIdentity("cms-content-create");
  const contentMutation = mutation({
    operation: "create",
    id: "footer.main",
    document: { _id: "footer.main", _type: "footer", title: "Footer" },
  });
  const cmsAsset = {
    legacy_sanity_asset_id: "image-asset-10x10-png",
    source_url:
      "https://cdn.sanity.io/images/9g42k3ur/production/asset-10x10.png",
    storage_bucket: "site-content-public",
    storage_path: "images/asset.png",
    mime_type: "image/png",
    byte_size: 4,
    sha256: "a".repeat(64),
    width: 10,
    height: 10,
    metadata: {},
  };
  const cmsLink = {
    document_legacy_id: "footer.main",
    asset_legacy_id: cmsAsset.legacy_sanity_asset_id,
    field_path: "$.logo.asset",
  };
  const contentResult = await applyCms({
    sql,
    ...contentIdentity,
    mutations: [contentMutation],
    assets: [cmsAsset],
    assetLinks: [cmsLink],
  });
  assert.equal(contentResult.replayed, false);
  const replayResult = await applyCms({
    sql,
    ...contentIdentity,
    mutations: [contentMutation],
    assets: [cmsAsset],
    assetLinks: [cmsLink],
  });
  assert.equal(replayResult.replayed, true);
  const [receiptReplay] = await sql`
    select public.roo_cms_publish_command_result(
      ${contentIdentity.commandId},
      ${contentIdentity.requestHash},
      'sanity:postgres-test'
    ) result
  `;
  assert.equal(receiptReplay.result.replayed, true);
  const [contentState] = await sql`
    select
      (select count(*)::integer from migration.cms_publish_commands
        where command_id=${contentIdentity.commandId}) receipt_count,
      (select count(*)::integer from migration.document_mutation_mirror_outbox
        where document_ids=array['footer.main']::text[]) mirror_count,
      (select count(*)::integer from cms.document_assets link
        join cms.documents document on document.id=link.document_id
        join cms.assets asset on asset.id=link.asset_id
        where document.legacy_sanity_id='footer.main'
          and asset.migration_status='verified') verified_links
  `;
  assert.deepEqual(contentState, {
    receipt_count: 1,
    mirror_count: 1,
    verified_links: 1,
  });

  const staleIdentity = cmsIdentity("cms-content-stale");
  await assert.rejects(
    applyCms({
      sql,
      ...staleIdentity,
      mutations: [
        mutation({
          operation: "replace",
          id: "footer.main",
          expectedRevision: "stale-revision",
          document: { _id: "footer.main", _type: "footer", title: "Stale" },
        }),
      ],
    }),
    /revision conflict/,
  );
  const [failedReceipt] = await sql`
    select count(*)::integer count from migration.cms_publish_commands
    where command_id=${staleIdentity.commandId}
  `;
  assert.equal(failedReceipt.count, 0);

  for (const type of ["bookingSettings", "coupon", "package", "upgradeLink"]) {
    const id = `${type}.cms-test`;
    const identity = cmsIdentity(`cms-commerce-${type}`);
    const beforeDocumentEvents = await sql`
      select count(*)::integer count from migration.document_mutation_mirror_outbox
    `.then(([row]) => row.count);
    await applyCms({
      sql,
      ...identity,
      mutations: [
        mutation({
          operation: "create",
          id,
          document: {
            _id: id,
            _type: type,
            title: type,
            ...(type === "coupon" ? { isActive: true } : {}),
          },
        }),
      ],
    });
    const afterDocumentEvents = await sql`
      select count(*)::integer count from migration.document_mutation_mirror_outbox
    `.then(([row]) => row.count);
    assert.equal(afterDocumentEvents, beforeDocumentEvents);
    const [commerceEvent] = await sql`
      select count(*)::integer count
      from migration.commerce_mirror_outbox
      where document_ids=array[${id}]::text[]
    `;
    assert.equal(commerceEvent.count, 1);
  }
  const [typedCommerce] = await sql`
    select
      (select source_backend from commerce.booking_settings where id='default') settings_backend,
      (select active from commerce.coupons where legacy_sanity_id='coupon.cms-test') coupon_active,
      (select backend_owner from commerce.coupons where legacy_sanity_id='coupon.cms-test') coupon_owner
  `;
  assert.deepEqual(typedCommerce, {
    settings_backend: "supabase",
    coupon_active: true,
    coupon_owner: "supabase",
  });

  await sql`update migration.commerce_control set starts_paused=true where singleton`;
  const pausedIdentity = cmsIdentity("cms-commerce-paused");
  await assert.rejects(
    applyCms({
      sql,
      ...pausedIdentity,
      mutations: [
        mutation({
          operation: "create",
          id: "package.cms-paused",
          document: {
            _id: "package.cms-paused",
            _type: "package",
            title: "Paused",
          },
        }),
      ],
    }),
    /CMS commerce writes are paused/,
  );
  const [pausedState] = await sql`
    select
      (select count(*)::integer from migration.cms_publish_commands
        where command_id=${pausedIdentity.commandId}) receipt_count,
      (select count(*)::integer from migration.source_documents
        where legacy_sanity_id='package.cms-paused') document_count
  `;
  assert.deepEqual(pausedState, { receipt_count: 0, document_count: 0 });
  await sql`update migration.commerce_control set starts_paused=false where singleton`;

  const concurrentCommerce = await Promise.allSettled([
    applyCms({
      sql,
      ...cmsIdentity("cms-commerce-concurrent-left"),
      mutations: [
        mutation({
          operation: "create",
          id: "package.cms-concurrent",
          document: {
            _id: "package.cms-concurrent",
            _type: "package",
            title: "Left",
          },
        }),
      ],
    }),
    applyCms({
      sql,
      ...cmsIdentity("cms-commerce-concurrent-right"),
      mutations: [
        mutation({
          operation: "create",
          id: "package.cms-concurrent",
          document: {
            _id: "package.cms-concurrent",
            _type: "package",
            title: "Right",
          },
        }),
      ],
    }),
  ]);
  assert.equal(
    concurrentCommerce.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const [concurrentCommerceFailure] = concurrentCommerce.filter(
    (result) => result.status === "rejected",
  );
  assert.match(
    String(concurrentCommerceFailure.reason),
    /document already exists/,
  );
  const [concurrentCommerceState] = await sql`
    select
      (select count(*)::integer from migration.source_documents
        where legacy_sanity_id='package.cms-concurrent') document_count,
      (select count(*)::integer from migration.commerce_mirror_outbox
        where document_ids=array['package.cms-concurrent']::text[]) mirror_count,
      (select count(*)::integer from migration.cms_publish_commands
        where command_id in (
          ${cmsIdentity("cms-commerce-concurrent-left").commandId},
          ${cmsIdentity("cms-commerce-concurrent-right").commandId}
        )) receipt_count
  `;
  assert.deepEqual(concurrentCommerceState, {
    document_count: 1,
    mirror_count: 1,
    receipt_count: 1,
  });

  const [packageSource] = await sql`
    select source_revision from migration.source_documents
    where legacy_sanity_id='package.cms-test'
  `;
  const deletePackageIdentity = cmsIdentity("cms-commerce-package-delete");
  const deletePackageMutation = mutation({
    operation: "delete",
    id: "package.cms-test",
    expectedRevision: packageSource.source_revision,
  });
  await applyCms({
    sql,
    ...deletePackageIdentity,
    mutations: [deletePackageMutation],
  });
  const deletedPackageReplay = await applyCms({
    sql,
    ...deletePackageIdentity,
    mutations: [deletePackageMutation],
  });
  assert.equal(deletedPackageReplay.replayed, true);
  const [packageCleanup] = await sql`
    select count(*)::integer count from migration.cms_projection_calls
    where document_id='package.cms-test' and operation='cleanup'
  `;
  assert.equal(packageCleanup.count, 2);

  const invalidCmsIdentity = cmsIdentity("cms-operational-invalid");
  await assert.rejects(
    applyCms({
      sql,
      ...invalidCmsIdentity,
      mutations: [
        mutation({
          operation: "create",
          id: "booking.invalid",
          document: { _id: "booking.invalid", _type: "booking" },
        }),
      ],
    }),
    /unsupported CMS document type/,
  );

  const [cmsReady] =
    await sql`select public.roo_cms_publish_readiness() result`;
  assert.equal(cmsReady.result.ready, true);
  assert.equal(cmsReady.result.receipts.processing, 0);
  assert.equal(cmsReady.result.assets.unverified_links, 0);

  await sql`
    update cms.assets set migration_status='failed'
    where legacy_sanity_asset_id=${cmsAsset.legacy_sanity_asset_id}
  `;
  const [unsafeAsset] =
    await sql`select public.roo_cms_publish_readiness() result`;
  assert.equal(unsafeAsset.result.ready, false);
  assert.equal(unsafeAsset.result.assets.unverified_links, 1);
  await sql`
    update cms.assets set migration_status='verified'
    where legacy_sanity_asset_id=${cmsAsset.legacy_sanity_asset_id}
  `;

  await sql`
    update migration.document_mutation_mirror_outbox
    set status='dead_letter',applied_at=null,dead_lettered_at=now(),
      lease_id=null,lease_expires_at=null
    where document_ids=array['footer.main']::text[]
  `;
  await sql`
    update migration.commerce_mirror_outbox
    set status='dead_letter'
    where document_ids=array['coupon.cms-test']::text[]
  `;
  const [unsafeMirrors] =
    await sql`select public.roo_cms_publish_readiness() result`;
  assert.equal(unsafeMirrors.result.ready, false);
  assert.equal(unsafeMirrors.result.content_mirror.ready, false);
  assert.equal(unsafeMirrors.result.commerce_mirror.ready, false);
  await sql`
    update migration.document_mutation_mirror_outbox
    set status='applied',applied_at=now(),dead_lettered_at=null
    where document_ids=array['footer.main']::text[]
  `;
  await sql`
    update migration.commerce_mirror_outbox
    set status='mirrored',mirrored_at=now()
    where document_ids=array['coupon.cms-test']::text[]
  `;

  const credentialUserId = "11111111-1111-4111-8111-111111111111";
  const credentialPrincipalId = "22222222-2222-4222-8222-222222222222";
  const credentialDocumentId = "referral.credential-recovery";
  const credentialOperationKey = "credential:reset:postgres-fixture";
  const firstPasswordHash = `$2b$12$${"a".repeat(53)}`;
  const secondPasswordHash = `$2b$12$${"b".repeat(53)}`;
  const credentialMutation = {
    set: {
      creatorPassword: firstPasswordHash,
      credentialVersion: 2,
      passwordLoginEnabled: true,
      passwordResetRequired: false,
      passwordChangedAt: "2026-07-15T00:00:00.000Z",
    },
    unset: [
      "resetToken",
      "resetTokenHash",
      "resetTokenExpiresAt",
      "resetDeliveryToken",
    ],
  };
  const credentialPreconditions = {
    creatorPassword: `$2b$12$${"c".repeat(53)}`,
    resetTokenHash: "live-reset-token-hash",
    resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
  };
  await sql`
    insert into auth.users(id, encrypted_password)
    values(${credentialUserId}::uuid, ${firstPasswordHash})
  `;
  await sql`
    insert into auth.sessions(user_id) values(${credentialUserId}::uuid)
  `;
  await sql`
    insert into accounts.principals(id)
    values(${credentialPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.principal_auth_users(user_id, principal_id)
    values(${credentialUserId}::uuid, ${credentialPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.creator_profiles(
      principal_id, user_id, legacy_sanity_id, source_revision,
      source_hash, backend_owner
    ) values(
      ${credentialPrincipalId}::uuid,
      ${credentialUserId}::uuid,
      ${credentialDocumentId},
      'supabase-old',
      ${"f".repeat(64)},
      'supabase'
    )
  `;
  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, backend_owner
    ) values(
      ${credentialDocumentId},
      'referral',
      'supabase-old',
      ${"f".repeat(64)},
      ${sql.json({
        _id: credentialDocumentId,
        _type: "referral",
        _rev: "supabase-old",
        creatorPassword: `$2b$12$${"c".repeat(53)}`,
        resetTokenHash: "live-reset-token-hash",
        resetTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      })}::jsonb,
      now(),
      now(),
      'supabase'
    )
  `;
  const [preparedCredential] = await sql`
    select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-old',
      ${sql.json(credentialPreconditions)}::jsonb,
      ${sql.json(credentialMutation)}::jsonb
    ) result
  `;
  assert.equal(preparedCredential.result.status, "prepared");
  const [replayedCredential] = await sql`
    select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-old',
      ${sql.json(credentialPreconditions)}::jsonb,
      ${sql.json(credentialMutation)}::jsonb
    ) result
  `;
  assert.equal(replayedCredential.result.idempotent, true);
  await assert.rejects(
    sql`select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-other-revision',
      ${sql.json(credentialPreconditions)}::jsonb,
      ${sql.json(credentialMutation)}::jsonb
    )`,
    (error) => error.code === "23505"
  );
  await assert.rejects(
    sql`select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-old',
      ${sql.json({
        ...credentialPreconditions,
        resetTokenHash: "different-reset-token-hash",
      })}::jsonb,
      ${sql.json(credentialMutation)}::jsonb
    )`,
    (error) => error.code === "23505"
  );
  await assert.rejects(
    sql`select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-old',
      ${sql.json(credentialPreconditions)}::jsonb,
      ${sql.json({
        ...credentialMutation,
        set: {
          ...credentialMutation.set,
          passwordChangedAt: "2099-01-02T00:00:00.000Z",
        },
      })}::jsonb
    )`,
    (error) => error.code === "23505"
  );
  await sql`
    insert into accounts.credential_migrations(user_id)
    values(${credentialUserId}::uuid)
  `;
  const [authCheckpoint] = await sql`
    select public.roo_mark_credential_operation(
      ${credentialOperationKey},
      'auth_applied',
      null
    ) result
  `;
  assert.equal(authCheckpoint.result.status, "auth_applied");
  assert.equal(authCheckpoint.result.session_version, 2);
  const [revokedAfterAuthCheckpoint] = await sql`
    select
      principal.session_version,
      operation.sessions_revoked_at is not null sessions_revoked,
      (select count(*)::integer from auth.sessions
       where user_id=${credentialUserId}::uuid) session_count
    from accounts.principals principal
    join accounts.credential_operations operation
      on operation.principal_id=principal.id
    where operation.operation_key=${credentialOperationKey}
  `;
  assert.deepEqual(revokedAfterAuthCheckpoint, {
    session_version: "2",
    sessions_revoked: true,
    session_count: 0,
  });
  await assert.rejects(
    sql`select public.roo_mark_credential_operation(
      ${credentialOperationKey},
      'failed',
      'SOURCE_PENDING'
    )`,
    (error) => error.code === "55000"
  );
  const [visibleAuthAppliedOperation] = await sql`
    select status
    from accounts.credential_operations
    where operation_key=${credentialOperationKey}
  `;
  assert.equal(visibleAuthAppliedOperation.status, "auth_applied");
  const [credentialMigrationCheckpoint] = await sql`
    select status, credential_kind
    from accounts.credential_migrations
    where user_id=${credentialUserId}::uuid
  `;
  assert.deepEqual(credentialMigrationCheckpoint, {
    status: "upgraded",
    credential_kind: "bcrypt",
  });
  await assert.rejects(
    sql`select public.roo_complete_credential_operation(
      ${credentialOperationKey}
    )`,
    (error) => error.code === "55000"
  );
  const [failedSourceState] = await sql`
    select payload->>'resetTokenHash' reset_token_hash
    from migration.source_documents
    where legacy_sanity_id=${credentialDocumentId}
  `;
  assert.equal(failedSourceState.reset_token_hash, "live-reset-token-hash");
  await sql`
    update migration.source_documents
    set
      source_revision='supabase-unrelated-edit',
      payload=payload || ${sql.json({
        _rev: "supabase-unrelated-edit",
        displayName: "Preserved unrelated edit",
      })}::jsonb
    where legacy_sanity_id=${credentialDocumentId}
  `;

  const [appliedCredentialSource] = await sql`
    select public.roo_apply_credential_source_operation(
      ${credentialOperationKey}
    ) result
  `;
  assert.equal(appliedCredentialSource.result.idempotent, false);
  assert.match(appliedCredentialSource.result.source_revision, /^[0-9a-f]{32}$/);
  const [reappliedCredentialSource] = await sql`
    select public.roo_apply_credential_source_operation(
      ${credentialOperationKey}
    ) result
  `;
  assert.equal(reappliedCredentialSource.result.idempotent, true);
  assert.equal(
    reappliedCredentialSource.result.source_revision,
    appliedCredentialSource.result.source_revision
  );
  const [credentialSource] = await sql`
    select
      source_revision,
      payload->>'creatorPassword' creator_password,
      payload->>'displayName' display_name,
      payload ? 'resetTokenHash' has_reset_token,
      (select count(*)::integer
       from migration.document_mutation_mirror_outbox event
       where event.document_ids=array[${credentialDocumentId}]::text[]) outbox_count
    from migration.source_documents
    where legacy_sanity_id=${credentialDocumentId}
  `;
  assert.equal(credentialSource.creator_password, firstPasswordHash);
  assert.equal(credentialSource.display_name, "Preserved unrelated edit");
  assert.equal(credentialSource.has_reset_token, false);
  assert.equal(credentialSource.source_revision, appliedCredentialSource.result.source_revision);
  assert.equal(credentialSource.outbox_count, 1);

  await assert.rejects(
    sql`select public.roo_prepare_credential_operation_v2(
      ${credentialOperationKey},
      ${credentialUserId}::uuid,
      ${secondPasswordHash},
      'supabase',
      ${credentialDocumentId},
      'supabase-old',
      ${sql.json(credentialPreconditions)}::jsonb,
      ${sql.json({
        ...credentialMutation,
        set: { ...credentialMutation.set, creatorPassword: secondPasswordHash },
      })}::jsonb
    )`,
    (error) => error.code === "23505"
  );

  const replacedTokenDocumentId = "referral.replaced-reset-token";
  const replacedTokenOperationKey = "credential:reset:replaced-token";
  const replacedTokenUserId = "33333333-3333-4333-8333-333333333333";
  const replacedTokenPrincipalId = "44444444-4444-4444-8444-444444444444";
  await sql`
    insert into auth.users(id, encrypted_password)
    values(${replacedTokenUserId}::uuid, ${secondPasswordHash})
  `;
  await sql`
    insert into accounts.principals(id)
    values(${replacedTokenPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.principal_auth_users(user_id, principal_id)
    values(${replacedTokenUserId}::uuid, ${replacedTokenPrincipalId}::uuid)
  `;
  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, backend_owner
    ) values(
      ${replacedTokenDocumentId},
      'referral',
      'token-r1',
      ${"e".repeat(64)},
      ${sql.json({
        _id: replacedTokenDocumentId,
        _type: "referral",
        _rev: "token-r1",
        creatorPassword: credentialPreconditions.creatorPassword,
        resetTokenHash: "first-token",
      })}::jsonb,
      now(),
      now(),
      'supabase'
    )
  `;
  await sql`
    select public.roo_prepare_credential_operation_v2(
      ${replacedTokenOperationKey},
      ${replacedTokenUserId}::uuid,
      ${secondPasswordHash},
      'supabase',
      ${replacedTokenDocumentId},
      'token-r1',
      ${sql.json({
        creatorPassword: credentialPreconditions.creatorPassword,
        resetTokenHash: "first-token",
      })}::jsonb,
      ${sql.json({
        ...credentialMutation,
        set: { ...credentialMutation.set, creatorPassword: secondPasswordHash },
      })}::jsonb
    )
  `;
  await sql`
    update accounts.credential_operations
    set status='auth_applied', auth_applied_at=now()
    where operation_key=${replacedTokenOperationKey}
  `;
  await sql`
    update migration.source_documents
    set
      source_revision='token-r2',
      payload=payload || '{"_rev":"token-r2","resetTokenHash":"replacement-token"}'::jsonb
    where legacy_sanity_id=${replacedTokenDocumentId}
  `;
  const [firstDeterministicFailure] = await sql`
    select public.roo_apply_credential_source_operation(
      ${replacedTokenOperationKey}
    ) result
  `;
  assert.equal(firstDeterministicFailure.result.status, "backoff");
  assert.equal(firstDeterministicFailure.result.error_class, "deterministic");
  assert.equal(firstDeterministicFailure.result.attempt_count, 1);
  assert.equal(
    firstDeterministicFailure.result.error_code,
    "CREDENTIAL_SOURCE_PRECONDITION_CHANGED",
  );
  const [earlyDeterministicReplay] = await sql`
    select public.roo_apply_credential_source_operation(
      ${replacedTokenOperationKey}
    ) result
  `;
  assert.equal(earlyDeterministicReplay.result.status, "backoff");
  assert.equal(earlyDeterministicReplay.result.idempotent, true);
  assert.equal(earlyDeterministicReplay.result.attempt_count, 1);

  await sql`
    update accounts.credential_operations
    set next_retry_at=now() - interval '1 second'
    where operation_key=${replacedTokenOperationKey}
  `;
  const [parkedDeterministicFailure] = await sql`
    select public.roo_apply_credential_source_operation(
      ${replacedTokenOperationKey}
    ) result
  `;
  assert.equal(parkedDeterministicFailure.result.status, "parked");
  assert.equal(parkedDeterministicFailure.result.attempt_count, 2);
  assert.equal(parkedDeterministicFailure.result.parked, true);

  const [parkedDeterministicState] = await sql`
    select
      source_recovery_blocked,
      source_recovery_blocked_at is not null parked_at_recorded,
      attempt_count,
      consecutive_error_count,
      last_error_code,
      last_error,
      last_error_class,
      next_retry_at
    from accounts.credential_operations
    where operation_key=${replacedTokenOperationKey}
  `;
  assert.deepEqual(parkedDeterministicState, {
    source_recovery_blocked: true,
    parked_at_recorded: true,
    attempt_count: 2,
    consecutive_error_count: 2,
    last_error_code: "CREDENTIAL_SOURCE_PRECONDITION_CHANGED",
    last_error: "Credential source precondition changed.",
    last_error_class: "deterministic",
    next_retry_at: null,
  });

  const [recoveryQueueAfterParking] = await sql`
    select public.roo_list_credential_recovery(25) result
  `;
  assert.equal(
    recoveryQueueAfterParking.result.some(
      (operation) => operation.operation_key === replacedTokenOperationKey,
    ),
    false,
  );

  const lockSql = postgres(databaseUrl, { max: 1 });
  let releaseSourceLock;
  let sourceLockReady;
  const sourceLockStarted = new Promise((resolve) => {
    sourceLockReady = resolve;
  });
  const sourceLockReleased = new Promise((resolve) => {
    releaseSourceLock = resolve;
  });
  const sourceLock = lockSql.begin(async (transaction) => {
    await transaction`
      select 1
      from migration.source_documents
      where legacy_sanity_id=${replacedTokenDocumentId}
      for update
    `;
    sourceLockReady();
    await sourceLockReleased;
  });
  await sourceLockStarted;
  try {
    const [parkedReplay] = await sql.begin(async (transaction) => {
      await transaction`set local statement_timeout='500ms'`;
      return transaction`
        select public.roo_apply_credential_source_operation(
          ${replacedTokenOperationKey}
        ) result
      `;
    });
    assert.equal(parkedReplay.result.status, "parked");
    assert.equal(parkedReplay.result.idempotent, true);
    assert.equal(parkedReplay.result.attempt_count, 2);
  } finally {
    releaseSourceLock();
    await sourceLock;
    await lockSql.end({ timeout: 2 });
  }

  const [credentialFailureView] = await sql`
    select verdict, "attemptCount", "lastErrorCode", "lastError", "errorClass"
    from ops.credential_failures
    where "operationKey"=${replacedTokenOperationKey}
  `;
  assert.deepEqual(credentialFailureView, {
    verdict: "parked",
    attemptCount: 2,
    lastErrorCode: "CREDENTIAL_SOURCE_PRECONDITION_CHANGED",
    lastError: "Credential source precondition changed.",
    errorClass: "deterministic",
  });
  const [replacedTokenSource] = await sql`
    select payload->>'resetTokenHash' reset_token_hash
    from migration.source_documents
    where legacy_sanity_id=${replacedTokenDocumentId}
  `;
  assert.equal(replacedTokenSource.reset_token_hash, "replacement-token");
  await sql`
    update accounts.credential_operations
    set status='failed'
    where operation_key=${replacedTokenOperationKey}
  `;

  const transientUserId = "99999999-9999-4999-8999-999999999999";
  const transientPrincipalId = "12121212-1212-4212-8212-121212121212";
  const transientOperationKey = "credential:change:transient-cap";
  await sql`
    insert into auth.users(id, encrypted_password)
    values(${transientUserId}::uuid, ${secondPasswordHash})
  `;
  await sql`
    insert into accounts.principals(id)
    values(${transientPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.principal_auth_users(user_id, principal_id)
    values(${transientUserId}::uuid, ${transientPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.credential_operations(
      operation_key,
      user_id,
      principal_id,
      password_hash,
      status,
      source_backend,
      source_document_id,
      sessions_revoked_at,
      auth_applied_at
    ) values(
      ${transientOperationKey},
      ${transientUserId}::uuid,
      ${transientPrincipalId}::uuid,
      ${secondPasswordHash},
      'auth_applied',
      'sanity',
      'referral.transient-cap',
      now(),
      now()
    )
  `;

  const recordTransientFailure = async () => {
    const [row] = await sql`
      select public.roo_record_credential_recovery_failure(
        ${transientOperationKey},
        'auth_applied',
        'CREDENTIAL_MIRROR_PENDING',
        'Credential fallback mirror is still pending.',
        'transient'
      ) result
    `;
    return row.result;
  };
  const firstTransientFailure = await recordTransientFailure();
  assert.equal(firstTransientFailure.status, "backoff");
  assert.equal(firstTransientFailure.attempt_count, 1);
  assert.equal(firstTransientFailure.parked, false);
  const earlyTransientReplay = await recordTransientFailure();
  assert.equal(earlyTransientReplay.idempotent, true);
  assert.equal(earlyTransientReplay.attempt_count, 1);

  for (let attempt = 2; attempt <= 6; attempt += 1) {
    await sql`
      update accounts.credential_operations
      set next_retry_at=now() - interval '1 second'
      where operation_key=${transientOperationKey}
    `;
    const recorded = await recordTransientFailure();
    assert.equal(recorded.attempt_count, attempt);
    assert.equal(recorded.status, attempt === 6 ? "parked" : "backoff");
  }

  const [transientCapState] = await sql`
    select
      source_recovery_blocked,
      attempt_count,
      consecutive_error_count,
      last_error_code,
      last_error_class,
      next_retry_at
    from accounts.credential_operations
    where operation_key=${transientOperationKey}
  `;
  assert.deepEqual(transientCapState, {
    source_recovery_blocked: true,
    attempt_count: 6,
    consecutive_error_count: 6,
    last_error_code: "CREDENTIAL_MIRROR_PENDING",
    last_error_class: "transient",
    next_retry_at: null,
  });
  const cappedTransientReplay = await recordTransientFailure();
  assert.equal(cappedTransientReplay.status, "parked");
  assert.equal(cappedTransientReplay.idempotent, true);
  assert.equal(cappedTransientReplay.attempt_count, 6);
  const [recoveryQueueAfterTransientCap] = await sql`
    select public.roo_list_credential_recovery(25) result
  `;
  assert.equal(
    recoveryQueueAfterTransientCap.result.some(
      (operation) => operation.operation_key === transientOperationKey,
    ),
    false,
  );
  await sql`
    update accounts.credential_operations
    set status='failed'
    where operation_key=${transientOperationKey}
  `;

  const credentialLease = crypto.randomUUID();
  const [credentialEvent] = await claim(
    sql,
    credentialLease,
    1,
    [credentialDocumentId]
  );
  assert.deepEqual(credentialEvent.document_ids, [credentialDocumentId]);
  assert.equal(credentialEvent.documents[0].resetTokenHash, undefined);
  assert.equal(
    credentialEvent.documents[0]._supabaseRevision,
    appliedCredentialSource.result.source_revision
  );
  await complete(
    sql,
    credentialEvent.event_key,
    credentialLease,
    true
  );
  const [firstCredentialCompletion] = await sql`
    select public.roo_complete_credential_operation(
      ${credentialOperationKey}
    ) result
  `;
  const [secondCredentialCompletion] = await sql`
    select public.roo_complete_credential_operation(
      ${credentialOperationKey}
    ) result
  `;
  assert.equal(firstCredentialCompletion.result.session_version, 2);
  assert.equal(firstCredentialCompletion.result.idempotent, false);
  assert.equal(secondCredentialCompletion.result.session_version, 2);
  assert.equal(secondCredentialCompletion.result.idempotent, true);
  const [lateAuthCheckpoint] = await sql`
    select public.roo_mark_credential_operation(
      ${credentialOperationKey},
      'auth_applied',
      'LATE_AUTH_RESPONSE'
    ) result
  `;
  assert.equal(lateAuthCheckpoint.result.status, "mirrored");
  assert.equal(lateAuthCheckpoint.result.idempotent, true);
  const [credentialFinal] = await sql`
    select
      principal.session_version,
      operation.status,
      operation.attempt_count,
      operation.source_applied_revision,
      (select count(*)::integer from auth.sessions
       where user_id=${credentialUserId}::uuid) session_count
    from accounts.principals principal
    join accounts.credential_operations operation
      on operation.principal_id=principal.id
    where operation.operation_key=${credentialOperationKey}
  `;
  assert.deepEqual(credentialFinal, {
    session_version: "2",
    status: "mirrored",
    attempt_count: 0,
    source_applied_revision: appliedCredentialSource.result.source_revision,
    session_count: 0,
  });

  const serializedUserId = "55555555-5555-4555-8555-555555555555";
  const serializedPrincipalId = "66666666-6666-4666-8666-666666666666";
  await sql`
    insert into auth.users(id, encrypted_password)
    values(${serializedUserId}::uuid, ${firstPasswordHash})
  `;
  await sql`
    insert into accounts.principals(id)
    values(${serializedPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.principal_auth_users(user_id, principal_id)
    values(${serializedUserId}::uuid, ${serializedPrincipalId}::uuid)
  `;
  const distinctKeyPreparations = await Promise.allSettled([
    sql`select public.roo_prepare_credential_operation_v2(
      'credential:change:serial-a',
      ${serializedUserId}::uuid,
      ${firstPasswordHash},
      'supabase',
      'referral.serialized',
      'serial-r1',
      ${sql.json({ creatorPassword: credentialPreconditions.creatorPassword })}::jsonb,
      ${sql.json(credentialMutation)}::jsonb
    ) result`,
    sql`select public.roo_prepare_credential_operation_v2(
      'credential:change:serial-b',
      ${serializedUserId}::uuid,
      ${secondPasswordHash},
      'supabase',
      'referral.serialized',
      'serial-r1',
      ${sql.json({ creatorPassword: credentialPreconditions.creatorPassword })}::jsonb,
      ${sql.json({
        ...credentialMutation,
        set: { ...credentialMutation.set, creatorPassword: secondPasswordHash },
      })}::jsonb
    ) result`,
  ]);
  assert.equal(
    distinctKeyPreparations.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejectedDistinctKey = distinctKeyPreparations.find(
    (result) => result.status === "rejected"
  );
  assert.equal(rejectedDistinctKey.reason.code, "55006");
  const [serializedCount] = await sql`
    select count(*)::integer count
    from accounts.credential_operations
    where principal_id=${serializedPrincipalId}::uuid
      and status in ('prepared','auth_applied')
  `;
  assert.equal(serializedCount.count, 1);
  await assert.rejects(
    sql`
      insert into accounts.credential_operations(
        operation_key, user_id, principal_id, password_hash
      ) values(
        'credential:change:direct-duplicate',
        ${serializedUserId}::uuid,
        ${serializedPrincipalId}::uuid,
        ${secondPasswordHash}
      )
    `,
    (error) => error.code === "23505"
  );
  await sql`
    update accounts.credential_operations
    set status='failed'
    where principal_id=${serializedPrincipalId}::uuid
  `;

  const sameKeyUserId = "77777777-7777-4777-8777-777777777777";
  const sameKeyPrincipalId = "88888888-8888-4888-8888-888888888888";
  await sql`
    insert into auth.users(id, encrypted_password)
    values(${sameKeyUserId}::uuid, ${firstPasswordHash})
  `;
  await sql`
    insert into accounts.principals(id)
    values(${sameKeyPrincipalId}::uuid)
  `;
  await sql`
    insert into accounts.principal_auth_users(user_id, principal_id)
    values(${sameKeyUserId}::uuid, ${sameKeyPrincipalId}::uuid)
  `;
  const sameKeyMutationA = credentialMutation;
  const sameKeyMutationB = {
    ...credentialMutation,
    set: { ...credentialMutation.set, creatorPassword: secondPasswordHash },
  };
  const sameKeyPreparations = await Promise.allSettled([
    sql`select public.roo_prepare_credential_operation_v2(
      'credential:reset:same-key',
      ${sameKeyUserId}::uuid,
      ${firstPasswordHash},
      'sanity',
      'referral.same-key',
      'sanity-r1',
      ${sql.json({ resetTokenHash: "same-token" })}::jsonb,
      ${sql.json(sameKeyMutationA)}::jsonb
    ) result`,
    sql`select public.roo_prepare_credential_operation_v2(
      'credential:reset:same-key',
      ${sameKeyUserId}::uuid,
      ${secondPasswordHash},
      'sanity',
      'referral.same-key',
      'sanity-r1',
      ${sql.json({ resetTokenHash: "same-token" })}::jsonb,
      ${sql.json(sameKeyMutationB)}::jsonb
    ) result`,
  ]);
  assert.equal(
    sameKeyPreparations.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejectedSameKey = sameKeyPreparations.find(
    (result) => result.status === "rejected"
  );
  assert.equal(rejectedSameKey.reason.code, "23505");
  const [sameKeyCount] = await sql`
    select count(*)::integer count
    from accounts.credential_operations
    where operation_key='credential:reset:same-key'
  `;
  assert.equal(sameKeyCount.count, 1);
  await sql`
    update accounts.credential_operations
    set status='failed'
    where operation_key='credential:reset:same-key'
  `;

  await assert.rejects(
    sql.begin(async (transaction) => {
      await transaction`set local role service_role`;
      await transaction`select * from migration.document_mutation_mirror_outbox`;
    }),
    /permission denied/,
  );
  await assert.rejects(
    sql.begin(async (transaction) => {
      await transaction`set local role service_role`;
      await transaction`select * from migration.cms_publish_commands`;
    }),
    /permission denied/,
  );
  await sql.begin(async (transaction) => {
    await transaction`set local role service_role`;
    const [row] = await transaction`
      select public.roo_document_mutation_mirror_backlog() backlog
    `;
    assert.equal(row.backlog.ready, true);
    const [cmsRow] = await transaction`
      select public.roo_cms_publish_readiness() readiness
    `;
    assert.equal(cmsRow.readiness.ready, true);
  });
  const [readiness] =
    await sql`select public.roo_supabase_port_readiness() result`;
  assert.equal(readiness.result.documentMutationMirror.ready, true);

  summary = {
    ok: true,
    postgres: await sql`show server_version`.then(
      ([row]) => row.server_version,
    ),
    verified: [
      "atomic business mutation and outbox rollback",
      "Sanity-compatible mutation identity validation",
      "concurrent create-if-missing convergence",
      "no-op mutation suppression",
      "concurrent disjoint leasing and same-document ordering",
      "newly committed document priority over unrelated backlog",
      "lease-matched completion and bounded expired lease recovery",
      "retry exhaustion, dead letter readiness, and actor-audited requeue",
      "mixed-event stale delete rejection and explicit per-document repair",
      "delete snapshot capture and canonical event hash",
      "Auth-applied credential recovery consumes the authoritative reset token",
      "deterministic credential failures back off once, park on repeat, and stop applying",
      "transient credential failures use exponential retry gates and park at six attempts",
      "parked credential operations short-circuit before locking the source document",
      "credential retry failures are visible in the service-role ops view",
      "credential replay and completion remain idempotent with one session-version bump",
      "per-principal credential serialization and conflicting same-key rejection",
      "late Auth checkpoints cannot regress a completed operation",
      "service-role RPC access without direct table access",
      "global readiness backlog gate",
      "CMS receipt replay and rollback-safe stale revision rejection",
      "verified CMS asset linking before readiness",
      "content mutations use the document mirror outbox",
      "booking, coupon, package, and upgrade mutations use commerce projection and outbox",
      "CMS commerce mutations respect the operational write pause",
      "same-document concurrent CMS commerce creates serialize and conflict",
      "commerce deletes execute targeted cleanup",
      "CMS readiness gates receipts, both mirror queues, and asset verification",
    ],
  };
} finally {
  if (sql) await sql.end({ timeout: 2 });
  if (started) {
    spawnSync(
      path.join(pgBin, "pg_ctl"),
      ["-D", dataDir, "-m", "fast", "-w", "stop"],
      {
        encoding: "utf8",
      },
    );
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
