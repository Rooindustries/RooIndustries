-- Forward repair for already-activated legacy Neon schema-v4 databases.
-- Apply while both Tourney databases remain paused at Supabase generation 1.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists tourney_parity_lookup_v4_idx
  on public.tourney_parity_runs(source_backend,target_backend,generation,created_at desc);
create index if not exists tourney_receipts_committed_age_v4_idx
  on public.tourney_command_receipts(committed_at,command_id) where status='committed';
create index if not exists tourney_receipts_failed_age_v4_idx
  on public.tourney_command_receipts(failed_at,command_id) where status='failed';
create index if not exists tourney_identity_conflicts_open_v4_idx
  on public.tourney_identity_conflicts(created_at,id) where resolved_at is null;
create index if not exists tourney_import_quarantine_open_v4_idx
  on public.tourney_import_quarantine(created_at,id) where resolved_at is null;
create index if not exists tourney_mirror_active_age_v4_idx
  on public.tourney_mirror_outbox(occurred_at,sequence)
  where status in ('pending','processing','retry');
create index if not exists tourney_external_active_age_v4_idx
  on public.tourney_external_operations(created_at,operation_key)
  where status in ('pending','processing','retry');
create index if not exists tourney_email_active_age_v4_idx
  on public.tourney_email_dispatches(created_at,id)
  where status in ('pending','sending','retry');
create index if not exists tourney_gate_event_generation_v4_idx
  on public.tourney_cutover_gate_events(event_kind,generation,created_at desc);
alter table public.tourney_shadow_latency_baselines
  add column if not exists source_window_started_at timestamptz,
  add column if not exists source_window_ended_at timestamptz;

alter table public.tourney_command_receipts
  add column if not exists failure_code text,
  add column if not exists failure_evidence jsonb not null default '{}'::jsonb,
  add column if not exists recovered_at timestamptz,
  add column if not exists recovery_evidence jsonb not null default '{}'::jsonb;

alter table public.tourney_email_dispatches
  drop constraint if exists tourney_email_dispatches_status_check;
alter table public.tourney_email_dispatches
  add constraint tourney_email_dispatches_status_check check (status in (
    'pending','sending','retry','sent','failed','dead_letter',
    'historical_unknown','expired'
  )) not valid;
alter table public.tourney_email_dispatches
  validate constraint tourney_email_dispatches_status_check;

update public.tourney_player_tokens token
set recipient_version = player.version::text
from public.tourney_players player
where token.player_id = player.id and token.purpose = 'reset'
  and nullif(pg_catalog.btrim(token.recipient_version), '') is null;
alter table public.tourney_player_tokens
  drop constraint if exists tourney_reset_token_version_v4_check;
alter table public.tourney_player_tokens
  add constraint tourney_reset_token_version_v4_check check (
    purpose <> 'reset' or nullif(pg_catalog.btrim(recipient_version), '') is not null
  ) not valid;
alter table public.tourney_player_tokens
  validate constraint tourney_reset_token_version_v4_check;

create or replace function public.guard_tourney_email_dispatch_terminal_state()
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
       or nullif(pg_catalog.btrim(new.audited_override_by), '') is null
       or nullif(pg_catalog.btrim(new.audited_override_reason), '') is null) then
    raise exception 'Historical Tourney email requires an audited override' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_tourney_email_dispatch_terminal_state
  on public.tourney_email_dispatches;
create trigger guard_tourney_email_dispatch_terminal_state
before update on public.tourney_email_dispatches for each row
execute function public.guard_tourney_email_dispatch_terminal_state();
revoke all on function public.guard_tourney_email_dispatch_terminal_state()
  from public;

alter table public.tourney_external_operations
  drop constraint if exists tourney_external_operations_operation_kind_check;
alter table public.tourney_external_operations
  add constraint tourney_external_operations_operation_kind_check check (
    operation_kind in (
      'supabase_player_auth', 'supabase_admin_auth', 'sanity_account_projection',
      'discord_membership', 'discord_role_reconcile', 'supabase_identity_unlink'
    )
  ) not valid;
alter table public.tourney_external_operations
  validate constraint tourney_external_operations_operation_kind_check;

alter table public.tourney_cutover_metadata
  add column if not exists reconciliation_lease_id uuid,
  add column if not exists reconciliation_lease_expires_at timestamptz,
  add column if not exists reconciliation_heartbeat_at timestamptz;

alter table public.tourney_discord_role_assignments
  add column if not exists stale_discord_user_ids text[] not null default '{}'::text[],
  add column if not exists pending_since timestamptz;
update public.tourney_discord_role_assignments
set pending_since=coalesce(pending_since,updated_at,created_at,now())
where status in ('pending','processing','retry');
create index if not exists tourney_discord_assignments_pending_age_v4_idx
  on public.tourney_discord_role_assignments(pending_since,principal_id)
  where status in ('pending','processing','retry');
create or replace function public.set_tourney_discord_assignment_pending_since()
returns trigger language plpgsql set search_path='' as $$
begin
  if current_setting('roo.tourney_mirror_apply',true)='1' then return new; end if;
  if new.status in ('pending','processing','retry') then
    if tg_op='INSERT' or old.status not in ('pending','processing','retry')
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
  on public.tourney_discord_role_assignments;
