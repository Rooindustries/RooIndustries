-- Schema-v4 expand phase for the Vercel-managed fallback PostgreSQL database.
-- Additive and rolling-deploy safe; no separate database-provider account is required.
set lock_timeout = '5s';
set statement_timeout = '120s';

create extension if not exists pgcrypto;

alter table tourney_players
  add column if not exists principal_id uuid;
create unique index if not exists tourney_players_principal_id_unique_v4
  on tourney_players (principal_id)
  where principal_id is not null;

create table if not exists tourney_schema_metadata (
  schema_name text primary key,
  schema_version integer not null check (schema_version > 0),
  expanded_version integer not null default 3 check (expanded_version > 0),
  updated_at timestamptz not null default now()
);
insert into tourney_schema_metadata (schema_name, schema_version, expanded_version)
values ('tourney', 3, 4)
on conflict (schema_name) do update set
  expanded_version = greatest(tourney_schema_metadata.expanded_version, 4),
  updated_at = now();

create table if not exists tourney_mirror_contracts (
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

alter table tourney_command_receipts drop constraint if exists tourney_command_receipts_status_check;
alter table tourney_command_receipts
  add column if not exists committed_at timestamptz,
  add column if not exists failed_at timestamptz,
  add column if not exists failure_code text,
  add column if not exists failure_evidence jsonb not null default '{}'::jsonb,
  add column if not exists recovered_at timestamptz,
  add column if not exists recovery_evidence jsonb not null default '{}'::jsonb,
  add constraint tourney_command_receipts_status_check
    check (status in ('processing', 'committed', 'completed', 'failed')) not valid;
alter table tourney_command_receipts validate constraint tourney_command_receipts_status_check;

alter table tourney_mirror_outbox
  add column if not exists status text not null default 'pending',
  add column if not exists record_hash text,
  add column if not exists max_attempts integer not null default 12,
  add column if not exists dead_lettered_at timestamptz;
update tourney_mirror_outbox set status = case
  when applied_at is not null then 'applied'
  when last_error_at is not null then 'retry'
  else 'pending' end;
alter table tourney_mirror_outbox
  drop constraint if exists tourney_mirror_outbox_status_check,
  drop constraint if exists tourney_mirror_outbox_max_attempts_check,
  drop constraint if exists tourney_mirror_outbox_record_hash_check,
  add constraint tourney_mirror_outbox_status_check
    check (status in ('pending', 'processing', 'retry', 'applied', 'dead_letter')) not valid,
  add constraint tourney_mirror_outbox_max_attempts_check
    check (max_attempts between 1 and 100) not valid,
  add constraint tourney_mirror_outbox_record_hash_check
    check (record_hash is null or record_hash ~ '^[0-9a-f]{64}$') not valid;
alter table tourney_mirror_outbox
  validate constraint tourney_mirror_outbox_status_check,
  validate constraint tourney_mirror_outbox_max_attempts_check,
  validate constraint tourney_mirror_outbox_record_hash_check;
drop index if exists tourney_mirror_outbox_pending_idx;
create index if not exists tourney_mirror_outbox_claim_v4_idx
  on tourney_mirror_outbox (available_at, generation desc, sequence)
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_mirror_outbox_dead_letter_v4_idx
  on tourney_mirror_outbox (dead_lettered_at desc, sequence)
  where status = 'dead_letter';
create index if not exists tourney_mirror_outbox_expired_lease_v4_idx
  on tourney_mirror_outbox (lease_expires_at, generation, sequence)
  where status = 'processing';

create table if not exists tourney_account_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  version bigint not null unique check (version > 0),
  accounts_json jsonb not null,
  canonical_hash text not null check (canonical_hash ~ '^[0-9a-f]{64}$'),
  generation integer not null default 1 check (generation >= 0),
  created_at timestamptz not null default now(),
  created_by text not null,
  supersedes_snapshot_id uuid references tourney_account_snapshots(snapshot_id),
  check (jsonb_typeof(accounts_json) in ('array', 'object'))
);

create table if not exists tourney_external_operations (
  operation_key text primary key,
  command_id text references tourney_command_receipts(command_id) on delete restrict,
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
  check ((status = 'processing' and lease_id is not null and lease_expires_at is not null) or status <> 'processing'),
  check ((status = 'applied' and completed_at is not null) or status <> 'applied')
);
alter table tourney_external_operations
  add column if not exists serialization_key text;
alter table tourney_external_operations
  drop constraint if exists tourney_external_operations_operation_kind_check;
