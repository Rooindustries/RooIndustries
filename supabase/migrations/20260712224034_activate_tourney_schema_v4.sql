-- Schema-v4 install phase. This migration is additive and safe to install
-- before the final pause. Runtime activation is a separate audited RPC below.

set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists tourney_account_snapshots_supersedes_v4_idx
  on tourney.account_snapshots (supersedes_snapshot_id)
  where supersedes_snapshot_id is not null;

create or replace function tourney.mirror_record_key(
  p_table_name text,
  p_row jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_contract tourney.mirror_contracts%rowtype;
  v_column text;
  v_key jsonb := '{}'::jsonb;
begin
  select * into v_contract
  from tourney.mirror_contracts
  where logical_table = p_table_name and enabled;
  if not found then
    raise exception 'Tourney mirror contract is not registered' using errcode = '22023';
  end if;
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'Tourney mirror row is invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_row) supplied(column_name)
    where not supplied.column_name = any(v_contract.allowed_columns)
  ) then
    raise exception 'Tourney mirror row contains unsupported columns' using errcode = '22023';
  end if;
  foreach v_column in array v_contract.key_columns loop
    if not (p_row ? v_column)
       or p_row->v_column is null
       or p_row->v_column = 'null'::jsonb
       or btrim(p_row->>v_column) = '' then
      raise exception 'Tourney mirror key is incomplete' using errcode = '23502';
    end if;
    v_key := v_key || jsonb_build_object(v_column, p_row->v_column);
  end loop;
  return v_key;
