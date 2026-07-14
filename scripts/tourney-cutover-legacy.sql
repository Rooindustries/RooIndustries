create table if not exists tourney_command_receipts (
  command_id text primary key,
  purpose text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  result_status integer,
  result_body jsonb,
  generation integer not null default 0 check (generation >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists tourney_mirror_outbox (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  command_id text,
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  generation integer not null default 0 check (generation >= 0),
  table_name text not null,
  operation text not null check (operation in ('upsert', 'delete')),
  record_key jsonb not null,
  record_data jsonb,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  applied_at timestamptz,
  last_error_code text,
  last_error_at timestamptz
);

create index if not exists tourney_mirror_outbox_pending_idx
  on tourney_mirror_outbox (available_at, sequence)
  where applied_at is null;

create table if not exists tourney_mirror_checkpoints (
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  table_name text not null,
  record_key_hash text not null check (record_key_hash ~ '^[0-9a-f]{64}$'),
  source_sequence bigint not null,
  event_id uuid not null,
  generation integer not null default 0,
  applied_at timestamptz not null default now(),
  primary key (target_backend, table_name, record_key_hash)
);

create table if not exists tourney_mirror_tombstones (
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  table_name text not null,
  record_key_hash text not null check (record_key_hash ~ '^[0-9a-f]{64}$'),
  record_key jsonb not null,
  source_sequence bigint not null,
  generation integer not null default 0,
  deleted_at timestamptz not null default now(),
  primary key (target_backend, table_name, record_key_hash)
);

create table if not exists tourney_parity_runs (
  id uuid primary key default gen_random_uuid(),
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  generation integer not null default 0,
  status text not null check (status in ('clean', 'drift', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  drift jsonb not null default '{}'::jsonb,
  relationships jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tourney_parity_runs_created_idx
  on tourney_parity_runs (created_at desc);

create table if not exists tourney_cutover_metadata (
  id text primary key default 'tourney' check (id = 'tourney'),
  primary_backend text not null default 'legacy'
    check (primary_backend in ('legacy', 'supabase')),
  generation integer not null default 0 check (generation >= 0),
  writes_paused boolean not null default false,
  fallback_read_only boolean not null default false,
  clean_since timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into tourney_cutover_metadata (id)
values ('tourney') on conflict (id) do nothing;

create table if not exists tourney_email_dispatches (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  command_id text,
  dispatch_kind text not null check (dispatch_kind in (
    'registration', 'approval', 'reset', 'discord_invite', 'appeal', 'payout'
  )),
  recipient text not null,
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'retry', 'sent', 'failed', 'historical_unknown')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tourney_email_dispatches_recovery_idx
  on tourney_email_dispatches (next_attempt_at, created_at)
  where status in ('pending', 'retry', 'sending');

create table if not exists tourney_identity_conflicts (
  id uuid primary key default gen_random_uuid(),
  legacy_player_id text,
  principal_id uuid,
  conflict_type text not null,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tourney_shadow_observations (
  id bigint generated always as identity primary key,
  route text not null,
  shape_match boolean not null,
  value_match boolean not null,
  ordering_match boolean not null,
  error_match boolean not null,
  primary_latency_ms integer not null default 0,
  shadow_latency_ms integer not null default 0,
  observed_at timestamptz not null default now()
);

create index if not exists tourney_shadow_observations_route_idx
  on tourney_shadow_observations (route, observed_at desc);

create or replace function capture_tourney_mirror_event()
returns trigger
language plpgsql
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_enabled boolean := coalesce(nullif(current_setting('roo.tourney_mirror_enabled', true), ''), '0') in ('1', 'true', 'on');
  v_generation integer := coalesce(nullif(current_setting('roo.tourney_generation', true), ''), '0')::integer;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
  v_key jsonb;
begin
  if not v_enabled or current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_key := case tg_table_name
    when 'tourney_bracket_entities' then jsonb_build_object(
      'entity_type', v_row->>'entity_type', 'entity_id', v_row->>'entity_id'
    )
    when 'tourney_bracket_counters' then jsonb_build_object(
      'entity_type', v_row->>'entity_type'
    )
    else jsonb_build_object('id', v_row->>'id')
  end;
  insert into tourney_mirror_outbox (
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data
  ) values (
    v_command_id, 'legacy', v_generation,
    case when tg_table_name = 'tourney_email_dispatches' then 'email_dispatches' else tg_table_name end,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, case when tg_op = 'DELETE' then null else v_row end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists capture_tourney_mirror_event on tourney_email_dispatches;
create trigger capture_tourney_mirror_event
after insert or update or delete on tourney_email_dispatches
for each row execute function capture_tourney_mirror_event();

do $$
declare v_name text;
begin
  foreach v_name in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    if to_regclass(v_name) is not null then
      execute format('drop trigger if exists capture_tourney_mirror_event on %I', v_name);
      execute format(
        'create trigger capture_tourney_mirror_event after insert or update or delete on %I for each row execute function capture_tourney_mirror_event()',
        v_name
      );
    end if;
  end loop;
end;
$$;
