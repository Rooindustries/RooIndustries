-- Schema-v4 expand phase. This migration is additive and rolling-deploy safe.
-- Activation and trigger replacement happen in the separate activation migration.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table tourney.tourney_players
  add column if not exists principal_id uuid;
update tourney.tourney_players player
set principal_id = account.principal_id
from accounts.tourney_accounts account
where player.principal_id is null
  and account.legacy_sanity_id = player.id;
create unique index if not exists tourney_players_principal_id_unique_v4
  on tourney.tourney_players (principal_id)
  where principal_id is not null;

create table if not exists tourney.mirror_contracts (
  logical_table text primary key,
  supabase_relation text not null unique,
  legacy_relation text not null unique,
  key_columns text[] not null,
  allowed_columns text[] not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(key_columns) > 0),
  check (key_columns <@ allowed_columns)
);

alter table tourney.command_receipts
  drop constraint if exists command_receipts_status_check;
alter table tourney.command_receipts
  add column if not exists committed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists failure_code text,
  add column if not exists failure_evidence jsonb not null default '{}'::jsonb,
  add column if not exists recovered_at timestamptz,
  add column if not exists recovery_evidence jsonb not null default '{}'::jsonb;
alter table tourney.command_receipts
  add constraint command_receipts_status_check
  check (status in ('processing', 'committed', 'completed', 'failed')) not valid;
alter table tourney.command_receipts
  validate constraint command_receipts_status_check;

alter table tourney.mirror_outbox
  add column if not exists status text not null default 'pending',
  add column if not exists record_hash text,
  add column if not exists max_attempts integer not null default 12,
  add column if not exists dead_lettered_at timestamptz;
update tourney.mirror_outbox
set status = case
  when applied_at is not null then 'applied'
  when last_error_at is not null then 'retry'
  else 'pending'
end;
alter table tourney.mirror_outbox
  drop constraint if exists mirror_outbox_status_check,
  add constraint mirror_outbox_status_check
    check (status in ('pending', 'processing', 'retry', 'applied', 'dead_letter')) not valid,
  drop constraint if exists mirror_outbox_max_attempts_check,
  add constraint mirror_outbox_max_attempts_check
    check (max_attempts between 1 and 100) not valid,
  drop constraint if exists mirror_outbox_record_hash_check,
  add constraint mirror_outbox_record_hash_check
    check (record_hash is null or record_hash ~ '^[0-9a-f]{64}$') not valid;
alter table tourney.mirror_outbox
  validate constraint mirror_outbox_status_check,
  validate constraint mirror_outbox_max_attempts_check,
  validate constraint mirror_outbox_record_hash_check;

drop index if exists tourney.tourney_mirror_outbox_pending_idx;
create index if not exists tourney_mirror_outbox_claim_v4_idx
  on tourney.mirror_outbox (available_at, generation desc, sequence)
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_mirror_outbox_dead_letter_v4_idx
  on tourney.mirror_outbox (dead_lettered_at desc, sequence)
  where status = 'dead_letter';
create index if not exists tourney_mirror_outbox_expired_lease_v4_idx
  on tourney.mirror_outbox (lease_expires_at, generation, sequence)
  where status = 'processing';

create table if not exists tourney.account_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  version bigint not null check (version > 0),
  accounts_json jsonb not null,
  canonical_hash text not null check (canonical_hash ~ '^[0-9a-f]{64}$'),
  generation integer not null default 1 check (generation >= 0),
  created_at timestamptz not null default now(),
  created_by text not null,
  supersedes_snapshot_id uuid references tourney.account_snapshots(snapshot_id),
  unique (version),
  check (jsonb_typeof(accounts_json) in ('array', 'object'))
);

create table if not exists tourney.external_operations (
  operation_key text primary key,
  command_id text references tourney.command_receipts(command_id) on delete restrict,
  operation_kind text not null check (operation_kind in (
    'supabase_player_auth', 'supabase_admin_auth', 'sanity_account_projection',
    'discord_membership', 'discord_role_reconcile', 'supabase_identity_unlink'
  )),
  entity_type text not null,
  entity_id text not null,
  serialization_key text not null,
  desired_state jsonb not null,
  desired_state_hash text not null check (desired_state_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'applied', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 12 check (max_attempts between 1 and 100),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and lease_id is not null and lease_expires_at is not null)
    or status <> 'processing'
  ),
  check (
    (status = 'applied' and completed_at is not null)
    or status <> 'applied'
  )
);
alter table tourney.external_operations
  drop constraint if exists external_operations_operation_kind_check;