alter table tourney_external_operations
  add constraint tourney_external_operations_operation_kind_check check (
    operation_kind in (
      'supabase_player_auth', 'supabase_admin_auth', 'sanity_account_projection',
      'discord_membership', 'discord_role_reconcile', 'supabase_identity_unlink'
    )
  ) not valid;
alter table tourney_external_operations
  validate constraint tourney_external_operations_operation_kind_check;
create or replace function set_tourney_external_operation_serialization_key()
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
drop trigger if exists set_tourney_external_operation_serialization_key
  on tourney_external_operations;
create trigger set_tourney_external_operation_serialization_key
before insert or update of operation_kind, entity_type, entity_id,
  desired_state, serialization_key
on tourney_external_operations
for each row execute function set_tourney_external_operation_serialization_key();
revoke all on function set_tourney_external_operation_serialization_key()
  from public;
update tourney_external_operations set serialization_key = case
  when operation_kind in ('discord_membership','discord_role_reconcile') then
    'discord:' || coalesce(
      desired_state#>>'{assignment,principalId}',
      desired_state#>>'{oauthProjection,principalId}',
      desired_state#>>'{oauthProjection,userId}',
      entity_id
    )
  when operation_kind = 'sanity_account_projection' then
    'sanity:account-snapshot'
  else operation_kind || ':' || entity_type || ':' || entity_id
end
where serialization_key is null or btrim(serialization_key) = '';
alter table tourney_external_operations
  alter column serialization_key set not null;
create index if not exists tourney_external_operations_claim_v4_idx
  on tourney_external_operations (next_attempt_at, created_at, operation_key)
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_external_operations_serial_v4_idx
  on tourney_external_operations (
    serialization_key, status, next_attempt_at, created_at, operation_key
  )
  where status in ('pending', 'retry', 'processing');
create index if not exists tourney_external_operations_command_v4_idx
  on tourney_external_operations (command_id, status, created_at);
create index if not exists tourney_external_operations_expired_lease_v4_idx
  on tourney_external_operations (lease_expires_at, operation_key)
  where status = 'processing';

