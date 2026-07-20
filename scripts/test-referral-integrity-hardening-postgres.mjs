#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
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
const temporaryBase = process.env.CLAUDE_JOB_DIR
  ? path.join(process.env.CLAUDE_JOB_DIR, "tmp")
  : os.tmpdir();
const tempRoot = fs.mkdtempSync(
  path.join(temporaryBase, "roo-referral-integrity-")
);
const dataDir = path.join(tempRoot, "pgdata");
const port = 57232 + Math.floor(Math.random() * 300);

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

const bootstrap = String.raw`
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema accounts;
create schema auth;
create schema cms;
create schema extensions;
create schema migration;
create extension pgcrypto with schema extensions;
grant usage on schema public, accounts, auth, cms, extensions, migration to service_role;

create table auth.users (
  id uuid primary key,
  encrypted_password text not null default ''
);

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  primary_email text,
  display_name text not null default '',
  status text not null default 'active'
    check (status in ('pending', 'active', 'disabled', 'deleted')),
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  source_backend text not null default 'supabase',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts.account_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  source_backend text not null default 'supabase',
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'sanity',
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table accounts.login_aliases (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alias_type text not null,
  normalized_value text not null,
  verified boolean not null default false,
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'sanity',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alias_type, normalized_value)
);

create table accounts.identity_links (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  provider_email text,
  email_verified boolean not null default false,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  backend_owner text not null default 'sanity',
  unique (provider, provider_subject)
);

create table accounts.credential_migrations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legacy_sanity_id text unique,
  legacy_source text not null default 'none',
  credential_kind text not null default 'bcrypt',
  status text not null default 'upgraded',
  source_revision text,
  source_hash text,
  backend_owner text not null default 'sanity',
  imported_at timestamptz,
  upgraded_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts.creator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
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
  tombstoned_at timestamptz,
  backend_owner text not null default 'sanity',
  cutover_generation integer not null default 0
);

create table cms.documents (
  legacy_sanity_id text primary key,
  document_type text not null,
  payload jsonb not null,
  content_hash text not null
);

create or replace function cms.sync_document_from_source(
  p_document jsonb,
  p_hash text
)
returns void
language sql
set search_path = ''
as $$
  insert into cms.documents(legacy_sanity_id, document_type, payload, content_hash)
  values(p_document->>'_id', p_document->>'_type', p_document, p_hash)
  on conflict(legacy_sanity_id) do update
  set document_type=excluded.document_type,
      payload=excluded.payload,
      content_hash=excluded.content_hash;
$$;

create table migration.commerce_control (
  singleton boolean primary key default true check (singleton),
  primary_backend text not null,
  generation integer not null,
  starts_paused boolean not null default false
);
insert into migration.commerce_control(singleton, primary_backend, generation)
values(true, 'supabase', 1);

create table migration.commerce_commands (
  command_id text primary key,
  request_hash text not null,
  cutover_generation integer not null,
  operation text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null default now()
);

create table migration.commerce_mirror_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence_no bigint generated always as identity unique,
  command_id text not null,
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

create table migration.document_mutation_mirror_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  sequence_no bigint generated always as identity unique,
  event_key uuid not null unique,
  document_ids text[] not null,
  documents jsonb not null default '[]'::jsonb,
  deleted_ids text[] not null default '{}'::text[],
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create or replace function migration.commerce_command_hash(
  p_operation text,
  p_payload jsonb,
  p_generation integer
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(extensions.digest(
    jsonb_build_object(
      'operation', p_operation,
      'payload', p_payload,
      'generation', p_generation
    )::text,
    'sha256'
  ), 'hex');
$$;

create or replace function migration.assert_commerce_write_fence(
  p_generation integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists(
    select 1 from migration.commerce_control
    where singleton
      and primary_backend='supabase'
      and generation=p_generation
  ) then
    raise exception 'Commerce generation is stale' using errcode='40001';
  end if;
end;
$$;

create or replace function migration.assert_commerce_start_fence(
  p_generation integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform migration.assert_commerce_write_fence(p_generation);
  if exists(
    select 1 from migration.commerce_control
    where singleton and starts_paused
  ) then
    raise exception 'Commerce starts are paused' using errcode='55006';
  end if;
end;
$$;

create or replace function migration.canonical_business_document(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select p_payload - array[
    '_rev', '_createdAt', '_updatedAt', '_supabaseSequence'
  ];
$$;

create or replace function migration.project_commerce_document_ids(text[])
returns jsonb language sql security definer set search_path=''
as $$ select '{}'::jsonb $$;
create or replace function migration.project_commerce_extensions(text[])
returns jsonb language sql security definer set search_path=''
as $$ select '{}'::jsonb $$;
create or replace function migration.restore_commerce_owners(text[])
returns void language sql security definer set search_path=''
as $$ select $$;
create or replace function migration.project_commerce_recovery_fields(text[])
returns integer language sql security definer set search_path=''
as $$ select 0 $$;
create or replace function migration.cleanup_commerce_document_ids(text[])
returns jsonb language sql security definer set search_path=''
as $$ select '{}'::jsonb $$;

create or replace function public.roo_apply_document_mutations(p_mutations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_operation text;
  v_id text;
  v_expected_revision text;
  v_current migration.source_documents%rowtype;
  v_payload jsonb;
  v_revision text;
  v_hash text;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_mutations) <> 'array'
    or jsonb_array_length(p_mutations) < 1 then
    raise exception 'p_mutations must be a nonempty JSON array'
      using errcode='22023';
  end if;
  for v_mutation in select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');
    select * into v_current
    from migration.source_documents
    where legacy_sanity_id=v_id
    for update;
    if v_operation = 'create' and found and not v_current.tombstoned then
      raise exception 'document already exists' using errcode='23505';
    end if;
    if v_operation = 'create_if_missing' and found and not v_current.tombstoned then
      v_results := v_results || jsonb_build_array(v_current.payload);
      continue;
    end if;
    if v_operation in ('replace', 'delete') and (
      not found or v_current.tombstoned
    ) then
      raise exception 'document not found' using errcode='P0002';
    end if;
    if v_expected_revision is not null
      and v_current.source_revision is distinct from v_expected_revision then
      raise exception 'document revision conflict' using errcode='40001';
    end if;
    if v_operation = 'delete' then
      update migration.source_documents
      set tombstoned=true, tombstoned_at=now(), last_seen_at=now()
      where legacy_sanity_id=v_id;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('_id', v_id, 'deleted', true)
      );
      continue;
    end if;
    if v_operation not in ('create', 'create_if_missing', 'replace') then
      raise exception 'unsupported document mutation operation'
        using errcode='22023';
    end if;
    v_revision := replace(extensions.gen_random_uuid()::text, '-', '');
    v_payload := v_mutation->'document' || jsonb_build_object(
      '_id', v_id,
      '_rev', v_revision,
      '_updatedAt', clock_timestamp()
    );
    if not (v_payload ? '_createdAt') then
      v_payload := v_payload || jsonb_build_object(
        '_createdAt', coalesce(v_current.payload->'_createdAt', to_jsonb(clock_timestamp()))
      );
    end if;
    v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, tombstoned, tombstoned_at,
      backend_owner
    ) values(
      v_id, v_payload->>'_type', v_revision, v_hash, v_payload,
      nullif(v_payload->>'_createdAt', '')::timestamptz,
      nullif(v_payload->>'_updatedAt', '')::timestamptz,
      false, null, 'supabase'
    ) on conflict(legacy_sanity_id) do update set
      document_type=excluded.document_type,
      source_revision=excluded.source_revision,
      source_hash=excluded.source_hash,
      payload=excluded.payload,
      source_updated_at=excluded.source_updated_at,
      last_seen_at=now(),
      tombstoned=false,
      tombstoned_at=null,
      backend_owner='supabase';
    perform cms.sync_document_from_source(v_payload, v_hash);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;
  return v_results;
end;
$$;
`;