create trigger set_tourney_discord_assignment_pending_since
before insert or update on public.tourney_discord_role_assignments
for each row execute function public.set_tourney_discord_assignment_pending_since();
revoke all on function public.set_tourney_discord_assignment_pending_since()
  from public;

alter table public.tourney_external_operations
  add column if not exists serialization_key text;
create or replace function public.set_tourney_external_operation_serialization_key()
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
  on public.tourney_external_operations;
create trigger set_tourney_external_operation_serialization_key
before insert or update of operation_kind, entity_type, entity_id,
  desired_state, serialization_key
on public.tourney_external_operations
for each row execute function public.set_tourney_external_operation_serialization_key();
revoke all on function public.set_tourney_external_operation_serialization_key()
  from public;
update public.tourney_external_operations set serialization_key = case
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
alter table public.tourney_external_operations
  alter column serialization_key set not null;
update public.tourney_mirror_contracts
set allowed_columns = (
      select pg_catalog.array_agg(attribute.attname order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'public.tourney_external_operations'::pg_catalog.regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
    updated_at = pg_catalog.now()
where logical_table = 'external_operations';
update public.tourney_mirror_contracts
set allowed_columns = (
      select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'public.tourney_command_receipts'::pg_catalog.regclass
        and attribute.attnum > 0 and not attribute.attisdropped
    ), updated_at = pg_catalog.now()
where logical_table = 'command_receipts';
update public.tourney_mirror_contracts
set allowed_columns=(
      select pg_catalog.array_agg(attribute.attname order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid='public.tourney_discord_role_assignments'::pg_catalog.regclass
        and attribute.attnum>0 and not attribute.attisdropped
    ),updated_at=pg_catalog.now()
where logical_table='discord_role_assignments';
create index if not exists tourney_external_operations_serial_v4_idx
  on public.tourney_external_operations (
    serialization_key, status, next_attempt_at, created_at, operation_key
  )
  where status in ('pending','retry','processing');

do $$
declare
  v_primary_backend text;
  v_generation integer;
  v_writes_paused boolean;
  v_fallback_read_only boolean;
  v_schema_version integer;
begin
  select primary_backend, generation, writes_paused, fallback_read_only
  into v_primary_backend, v_generation, v_writes_paused, v_fallback_read_only
  from public.tourney_cutover_metadata
  where id = 'tourney'
  for share;
  select schema_version into v_schema_version
  from public.tourney_schema_metadata
  where schema_name = 'tourney';
  if v_primary_backend is null
     or v_primary_backend <> 'supabase'
     or v_generation <> 1
     or not v_writes_paused
     or v_fallback_read_only
     or coalesce(v_schema_version, 0) < 4
     or to_regclass('public.tourney_mirror_contracts') is null
     or to_regprocedure('public.tourney_mirror_record_key(text,jsonb)') is null
     or to_regprocedure('public.digest(bytea,text)') is null then
    raise exception 'Legacy Tourney repair safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.capture_tourney_mirror_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
  v_meta public.tourney_cutover_metadata%rowtype;
  v_logical_table text;
  v_key jsonb;
  v_data jsonb := case when tg_op = 'DELETE' then null else v_row end;
  v_hash text;
begin
  if current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select * into v_meta from public.tourney_cutover_metadata
  where id = 'tourney' for share;
  if v_meta.id is null or not v_meta.hardened_active
     or v_meta.primary_backend <> 'legacy' or v_meta.generation < 1 then
    raise exception 'Tourney mirror source authority is invalid'
      using errcode = '55000';
  end if;
  if v_command_id is null or pg_catalog.length(v_command_id) not between 3 and 512
     or v_command_id ~ '[[:cntrl:]]' then
    raise exception 'Tourney mirror command context is required'
      using errcode = '22023';
  end if;
  select logical_table into v_logical_table
  from public.tourney_mirror_contracts
  where legacy_relation = tg_table_name and enabled;
  if v_logical_table is null then
    raise exception 'Tourney mirror relation is not registered' using errcode = '22023';
  end if;
  v_key := public.tourney_mirror_record_key(v_logical_table, v_row);
  v_hash := case when v_data is null then null else
    pg_catalog.encode(
      public.digest(pg_catalog.convert_to(v_data::text, 'UTF8'), 'sha256'),
      'hex'
    )
  end;
  insert into public.tourney_mirror_outbox (
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data, record_hash, status
  ) values (
    v_command_id, 'legacy', v_meta.generation, v_logical_table,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, v_data, v_hash, 'pending'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.tourney_guard_payout_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('paid','void') and new.status is distinct from old.status then
    raise exception 'Paid and void Tourney payouts are terminal'
      using errcode = '23514';
  end if;
  if old.status = 'ready' and new.status not in ('ready','paid','void') then
    raise exception 'Ready Tourney payouts cannot regress'
      using errcode = '23514';
  end if;
  if old.status in ('ready','paid','void') and (
    new.player_id is distinct from old.player_id
    or new.payout_type is distinct from old.payout_type
    or new.amount_usd is distinct from old.amount_usd
    or new.payout_email is distinct from old.payout_email
  ) then
    raise exception 'Tourney payout financial details are locked'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_tourney_payout_transition
  on public.tourney_payouts;
create trigger guard_tourney_payout_transition
before update on public.tourney_payouts
for each row execute function public.tourney_guard_payout_transition();
revoke all on function public.tourney_guard_payout_transition() from public;