alter table tourney.external_operations
  add constraint external_operations_operation_kind_check check (
    operation_kind in (
      'supabase_player_auth', 'supabase_admin_auth', 'sanity_account_projection',
      'discord_membership', 'discord_role_reconcile', 'supabase_identity_unlink'
    )
  ) not valid;
alter table tourney.external_operations
  validate constraint external_operations_operation_kind_check;

create table if not exists tourney.external_operation_secrets (
  operation_key text primary key
    references tourney.external_operations(operation_key) on delete cascade,
  encrypted_payload text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (length(encrypted_payload) between 32 and 16384)
);
alter table tourney.external_operation_secrets enable row level security;
revoke all on table tourney.external_operation_secrets
  from public, anon, authenticated;
grant select, insert, update, delete on table tourney.external_operation_secrets
  to service_role;
create index if not exists tourney_external_operation_secrets_expiry_v4_idx
  on tourney.external_operation_secrets (expires_at, operation_key);
create or replace function tourney.set_external_operation_serialization_key()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if nullif(pg_catalog.btrim(new.serialization_key), '') is null then
    new.serialization_key := case
      when new.operation_kind in ('discord_membership','discord_role_reconcile') then
        'discord:' || coalesce(
          new.desired_state#>>'{assignment,principalId}',
          new.desired_state#>>'{oauthProjection,principalId}',
          new.desired_state#>>'{oauthProjection,userId}',
          new.entity_id
        )
      when new.operation_kind = 'sanity_account_projection' then
        'sanity:account-snapshot'
      else new.operation_kind || ':' || new.entity_type || ':' || new.entity_id
    end;
  end if;
  return new;
end;
$$;
drop trigger if exists set_external_operation_serialization_key
  on tourney.external_operations;
create trigger set_external_operation_serialization_key
before insert or update of operation_kind, entity_type, entity_id,
  desired_state, serialization_key
on tourney.external_operations
for each row execute function tourney.set_external_operation_serialization_key();
revoke all on function tourney.set_external_operation_serialization_key()
  from public;
create index if not exists tourney_external_operations_claim_v4_idx
  on tourney.external_operations (next_attempt_at, created_at, operation_key)
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_external_operations_serial_v4_idx
  on tourney.external_operations (
    serialization_key, status, next_attempt_at, created_at, operation_key
  )
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_external_operations_command_v4_idx
  on tourney.external_operations (command_id, status, created_at);
create index if not exists tourney_external_operations_dead_letter_v4_idx
  on tourney.external_operations (updated_at desc, operation_key)
  where status = 'dead_letter';
create index if not exists tourney_external_operations_expired_lease_v4_idx
  on tourney.external_operations (lease_expires_at, operation_key)
  where status = 'processing';