const dispatchResolutionSchema = String.raw`
alter table accounts.referral_email_dispatches
  drop constraint referral_email_dispatches_status_check,
  add column resolved_at timestamptz,
  add column resolution_code text,
  add constraint referral_email_dispatches_status_check
    check (status in (
      'pending', 'sending', 'retry', 'sent', 'dead_letter', 'resolved'
    )),
  add constraint referral_email_dispatches_resolution_check check (
    (status = 'resolved' and resolved_at is not null and resolution_code is not null)
    or (status <> 'resolved' and resolved_at is null and resolution_code is null)
  );

alter table accounts.referral_email_dispatch_actions
  drop constraint referral_email_dispatch_actions_action_check,
  drop constraint referral_email_dispatch_actions_actor_check,
  add column reason_code text,
  add constraint referral_email_dispatch_actions_action_check
    check (action in ('requeue', 'resolve_without_resend')),
  add constraint referral_email_dispatch_actions_actor_check
    check (actor in ('service_role_recovery', 'service_role_resolution')),
  add constraint referral_email_dispatch_actions_reason_check check (
    (action = 'requeue' and reason_code is null)
    or (action = 'resolve_without_resend' and reason_code is not null)
  );

create or replace function accounts.guard_referral_email_dispatch_terminal_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('sent', 'resolved') and new is distinct from old then
    raise exception 'A terminal referral email dispatch is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
`;