end;
$$;

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
  where supabase_relation = tg_table_schema || '.' || tg_table_name
    and enabled;
  if v_logical_table is null then
    raise exception 'Tourney mirror relation is not registered' using errcode = '22023';
  end if;
  v_key := tourney.mirror_record_key(v_logical_table, v_row);
  v_hash := case when v_data is null then null else
    encode(extensions.digest(convert_to(v_data::text, 'UTF8'), 'sha256'), 'hex') end;
  insert into tourney.mirror_outbox (
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data, record_hash, status
  ) values (
    v_command_id, 'supabase', v_meta.generation, v_logical_table,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, v_data, v_hash, 'pending'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

alter table tourney.cutover_gate_events
  drop constraint if exists tourney_cutover_gate_events_event_kind_check;
alter table tourney.cutover_gate_events
  drop constraint if exists cutover_gate_events_event_kind_check;
alter table tourney.cutover_gate_events
  add constraint cutover_gate_events_event_kind_check
  check (event_kind in (
    'hardened_activated', 'natural_mirror_verified', 'zero_drift_pass',
    'clock_started', 'clock_reset', 'legacy_read_only', 'fallback_bootstrap'
  )) not valid;
alter table tourney.cutover_gate_events
  validate constraint cutover_gate_events_event_kind_check;

create or replace function public.roo_enqueue_tourney_fallback_bootstrap(
  p_actor text
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
  v_key jsonb;
  v_hash text;
  v_queued integer := 0;
  v_skipped integer := 0;
  v_actor text := nullif(btrim(p_actor), '');
begin
  if v_actor is null or v_actor !~ '^[A-Za-z0-9._:@-]{3,64}$' then
    raise exception 'Fallback bootstrap actor is required' using errcode = '22023';
  end if;
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  if v_meta.id is null
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
    for v_source in execute format(
      'select to_jsonb(source_row) record_data from %s source_row order by to_jsonb(source_row)::text',
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
      if exists (
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
      end if;
    end loop;
  end loop;

  insert into tourney.cutover_gate_events(event_kind, generation, actor, evidence)
  values(
    'fallback_bootstrap', v_meta.generation, v_actor,
    jsonb_build_object('queued', v_queued, 'skipped', v_skipped)
  );
  return jsonb_build_object(
    'generation', v_meta.generation,
    'queued', v_queued,
    'skipped', v_skipped
  );
end;
$$;

create or replace function tourney.history_uuid(p_value text)
returns uuid language sql immutable strict set search_path='' as $$
  select (
    substr(md5(p_value),1,8)||'-'||substr(md5(p_value),9,4)||'-4'||
    substr(md5(p_value),14,3)||'-8'||substr(md5(p_value),18,3)||'-'||
    substr(md5(p_value),21,12)
  )::uuid
$$;

create index if not exists tourney_email_dispatches_history_v4_idx
  on tourney.email_dispatches (dispatch_kind, recipient_hash);

create or replace function public.roo_backfill_tourney_email_history_v4(
  p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_count integer := 0;
begin
  if btrim(coalesce(p_actor, '')) = '' or length(p_actor) > 120 then
    raise exception 'Tourney email history actor is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for update;
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or not v_meta.hardened_active then
    raise exception 'Tourney email history backfill controls are not ready'
      using errcode = '55000';
  end if;
insert into tourney.email_dispatches(
  id,idempotency_key,command_id,dispatch_kind,recipient,recipient_hash,
  payload,status,provider_message_id,sent_at,created_at,updated_at
)
select tourney.history_uuid(candidate.key),candidate.key,null::text,
  candidate.kind,candidate.recipient,
  encode(extensions.digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex'),
  candidate.payload,candidate.status,candidate.provider_message_id,candidate.sent_at,
  candidate.occurred_at,candidate.occurred_at
from (
  select
    'history:registration:'||token.player_id||':'||lower(token.recipient_email) key,
    'history:registration:'||token.player_id command_id,'registration' kind,
    lower(token.recipient_email) recipient,
    jsonb_build_object('historical',true,'entityId',token.player_id,'audience','admin') payload,
    'historical_unknown' status,null::text provider_message_id,null::timestamptz sent_at,
    min(token.created_at) occurred_at
  from tourney.tourney_player_tokens token
  where token.recipient_email is not null and token.purpose in ('approve','deny')
  group by token.player_id, lower(token.recipient_email)
  union all
  select 'history:approval:'||player.id||':'||lower(player.email),
    'history:approval:'||player.id,'approval',lower(player.email),
    jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),
    'historical_unknown',null,null,coalesce(player.approved_at,player.updated_at)
  from tourney.tourney_players player where player.status='approved'
  union all
  select 'history:reset:'||token.id||':'||lower(player.email),
    'history:reset:'||token.id,'reset',lower(player.email),
    jsonb_build_object('historical',true,'entityId',token.id,'audience','player'),
    'historical_unknown',null,null,token.created_at
  from tourney.tourney_player_tokens token
  join tourney.tourney_players player on player.id=token.player_id
  where token.purpose='reset'
  union all
  select 'history:discord_invite:'||player.id||':'||lower(player.email),
    'history:discord_invite:'||player.id,'discord_invite',lower(player.email),
    jsonb_build_object('historical',true,'entityId',player.id,'audience','player'),
    'sent',player.discord_invite_email_id,player.discord_invite_sent_at,player.discord_invite_sent_at
  from tourney.tourney_players player where player.discord_invite_sent_at is not null
  union all
  select 'history:appeal:'||appeal.id||':'||lower(player.email),
    'history:appeal:'||appeal.id,'appeal',lower(player.email),
    jsonb_build_object('historical',true,'entityId',appeal.id,'audience','submitter'),
    'historical_unknown',null,null,appeal.created_at
  from tourney.tourney_appeals appeal
  join tourney.tourney_players player on player.id=appeal.submitter_player_id
  union all
  select 'history:payout:'||payout.id||':'||payout.status||':'||lower(payout.payout_email),
    'history:payout:'||payout.id||':'||payout.status,'payout',lower(payout.payout_email),
    jsonb_build_object('historical',true,'entityId',payout.id,'audience',payout.status),
    'historical_unknown',null,null,payout.updated_at
  from tourney.tourney_payouts payout
  where payout.status in ('ready','paid','void') and payout.payout_email is not null
) candidate
where candidate.recipient <> ''
  and not exists(
    select 1 from tourney.email_dispatches existing
    where existing.dispatch_kind=candidate.kind
      and existing.recipient_hash=encode(extensions.digest(convert_to(candidate.recipient,'UTF8'),'sha256'),'hex')
      and coalesce(
        existing.payload->>'entityId',
        existing.payload#>>'{player,id}',
        existing.payload#>>'{appeal,id}',
        existing.payload#>>'{payout,id}'
      )=candidate.payload->>'entityId'
      and coalesce(existing.payload->>'audience','')=coalesce(candidate.payload->>'audience','')
  )
on conflict(idempotency_key) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('inserted', v_count, 'actor', btrim(p_actor));
end;
$$;

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
  select * into v_meta from tourney.cutover_metadata where id = 'tourney' for update;
  select * into v_latest_parity from tourney.parity_runs order by created_at desc limit 1;
  v_blocker := case
    when not v_meta.hardened_active then 'hardening_inactive'
    when v_meta.generation < 1 then 'generation_zero'
    when v_meta.natural_mutation_verified_at is null then 'natural_mutation_unverified'
    when exists (select 1 from tourney.mirror_outbox where status = 'dead_letter') then 'mirror_dead_letter'
    when exists (select 1 from tourney.mirror_outbox where status in ('pending','retry','processing') and occurred_at < v_now - interval '5 minutes') then 'mirror_overdue'
    when exists (select 1 from tourney.external_operations where status = 'dead_letter') then 'external_dead_letter'
    when exists (select 1 from tourney.external_operations where status in ('pending','retry','processing') and created_at < v_now - interval '5 minutes') then 'external_overdue'
    when exists (select 1 from tourney.email_dispatches where status in ('failed','dead_letter')) then 'email_terminal_failure'
    when exists (select 1 from tourney.identity_conflicts where resolved_at is null) then 'identity_conflict'
    when exists (select 1 from accounts.discord_role_assignments where status in ('dead_letter','blocked')) then 'discord_blocker'
    when v_latest_parity.id is null or v_latest_parity.status <> 'clean' then 'parity_not_clean'
    when exists (
      select 1
      from (values
        ('public_roster'), ('public_bracket'), ('admin_players'),
        ('appeals'), ('payouts')
      ) required(route)
      left join lateral (
        select count(*)::integer samples,
          count(*) filter (where not (
            sample.shape_match and sample.value_match and
            sample.ordering_match and sample.error_match
          ))::integer mismatches
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
    else null end;

  if v_blocker is not null then
    if v_meta.clean_since is not null or v_meta.clock_last_reset_reason is distinct from v_blocker then
      insert into tourney.cutover_gate_events (event_kind, generation, actor, evidence)
      values ('clock_reset', v_meta.generation, btrim(p_actor), jsonb_build_object('reason', v_blocker));
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
    ), v_meta.natural_mutation_verified_at)
  ) into v_pass_window_start;
  select min(created_at), max(created_at)
  into v_first_pass, v_second_pass
  from tourney.parity_runs
  where generation = v_meta.generation and status = 'clean'
    and created_at >= v_pass_window_start;
  if v_first_pass is null or v_second_pass - v_first_pass < interval '10 minutes' then
    update tourney.cutover_metadata set
      first_zero_drift_at = v_first_pass,
      second_zero_drift_at = null,
      clean_since = null,
      clock_last_evaluated_at = v_now,
      clock_last_reset_reason = 'two_parity_passes_required',
      updated_at = v_now,
      updated_by = btrim(p_actor)
    where id = 'tourney';
    return jsonb_build_object('clean_since', null, 'blocker', 'two_parity_passes_required');
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
    where event_kind = 'clock_started' and generation = v_meta.generation
  ) then
    insert into tourney.cutover_gate_events (event_kind, generation, actor, evidence)
    values ('clock_started', v_meta.generation, btrim(p_actor),
      jsonb_build_object('clean_since', v_meta.clean_since));
  end if;
  return jsonb_build_object('clean_since', v_meta.clean_since, 'blocker', null);
end;
$$;

create or replace function public.roo_import_tourney_snapshot_v4(
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
  v_collision_count integer := 0;
  v_table text;
  v_count integer;
  v_hash text;
  v_target_counts jsonb := '{}'::jsonb;
  v_target_hashes jsonb := '{}'::jsonb;
  v_source_hashes jsonb := '{}'::jsonb;
  v_source_table_hash text;
  v_relationships jsonb;
  v_status_counts jsonb;
  v_contract record;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'Tourney snapshot input is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata where id = 'tourney' for update;
  if p_allow_tombstones and (
    v_meta.primary_backend <> 'legacy' or not v_meta.writes_paused or v_meta.generation <> 0
  ) then
    raise exception 'Destructive Tourney reconciliation is forbidden' using errcode = '55000';
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
    select value as row from jsonb_array_elements(coalesce(p_snapshot->'tourney_players', '[]'::jsonb))
  ), token_rows as (
    select value as row from jsonb_array_elements(coalesce(p_snapshot->'tourney_player_tokens', '[]'::jsonb))
  ), team_rows as (
    select value as row from jsonb_array_elements(coalesce(p_snapshot->'tourney_bracket_teams', '[]'::jsonb))
  ), collisions as (
    select 'tourney_players'::text logical_table, 'duplicate_source_unique_key'::text collision_kind,
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
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('email',lower(input.row->>'email'))
    from input_rows input join tourney.tourney_players target
      on target.email=lower(input.row->>'email') and target.id<>input.row->>'id'
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('discord_key',lower(input.row->>'discord_key'))
    from input_rows input join tourney.tourney_players target
      on target.discord_key=lower(input.row->>'discord_key') and target.id<>input.row->>'id'
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('discord_user_id',input.row->>'discord_user_id')
    from input_rows input join tourney.tourney_players target
      on target.discord_user_id=input.row->>'discord_user_id' and target.id<>input.row->>'id'
    where nullif(input.row->>'discord_user_id','') is not null
    union all
    select 'tourney_players','target_unique_key_conflict',
      jsonb_build_object('principal_id',input.row->>'principal_id')
    from input_rows input join tourney.tourney_players target
      on target.principal_id::text=input.row->>'principal_id' and target.id<>input.row->>'id'
    where nullif(input.row->>'principal_id','') is not null
    union all
    select 'tourney_player_tokens','target_unique_key_conflict',
      jsonb_build_object('token_hash',input.row->>'token_hash')
    from token_rows input join tourney.tourney_player_tokens target
      on target.token_hash=input.row->>'token_hash' and target.id<>input.row->>'id'
    union all
    select 'tourney_bracket_teams','target_unique_key_conflict',
      jsonb_build_object('name',input.row->>'name')
    from team_rows input join tourney.tourney_bracket_teams target
      on target.name=input.row->>'name' and target.id<>input.row->>'id'
  )
  insert into migration.tourney_import_quarantine (
    source_hash, logical_table, collision_kind, record_key
  ) select p_source_hash, logical_table, collision_kind, record_key from collisions;
  get diagnostics v_count = row_count;
  v_collision_count := v_collision_count + v_count;
  if v_collision_count > 0 then
    return jsonb_build_object(
      'status', 'quarantined', 'source_hash', p_source_hash,
      'collision_count', v_collision_count
    );
  end if;

  perform set_config('roo.tourney_mirror_apply', '1', true);
  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    v_count := tourney.upsert_snapshot_rows(v_table, coalesce(p_snapshot->v_table, '[]'::jsonb));
    execute format('select count(*) from tourney.%I', v_table) into v_count;
    v_target_counts := v_target_counts || jsonb_build_object(v_table, v_count);
    execute format(
      'select encode(extensions.digest(convert_to(coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text), ''[]''::jsonb)::text, ''UTF8''), ''sha256''), ''hex'') from tourney.%I source_row',
      v_table
    ) into v_hash;
    v_target_hashes := v_target_hashes || jsonb_build_object(v_table, v_hash);
    select encode(extensions.digest(convert_to(
      coalesce(jsonb_agg(value order by value::text), '[]'::jsonb)::text,
      'UTF8'
    ), 'sha256'), 'hex')
    into v_source_table_hash
    from jsonb_array_elements(coalesce(p_snapshot->v_table, '[]'::jsonb));
    v_source_hashes := v_source_hashes || jsonb_build_object(v_table, v_source_table_hash);
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
  insert into migration.tourney_sync_runs (source_hash, source_counts, imported_counts, status)
  values (p_source_hash, coalesce(p_snapshot->'_counts', '{}'::jsonb), v_target_counts, 'completed');
  return jsonb_build_object(
    'status', 'completed', 'source_hash', p_source_hash,
    'target_counts', v_target_counts,
    'source_canonical_hashes', v_source_hashes,
    'target_canonical_hashes', v_target_hashes,
    'status_counts', v_status_counts,
    'relationships', v_relationships
  );
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
  ), email_counts as (
    select status, count(*)::integer count
    from tourney.email_dispatches group by status
  ), discord_counts as (
    select status, count(*)::integer count
    from accounts.discord_role_assignments group by status
  ), shadow as (
    select route, count(*)::integer samples,
      count(*) filter (where not (
        shape_match and value_match and ordering_match and error_match
      ))::integer mismatches,
      percentile_cont(0.95) within group (order by primary_latency_ms)::integer primary_p95_ms,
      percentile_cont(0.95) within group (order by shadow_latency_ms)::integer shadow_p95_ms,
      max(observed_at) last_observed_at
    from (
      select *, row_number() over (partition by route order by observed_at desc, id desc) sample_rank
      from tourney.shadow_observations
    ) ranked where sample_rank <= 30 group by route
  ), blockers as (
    select array_remove(array[
      case when exists(select 1 from tourney.mirror_outbox where status='dead_letter') then 'mirror_dead_letter' end,
      case when exists(select 1 from tourney.mirror_outbox where status in ('pending','retry','processing') and occurred_at < now()-interval '5 minutes') then 'mirror_overdue' end,
      case when exists(select 1 from tourney.external_operations where status='dead_letter') then 'external_dead_letter' end,
      case when exists(select 1 from tourney.external_operations where status in ('pending','retry','processing') and created_at < now()-interval '5 minutes') then 'external_overdue' end,
      case when exists(select 1 from tourney.email_dispatches where status in ('failed','dead_letter')) then 'email_terminal_failure' end,
      case when exists(select 1 from accounts.discord_role_assignments where status in ('dead_letter','blocked')) then 'discord_blocker' end,
      case when exists(select 1 from tourney.identity_conflicts where resolved_at is null) then 'identity_conflict' end,
      case when exists(select 1 from tourney.shadow_observations where observed_at >= now()-interval '24 hours' and not (shape_match and value_match and ordering_match and error_match)) then 'shadow_mismatch' end,
      (select clock_last_reset_reason from tourney.cutover_metadata where id='tourney')
    ], null) blocker_values
  )
  select jsonb_build_object(
    'control', (select to_jsonb(metadata)-'updated_by' from tourney.cutover_metadata metadata where id='tourney'),
    'player_counts', coalesce((select jsonb_object_agg(status,count) from player_counts),'{}'::jsonb),
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
    'mirror', jsonb_build_object(
      'counts',coalesce((select jsonb_object_agg(status,count) from mirror_counts),'{}'::jsonb),
      'oldest_pending_at',(select min(occurred_at) from tourney.mirror_outbox where status in ('pending','retry','processing'))
    ),
    'external_operations', jsonb_build_object(
      'counts',coalesce((select jsonb_object_agg(status,count) from external_counts),'{}'::jsonb),
      'oldest_pending_at',(select min(created_at) from tourney.external_operations where status in ('pending','retry','processing'))
    ),
    'auth_operations', jsonb_build_object(
      'pending',(select count(*) from tourney.tourney_player_auth_operations where operation_status in ('pending','processing','auth_applied','retry')),
      'oldest_pending_at',(select min(created_at) from tourney.tourney_player_auth_operations where operation_status in ('pending','processing','auth_applied','retry'))
    ),
    'discord',coalesce((select jsonb_object_agg(status,count) from discord_counts),'{}'::jsonb),
    'email',coalesce((select jsonb_object_agg(status,count) from email_counts),'{}'::jsonb),
    'identity_conflicts',(select count(*) from tourney.identity_conflicts where resolved_at is null),
    'last_parity',(select to_jsonb(run) from tourney.parity_runs run order by created_at desc limit 1),
    'shadow_reads',coalesce((select jsonb_object_agg(route,to_jsonb(shadow)-'route') from shadow),'{}'::jsonb),
    'clock_blockers',(select to_jsonb(blocker_values) from blockers)
  )
$$;

create or replace function public.roo_activate_tourney_schema_v4(p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_contract record;
begin
  if v_actor = '' or length(v_actor) > 120 then
    raise exception 'Tourney activation actor is invalid' using errcode = '22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id = 'tourney' for update;
  select schema_version into v_schema_version from tourney.schema_metadata
  where schema_name = 'tourney' for update;
  if v_meta.hardened_active and coalesce(v_schema_version, 0) >= 4 then
    return jsonb_build_object(
      'activated', true,
      'already_active', true,
      'generation', v_meta.generation,
      'schema_version', v_schema_version
    );
  end if;
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only
     or to_regclass('tourney.mirror_contracts') is null
     or to_regclass('tourney.account_snapshots') is null
     or to_regclass('tourney.external_operations') is null
     or to_regclass('accounts.discord_role_assignments') is null
     or to_regclass('tourney.shadow_latency_baselines') is null
     or (select count(*) from tourney.shadow_latency_baselines) <> 5 then
    raise exception 'Supabase Tourney activation safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
  if exists (
    with expected(logical_table, supabase_relation, legacy_relation, key_columns) as (
      values
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
    )
    select 1
    from expected
    full join tourney.mirror_contracts contract using(logical_table)
    where expected.logical_table is null or contract.logical_table is null
       or not contract.enabled
       or contract.supabase_relation is distinct from expected.supabase_relation
       or contract.legacy_relation is distinct from expected.legacy_relation
       or contract.key_columns is distinct from expected.key_columns
       or contract.allowed_columns is distinct from (
         select pg_catalog.array_agg(attribute.attname::text order by attribute.attnum)
         from pg_catalog.pg_attribute attribute
         where attribute.attrelid = expected.supabase_relation::regclass
           and attribute.attnum > 0 and not attribute.attisdropped
       )
  ) then
    raise exception 'Supabase Tourney mirror registry is incomplete or stale'
      using errcode = '55000';
  end if;

  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute format(
      'drop trigger if exists capture_tourney_mirror_event on %s',
      v_contract.supabase_relation::regclass
    );
    execute format(
      'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function tourney.capture_mirror_event_v4()',
      v_contract.supabase_relation::regclass
    );
  end loop;

  update tourney.cutover_metadata set
    hardened_active = true,
    clean_since = null,
    natural_mutation_verified_at = null,
    first_zero_drift_at = null,
    second_zero_drift_at = null,
    clock_last_reset_reason = 'fresh_hardening_window',
    updated_at = now(),
    updated_by = v_actor
  where id = 'tourney';
  -- Rows created by the expanded application before activation were not yet
  -- covered by v4 triggers. Queue an authoritative generation-1 bootstrap for
  -- every registered row while writes are paused; normal mirror checkpoints
  -- make any duplicate event harmless.
  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute pg_catalog.format(
      'insert into tourney.mirror_outbox(
         command_id,source_backend,generation,table_name,operation,
         record_key,record_data,record_hash,status
       )
       select $1 || '':'' || $2,''supabase'',1,$2,''upsert'',
         tourney.mirror_record_key($2,to_jsonb(source_row)),
         to_jsonb(source_row),
         pg_catalog.encode(extensions.digest(
           pg_catalog.convert_to(to_jsonb(source_row)::text,''UTF8''),''sha256''
         ),''hex''),
         ''pending''
       from %s source_row',
      v_contract.supabase_relation::regclass
    ) using 'schema-v4-bootstrap:' || v_actor, v_contract.logical_table;
  end loop;
  insert into tourney.cutover_gate_events (event_kind, generation, actor, evidence)
  values ('hardened_activated', v_meta.generation, v_actor,
    jsonb_build_object('schema_version', 4));
  insert into tourney.schema_metadata (schema_name, schema_version, updated_at)
  values ('tourney', 4, now())
  on conflict (schema_name) do update
  set schema_version = greatest(tourney.schema_metadata.schema_version, excluded.schema_version),
      updated_at = now();
  return jsonb_build_object(
    'activated', true,
    'already_active', false,
    'generation', v_meta.generation,
    'schema_version', 4
  );
end;
$$;

revoke all on function tourney.mirror_record_key(text, jsonb)
  from public, anon, authenticated;
revoke all on function tourney.capture_mirror_event_v4()
  from public, anon, authenticated;
revoke all on function public.roo_enqueue_tourney_fallback_bootstrap(text)
  from public, anon, authenticated;
revoke all on function tourney.history_uuid(text)
  from public, anon, authenticated;
revoke all on function tourney.refresh_cutover_clock(text)
  from public, anon, authenticated;
revoke all on function public.roo_import_tourney_snapshot_v4(jsonb, text, boolean)
  from public, anon, authenticated;
revoke all on function public.roo_tourney_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_activate_tourney_schema_v4(text)
  from public, anon, authenticated;
revoke all on function public.roo_backfill_tourney_email_history_v4(text)
  from public, anon, authenticated;
grant execute on function tourney.refresh_cutover_clock(text) to service_role;
grant execute on function public.roo_enqueue_tourney_fallback_bootstrap(text)
  to service_role;
grant execute on function public.roo_import_tourney_snapshot_v4(jsonb, text, boolean)
  to service_role;
grant execute on function public.roo_tourney_readiness() to service_role;
grant execute on function public.roo_activate_tourney_schema_v4(text)
  to service_role;
grant execute on function public.roo_backfill_tourney_email_history_v4(text)
  to service_role;