create table if not exists migration.tourney_import_quarantine (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  logical_table text not null,
  collision_kind text not null,
  record_key jsonb not null,
  safe_details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists tourney_import_quarantine_open_v4_idx
  on migration.tourney_import_quarantine (source_hash, logical_table, created_at)
  where resolved_at is null;

create table if not exists tourney.cutover_gate_events (
  id bigint generated always as identity primary key,
  event_kind text not null check (event_kind in (
    'hardened_activated', 'natural_mirror_verified', 'zero_drift_pass',
    'clock_started', 'clock_reset', 'legacy_read_only'
  )),
  generation integer not null check (generation >= 0),
  actor text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tourney_cutover_gate_events_kind_v4_idx
  on tourney.cutover_gate_events (event_kind, created_at desc);

alter table tourney.cutover_metadata
  add column if not exists hardened_active boolean not null default false,
  add column if not exists natural_mutation_verified_at timestamptz,
  add column if not exists first_zero_drift_at timestamptz,
  add column if not exists second_zero_drift_at timestamptz,
  add column if not exists clock_last_evaluated_at timestamptz,
  add column if not exists clock_last_reset_reason text;

alter table tourney.parity_runs
  add column if not exists status_counts jsonb not null default '{}'::jsonb,
  add column if not exists canonical_hashes jsonb not null default '{}'::jsonb,
  add column if not exists shadow_results jsonb not null default '{}'::jsonb;

alter table tourney.shadow_observations
  add column if not exists primary_status integer,
  add column if not exists shadow_status integer,
  add column if not exists primary_error_code text,
  add column if not exists shadow_error_code text,
  add column if not exists primary_hash text,
  add column if not exists shadow_hash text;

create table if not exists tourney.shadow_latency_baselines (
  route text primary key check (route in (
    'public_roster','public_bracket','admin_players','appeals','payouts'
  )),
  primary_p95_ms integer not null check (primary_p95_ms >= 0),
  sample_count integer not null check (sample_count >= 30),
  source_window_started_at timestamptz,
  source_window_ended_at timestamptz,
  captured_at timestamptz not null default now(),
  captured_by text not null
);
alter table tourney.shadow_latency_baselines enable row level security;
revoke all on table tourney.shadow_latency_baselines
  from public, anon, authenticated;
grant select, insert, update, delete on table tourney.shadow_latency_baselines
  to service_role;

alter table tourney.email_dispatches
  drop constraint if exists email_dispatches_status_check;
alter table tourney.email_dispatches
  add column if not exists audited_override_at timestamptz,
  add column if not exists audited_override_by text,
  add column if not exists audited_override_reason text;
alter table tourney.email_dispatches
  add constraint email_dispatches_status_check
  check (status in (
    'pending', 'sending', 'retry', 'sent', 'failed', 'dead_letter',
    'historical_unknown', 'expired'
  )) not valid;
alter table tourney.email_dispatches
  validate constraint email_dispatches_status_check;
create index if not exists tourney_email_dispatches_expired_lease_v4_idx
  on tourney.email_dispatches (lease_expires_at, created_at)
  where status = 'sending';

alter table accounts.discord_role_assignments
  drop constraint if exists discord_role_assignments_status_check;
alter table accounts.discord_role_assignments
  add column if not exists player_id text,
  add column if not exists stale_discord_user_ids text[] not null default '{}'::text[],
  add column if not exists lease_id uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists max_attempts integer not null default 12,
  add column if not exists blocked_at timestamptz,
  add column if not exists pending_since timestamptz;
update accounts.discord_role_assignments
set pending_since = coalesce(pending_since, updated_at, created_at, now())
where status in ('pending','processing','retry');
alter table accounts.discord_role_assignments
  add constraint discord_role_assignments_status_check
  check (status in (
    'pending', 'processing', 'applied', 'retry', 'blocked', 'blocked_reauth',
    'dead_letter'
  )) not valid;
alter table accounts.discord_role_assignments
  validate constraint discord_role_assignments_status_check;
create index if not exists discord_role_assignments_claim_v4_idx
  on accounts.discord_role_assignments (status, updated_at, principal_id)
  where status in ('pending', 'retry', 'processing');
create index if not exists discord_role_assignments_pending_age_v4_idx
  on accounts.discord_role_assignments (pending_since, principal_id)
  where status in ('pending', 'retry', 'processing');

create or replace function accounts.set_discord_assignment_pending_since()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('roo.tourney_mirror_apply', true) = '1' then
    return new;
  end if;
  if new.status in ('pending','processing','retry') then
    if tg_op = 'INSERT'
       or old.status not in ('pending','processing','retry')
       or old.generation is distinct from new.generation
       or old.discord_user_id is distinct from new.discord_user_id
       or old.guild_id is distinct from new.guild_id
       or old.desired_role is distinct from new.desired_role then
      new.pending_since := pg_catalog.now();
    else
      new.pending_since := coalesce(
        old.pending_since, old.updated_at, old.created_at, pg_catalog.now()
      );
    end if;
  else
    new.pending_since := null;
  end if;
  return new;
end;
$$;
drop trigger if exists set_discord_assignment_pending_since
  on accounts.discord_role_assignments;
create trigger set_discord_assignment_pending_since
before insert or update on accounts.discord_role_assignments
for each row execute function accounts.set_discord_assignment_pending_since();
revoke all on function accounts.set_discord_assignment_pending_since()
  from public, anon, authenticated;

create or replace function tourney.guard_email_dispatch_terminal_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then
    raise exception 'A sent Tourney email dispatch cannot regress' using errcode = '23514';
  end if;
  if old.status = 'expired' and new.status <> 'expired' then
    raise exception 'An expired Tourney email dispatch cannot become sendable' using errcode = '23514';
  end if;
  if old.status = 'historical_unknown'
     and new.status in ('pending', 'sending', 'retry')
     and (new.audited_override_at is null
       or nullif(btrim(new.audited_override_by), '') is null
       or nullif(btrim(new.audited_override_reason), '') is null) then
    raise exception 'Historical Tourney email requires an audited override' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_email_dispatch_terminal_state on tourney.email_dispatches;
create trigger guard_email_dispatch_terminal_state
before update on tourney.email_dispatches
for each row execute function tourney.guard_email_dispatch_terminal_state();

do $$
declare
  v_row record;
  v_allowed text[];
begin
  for v_row in
    select * from (values
      ('tourney_players', 'tourney.tourney_players', 'tourney_players', array['id']::text[]),
      ('tourney_player_tokens', 'tourney.tourney_player_tokens', 'tourney_player_tokens', array['id']::text[]),
      ('tourney_registration_config', 'tourney.tourney_registration_config', 'tourney_registration_config', array['id']::text[]),
      ('tourney_bracket_teams', 'tourney.tourney_bracket_teams', 'tourney_bracket_teams', array['id']::text[]),
      ('tourney_bracket_team_members', 'tourney.tourney_bracket_team_members', 'tourney_bracket_team_members', array['id']::text[]),
      ('tourney_bracket_meta', 'tourney.tourney_bracket_meta', 'tourney_bracket_meta', array['id']::text[]),
      ('tourney_bracket_entities', 'tourney.tourney_bracket_entities', 'tourney_bracket_entities', array['entity_type','entity_id']::text[]),
      ('tourney_bracket_counters', 'tourney.tourney_bracket_counters', 'tourney_bracket_counters', array['entity_type']::text[]),
      ('tourney_bracket_audit', 'tourney.tourney_bracket_audit', 'tourney_bracket_audit', array['id']::text[]),
      ('tourney_bracket_lock', 'tourney.tourney_bracket_lock', 'tourney_bracket_lock', array['id']::text[]),
      ('tourney_appeals', 'tourney.tourney_appeals', 'tourney_appeals', array['id']::text[]),
      ('tourney_payouts', 'tourney.tourney_payouts', 'tourney_payouts', array['id']::text[]),
      ('email_dispatches', 'tourney.email_dispatches', 'tourney_email_dispatches', array['id']::text[]),
      ('command_receipts', 'tourney.command_receipts', 'tourney_command_receipts', array['command_id']::text[]),
      ('account_snapshots', 'tourney.account_snapshots', 'tourney_account_snapshots', array['snapshot_id']::text[]),
      ('external_operations', 'tourney.external_operations', 'tourney_external_operations', array['operation_key']::text[]),
      ('discord_role_assignments', 'accounts.discord_role_assignments', 'tourney_discord_role_assignments', array['principal_id']::text[])
    ) contract(logical_table, supabase_relation, legacy_relation, key_columns)
  loop
    select array_agg(attribute.attname order by attribute.attnum)
    into v_allowed
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = v_row.supabase_relation::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped;
    insert into tourney.mirror_contracts (
      logical_table, supabase_relation, legacy_relation, key_columns,
      allowed_columns, enabled, updated_at
    ) values (
      v_row.logical_table, v_row.supabase_relation, v_row.legacy_relation,
      v_row.key_columns, v_allowed, true, now()
    ) on conflict (logical_table) do update set
      supabase_relation = excluded.supabase_relation,
      legacy_relation = excluded.legacy_relation,
      key_columns = excluded.key_columns,
      allowed_columns = excluded.allowed_columns,
      enabled = true,
      updated_at = now();
  end loop;
end;
$$;

do $$
declare v_table regclass;
begin
  foreach v_table in array array[
    'tourney.mirror_contracts'::regclass,
    'tourney.account_snapshots'::regclass,
    'tourney.external_operations'::regclass,
    'tourney.cutover_gate_events'::regclass,
    'migration.tourney_import_quarantine'::regclass
  ] loop
    execute format('alter table %s enable row level security', v_table);
    execute format('revoke all on table %s from public, anon, authenticated', v_table);
    execute format('grant all on table %s to service_role', v_table);
  end loop;
end;
$$;

create or replace function public.roo_capture_tourney_hardening_snapshot(
  p_legacy_snapshot jsonb default null,
  p_sanity_account jsonb default null,
  p_legacy_snapshot_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract record;
  v_rows jsonb;
  v_payload jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_key text := encode(extensions.gen_random_bytes(32), 'hex');
  v_key_id uuid;
  v_snapshot_id uuid;
  v_hash text;
  v_relation text;
  v_roundtrip text;
  v_vault_key text;
  v_meta record;
  v_expanded_version integer;
begin
  if nullif(p_legacy_snapshot_text,'') is null then
    raise exception 'Exact legacy Tourney snapshot text is required'
      using errcode='22023';
  end if;
  begin
    p_legacy_snapshot := p_legacy_snapshot_text::jsonb;
  exception when others then
    raise exception 'Exact legacy Tourney snapshot text is malformed'
      using errcode='22023';
  end;
  select metadata.id,metadata.primary_backend,metadata.generation,metadata.writes_paused,
    metadata.fallback_read_only
  into v_meta
  from tourney.cutover_metadata metadata
  where metadata.id='tourney'
  for share;
  select metadata.expanded_version into v_expanded_version
  from tourney.schema_metadata metadata
  where metadata.schema_name='tourney';
  if v_meta.id is null or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1 or not v_meta.writes_paused
     or v_meta.fallback_read_only or coalesce(v_expanded_version,0) < 4 then
    raise exception 'Tourney snapshot controls are not in the paused schema-v4 pre-cutover state'
      using errcode='55000';
  end if;
  if coalesce(jsonb_typeof(p_legacy_snapshot),'') <> 'object'
     or not (p_legacy_snapshot ?& array[
       'tourney_players','tourney_player_tokens','tourney_registration_config',
       'tourney_bracket_teams','tourney_bracket_team_members','tourney_bracket_meta',
       'tourney_bracket_entities','tourney_bracket_counters','tourney_bracket_audit',
       'tourney_bracket_lock','tourney_appeals','tourney_payouts',
       'tourney_email_dispatches','tourney_command_receipts','tourney_mirror_outbox',
       'tourney_mirror_checkpoints','tourney_mirror_tombstones',
       'tourney_account_snapshots','tourney_external_operations',
       'tourney_discord_role_assignments','tourney_identity_conflicts',
       'tourney_parity_runs','tourney_cutover_metadata','tourney_schema_metadata',
       'tourney_mirror_contracts','tourney_cutover_gate_events',
       'tourney_import_quarantine','tourney_shadow_observations',
       'tourney_shadow_latency_baselines'
     ])
     or exists(
       select 1 from jsonb_each(p_legacy_snapshot) entry
       where jsonb_typeof(entry.value) <> 'array'
     ) then
    raise exception 'Legacy Tourney snapshot is incomplete or malformed'
      using errcode='22023';
  end if;
  if coalesce(jsonb_typeof(p_sanity_account),'') <> 'object'
     or p_sanity_account->>'_id' is distinct from 'tourneyAuthStore' then
    raise exception 'Sanity Tourney account snapshot is missing or malformed'
      using errcode='22023';
  end if;
  if not exists(
    select 1
    from jsonb_array_elements(p_legacy_snapshot->'tourney_cutover_metadata') row_data
    where row_data->>'id'='tourney'
      and row_data->>'primary_backend'='supabase'
      and (row_data->>'generation')::bigint=1
      and (row_data->>'writes_paused')::boolean
      and not (row_data->>'fallback_read_only')::boolean
  ) then
    raise exception 'Legacy Tourney snapshot controls do not match the paused cutover'
      using errcode='55000';
  end if;
  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text), ''[]''::jsonb) from %s source_row',
      v_contract.supabase_relation::regclass
    ) into v_rows;
    v_payload := v_payload || jsonb_build_object(v_contract.logical_table, v_rows);
    v_counts := v_counts || jsonb_build_object(v_contract.logical_table, jsonb_array_length(v_rows));
  end loop;
  select coalesce(jsonb_agg(to_jsonb(account) order by account.principal_id), '[]'::jsonb)
  into v_rows from accounts.tourney_accounts account;
  v_payload := v_payload || jsonb_build_object('accounts.tourney_accounts', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.tourney_accounts', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(principal) order by principal.id), '[]'::jsonb)
  into v_rows from accounts.principals principal
  where principal.id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.principals', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.principals', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.id), '[]'::jsonb)
  into v_rows from accounts.login_aliases alias
  where alias.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.login_aliases', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.login_aliases', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(identity) order by identity.id), '[]'::jsonb)
  into v_rows from accounts.identity_links identity
  where identity.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.identity_links', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.identity_links', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.user_id), '[]'::jsonb)
  into v_rows from accounts.principal_auth_users mapping
  where mapping.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.principal_auth_users', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.principal_auth_users', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(auth_user) order by auth_user.id), '[]'::jsonb)
  into v_rows from auth.users auth_user
  where auth_user.id in (
    select user_id from accounts.principal_auth_users
    where principal_id in (select principal_id from accounts.tourney_accounts)
  );
  v_payload := v_payload || jsonb_build_object('auth.users', v_rows);
  v_counts := v_counts || jsonb_build_object('auth.users', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(identity) order by identity.id), '[]'::jsonb)
  into v_rows from auth.identities identity
  where identity.user_id in (
    select user_id from accounts.principal_auth_users
    where principal_id in (select principal_id from accounts.tourney_accounts)
  );
  v_payload := v_payload || jsonb_build_object('auth.identities', v_rows);
  v_counts := v_counts || jsonb_build_object('auth.identities', jsonb_array_length(v_rows));
  foreach v_relation in array array[
    'tourney.mirror_outbox','tourney.mirror_checkpoints',
    'tourney.mirror_tombstones','tourney.schema_metadata',
    'tourney.tourney_player_auth_operations','tourney.external_operation_secrets',
    'tourney.mirror_contracts','tourney.parity_runs','tourney.cutover_metadata',
    'tourney.identity_conflicts','tourney.shadow_observations',
    'tourney.shadow_latency_baselines','tourney.cutover_gate_events',
    'migration.tourney_sync_runs','migration.tourney_import_quarantine',
    'migration.tourney_import_preflights'
  ] loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(snapshot_row) order by to_jsonb(snapshot_row)::text), ''[]''::jsonb) from %s snapshot_row',
      v_relation::regclass
    ) into v_rows;
    v_payload := v_payload || jsonb_build_object(v_relation,v_rows);
    v_counts := v_counts || jsonb_build_object(v_relation,jsonb_array_length(v_rows));
  end loop;
  select coalesce(jsonb_agg(to_jsonb(intent) order by intent.id),'[]'::jsonb)
  into v_rows
  from accounts.oauth_intents intent
  where intent.flow='tourney'
    or intent.principal_id in (select principal_id from accounts.tourney_accounts)
    or intent.target_user_id in (
      select user_id from accounts.principal_auth_users mapping
      where mapping.principal_id in (select principal_id from accounts.tourney_accounts)
    )
    or intent.claimed_user_id in (
      select user_id from accounts.principal_auth_users mapping
      where mapping.principal_id in (select principal_id from accounts.tourney_accounts)
    );
  v_payload := v_payload || jsonb_build_object('accounts.oauth_intents',v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.oauth_intents',jsonb_array_length(v_rows));
  v_payload := v_payload || jsonb_build_object(
    'legacy',p_legacy_snapshot,'sanity_account',p_sanity_account
  );
  select vault.create_secret(
    v_key,
    'tourney-hardening-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    'AES key for the Roo Industries Tourney hardening snapshot'
  ) into v_key_id;
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  insert into migration.tourney_pre_cutover_snapshots(
    key_secret_id,payload_sha256,ciphertext,table_counts
  ) values(
    v_key_id,v_hash,
    extensions.pgp_sym_encrypt(v_payload::text,v_key,'cipher-algo=aes256,compress-algo=1'),
    v_counts
  ) returning id into v_snapshot_id;
  select secret.decrypted_secret into v_vault_key
  from vault.decrypted_secrets secret
  where secret.id=v_key_id;
  if v_vault_key is distinct from v_key then
    raise exception 'Tourney hosted snapshot Vault key retrieval failed'
      using errcode='XX001';
  end if;
  select extensions.pgp_sym_decrypt(snapshot.ciphertext,v_vault_key)
  into v_roundtrip
  from migration.tourney_pre_cutover_snapshots snapshot
  where snapshot.id=v_snapshot_id;
  if v_roundtrip is distinct from v_payload::text then
    raise exception 'Tourney hosted snapshot round-trip verification failed'
      using errcode='XX001';
  end if;
  return jsonb_build_object(
    'snapshot_id',v_snapshot_id,'payload_sha256',v_hash,
    'table_counts',v_counts,'captured_at',now(),
    'payload',v_payload,'payload_text',v_payload::text,
    'hosted_roundtrip_verified',true
  );
end;
$$;

revoke all on function tourney.guard_email_dispatch_terminal_state()
  from public, anon, authenticated;
revoke all on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  to service_role;
grant usage, select on all sequences in schema tourney to service_role;
