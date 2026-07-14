-- Additive forward repairs for Tourney schema-v4 cutover safety. Runtime
-- activation remains gated by public.roo_activate_tourney_schema_v4(text).
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists tourney_parity_lookup_v4_idx
  on tourney.parity_runs(source_backend,target_backend,generation,created_at desc);
create index if not exists tourney_receipts_committed_age_v4_idx
  on tourney.command_receipts(committed_at,command_id) where status='committed';
create index if not exists tourney_receipts_failed_age_v4_idx
  on tourney.command_receipts(failed_at,command_id) where status='failed';
create index if not exists tourney_identity_conflicts_open_v4_idx
  on tourney.identity_conflicts(created_at,id) where resolved_at is null;
create index if not exists tourney_mirror_active_age_v4_idx
  on tourney.mirror_outbox(occurred_at,sequence)
  where status in ('pending','processing','retry');
create index if not exists tourney_external_active_age_v4_idx
  on tourney.external_operations(created_at,operation_key)
  where status in ('pending','processing','retry');
create index if not exists tourney_auth_active_age_v4_idx
  on tourney.tourney_player_auth_operations(created_at,id)
  where operation_status in ('pending','processing','auth_applied','retry');
create index if not exists tourney_email_active_age_v4_idx
  on tourney.email_dispatches(created_at,id)
  where status in ('pending','sending','retry');
create index if not exists tourney_gate_event_generation_v4_idx
  on tourney.cutover_gate_events(event_kind,generation,created_at desc);

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

alter table tourney.shadow_latency_baselines
  add column if not exists source_window_started_at timestamptz,
  add column if not exists source_window_ended_at timestamptz;

alter table tourney.command_receipts
  add column if not exists failure_code text,
  add column if not exists failure_evidence jsonb not null default '{}'::jsonb,
  add column if not exists recovered_at timestamptz,
  add column if not exists recovery_evidence jsonb not null default '{}'::jsonb;

alter table tourney.email_dispatches
  drop constraint if exists email_dispatches_status_check;
alter table tourney.email_dispatches
  add constraint email_dispatches_status_check check (status in (
    'pending','sending','retry','sent','failed','dead_letter',
    'historical_unknown','expired'
  )) not valid;
alter table tourney.email_dispatches
  validate constraint email_dispatches_status_check;

update tourney.tourney_player_tokens token
set recipient_version = player.version::text
from tourney.tourney_players player
where token.player_id = player.id and token.purpose = 'reset'
  and nullif(pg_catalog.btrim(token.recipient_version), '') is null;
alter table tourney.tourney_player_tokens
  drop constraint if exists tourney_reset_token_version_v4_check;
alter table tourney.tourney_player_tokens
  add constraint tourney_reset_token_version_v4_check check (
    purpose <> 'reset' or nullif(pg_catalog.btrim(recipient_version), '') is not null
  ) not valid;
alter table tourney.tourney_player_tokens
  validate constraint tourney_reset_token_version_v4_check;

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
     and new.status in ('pending','sending','retry')
     and (new.audited_override_at is null
       or nullif(pg_catalog.btrim(new.audited_override_by), '') is null
       or nullif(pg_catalog.btrim(new.audited_override_reason), '') is null) then
    raise exception 'Historical Tourney email requires an audited override' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_email_dispatch_terminal_state
  on tourney.email_dispatches;
create trigger guard_email_dispatch_terminal_state
before update on tourney.email_dispatches
for each row execute function tourney.guard_email_dispatch_terminal_state();
revoke all on function tourney.guard_email_dispatch_terminal_state()
  from public,anon,authenticated;

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