const migrationFiles = [
  "20260715080000_add_referral_creator_terms_editor.sql",
  "20260715110000_add_referral_email_dispatch_ledger.sql",
  "20260720090000_harden_referral_mutations_and_lifecycle.sql",
  "20260720091000_harden_referral_email_dispatch_source_state.sql",
  "20260720092000_add_referral_recovery_evidence.sql",
  "20260720093000_ignore_namespaced_mirror_metadata.sql",
];

const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

let started = false;
let sql = null;
try {
  run(path.join(pgBin, "initdb"), [
    "-D",
    dataDir,
    "--auth=trust",
    "--no-locale",
  ]);
  run(
    path.join(pgBin, "pg_ctl"),
    ["-D", dataDir, "-o", `-p ${port} -h 127.0.0.1`, "-w", "start"],
    { stdio: "ignore" }
  );
  started = true;
  const psql = (args) =>
    run(path.join(pgBin, "psql"), [
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      ...args,
    ]);
  psql(["-c", bootstrap]);
  psql([
    "-f",
    path.join(root, "supabase/migrations", migrationFiles[0]),
  ]);
  psql([
    "-f",
    path.join(root, "supabase/migrations", migrationFiles[1]),
  ]);
  psql(["-c", dispatchResolutionSchema]);
  for (const file of migrationFiles.slice(2)) {
    psql(["-f", path.join(root, "supabase/migrations", file)]);
  }

  sql = postgres(`postgres://127.0.0.1:${port}/postgres`, {
    max: 8,
    prepare: false,
  });

  const sparseReferralId = "referral.sparse-overlay";
  const sparsePassword = `$2b$12$${"s".repeat(53)}`;
  const sparsePayload = {
    _id: sparseReferralId,
    _type: "referral",
    _rev: "sparse-r1",
    _createdAt: "2026-07-20T00:00:00.000Z",
    _updatedAt: "2026-07-20T00:00:00.000Z",
    creatorEmail: "sparse@example.com",
    creatorPassword: sparsePassword,
    registrationStatus: "active",
    customAgreement: { tier: "ambassador" },
    paidTotal: 10,
    owedTotal: 25,
  };
  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, backend_owner, cutover_generation
    ) values(
      ${sparseReferralId}, 'referral', 'sparse-r1', ${"a".repeat(64)},
      ${sql.json(sparsePayload)}::jsonb,
      '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z', 'supabase', 1
    )
  `;
  const [sparseMutation] = await sql`
    select migration.roo_apply_commerce_document_mutations_unbounded(
      'referral-sparse-overlay',
      ${sql.json([
        {
          operation: "replace",
          id: sparseReferralId,
          expected_revision: "sparse-r1",
          document: {
            _id: sparseReferralId,
            _type: "referral",
            owedTotal: 75,
          },
        },
      ])}::jsonb,
      1
    ) result
  `;
  assert.equal(sparseMutation.result.results[0].creatorEmail, "sparse@example.com");
  assert.equal(sparseMutation.result.results[0].creatorPassword, sparsePassword);
  assert.equal(sparseMutation.result.results[0].registrationStatus, "active");
  assert.equal(sparseMutation.result.results[0].paidTotal, 10);
  assert.equal(sparseMutation.result.results[0].owedTotal, 75);
  assert.deepEqual(sparseMutation.result.results[0].customAgreement, {
    tier: "ambassador",
  });
  const [sparseSource] = await sql`
    select
      payload->>'creatorEmail' creator_email,
      payload->>'creatorPassword' creator_password,
      payload->>'registrationStatus' registration_status,
      payload->>'paidTotal' paid_total,
      payload->>'owedTotal' owed_total,
      payload->'customAgreement' custom_agreement
    from migration.source_documents
    where legacy_sanity_id=${sparseReferralId}
  `;
  assert.deepEqual(sparseSource, {
    creator_email: "sparse@example.com",
    creator_password: sparsePassword,
    registration_status: "active",
    paid_total: "10",
    owed_total: "75",
    custom_agreement: { tier: "ambassador" },
  });

  const lifecycleUserId = "10000000-0000-4000-8000-000000000001";
  const lifecycleReferralId = "referral.lifecycle";
  const lifecycleEmail = "lifecycle@example.com";
  const lifecycleSourceHash = "b".repeat(64);
  await sql`insert into auth.users(id) values(${lifecycleUserId}::uuid)`;
  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      backend_owner
    ) values(
      ${lifecycleReferralId}, 'referral', 'lifecycle-r1', ${lifecycleSourceHash},
      ${sql.json({
        _id: lifecycleReferralId,
        _type: "referral",
        creatorEmail: lifecycleEmail,
        registrationStatus: "pending_email",
        slug: { current: "lifecycle" },
      })}::jsonb,
      'supabase'
    )
  `;
  const creatorAccount = (registrationStatus, sourceRevision) => ({
    user_id: lifecycleUserId,
    primary_email: lifecycleEmail,
    display_name: "Lifecycle Creator",
    referral_code: "lifecycle",
    legacy_sanity_id: lifecycleReferralId,
    source_revision: sourceRevision,
    source_hash: lifecycleSourceHash,
    registration_status: registrationStatus,
  });
  await sql`
    select public.roo_upsert_native_creator_account(
      ${sql.json(creatorAccount("pending_email", "lifecycle-r1"))}::jsonb
    )
  `;
  const [pendingAccount] = await sql`
    select
      profile.status,
      creator.active creator_active,
      bool_and(alias.verified) aliases_verified,
      identity.email_verified
    from public.profiles profile
    join accounts.creator_profiles creator on creator.user_id=profile.user_id
    join accounts.login_aliases alias on alias.user_id=profile.user_id
    join accounts.identity_links identity on identity.user_id=profile.user_id
    where profile.user_id=${lifecycleUserId}::uuid
    group by profile.status, creator.active, identity.email_verified
  `;
  assert.deepEqual(pendingAccount, {
    status: "pending",
    creator_active: false,
    aliases_verified: false,
    email_verified: false,
  });
  await assert.rejects(
    sql`
      select public.roo_upsert_native_creator_account(
        ${sql.json(creatorAccount("active", "lifecycle-r1"))}::jsonb
      )
    `,
    (error) => error.code === "40001"
  );

  await sql`
    update migration.source_documents
    set source_revision='lifecycle-r2',
        payload=payload || ${sql.json({
          registrationStatus: "active",
          emailVerifiedAt: "2026-07-20T00:00:00.000Z",
        })}::jsonb
    where legacy_sanity_id=${lifecycleReferralId}
  `;
  await sql`
    select public.roo_project_referral_account_shadow(array[${lifecycleReferralId}])
  `;
  const [activeAccount] = await sql`
    select
      profile.status,
      creator.active creator_active,
      bool_and(alias.verified) aliases_verified,
      identity.email_verified
    from public.profiles profile
    join accounts.creator_profiles creator on creator.user_id=profile.user_id
    join accounts.login_aliases alias on alias.user_id=profile.user_id
    join accounts.identity_links identity on identity.user_id=profile.user_id
    where profile.user_id=${lifecycleUserId}::uuid
    group by profile.status, creator.active, identity.email_verified
  `;
  assert.deepEqual(activeAccount, {
    status: "active",
    creator_active: true,
    aliases_verified: true,
    email_verified: true,
  });

  await sql`
    update public.profiles set status='disabled'
    where user_id=${lifecycleUserId}::uuid
  `;
  await sql`
    update accounts.creator_profiles set active=false
    where user_id=${lifecycleUserId}::uuid
  `;
  await sql`
    update migration.source_documents
    set source_revision='lifecycle-r3'
    where legacy_sanity_id=${lifecycleReferralId}
  `;
  await sql`
    select public.roo_upsert_native_creator_account(
      ${sql.json(creatorAccount("active", "lifecycle-r3"))}::jsonb
    )
  `;
  await sql`select public.roo_project_referral_account_shadow(array[${lifecycleReferralId}])`;
  const [disabledAccount] = await sql`
    select profile.status, creator.active creator_active
    from public.profiles profile
    join accounts.creator_profiles creator on creator.user_id=profile.user_id
    where profile.user_id=${lifecycleUserId}::uuid
  `;
  assert.deepEqual(disabledAccount, {
    status: "disabled",
    creator_active: false,
  });

  const emailReferralId = "referral.stale-email";
  const email = "dispatch@example.com";
  const token = "R".repeat(43);
  const tokenHash = digest(token);
  const emailHash = digest(email);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const emailDocument = {
    _id: emailReferralId,
    _type: "referral",
    creatorEmail: email,
    registrationStatus: "pending_email",
    registrationVerificationTokenHash: tokenHash,
    registrationVerificationExpiresAt: expiresAt,
  };
  const [dispatch] = await sql`
    select public.roo_enqueue_referral_email_mutation(
      ${sql.json([{ operation: "create", document: emailDocument }])}::jsonb,
      ${emailReferralId},
      'registration_verification',
      ${email},
      ${emailHash},
      ${tokenHash},
      ${sql.json({ token, name: "Dispatch Fixture" })}::jsonb,
      ${expiresAt}::timestamptz
    ) result
  `;
  await sql`
    update migration.source_documents
    set source_revision='stale-email-r2',
        payload=payload || '{"registrationStatus":"active"}'::jsonb
    where legacy_sanity_id=${emailReferralId}
  `;
  const [staleClaim] = await sql`
    select public.roo_claim_referral_email_dispatch(
      ${dispatch.result.idempotency_key},
      ${crypto.randomUUID()}::uuid,
      120
    ) result
  `;
  assert.equal(staleClaim.result.claimed, false);
  assert.equal(staleClaim.result.dead_letter, true);
  assert.equal(staleClaim.result.source_state_changed, true);
  const [staleDispatch] = await sql`
    select status, last_error_code, delivery_payload ? 'token' has_token
    from accounts.referral_email_dispatches
    where idempotency_key=${dispatch.result.idempotency_key}
  `;
  assert.deepEqual(staleDispatch, {
    status: "dead_letter",
    last_error_code: "source_state_changed",
    has_token: false,
  });
  const [staleRequeue] = await sql`
    select public.roo_requeue_referral_email_dispatch(
      ${emailReferralId},
      'registration_verification'
    ) result
  `;
  assert.equal(staleRequeue.result.requeued, false);
  assert.equal(
    staleRequeue.result.recovery_blocked_reason,
    "source_registration_not_pending"
  );

  const recoveryReferralId = "referral.accounting-loss";
  const recoveryHash = "c".repeat(64);
  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      backend_owner
    ) values(
      ${recoveryReferralId}, 'referral', 'loss-current-r1', ${recoveryHash},
      ${sql.json({
        _id: recoveryReferralId,
        _type: "referral",
        creatorEmail: "loss@example.com",
        registrationStatus: "active",
      })}::jsonb,
      'supabase'
    )
  `;
  const globalSequence = "9007199254740993";
  const commerceSequence = "9007199254740994";
  const globalEventKey = "20000000-0000-4000-8000-000000000001";
  await sql`
    insert into migration.document_mutation_mirror_outbox(
      sequence_no, event_key, document_ids, documents, status, created_at, applied_at
    ) overriding system value values(
      ${globalSequence}::bigint,
      ${globalEventKey}::uuid,
      array[${recoveryReferralId}],
      ${sql.json([
        {
          _id: recoveryReferralId,
          _type: "referral",
          _rev: "loss-global-r1",
          creatorEmail: "loss@example.com",
          creatorPassword: `$2b$12$${"p".repeat(53)}`,
          paidTotal: 10,
          owedTotal: 25,
        },
      ])}::jsonb,
      'applied',
      '2026-07-20T01:00:00Z',
      '2026-07-20T01:00:01Z'
    )
  `;
  const [snapshot] = await sql`
    select public.roo_referral_recovery_snapshot(
      ${recoveryReferralId}, 'global', ${globalSequence}::bigint
    ) result
  `;
  assert.equal(snapshot.result.sequence_no, globalSequence);
  assert.equal(snapshot.result.source_revision, "loss-global-r1");
  assert.deepEqual(snapshot.result.accounting, { paidTotal: 10, owedTotal: 25 });
  assert.deepEqual(snapshot.result.accounting_keys, ["owedTotal", "paidTotal"]);
  assert.match(snapshot.result.accounting_digest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(snapshot.result).includes("creatorPassword"), false);
  assert.equal(JSON.stringify(snapshot.result).includes("loss@example.com"), false);

  const [unambiguousCandidates] =
    await sql`select public.roo_referral_accounting_loss_candidates() result`;
  const initialCandidate = unambiguousCandidates.result.find(
    (candidate) => candidate.referral_id === recoveryReferralId
  );
  assert.equal(initialCandidate.suggested_sequence_no, globalSequence);
  assert.deepEqual(initialCandidate.missing_accounting_keys, [
    "owedTotal",
    "paidTotal",
  ]);
  assert.equal(initialCandidate.later_accounting_change_count, 0);
  assert.equal(initialCandidate.unambiguous, true);

  await sql`
    insert into migration.commerce_mirror_outbox(
      sequence_no, command_id, event_key, document_ids, documents, deleted_ids,
      canonical_hash, cutover_generation, status, created_at, mirrored_at
    ) overriding system value values(
      ${commerceSequence}::bigint,
      'recovery-commerce-event',
      ${`commerce-mirror:${"d".repeat(64)}`},
      array[${recoveryReferralId}],
      ${sql.json([
        {
          _id: recoveryReferralId,
          _type: "referral",
          _rev: "loss-commerce-r2",
          owedTotal: 30,
        },
      ])}::jsonb,
      '{}'::text[],
      ${"e".repeat(64)},
      1,
      'mirrored',
      '2026-07-20T02:00:00Z',
      '2026-07-20T02:00:01Z'
    )
  `;
  const [ambiguousCandidates] =
    await sql`select public.roo_referral_accounting_loss_candidates() result`;
  const ambiguousCandidate = ambiguousCandidates.result.find(
    (candidate) => candidate.referral_id === recoveryReferralId
  );
  assert.equal(ambiguousCandidate.suggested_sequence_no, globalSequence);
  assert.equal(ambiguousCandidate.later_accounting_change_count, 1);
  assert.equal(ambiguousCandidate.unambiguous, false);

  const [mirrorState] = await sql`
    select public.roo_referral_mirror_domain_state(
      array[${recoveryReferralId}]
    ) result
  `;
  assert.deepEqual(mirrorState.result, [
    {
      referral_id: recoveryReferralId,
      source_revision: "loss-current-r1",
      source_hash: recoveryHash,
      global_sequence: globalSequence,
      commerce_sequence: commerceSequence,
    },
  ]);
  await assert.rejects(
    sql`
      select public.roo_referral_mirror_domain_state(
        array[${recoveryReferralId}, ${recoveryReferralId}]
      )
    `,
    (error) => error.code === "22023"
  );
  await assert.rejects(
    sql`
      select public.roo_referral_recovery_snapshot(
        'invalid-referral-id', 'global', 1
      )
    `,
    (error) => error.code === "22023"
  );

  await sql`
    insert into migration.source_documents(
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      backend_owner
    )
    select
      format('referral.limit_%s', lpad(value::text, 3, '0')),
      'referral',
      format('limit-r%s', value),
      repeat('f', 64),
      jsonb_build_object(
        '_id', format('referral.limit_%s', lpad(value::text, 3, '0')),
        '_type', 'referral'
      ),
      'supabase'
    from generate_series(1, 501) value
  `;
  await assert.rejects(
    sql`select public.roo_referral_mirror_domain_state(null::text[])`,
    (error) => error.code === "54000"
  );

  const [privileges] = await sql`
    select
      has_function_privilege(
        'anon',
        'public.roo_referral_recovery_snapshot(text,text,bigint)',
        'execute'
      ) anon_snapshot,
      has_function_privilege(
        'authenticated',
        'public.roo_referral_accounting_loss_candidates()',
        'execute'
      ) authenticated_candidates,
      has_function_privilege(
        'service_role',
        'public.roo_referral_recovery_snapshot(text,text,bigint)',
        'execute'
      ) service_snapshot,
      has_function_privilege(
        'service_role',
        'public.roo_referral_accounting_loss_candidates()',
        'execute'
      ) service_candidates,
      has_function_privilege(
        'service_role',
        'public.roo_referral_mirror_domain_state(text[])',
        'execute'
      ) service_mirror_state,
      has_function_privilege(
        'service_role',
        'migration.referral_accounting_patch(jsonb)',
        'execute'
      ) service_private_helper
  `;
  assert.deepEqual(privileges, {
    anon_snapshot: false,
    authenticated_candidates: false,
    service_snapshot: true,
    service_candidates: true,
    service_mirror_state: true,
    service_private_helper: false,
  });

  const [canonical] = await sql`
    select migration.canonical_business_document(
      ${sql.json({
        _id: recoveryReferralId,
        _type: "referral",
        _supabaseSequence: "99",
        _supabaseSequences: { global: "7", commerce: "8" },
        _supabaseRevision: "transport-r1",
        creatorPassword: sparsePassword,
        registrationVerificationTokenHash: "f".repeat(64),
        owedTotal: 30,
      })}::jsonb
    ) result
  `;
  assert.deepEqual(canonical.result, {
    _id: recoveryReferralId,
    _type: "referral",
    owedTotal: 30,
  });

  await sql.end();
  sql = null;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        postgres: run(path.join(pgBin, "postgres"), ["--version"]).trim(),
        migrations: migrationFiles,
        checks: 30,
      },
      null,
      2
    )}\n`
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