create table if not exists tourney_discord_role_assignments (
  principal_id uuid primary key,
  user_id uuid,
  player_id text,
  discord_user_id text not null unique,
  previous_discord_user_id text,
  stale_discord_user_ids text[] not null default '{}'::text[],
  guild_id text not null,
  tourney_role text,
  desired_role text not null default 'none' check (desired_role in ('none','participant','host')),
  applied_role text not null default 'none' check (applied_role in ('none','participant','host')),
  generation bigint not null default 1 check (generation > 0),
  applied_generation bigint not null default 0 check (applied_generation >= 0),
  status text not null default 'pending' check (status in (
    'pending','processing','applied','retry','blocked','blocked_reauth','dead_letter'
  )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 12 check (max_attempts between 1 and 100),
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  blocked_at timestamptz,
  joined_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  pending_since timestamptz
);
alter table tourney_discord_role_assignments
  add column if not exists pending_since timestamptz;
update tourney_discord_role_assignments
set pending_since=coalesce(pending_since,updated_at,created_at,now())
where status in ('pending','processing','retry');
create index if not exists tourney_discord_assignments_claim_v4_idx
  on tourney_discord_role_assignments (status, updated_at, principal_id)
  where status in ('pending','retry','processing');
create index if not exists tourney_discord_assignments_pending_age_v4_idx
  on tourney_discord_role_assignments (pending_since,principal_id)
  where status in ('pending','retry','processing');

create or replace function set_tourney_discord_assignment_pending_since()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('roo.tourney_mirror_apply',true)='1' then return new; end if;
  if new.status in ('pending','processing','retry') then
    if tg_op='INSERT'
       or old.status not in ('pending','processing','retry')
       or old.generation is distinct from new.generation
       or old.discord_user_id is distinct from new.discord_user_id
       or old.guild_id is distinct from new.guild_id
       or old.desired_role is distinct from new.desired_role then
      new.pending_since:=now();
    else
      new.pending_since:=coalesce(old.pending_since,old.updated_at,old.created_at,now());
    end if;
  else new.pending_since:=null;
  end if;
  return new;
end;
$$;
drop trigger if exists set_tourney_discord_assignment_pending_since
  on tourney_discord_role_assignments;
create trigger set_tourney_discord_assignment_pending_since
before insert or update on tourney_discord_role_assignments
for each row execute function set_tourney_discord_assignment_pending_since();
revoke all on function set_tourney_discord_assignment_pending_since() from public;

create table if not exists tourney_import_quarantine (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  logical_table text not null,
  collision_kind text not null,
  record_key jsonb not null,
  safe_details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tourney_cutover_gate_events (
  id bigint generated always as identity primary key,
  event_kind text not null,
  generation integer not null check (generation >= 0),
  actor text not null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists tourney_cutover_control_operations (
  operation_kind text not null
    check (operation_kind in ('pause', 'resume')),
  operation_id text not null
    check (operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'),
  primary_backend text not null
    check (primary_backend in ('legacy', 'supabase')),
  generation integer not null check (generation between 0 and 100),
  target_writes_paused boolean not null,
  actor text not null check (
    actor = pg_catalog.btrim(actor)
    and pg_catalog.char_length(actor) between 3 and 200
    and actor !~ '[[:cntrl:]]'
  ),
  applied_at timestamptz not null default pg_catalog.now(),
  primary key (operation_kind, operation_id),
  check (target_writes_paused = (operation_kind = 'pause'))
);

create or replace function guard_tourney_cutover_control_operation_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('roo.tourney_cutover_compensation', true) = '1' then
    return old;
  end if;
  raise exception 'Tourney cutover control operations are append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists guard_tourney_cutover_control_operation_append_only
  on tourney_cutover_control_operations;
create trigger guard_tourney_cutover_control_operation_append_only
before update or delete on tourney_cutover_control_operations
for each row execute function guard_tourney_cutover_control_operation_append_only();
revoke all on table tourney_cutover_control_operations from public;
revoke all on function guard_tourney_cutover_control_operation_append_only()
  from public;

alter table tourney_cutover_metadata
  add column if not exists hardened_active boolean not null default false,
  add column if not exists reconciliation_lease_id uuid,
  add column if not exists reconciliation_lease_expires_at timestamptz,
  add column if not exists reconciliation_heartbeat_at timestamptz,
  add column if not exists last_pause_operation_id text,
  add column if not exists last_resume_operation_id text,
  add column if not exists natural_mutation_verified_at timestamptz,
  add column if not exists first_zero_drift_at timestamptz,
  add column if not exists second_zero_drift_at timestamptz,
  add column if not exists clock_last_evaluated_at timestamptz,
  add column if not exists clock_last_reset_reason text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.tourney_cutover_metadata'::pg_catalog.regclass
      and conname = 'tourney_cutover_metadata_last_pause_operation_id_check'
  ) then
    alter table public.tourney_cutover_metadata
      add constraint tourney_cutover_metadata_last_pause_operation_id_check check (
        last_pause_operation_id is null or (
          last_pause_operation_id = pg_catalog.btrim(last_pause_operation_id)
          and pg_catalog.char_length(last_pause_operation_id) between 8 and 128
          and last_pause_operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'
        )
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.tourney_cutover_metadata'::pg_catalog.regclass
      and conname = 'tourney_cutover_metadata_last_resume_operation_id_check'
  ) then
    alter table public.tourney_cutover_metadata
      add constraint tourney_cutover_metadata_last_resume_operation_id_check check (
        last_resume_operation_id is null or (
          last_resume_operation_id = pg_catalog.btrim(last_resume_operation_id)
          and pg_catalog.char_length(last_resume_operation_id) between 8 and 128
          and last_resume_operation_id ~ '^[a-z0-9][a-z0-9:_-]{7,127}$'
        )
      ) not valid;
  end if;
end;
$$;
alter table public.tourney_cutover_metadata
  validate constraint tourney_cutover_metadata_last_pause_operation_id_check;
alter table public.tourney_cutover_metadata
  validate constraint tourney_cutover_metadata_last_resume_operation_id_check;
alter table tourney_parity_runs
  add column if not exists status_counts jsonb not null default '{}'::jsonb,
  add column if not exists canonical_hashes jsonb not null default '{}'::jsonb,
  add column if not exists shadow_results jsonb not null default '{}'::jsonb;
alter table tourney_shadow_observations
  add column if not exists primary_status integer,
  add column if not exists shadow_status integer,
  add column if not exists primary_error_code text,
  add column if not exists shadow_error_code text,
  add column if not exists primary_hash text,
  add column if not exists shadow_hash text;
create table if not exists tourney_shadow_latency_baselines (
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
revoke all on table tourney_shadow_latency_baselines from public;

alter table tourney_email_dispatches drop constraint if exists tourney_email_dispatches_status_check;
alter table tourney_email_dispatches
  add column if not exists audited_override_at timestamptz,
  add column if not exists audited_override_by text,
  add column if not exists audited_override_reason text,
  add constraint tourney_email_dispatches_status_check check (status in (
    'pending','sending','retry','sent','failed','dead_letter','historical_unknown','expired'
  )) not valid;
alter table tourney_email_dispatches validate constraint tourney_email_dispatches_status_check;
create index if not exists tourney_email_dispatches_expired_lease_v4_idx
  on tourney_email_dispatches (lease_expires_at, created_at)
  where status = 'sending';

create or replace function guard_tourney_email_dispatch_terminal_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then
    raise exception 'A sent Tourney email dispatch cannot regress' using errcode = '23514';
  end if;
  if old.status = 'expired' and new.status <> 'expired' then
    raise exception 'An expired Tourney email dispatch cannot become sendable' using errcode = '23514';
  end if;
  if old.status = 'historical_unknown' and new.status in ('pending','sending','retry')
     and (new.audited_override_at is null
       or nullif(btrim(new.audited_override_by), '') is null
       or nullif(btrim(new.audited_override_reason), '') is null) then
    raise exception 'Historical Tourney email requires an audited override' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_tourney_email_dispatch_terminal_state on tourney_email_dispatches;
create trigger guard_tourney_email_dispatch_terminal_state
before update on tourney_email_dispatches for each row
execute function guard_tourney_email_dispatch_terminal_state();

do $$
declare v_row record; v_allowed text[];
begin
  for v_row in select * from (values
    ('tourney_players','tourney.tourney_players','tourney_players',array['id']::text[]),
    ('tourney_player_tokens','tourney.tourney_player_tokens','tourney_player_tokens',array['id']::text[]),
    ('tourney_registration_config','tourney.tourney_registration_config','tourney_registration_config',array['id']::text[]),
    ('tourney_bracket_teams','tourney.tourney_bracket_teams','tourney_bracket_teams',array['id']::text[]),
    ('tourney_bracket_team_members','tourney.tourney_bracket_team_members','tourney_bracket_team_members',array['id']::text[]),
    ('tourney_bracket_meta','tourney.tourney_bracket_meta','tourney_bracket_meta',array['id']::text[]),
    ('tourney_bracket_entities','tourney.tourney_bracket_entities','tourney_bracket_entities',array['entity_type','entity_id']::text[]),
    ('tourney_bracket_counters','tourney.tourney_bracket_counters','tourney_bracket_counters',array['entity_type']::text[]),
    ('tourney_bracket_audit','tourney.tourney_bracket_audit','tourney_bracket_audit',array['id']::text[]),
    ('tourney_bracket_lock','tourney.tourney_bracket_lock','tourney_bracket_lock',array['id']::text[]),
    ('tourney_appeals','tourney.tourney_appeals','tourney_appeals',array['id']::text[]),
    ('tourney_payouts','tourney.tourney_payouts','tourney_payouts',array['id']::text[]),
    ('email_dispatches','tourney.email_dispatches','tourney_email_dispatches',array['id']::text[]),
    ('command_receipts','tourney.command_receipts','tourney_command_receipts',array['command_id']::text[]),
    ('account_snapshots','tourney.account_snapshots','tourney_account_snapshots',array['snapshot_id']::text[]),
    ('external_operations','tourney.external_operations','tourney_external_operations',array['operation_key']::text[]),
    ('discord_role_assignments','accounts.discord_role_assignments','tourney_discord_role_assignments',array['principal_id']::text[])
  ) contract(logical_table,supabase_relation,legacy_relation,key_columns)
  loop
    select array_agg(attname order by attnum) into v_allowed
    from pg_attribute where attrelid = v_row.legacy_relation::regclass
      and attnum > 0 and not attisdropped;
    insert into tourney_mirror_contracts (
      logical_table,supabase_relation,legacy_relation,key_columns,allowed_columns,enabled,updated_at
    ) values (
      v_row.logical_table,v_row.supabase_relation,v_row.legacy_relation,
      v_row.key_columns,v_allowed,true,now()
    ) on conflict (logical_table) do update set
      supabase_relation=excluded.supabase_relation,
      legacy_relation=excluded.legacy_relation,
      key_columns=excluded.key_columns,
      allowed_columns=excluded.allowed_columns,
      enabled=true,updated_at=now();
  end loop;
end;
$$;