create or replace function public.roo_resolve_tourney_import_principal(
  p_legacy_player_id text,
  p_username text,
  p_login_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principals uuid[];
  v_principal uuid;
  v_auth_user uuid;
  v_conflict_id uuid;
begin
  if nullif(pg_catalog.btrim(p_legacy_player_id), '') is null
     or nullif(pg_catalog.btrim(p_username), '') is null
     or nullif(pg_catalog.btrim(p_login_email), '') is null then
    raise exception 'Complete Tourney identity input is required'
      using errcode = '22023';
  end if;
  select pg_catalog.array_agg(distinct candidate.principal_id)
  into v_principals
  from (
    select account.principal_id
    from accounts.tourney_accounts account
    where account.legacy_sanity_id = pg_catalog.btrim(p_legacy_player_id)
       or account.username = pg_catalog.lower(pg_catalog.btrim(p_username))
    union
    select account.principal_id
    from accounts.login_aliases alias
    join accounts.tourney_accounts account
      on account.principal_id = alias.principal_id
    where alias.alias_type in ('tourney_email', 'email')
      and alias.normalized_value = pg_catalog.lower(pg_catalog.btrim(p_login_email))
      and account.legacy_sanity_id = pg_catalog.btrim(p_legacy_player_id)
  ) candidate;
  if coalesce(pg_catalog.array_length(v_principals, 1), 0) > 1 then
    insert into tourney.identity_conflicts(
      legacy_player_id, conflict_type, details
    ) values(
      pg_catalog.btrim(p_legacy_player_id), 'principal_collision',
      pg_catalog.jsonb_build_object(
        'candidate_count', pg_catalog.array_length(v_principals, 1)
      )
    ) returning id into v_conflict_id;
    return pg_catalog.jsonb_build_object(
      'conflict', true, 'conflict_id', v_conflict_id
    );
  end if;
  v_principal := v_principals[1];
  if v_principal is not null then
    select mapping.user_id into v_auth_user
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_principal
    order by mapping.is_primary desc, mapping.linked_at, mapping.user_id
    limit 1;
  end if;
  return pg_catalog.jsonb_build_object(
    'conflict', false,
    'principal_id', v_principal,
    'auth_user_id', v_auth_user,
    'matched', v_principal is not null
  );
end;
$$;
revoke all on function public.roo_resolve_tourney_import_principal(text, text, text)
  from public, anon, authenticated;
grant execute on function public.roo_resolve_tourney_import_principal(text, text, text)
  to service_role;

-- Keep OAuth finalization identity-only. Discord desired state is written by
-- the durable Tourney command after this transaction commits.
do $$
begin
  if pg_catalog.to_regprocedure(
    'public.roo_finalize_oauth_intent_identity_impl(text,uuid,text,text,text)'
  ) is null and pg_catalog.to_regprocedure(
    'public.roo_finalize_oauth_intent(text,uuid,text,text,text)'
  ) is not null then
    alter function public.roo_finalize_oauth_intent(text,uuid,text,text,text)
      rename to roo_finalize_oauth_intent_identity_impl;
    revoke all on function public.roo_finalize_oauth_intent_identity_impl(
      text,uuid,text,text,text
    ) from public,anon,authenticated,service_role;
  end if;
end;
$$;

-- Preserve the old signature during rolling deployment, but ignore its guild
-- argument so old application instances cannot write mirrored Discord state.
create or replace function public.roo_finalize_oauth_intent(
  p_token_hash text,
  p_user_id uuid,
  p_provider text,
  p_guild_id text default null,
  p_reauth_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.roo_finalize_oauth_intent_identity_impl(
    p_token_hash,p_user_id,p_provider,null,p_reauth_token_hash
  );
  return v_result || pg_catalog.jsonb_build_object(
    'discord_role',pg_catalog.jsonb_build_object(
      'queued',false,'reason','durable_projection'
    )
  );
end;
$$;
revoke all on function public.roo_finalize_oauth_intent(text,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.roo_finalize_oauth_intent(text,uuid,text,text,text)
  to service_role;

create or replace function public.roo_finalize_oauth_intent_v2(
  p_token_hash text,
  p_user_id uuid,
  p_provider text,
  p_reauth_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.roo_finalize_oauth_intent(
    p_token_hash,
    p_user_id,
    p_provider,
    null,
    p_reauth_token_hash
  );
  return v_result || pg_catalog.jsonb_build_object(
    'discord_role',
    pg_catalog.jsonb_build_object(
      'queued', false,
      'reason', 'durable_projection'
    )
  );
end;
$$;
revoke all on function public.roo_finalize_oauth_intent_v2(text,uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.roo_finalize_oauth_intent_v2(text,uuid,text,text)
  to service_role;

create or replace function tourney.capture_mirror_event_v4()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
  v_meta tourney.cutover_metadata%rowtype;
  v_logical_table text;
  v_key jsonb;
  v_data jsonb := case when tg_op = 'DELETE' then null else v_row end;
  v_hash text;
begin
  if current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for share;
  if v_meta.id is null or not v_meta.hardened_active
     or v_meta.primary_backend <> 'supabase' or v_meta.generation < 1 then
    raise exception 'Tourney mirror source authority is invalid'
      using errcode = '55000';
  end if;
  if v_command_id is null or pg_catalog.length(v_command_id) not between 3 and 512
     or v_command_id ~ '[[:cntrl:]]' then
    raise exception 'Tourney mirror command context is required'
      using errcode = '22023';
  end if;
  select logical_table into v_logical_table
  from tourney.mirror_contracts
  where supabase_relation = tg_table_schema || '.' || tg_table_name and enabled;
  if v_logical_table is null then
    raise exception 'Tourney mirror relation is not registered' using errcode = '22023';
  end if;
  v_key := tourney.mirror_record_key(v_logical_table, v_row);
  v_hash := case when v_data is null then null else
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_data::text, 'UTF8'), 'sha256'),
      'hex'
    )
  end;
  insert into tourney.mirror_outbox(
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data, record_hash, status
  ) values(
    v_command_id, 'supabase', v_meta.generation, v_logical_table,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, v_data, v_hash, 'pending'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function tourney.capture_mirror_event_v4()
  from public, anon, authenticated;
grant execute on function tourney.capture_mirror_event_v4() to service_role;

-- Retire unsafe pre-v4 service entry points while retaining the v1 account
-- function as a private implementation detail used by the monotonic v2 RPC.
do $$
declare
  v_signature text;
  v_function regprocedure;
begin
  foreach v_signature in array array[
    'public.roo_import_tourney_snapshot(jsonb,text)',
    'public.roo_import_tourney_snapshot_incremental(jsonb,text)',
    'public.roo_import_tourney_player_account(jsonb)'
  ] loop
    v_function := pg_catalog.to_regprocedure(v_signature);
    if v_function is not null then
      execute 'revoke all on function ' || v_function::text ||
        ' from public,anon,authenticated,service_role';
    end if;
  end loop;
end;
$$;

alter table tourney.cutover_metadata
  add column if not exists reconciliation_lease_id uuid,
  add column if not exists reconciliation_lease_expires_at timestamptz,
  add column if not exists reconciliation_heartbeat_at timestamptz;

alter table accounts.discord_role_assignments
  add column if not exists stale_discord_user_ids text[] not null default '{}'::text[],
  add column if not exists pending_since timestamptz;
update accounts.discord_role_assignments
set pending_since=coalesce(pending_since,updated_at,created_at,now())
where status in ('pending','processing','retry');
create index if not exists discord_role_assignments_pending_age_v4_idx
  on accounts.discord_role_assignments(pending_since,principal_id)
  where status in ('pending','processing','retry');
create or replace function accounts.set_discord_assignment_pending_since()
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
drop trigger if exists set_discord_assignment_pending_since
  on accounts.discord_role_assignments;
create trigger set_discord_assignment_pending_since
before insert or update on accounts.discord_role_assignments
for each row execute function accounts.set_discord_assignment_pending_since();
revoke all on function accounts.set_discord_assignment_pending_since()
  from public,anon,authenticated;

alter table tourney.external_operations
  add column if not exists serialization_key text;
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
update tourney.external_operations set serialization_key = case
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
alter table tourney.external_operations
  alter column serialization_key set not null;
update tourney.mirror_contracts
set allowed_columns = (
      select pg_catalog.array_agg(attribute.attname order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'tourney.external_operations'::pg_catalog.regclass
        and attribute.attnum > 0
        and not attribute.attisdropped
    ),
    updated_at = pg_catalog.now()
where logical_table = 'external_operations';
update tourney.mirror_contracts
set allowed_columns = (
      select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'tourney.command_receipts'::pg_catalog.regclass
        and attribute.attnum > 0 and not attribute.attisdropped
    ), updated_at = pg_catalog.now()
where logical_table = 'command_receipts';
update tourney.mirror_contracts
set allowed_columns = (
      select pg_catalog.array_agg(attribute.attname order by attribute.attnum)
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = 'accounts.discord_role_assignments'::pg_catalog.regclass
        and attribute.attnum > 0 and not attribute.attisdropped
    ), updated_at=pg_catalog.now()
where logical_table='discord_role_assignments';
create index if not exists tourney_external_operations_serial_v4_idx
  on tourney.external_operations (
    serialization_key, status, next_attempt_at, created_at, operation_key
  )
  where status in ('pending','retry','processing');

create table if not exists migration.tourney_import_preflights (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  target_hash text not null check (target_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('preflight','quarantined','applied','failed')),
  collision_count integer not null default 0 check (collision_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
alter table migration.tourney_import_preflights
  add column if not exists allow_tombstones boolean not null default false;
create index if not exists tourney_import_preflights_source_v4_idx
  on migration.tourney_import_preflights (source_hash, started_at desc);
alter table migration.tourney_import_preflights enable row level security;
revoke all on table migration.tourney_import_preflights
  from public, anon, authenticated;
grant all on table migration.tourney_import_preflights to service_role;

create or replace function tourney.canonical_json(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(p_value)
    when 'object' then (
      select '{' || coalesce(pg_catalog.string_agg(
        pg_catalog.to_json(entry.key)::text || ':' || tourney.canonical_json(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}'
      from pg_catalog.jsonb_each(p_value) entry
    )
    when 'array' then (
      select '[' || coalesce(pg_catalog.string_agg(
        tourney.canonical_json(entry.value),
        ',' order by entry.ordinality
      ), '') || ']'
      from pg_catalog.jsonb_array_elements(p_value)
        with ordinality entry(value, ordinality)
    )
    else p_value::text
  end
$$;

create or replace function tourney.snapshot_managed_target_hash()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_rows jsonb;
  v_snapshot jsonb := '{}'::jsonb;
begin
  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(target_row) ' ||
      'order by to_jsonb(target_row)::text), ''[]''::jsonb) ' ||
      'from tourney.%I target_row',
      v_table
    ) into v_rows;
    v_snapshot := v_snapshot || jsonb_build_object(v_table, v_rows);
  end loop;
  return encode(extensions.digest(
    convert_to(tourney.canonical_json(v_snapshot), 'UTF8'),
    'sha256'
  ), 'hex');
end;
$$;

create or replace function public.roo_capture_tourney_shadow_latency_baseline(
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_route text;
  v_samples integer;
  v_p95 integer;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_captured integer := 0;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null or length(p_actor) > 120 then
    raise exception 'Tourney latency baseline actor is invalid' using errcode='22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id='tourney' for update;
  if v_meta.id is null
     or v_meta.hardened_active
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only then
    raise exception 'Tourney latency baseline controls are not ready'
      using errcode='55000';
  end if;
  foreach v_route in array array[
    'public_roster','public_bracket','admin_players','appeals','payouts'
  ] loop
    select count(*)::integer,
      percentile_cont(0.95) within group(order by sample.primary_latency_ms)::integer,
      min(sample.observed_at),max(sample.observed_at)
    into v_samples,v_p95,v_window_start,v_window_end
    from (
      select primary_latency_ms,observed_at
      from tourney.shadow_observations
      where route=v_route
        and shape_match and value_match and ordering_match and error_match
        and primary_status between 200 and 299
        and shadow_status between 200 and 299
      order by observed_at desc,id desc
      limit 30
    ) sample;
    if coalesce(v_samples,0) < 30 or v_p95 is null
       or v_window_end < now()-interval '7 minutes' then
      raise exception 'Tourney latency baseline requires 30 clean samples per route'
        using errcode='55000';
    end if;
    insert into tourney.shadow_latency_baselines(
      route,primary_p95_ms,sample_count,source_window_started_at,
      source_window_ended_at,captured_at,captured_by
    ) values(
      v_route,v_p95,v_samples,v_window_start,v_window_end,
      now(),pg_catalog.btrim(p_actor)
    )
    on conflict(route) do update set
      primary_p95_ms=excluded.primary_p95_ms,
      sample_count=excluded.sample_count,
      source_window_started_at=excluded.source_window_started_at,
      source_window_ended_at=excluded.source_window_ended_at,
      captured_at=excluded.captured_at,
      captured_by=excluded.captured_by;
    v_captured:=v_captured+1;
  end loop;
  return jsonb_build_object('captured',v_captured);
end;
$$;

create or replace function tourney.delete_snapshot_missing_rows(
  p_table_name text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table regclass;
  v_predicate text;
  v_count integer;
begin
  if not (p_table_name = any(array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ]::text[])) or coalesce(jsonb_typeof(p_rows), '') <> 'array' then
    raise exception 'Tourney snapshot delete input is invalid' using errcode = '22023';
  end if;

  v_table := format('tourney.%I', p_table_name)::regclass;
  select string_agg(
    format(
      'source_row.%1$I is not distinct from target_row.%1$I',
      attribute.attname
    ),
    ' and ' order by key_attribute.ordinality
  )
  into v_predicate
  from pg_catalog.pg_index primary_index
  join lateral unnest(primary_index.indkey) with ordinality
    key_attribute(attnum, ordinality) on true
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = primary_index.indrelid
   and attribute.attnum = key_attribute.attnum
  where primary_index.indrelid = v_table
    and primary_index.indisprimary;
  if v_predicate is null then
    raise exception 'Tourney snapshot table has no primary key' using errcode = '55000';
  end if;

  execute format(
    'delete from %1$s target_row where not exists (' ||
    'select 1 from jsonb_populate_recordset(null::%1$s, $1) source_row ' ||
    'where %2$s)',
    v_table,
    v_predicate
  ) using p_rows;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.roo_preflight_tourney_snapshot_v4(
  p_snapshot jsonb,
  p_source_hash text,
  p_allow_tombstones boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_table text;
  v_computed_source_hash text;
  v_target_hash text;
  v_preflight_id uuid;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$'
     or coalesce(pg_catalog.jsonb_typeof(p_snapshot), '') <> 'object' then
    raise exception 'Tourney snapshot input is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for share;
  if v_meta.id is null or v_meta.primary_backend <> 'legacy'
     or not v_meta.writes_paused or v_meta.generation <> 0
     or v_meta.fallback_read_only then
    raise exception 'Tourney snapshot preflight safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
  v_computed_source_hash := pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(tourney.canonical_json(p_snapshot), 'UTF8'),
    'sha256'
  ), 'hex');
  if v_computed_source_hash <> p_source_hash then
    raise exception 'Tourney snapshot source hash does not match its payload'
      using errcode = '22023';
  end if;
  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    if not (p_snapshot ? v_table)
       or pg_catalog.jsonb_typeof(p_snapshot->v_table) <> 'array' then
      raise exception 'Tourney reconciliation requires a complete snapshot'
        using errcode = '22023';
    end if;
  end loop;
  v_target_hash := tourney.snapshot_managed_target_hash();
  insert into migration.tourney_import_preflights(
    source_hash, target_hash, status, allow_tombstones
  ) values(
    p_source_hash, v_target_hash, 'preflight', p_allow_tombstones
  ) returning id into v_preflight_id;
  return pg_catalog.jsonb_build_object(
    'preflight_id', v_preflight_id,
    'source_hash', p_source_hash,
    'target_hash', v_target_hash,
    'allow_tombstones', p_allow_tombstones
  );
end;
$$;

drop function if exists public.roo_import_tourney_snapshot_v4(jsonb, text, boolean);
create function public.roo_import_tourney_snapshot_v4(
  p_snapshot jsonb,
  p_source_hash text,
  p_allow_tombstones boolean,
  p_preflight_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_collision_count integer := 0;
  v_table text;
  v_count integer;
  v_hash text;
  v_target_counts jsonb := '{}'::jsonb;
  v_target_hashes jsonb := '{}'::jsonb;
  v_source_hashes jsonb := '{}'::jsonb;
  v_source_table_hash text;
  v_deleted_counts jsonb := '{}'::jsonb;
  v_relationships jsonb;
  v_status_counts jsonb;
  v_contract record;
  v_computed_source_hash text;
  v_preflight migration.tourney_import_preflights%rowtype;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$'
     or coalesce(jsonb_typeof(p_snapshot), '') <> 'object' then
    raise exception 'Tourney snapshot input is invalid' using errcode = '22023';
  end if;
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  if v_meta.id is null
     or v_meta.primary_backend <> 'legacy'
     or not v_meta.writes_paused
     or v_meta.generation <> 0
     or v_meta.fallback_read_only then
    raise exception 'Tourney snapshot import safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
  v_computed_source_hash := encode(extensions.digest(
    convert_to(tourney.canonical_json(p_snapshot), 'UTF8'),
    'sha256'
  ), 'hex');
  if v_computed_source_hash <> p_source_hash then
    raise exception 'Tourney snapshot source hash does not match its payload'
      using errcode = '22023';
  end if;
  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    if not (p_snapshot ? v_table)
       or jsonb_typeof(p_snapshot->v_table) <> 'array' then
      raise exception 'Tourney reconciliation requires a complete snapshot'
        using errcode = '22023';
    end if;
  end loop;
  lock table
    tourney.tourney_players,
    tourney.tourney_player_tokens,
    tourney.tourney_registration_config,
    tourney.tourney_bracket_teams,
    tourney.tourney_bracket_team_members,
    tourney.tourney_bracket_meta,
    tourney.tourney_bracket_entities,
    tourney.tourney_bracket_counters,
    tourney.tourney_bracket_audit,
    tourney.tourney_bracket_lock,
    tourney.tourney_appeals,
    tourney.tourney_payouts,
    tourney.tourney_player_auth_operations
  in share row exclusive mode;
  if exists (
    select 1 from tourney.tourney_player_auth_operations
    where operation_status in ('pending','processing','auth_applied','retry')
  ) then
    raise exception 'Tourney snapshot import is blocked by an active Auth operation'
      using errcode = '55006';
  end if;
  select * into v_preflight
  from migration.tourney_import_preflights preflight
  where preflight.id = p_preflight_id
  for update;
  if v_preflight.id is null or v_preflight.status <> 'preflight'
     or v_preflight.source_hash <> p_source_hash
     or v_preflight.allow_tombstones is distinct from p_allow_tombstones then
    raise exception 'Tourney snapshot preflight token is invalid or already consumed'
      using errcode = '55000';
  end if;
  for v_contract in
    select logical_table, key_columns
    from tourney.mirror_contracts
    where logical_table = any(array[
      'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
      'tourney_bracket_teams', 'tourney_bracket_team_members',
      'tourney_bracket_meta', 'tourney_bracket_entities',
      'tourney_bracket_counters', 'tourney_bracket_audit',
      'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
    ])
  loop
    insert into migration.tourney_import_quarantine (
      source_hash, logical_table, collision_kind, record_key
    )
    select p_source_hash, v_contract.logical_table,
      'duplicate_source_primary_key', keyed.record_key
    from (
      select (
        select jsonb_object_agg(key_column, source_row->key_column)
        from unnest(v_contract.key_columns) key_column
      ) record_key
      from jsonb_array_elements(
        coalesce(p_snapshot->v_contract.logical_table, '[]'::jsonb)
      ) source_row
    ) keyed
    group by keyed.record_key
    having count(*) > 1;
    get diagnostics v_count = row_count;
    v_collision_count := v_collision_count + v_count;
  end loop;

  with input_rows as (
    select value as row
    from jsonb_array_elements(coalesce(p_snapshot->'tourney_players', '[]'::jsonb))
  ), token_rows as (
    select value as row
    from jsonb_array_elements(coalesce(p_snapshot->'tourney_player_tokens', '[]'::jsonb))
  ), team_rows as (
    select value as row
    from jsonb_array_elements(coalesce(p_snapshot->'tourney_bracket_teams', '[]'::jsonb))
  ), collisions as (
    select 'tourney_players'::text logical_table,
      'duplicate_source_unique_key'::text collision_kind,
      jsonb_build_object('username', lower(row->>'username')) record_key
    from input_rows group by lower(row->>'username') having count(*) > 1
    union all
    select 'tourney_players','duplicate_source_unique_key',
      jsonb_build_object('email',lower(row->>'email'))
    from input_rows group by lower(row->>'email') having count(*) > 1
    union all
    select 'tourney_players','duplicate_source_unique_key',
      jsonb_build_object('discord_key',lower(row->>'discord_key'))
    from input_rows group by lower(row->>'discord_key') having count(*) > 1
    union all
    select 'tourney_players','duplicate_source_unique_key',
      jsonb_build_object('discord_user_id',row->>'discord_user_id')
    from input_rows where nullif(row->>'discord_user_id','') is not null
    group by row->>'discord_user_id' having count(*) > 1
    union all
    select 'tourney_players','duplicate_source_unique_key',
      jsonb_build_object('principal_id',row->>'principal_id')
    from input_rows where nullif(row->>'principal_id','') is not null
    group by row->>'principal_id' having count(*) > 1
    union all
    select 'tourney_player_tokens','duplicate_source_unique_key',
      jsonb_build_object('token_hash',row->>'token_hash')
    from token_rows group by row->>'token_hash' having count(*) > 1
    union all
    select 'tourney_bracket_teams','duplicate_source_unique_key',
      jsonb_build_object('name',row->>'name')
    from team_rows group by row->>'name' having count(*) > 1
    union all
    select 'tourney_players', 'target_unique_key_conflict',
      jsonb_build_object('username', lower(input.row->>'username'))
    from input_rows input
    join tourney.tourney_players target
      on target.username = lower(input.row->>'username')
     and target.id <> input.row->>'id'
    where not p_allow_tombstones or exists (
      select 1 from input_rows retained where retained.row->>'id' = target.id
    )
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('email',lower(input.row->>'email'))
    from input_rows input
    join tourney.tourney_players target
      on target.email=lower(input.row->>'email') and target.id<>input.row->>'id'
    where not p_allow_tombstones or exists (
      select 1 from input_rows retained where retained.row->>'id' = target.id
    )
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('discord_key',lower(input.row->>'discord_key'))
    from input_rows input
    join tourney.tourney_players target
      on target.discord_key=lower(input.row->>'discord_key') and target.id<>input.row->>'id'
    where not p_allow_tombstones or exists (
      select 1 from input_rows retained where retained.row->>'id' = target.id
    )
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('discord_user_id',input.row->>'discord_user_id')
    from input_rows input
    join tourney.tourney_players target
      on target.discord_user_id=input.row->>'discord_user_id' and target.id<>input.row->>'id'
    where nullif(input.row->>'discord_user_id','') is not null
      and (not p_allow_tombstones or exists (
        select 1 from input_rows retained where retained.row->>'id' = target.id
      ))
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('principal_id',input.row->>'principal_id')
    from input_rows input
    join tourney.tourney_players target
      on target.principal_id::text=input.row->>'principal_id' and target.id<>input.row->>'id'
    where nullif(input.row->>'principal_id','') is not null
      and (not p_allow_tombstones or exists (
        select 1 from input_rows retained where retained.row->>'id' = target.id
      ))
    union all
    select 'tourney_player_tokens','target_unique_key_conflict',
      jsonb_build_object('token_hash',input.row->>'token_hash')
    from token_rows input
    join tourney.tourney_player_tokens target
      on target.token_hash=input.row->>'token_hash' and target.id<>input.row->>'id'
    where not p_allow_tombstones or exists (
      select 1 from token_rows retained where retained.row->>'id' = target.id
    )
    union all
    select 'tourney_bracket_teams','target_unique_key_conflict',
      jsonb_build_object('name',input.row->>'name')
    from team_rows input
    join tourney.tourney_bracket_teams target
      on target.name=input.row->>'name' and target.id<>input.row->>'id'
    where not p_allow_tombstones or exists (
      select 1 from team_rows retained where retained.row->>'id' = target.id
    )
  )
  insert into migration.tourney_import_quarantine (
    source_hash, logical_table, collision_kind, record_key
  )
  select p_source_hash, logical_table, collision_kind, record_key
  from collisions;
  get diagnostics v_count = row_count;
  v_collision_count := v_collision_count + v_count;
  if v_collision_count > 0 then
    update migration.tourney_import_preflights set
      status = 'quarantined', collision_count = v_collision_count,
      completed_at = now()
    where id = p_preflight_id;
    return jsonb_build_object(
      'status', 'quarantined', 'source_hash', p_source_hash,
      'collision_count', v_collision_count
    );
  end if;

  if tourney.snapshot_managed_target_hash() <> v_preflight.target_hash then
    update migration.tourney_import_preflights set
      status = 'failed', completed_at = now()
    where id = p_preflight_id;
    return jsonb_build_object(
      'status', 'target_changed',
      'source_hash', p_source_hash,
      'target_preflight_hash', v_preflight.target_hash
    );
  end if;

  perform set_config('roo.tourney_mirror_apply', '1', true);
  if p_allow_tombstones then
    foreach v_table in array array[
      'tourney_player_tokens', 'tourney_bracket_team_members',
      'tourney_appeals', 'tourney_payouts', 'tourney_bracket_audit',
      'tourney_bracket_entities', 'tourney_bracket_counters',
      'tourney_bracket_lock', 'tourney_bracket_meta',
      'tourney_registration_config', 'tourney_bracket_teams',
      'tourney_players'
    ] loop
      v_count := tourney.delete_snapshot_missing_rows(
        v_table,
        p_snapshot->v_table
      );
      v_deleted_counts := v_deleted_counts || jsonb_build_object(v_table, v_count);
    end loop;
  end if;

  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    v_count := tourney.upsert_snapshot_rows(
      v_table,
      coalesce(p_snapshot->v_table, '[]'::jsonb)
    );
    execute format('select count(*) from tourney.%I', v_table) into v_count;
    v_target_counts := v_target_counts || jsonb_build_object(v_table, v_count);
    execute format(
      'select encode(extensions.digest(convert_to(' ||
      'coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text), ' ||
      '''[]''::jsonb)::text, ''UTF8''), ''sha256''), ''hex'') ' ||
      'from tourney.%I source_row',
      v_table
    ) into v_hash;
    v_target_hashes := v_target_hashes || jsonb_build_object(v_table, v_hash);
    execute format(
      'select encode(extensions.digest(convert_to(' ||
      'coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text), ' ||
      '''[]''::jsonb)::text, ''UTF8''), ''sha256''), ''hex'') ' ||
      'from jsonb_populate_recordset(null::tourney.%I, $1) source_row',
      v_table
    ) using coalesce(p_snapshot->v_table, '[]'::jsonb)
      into v_source_table_hash;
    v_source_hashes := v_source_hashes ||
      jsonb_build_object(v_table, v_source_table_hash);
  end loop;

  select coalesce(jsonb_object_agg(status, count), '{}'::jsonb)
  into v_status_counts
  from (
    select status, count(*)::integer count
    from tourney.tourney_players group by status order by status
  ) statuses;
  select jsonb_build_object(
    'orphan_team_members', count(*) filter (where team.id is null),
    'orphan_player_members', count(*) filter (
      where member.player_id is not null and player.id is null
    )
  ) into v_relationships
  from tourney.tourney_bracket_team_members member
  left join tourney.tourney_bracket_teams team on team.id = member.team_id
  left join tourney.tourney_players player on player.id = member.player_id;
  if v_target_counts is distinct from coalesce(p_snapshot->'_counts', '{}'::jsonb) then
    raise exception 'Tourney snapshot target counts differ from the source snapshot'
      using errcode = 'P0001';
  end if;
  if v_target_hashes is distinct from v_source_hashes then
    raise exception 'Tourney snapshot target hashes differ from the source snapshot'
      using errcode = 'P0001';
  end if;
  if coalesce((v_relationships->>'orphan_team_members')::integer, 0) <> 0
     or coalesce((v_relationships->>'orphan_player_members')::integer, 0) <> 0 then
    raise exception 'Tourney snapshot contains orphaned bracket relationships'
      using errcode = '23503';
  end if;
  insert into migration.tourney_sync_runs (
    source_hash, source_counts, imported_counts, status
  ) values (
    p_source_hash,
    coalesce(p_snapshot->'_counts', '{}'::jsonb),
    v_target_counts,
    'completed'
  );
  update migration.tourney_import_preflights set
    status = 'applied', completed_at = now()
  where id = p_preflight_id;
  return jsonb_build_object(
    'status', 'completed', 'source_hash', p_source_hash,
    'target_counts', v_target_counts,
    'source_canonical_hashes', v_source_hashes,
    'target_canonical_hashes', v_target_hashes,
    'deleted_counts', v_deleted_counts,
    'status_counts', v_status_counts,
    'relationships', v_relationships
  );
end;
$$;

drop function if exists public.roo_enqueue_tourney_fallback_bootstrap(text);
create function public.roo_enqueue_tourney_fallback_bootstrap(
  p_actor text,
  p_fallback_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_contract record;
  v_source record;
  v_target_record jsonb;
  v_target_normalized jsonb;
  v_key jsonb;
  v_hash text;
  v_source_found boolean;
  v_target_found boolean;
  v_queued integer := 0;
  v_skipped integer := 0;
  v_upserts_queued integer := 0;
  v_deletes_queued integer := 0;
  v_actor text := nullif(btrim(p_actor), '');
begin
  if v_actor is null or v_actor !~ '^[A-Za-z0-9._:@-]{3,64}$'
     or coalesce(jsonb_typeof(p_fallback_snapshot), '') <> 'object' then
    raise exception 'Fallback bootstrap input is invalid' using errcode = '22023';
  end if;
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  if not found
     or v_meta.primary_backend <> 'supabase'
     or not v_meta.writes_paused
     or v_meta.generation < 1
     or v_meta.fallback_read_only then
    raise exception 'Fallback bootstrap safety preconditions are not satisfied'
      using errcode = '55000';
  end if;

  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts
    where enabled
    order by logical_table
  loop
    if not (p_fallback_snapshot ? v_contract.logical_table)
       or jsonb_typeof(p_fallback_snapshot->v_contract.logical_table) <> 'array' then
      raise exception 'Fallback bootstrap requires a complete target snapshot'
        using errcode = '22023';
    end if;

    for v_source in execute format(
      'select to_jsonb(source_row) record_data from %s source_row ' ||
      'order by to_jsonb(source_row)::text',
      v_contract.supabase_relation::regclass
    )
    loop
      v_key := tourney.mirror_record_key(
        v_contract.logical_table,
        v_source.record_data
      );
      v_hash := encode(extensions.digest(
        convert_to(v_source.record_data::text, 'UTF8'),
        'sha256'
      ), 'hex');
      select candidate into v_target_record
      from jsonb_array_elements(
        p_fallback_snapshot->v_contract.logical_table
      ) candidate
      where tourney.mirror_record_key(
        v_contract.logical_table,
        candidate
      ) = v_key
      limit 1;
      v_target_found := found;
      v_target_normalized := null;
      if v_target_found then
        execute format(
          'select to_jsonb(normalized_row) ' ||
          'from jsonb_populate_record(null::%s, $1) normalized_row',
          v_contract.supabase_relation::regclass
        ) using v_target_record into v_target_normalized;
      end if;

      if v_target_found
         and v_target_normalized = v_source.record_data
         and exists (
           select 1
           from tourney.mirror_outbox existing
           where existing.source_backend = 'supabase'
             and existing.generation = v_meta.generation
             and existing.table_name = v_contract.logical_table
             and existing.operation = 'upsert'
             and existing.record_key = v_key
             and existing.record_hash = v_hash
             and existing.status <> 'dead_letter'
         ) then
        v_skipped := v_skipped + 1;
      elsif exists (
        select 1
        from tourney.mirror_outbox existing
        where existing.source_backend = 'supabase'
          and existing.generation = v_meta.generation
          and existing.table_name = v_contract.logical_table
          and existing.operation = 'upsert'
          and existing.record_key = v_key
          and existing.record_hash = v_hash
          and existing.status in ('pending', 'retry', 'processing')
      ) then
        v_skipped := v_skipped + 1;
      else
        insert into tourney.mirror_outbox(
          command_id, source_backend, generation, table_name, operation,
          record_key, record_data, record_hash, status
        ) values(
          'fallback-bootstrap:g' || v_meta.generation || ':' || v_actor,
          'supabase', v_meta.generation, v_contract.logical_table, 'upsert',
          v_key, v_source.record_data, v_hash, 'pending'
        );
        v_queued := v_queued + 1;
        v_upserts_queued := v_upserts_queued + 1;
      end if;
    end loop;

    for v_target_record in
      select candidate
      from jsonb_array_elements(
        p_fallback_snapshot->v_contract.logical_table
      ) candidate
    loop
      v_key := tourney.mirror_record_key(
        v_contract.logical_table,
        v_target_record
      );
      execute format(
        'select exists(select 1 from %s source_row where to_jsonb(source_row) @> $1)',
        v_contract.supabase_relation::regclass
      ) using v_key into v_source_found;
      if not v_source_found then
        if exists (
          select 1
          from tourney.mirror_outbox existing
          where existing.source_backend = 'supabase'
            and existing.generation = v_meta.generation
            and existing.table_name = v_contract.logical_table
            and existing.operation = 'delete'
            and existing.record_key = v_key
            and existing.status in ('pending', 'retry', 'processing')
        ) then
          v_skipped := v_skipped + 1;
        else
          insert into tourney.mirror_outbox(
            command_id, source_backend, generation, table_name, operation,
            record_key, record_data, record_hash, status
          ) values(
            'fallback-bootstrap:g' || v_meta.generation || ':' || v_actor,
            'supabase', v_meta.generation, v_contract.logical_table, 'delete',
            v_key, null, null, 'pending'
          );
          v_queued := v_queued + 1;
          v_deletes_queued := v_deletes_queued + 1;
        end if;
      end if;
    end loop;
  end loop;

  insert into tourney.cutover_gate_events(
    event_kind, generation, actor, evidence
  ) values(
    'fallback_bootstrap', v_meta.generation, v_actor,
    jsonb_build_object(
      'queued', v_queued,
      'skipped', v_skipped,
      'upserts_queued', v_upserts_queued,
      'deletes_queued', v_deletes_queued
    )
  );
  return jsonb_build_object(
    'generation', v_meta.generation,
    'queued', v_queued,
    'skipped', v_skipped,
    'upserts_queued', v_upserts_queued,
    'deletes_queued', v_deletes_queued
  );
end;
$$;

update tourney.shadow_observations
set error_match = false
where not coalesce(primary_status between 200 and 299, false)
   or not coalesce(shadow_status between 200 and 299, false);

create or replace function tourney.refresh_cutover_clock(p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_now timestamptz := clock_timestamp();
  v_blocker text;
  v_latest_parity tourney.parity_runs%rowtype;
  v_first_pass timestamptz;
  v_second_pass timestamptz;
  v_pass_window_start timestamptz;
begin
  if nullif(btrim(p_actor), '') is null then
    raise exception 'Clock refresh actor is required' using errcode = '22023';
  end if;
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  select * into v_latest_parity
  from tourney.parity_runs
  where source_backend = 'supabase'
    and target_backend = 'legacy'
    and generation = v_meta.generation
  order by created_at desc
  limit 1;
  v_blocker := case
    when v_meta.id is null then 'cutover_control_missing'
    when not v_meta.hardened_active then 'hardening_inactive'
    when v_meta.primary_backend <> 'supabase' then 'supabase_primary_required'
    when v_meta.generation <> 1 then 'generation_one_required'
    when v_meta.natural_mutation_verified_at is null then 'natural_mutation_unverified'
    when exists (
      select 1 from tourney.mirror_outbox where status = 'dead_letter'
    ) then 'mirror_dead_letter'
    when exists (
      select 1 from tourney.mirror_outbox
      where status in ('pending','retry','processing')
        and occurred_at < v_now - interval '5 minutes'
    ) then 'mirror_overdue'
    when exists (
      select 1 from tourney.external_operations where status = 'dead_letter'
    ) then 'external_dead_letter'
    when exists (
      select 1 from tourney.external_operations
      where status in ('pending','retry','processing')
        and created_at < v_now - interval '5 minutes'
    ) then 'external_overdue'
    when exists (
      select 1 from tourney.tourney_player_auth_operations
      where operation_status in ('pending','processing','auth_applied','retry')
        and created_at < v_now - interval '5 minutes'
    ) then 'auth_operation_overdue'
    when exists (
      select 1 from tourney.command_receipts where status = 'failed'
    ) then 'command_receipt_failed'
    when exists (
      select 1 from tourney.command_receipts
      where status = 'committed'
        and committed_at < v_now - interval '5 minutes'
    ) then 'command_receipt_overdue'
    when exists (
      select 1 from tourney.email_dispatches
      where status in ('failed','dead_letter')
    ) then 'email_terminal_failure'
    when exists (
      select 1 from tourney.email_dispatches
      where status in ('pending','sending','retry')
        and created_at < v_now - interval '5 minutes'
    ) then 'email_overdue'
    when exists (
      select 1 from tourney.identity_conflicts where resolved_at is null
    ) then 'identity_conflict'
    when exists (
      select 1 from accounts.discord_role_assignments
      where status in ('dead_letter','blocked','blocked_reauth')
    ) then 'discord_blocker'
    when exists (
      select 1 from accounts.discord_role_assignments
      where status in ('pending','processing','retry')
        and pending_since < v_now - interval '5 minutes'
    ) then 'discord_overdue'
    when v_latest_parity.id is null or v_latest_parity.status <> 'clean'
      then 'parity_not_clean'
    when v_latest_parity.created_at < v_now - interval '7 minutes'
      then 'parity_stale'
    when v_latest_parity.created_at < coalesce((
      select max(applied_at) from tourney.mirror_outbox
      where source_backend='supabase' and generation=v_meta.generation
    ),'-infinity'::timestamptz) then 'parity_precedes_latest_mirror'
    when v_meta.clean_since is not null and exists (
      select 1 from tourney.parity_runs
      where source_backend='supabase' and target_backend='legacy'
        and generation=v_meta.generation and status<>'clean'
        and created_at > v_meta.clean_since
    ) then 'parity_drift_after_clock'
    when v_meta.clean_since is not null and exists (
      select 1 from tourney.shadow_observations
      where observed_at > v_meta.clean_since and not (
        shape_match and value_match and ordering_match and error_match
        and coalesce(primary_status between 200 and 299,false)
        and coalesce(shadow_status between 200 and 299,false)
      )
    ) then 'shadow_drift_after_clock'
    when exists (
      select 1 from (values
        ('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')
      ) required(route)
      where coalesce((
        select max(observed_at) from tourney.shadow_observations observation
        where observation.route=required.route
          and observation.observed_at >= v_meta.natural_mutation_verified_at
      ),'-infinity'::timestamptz) < v_now-interval '7 minutes'
    ) then 'shadow_samples_stale'
    when exists (
      select 1
      from (values
        ('public_roster'), ('public_bracket'), ('admin_players'),
        ('appeals'), ('payouts')
      ) required(route)
      left join lateral (
        select count(*)::integer samples,
          count(*) filter (where not (
            sample.shape_match
            and sample.value_match
            and sample.ordering_match
            and sample.error_match
            and coalesce(sample.primary_status between 200 and 299, false)
            and coalesce(sample.shadow_status between 200 and 299, false)
          ))::integer mismatches,
          percentile_cont(0.95) within group (
            order by sample.primary_latency_ms
          )::integer primary_p95_ms,
          percentile_cont(0.95) within group (
            order by sample.shadow_latency_ms
          )::integer shadow_p95_ms
        from (
          select * from tourney.shadow_observations observation
          where observation.route = required.route
            and observation.observed_at >= v_meta.natural_mutation_verified_at
          order by observation.observed_at desc, observation.id desc
          limit 30
        ) sample
      ) summary on true
      where coalesce(summary.samples, 0) < 30
        or coalesce(summary.mismatches, 0) > 0
    ) then 'shadow_samples_not_clean'
    when exists (
      select 1
      from (values
        ('public_roster', 750), ('public_bracket', 750),
        ('admin_players', 1000), ('appeals', 1000), ('payouts', 1000)
      ) required(route, maximum_p95_ms)
      left join lateral (
        select
          percentile_cont(0.95) within group (
            order by sample.primary_latency_ms
          )::integer primary_p95_ms,
          percentile_cont(0.95) within group (
            order by sample.shadow_latency_ms
          )::integer shadow_p95_ms
        from (
          select * from tourney.shadow_observations observation
          where observation.route = required.route
            and observation.observed_at >= v_meta.natural_mutation_verified_at
          order by observation.observed_at desc, observation.id desc
          limit 30
        ) sample
      ) summary on true
      where coalesce(summary.primary_p95_ms, 2147483647) >= required.maximum_p95_ms
        or coalesce(summary.shadow_p95_ms, 2147483647) >= required.maximum_p95_ms
    ) then 'shadow_latency_exceeded'
    when exists (
      select 1
      from (values
        ('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')
      ) required(route)
      left join tourney.shadow_latency_baselines baseline
        on baseline.route=required.route
      where baseline.route is null
    ) then 'shadow_latency_baseline_missing'
    when exists (
      select 1
      from tourney.shadow_latency_baselines baseline
      join lateral (
        select percentile_cont(0.95) within group(
          order by sample.primary_latency_ms
        )::integer primary_p95_ms
        from (
          select observation.primary_latency_ms
          from tourney.shadow_observations observation
          where observation.route=baseline.route
            and observation.observed_at >= v_meta.natural_mutation_verified_at
          order by observation.observed_at desc,observation.id desc
          limit 30
        ) sample
      ) current on true
      where current.primary_p95_ms > baseline.primary_p95_ms * 1.2
    ) then 'shadow_latency_regression'
    else null
  end;

  if v_blocker is null and exists (
    select 1 from tourney.mirror_outbox
    where status in ('pending','retry','processing')
  ) then
    update tourney.cutover_metadata set
      clock_last_evaluated_at = v_now,
      updated_at = v_now,
      updated_by = btrim(p_actor)
    where id = 'tourney';
    return jsonb_build_object(
      'clean_since', v_meta.clean_since,
      'blocker', 'mirror_in_transit',
      'held', true
    );
  end if;

  if v_blocker is not null then
    if v_meta.clean_since is not null
       or v_meta.clock_last_reset_reason is distinct from v_blocker then
      insert into tourney.cutover_gate_events (
        event_kind, generation, actor, evidence
      ) values (
        'clock_reset', v_meta.generation, btrim(p_actor),
        jsonb_build_object('reason', v_blocker)
      );
    end if;
    update tourney.cutover_metadata set
      clean_since = null,
      first_zero_drift_at = null,
      second_zero_drift_at = null,
      clock_last_evaluated_at = v_now,
      clock_last_reset_reason = v_blocker,
      updated_at = v_now,
      updated_by = btrim(p_actor)
    where id = 'tourney';
    return jsonb_build_object('clean_since', null, 'blocker', v_blocker);
  end if;

  select greatest(
    v_meta.natural_mutation_verified_at,
    coalesce((
      select max(created_at) from tourney.cutover_gate_events
      where event_kind = 'clock_reset'
        and generation = v_meta.generation
    ), v_meta.natural_mutation_verified_at),
    coalesce((
      select max(created_at) from tourney.parity_runs
      where source_backend='supabase' and target_backend='legacy'
        and generation=v_meta.generation and status<>'clean'
    ),v_meta.natural_mutation_verified_at)
  ) into v_pass_window_start;
  select min(created_at), max(created_at)
  into v_first_pass, v_second_pass
  from tourney.parity_runs
  where generation = v_meta.generation
    and source_backend = 'supabase'
    and target_backend = 'legacy'
    and status = 'clean'
    and created_at >= v_pass_window_start;
  if v_first_pass is null
     or v_second_pass - v_first_pass < interval '10 minutes' then
    update tourney.cutover_metadata set
      first_zero_drift_at = v_first_pass,
      second_zero_drift_at = null,
      clean_since = null,
      clock_last_evaluated_at = v_now,
      clock_last_reset_reason = 'two_parity_passes_required',
      updated_at = v_now,
      updated_by = btrim(p_actor)
    where id = 'tourney';
    return jsonb_build_object(
      'clean_since', null,
      'blocker', 'two_parity_passes_required'
    );
  end if;

  update tourney.cutover_metadata set
    first_zero_drift_at = v_first_pass,
    second_zero_drift_at = v_second_pass,
    clean_since = coalesce(clean_since, v_second_pass),
    clock_last_evaluated_at = v_now,
    clock_last_reset_reason = null,
    updated_at = v_now,
    updated_by = btrim(p_actor)
  where id = 'tourney'
  returning * into v_meta;
  if not exists (
    select 1 from tourney.cutover_gate_events
    where event_kind = 'clock_started'
      and generation = v_meta.generation
  ) then
    insert into tourney.cutover_gate_events (
      event_kind, generation, actor, evidence
    ) values (
      'clock_started', v_meta.generation, btrim(p_actor),
      jsonb_build_object('clean_since', v_meta.clean_since)
    );
  end if;
  return jsonb_build_object('clean_since', v_meta.clean_since, 'blocker', null);
end;
$$;

create or replace function public.roo_tourney_readiness()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with player_counts as (
    select status, count(*)::integer count
    from tourney.tourney_players group by status
  ), mirror_counts as (
    select status, count(*)::integer count
    from tourney.mirror_outbox group by status
  ), external_counts as (
    select status, count(*)::integer count
    from tourney.external_operations group by status
  ), auth_counts as (
    select operation_status status, count(*)::integer count
    from tourney.tourney_player_auth_operations group by operation_status
  ), email_counts as (
    select status, count(*)::integer count
    from tourney.email_dispatches group by status
  ), receipt_counts as (
    select status, count(*)::integer count
    from tourney.command_receipts group by status
  ), discord_counts as (
    select status, count(*)::integer count
    from accounts.discord_role_assignments group by status
  ), shadow as (
    select route, count(*)::integer samples,
      count(*) filter (where not (
        shape_match
        and value_match
        and ordering_match
        and error_match
        and coalesce(primary_status between 200 and 299, false)
        and coalesce(shadow_status between 200 and 299, false)
      ))::integer mismatches,
      percentile_cont(0.95) within group (
        order by primary_latency_ms
      )::integer primary_p95_ms,
      percentile_cont(0.95) within group (
        order by shadow_latency_ms
      )::integer shadow_p95_ms,
      max(observed_at) last_observed_at
    from (
      select *, row_number() over (
        partition by route order by observed_at desc, id desc
      ) sample_rank
      from tourney.shadow_observations
      where observed_at >= coalesce((
        select natural_mutation_verified_at
        from tourney.cutover_metadata where id='tourney'
      ), 'infinity'::timestamptz)
    ) ranked
    where sample_rank <= 30
    group by route
  ), blockers as (
    select array_remove(array[
      case when not coalesce((
        select hardened_active from tourney.cutover_metadata where id='tourney'
      ), false) then 'hardening_inactive' end,
      case when coalesce((
        select primary_backend from tourney.cutover_metadata where id='tourney'
      ), '') <> 'supabase' then 'supabase_primary_required' end,
      case when coalesce((
        select generation from tourney.cutover_metadata where id='tourney'
      ), -1) <> 1 then 'generation_one_required' end,
      case when (
        select natural_mutation_verified_at from tourney.cutover_metadata
        where id='tourney'
      ) is null then 'natural_mutation_unverified' end,
      case when exists(
        select 1 from tourney.mirror_outbox where status='dead_letter'
      ) then 'mirror_dead_letter' end,
      case when exists(
        select 1 from tourney.mirror_outbox
        where status in ('pending','retry','processing')
          and occurred_at < now()-interval '5 minutes'
      ) then 'mirror_overdue' end,
      case when exists(
        select 1 from tourney.external_operations where status='dead_letter'
      ) then 'external_dead_letter' end,
      case when exists(
        select 1 from tourney.external_operations
        where status in ('pending','retry','processing')
          and created_at < now()-interval '5 minutes'
      ) then 'external_overdue' end,
      case when exists(
        select 1 from tourney.tourney_player_auth_operations
        where operation_status in ('pending','processing','auth_applied','retry')
          and created_at < now()-interval '5 minutes'
      ) then 'auth_operation_overdue' end,
      case when exists(
        select 1 from tourney.command_receipts where status='failed'
      ) then 'command_receipt_failed' end,
      case when exists(
        select 1 from tourney.command_receipts
        where status='committed'
          and committed_at < now()-interval '5 minutes'
      ) then 'command_receipt_overdue' end,
      case when exists(
        select 1 from tourney.email_dispatches
        where status in ('failed','dead_letter')
      ) then 'email_terminal_failure' end,
      case when exists(
        select 1 from tourney.email_dispatches
        where status in ('pending','sending','retry')
          and created_at < now()-interval '5 minutes'
      ) then 'email_overdue' end,
      case when exists(
        select 1 from accounts.discord_role_assignments
        where status in ('dead_letter','blocked','blocked_reauth')
      ) then 'discord_blocker' end,
      case when exists(
        select 1 from accounts.discord_role_assignments
        where status in ('pending','processing','retry')
          and pending_since < now()-interval '5 minutes'
      ) then 'discord_overdue' end,
      case when exists(
        select 1 from tourney.identity_conflicts where resolved_at is null
      ) then 'identity_conflict' end,
      case when exists(
        select 1 from tourney.shadow_observations
        where observed_at >= now()-interval '24 hours'
          and observed_at >= coalesce((
            select natural_mutation_verified_at
            from tourney.cutover_metadata where id='tourney'
          ), 'infinity'::timestamptz)
          and not (
            shape_match
            and value_match
            and ordering_match
            and error_match
            and coalesce(primary_status between 200 and 299, false)
            and coalesce(shadow_status between 200 and 299, false)
          )
      ) then 'shadow_mismatch' end,
      case when coalesce((
        select run.status from tourney.parity_runs run
        where run.source_backend='supabase'
          and run.target_backend='legacy'
          and run.generation=1
        order by run.created_at desc
        limit 1
      ),'') <> 'clean' then 'parity_not_clean' end,
      case when coalesce((
        select max(run.created_at) from tourney.parity_runs run
        where run.source_backend='supabase' and run.target_backend='legacy'
          and run.generation=1
      ),'-infinity'::timestamptz) < now()-interval '7 minutes'
        then 'parity_stale' end,
      case when coalesce((
        select max(run.created_at) from tourney.parity_runs run
        where run.source_backend='supabase' and run.target_backend='legacy'
          and run.generation=1
      ),'-infinity'::timestamptz) < coalesce((
        select max(applied_at) from tourney.mirror_outbox
        where source_backend='supabase' and generation=1
      ),'-infinity'::timestamptz) then 'parity_precedes_latest_mirror' end,
      case when exists(
        select 1 from (values
          ('public_roster'),('public_bracket'),('admin_players'),('appeals'),('payouts')
        ) required(route)
        where coalesce((select max(observed_at) from tourney.shadow_observations observation
          where observation.route=required.route),'-infinity'::timestamptz)
          < now()-interval '7 minutes'
      ) then 'shadow_samples_stale' end,
      case when coalesce((
        select clock_last_evaluated_at from tourney.cutover_metadata where id='tourney'
      ),'-infinity'::timestamptz) < now()-interval '7 minutes'
        then 'clock_evaluation_stale' end,
      case when exists(
        select 1
        from (values
          ('public_roster', 750), ('public_bracket', 750),
          ('admin_players', 1000), ('appeals', 1000), ('payouts', 1000)
        ) required(route, maximum_p95_ms)
        left join shadow sample on sample.route=required.route
        left join tourney.shadow_latency_baselines baseline
          on baseline.route=required.route
        where coalesce(sample.samples,0) < 30
          or coalesce(sample.mismatches,0) > 0
          or coalesce(sample.primary_p95_ms,2147483647) >= required.maximum_p95_ms
          or coalesce(sample.shadow_p95_ms,2147483647) >= required.maximum_p95_ms
          or baseline.route is null
          or sample.primary_p95_ms > baseline.primary_p95_ms * 1.2
      ) then 'shadow_acceptance_gate_failed' end,
      (select clock_last_reset_reason
       from tourney.cutover_metadata where id='tourney')
    ], null) blocker_values
  )
  select jsonb_build_object(
    'control', (
      select to_jsonb(metadata)-'updated_by'
      from tourney.cutover_metadata metadata where id='tourney'
    ),
    'player_counts', coalesce(
      (select jsonb_object_agg(status,count) from player_counts),
      '{}'::jsonb
    ),
    'table_counts', jsonb_build_object(
      'players',(select count(*) from tourney.tourney_players),
      'tokens',(select count(*) from tourney.tourney_player_tokens),
      'teams',(select count(*) from tourney.tourney_bracket_teams),
      'team_members',(select count(*) from tourney.tourney_bracket_team_members),
      'appeals',(select count(*) from tourney.tourney_appeals),
      'payouts',(select count(*) from tourney.tourney_payouts),
      'account_snapshots',(select count(*) from tourney.account_snapshots),
      'command_receipts',(select count(*) from tourney.command_receipts)
    ),
    'command_receipts',jsonb_build_object(
      'counts',coalesce(
        (select jsonb_object_agg(status,count) from receipt_counts),
        '{}'::jsonb
      ),
      'oldest_committed_at',(
        select min(committed_at) from tourney.command_receipts
        where status='committed'
      ),
      'oldest_failed_at',(
        select min(failed_at) from tourney.command_receipts
        where status='failed'
      )
    ),
    'mirror', jsonb_build_object(
      'counts',coalesce(
        (select jsonb_object_agg(status,count) from mirror_counts),
        '{}'::jsonb
      ),
      'oldest_pending_at',(
        select min(occurred_at) from tourney.mirror_outbox
        where status in ('pending','retry','processing')
      )
    ),
    'external_operations', jsonb_build_object(
      'counts',coalesce(
        (select jsonb_object_agg(status,count) from external_counts),
        '{}'::jsonb
      ),
      'oldest_pending_at',(
        select min(created_at) from tourney.external_operations
        where status in ('pending','retry','processing')
      ),
      'overdue',(
        select count(*) from tourney.external_operations
        where status in ('pending','retry','processing')
          and created_at < now()-interval '5 minutes'
      )
    ),
    'auth_operations', jsonb_build_object(
      'counts',coalesce(
        (select jsonb_object_agg(status,count) from auth_counts),
        '{}'::jsonb
      ),
      'pending',(
        select count(*) from tourney.tourney_player_auth_operations
        where operation_status in ('pending','processing','auth_applied','retry')
      ),
      'oldest_pending_at',(
        select min(created_at) from tourney.tourney_player_auth_operations
        where operation_status in ('pending','processing','auth_applied','retry')
      ),
      'overdue',(
        select count(*) from tourney.tourney_player_auth_operations
        where operation_status in ('pending','processing','auth_applied','retry')
          and created_at < now()-interval '5 minutes'
      )
    ),
    'discord',coalesce(
      (select jsonb_object_agg(status,count) from discord_counts),
      '{}'::jsonb
    ),
    'email',coalesce(
      (select jsonb_object_agg(status,count) from email_counts),
      '{}'::jsonb
    ),
    'email_queue',jsonb_build_object(
      'oldest_pending_at',(
        select min(created_at) from tourney.email_dispatches
        where status in ('pending','sending','retry')
      ),
      'overdue',(
        select count(*) from tourney.email_dispatches
        where status in ('pending','sending','retry')
          and created_at < now()-interval '5 minutes'
      )
    ),
    'discord_queue',jsonb_build_object(
      'oldest_pending_at',(
        select min(pending_since) from accounts.discord_role_assignments
        where status in ('pending','processing','retry')
      ),
      'overdue',(
        select count(*) from accounts.discord_role_assignments
        where status in ('pending','processing','retry')
          and pending_since < now()-interval '5 minutes'
      )
    ),
    'identity_conflicts',(
      select count(*) from tourney.identity_conflicts where resolved_at is null
    ),
    'last_parity',(
      select to_jsonb(run) from tourney.parity_runs run
      where run.source_backend='supabase'
        and run.target_backend='legacy'
        and run.generation=1
      order by created_at desc limit 1
    ),
    'shadow_reads',coalesce(
      (select jsonb_object_agg(route,to_jsonb(shadow)-'route') from shadow),
      '{}'::jsonb
    ),
    'shadow_latency_baselines',coalesce((
      select jsonb_object_agg(route,jsonb_build_object(
        'primary_p95_ms',primary_p95_ms,
        'sample_count',sample_count,
        'source_window_started_at',source_window_started_at,
        'source_window_ended_at',source_window_ended_at,
        'captured_at',captured_at,
        'captured_by',captured_by
      )) from tourney.shadow_latency_baselines
    ),'{}'::jsonb),
    'clock_blockers',(select to_jsonb(blocker_values) from blockers),
    'clean_duration_seconds',coalesce((
      select greatest(0,extract(epoch from (now()-clean_since)))::bigint
      from tourney.cutover_metadata where id='tourney' and clean_since is not null
    ),0),
    'legacy_read_only_eligible',coalesce((
      select hardened_active
        and primary_backend='supabase'
        and generation=1
        and clean_since is not null
        and clean_since <= now()-interval '14 days'
      from tourney.cutover_metadata where id='tourney'
    ),false) and coalesce((
      select cardinality(blocker_values)=0 from blockers
    ),false)
  )
$$;

create or replace function tourney.guard_payout_transition()
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
  on tourney.tourney_payouts;
create trigger guard_tourney_payout_transition
before update on tourney.tourney_payouts
for each row execute function tourney.guard_payout_transition();

revoke all on function tourney.guard_payout_transition()
  from public, anon, authenticated, service_role;
revoke all on function tourney.delete_snapshot_missing_rows(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function tourney.upsert_snapshot_rows(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function tourney.canonical_json(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function tourney.snapshot_managed_target_hash()
  from public, anon, authenticated, service_role;
revoke all on function tourney.capture_mirror_event_v4()
  from public, anon, authenticated, service_role;
revoke all on function tourney.mirror_record_key(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function tourney.history_uuid(text)
  from public, anon, authenticated, service_role;
revoke all on function tourney.guard_email_dispatch_terminal_state()
  from public, anon, authenticated, service_role;
revoke all on function tourney.set_external_operation_serialization_key()
  from public, anon, authenticated, service_role;
revoke all on function accounts.set_discord_assignment_pending_since()
  from public, anon, authenticated, service_role;
revoke all on function public.roo_capture_tourney_shadow_latency_baseline(text)
  from public, anon, authenticated;
revoke all on function public.roo_preflight_tourney_snapshot_v4(jsonb, text, boolean)
  from public, anon, authenticated;
revoke all on function public.roo_import_tourney_snapshot_v4(jsonb, text, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.roo_enqueue_tourney_fallback_bootstrap(text, jsonb)
  from public, anon, authenticated;
revoke all on function tourney.refresh_cutover_clock(text)
  from public, anon, authenticated;
revoke all on function public.roo_tourney_readiness()
  from public, anon, authenticated;
grant execute on function public.roo_preflight_tourney_snapshot_v4(jsonb, text, boolean)
  to service_role;
grant execute on function public.roo_import_tourney_snapshot_v4(jsonb, text, boolean, uuid)
  to service_role;
grant execute on function public.roo_capture_tourney_shadow_latency_baseline(text)
  to service_role;
grant execute on function public.roo_enqueue_tourney_fallback_bootstrap(text, jsonb)
  to service_role;
grant execute on function tourney.refresh_cutover_clock(text)
  to service_role;
grant execute on function public.roo_tourney_readiness()
  to service_role;
