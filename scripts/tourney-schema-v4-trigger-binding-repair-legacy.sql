set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
  v_meta public.tourney_cutover_metadata%rowtype;
  v_schema_version integer;
begin
  select * into v_meta
  from public.tourney_cutover_metadata
  where id = 'tourney'
  for update;
  select schema_version into v_schema_version
  from public.tourney_schema_metadata
  where schema_name = 'tourney'
  for update;
  if v_meta.id is null
     or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only
     or not v_meta.hardened_active
     or coalesce(v_schema_version, 0) < 4
     or to_regclass('public.tourney_mirror_contracts') is null
     or to_regprocedure('public.tourney_mirror_record_key(text,jsonb)') is null
     or to_regprocedure('public.digest(bytea,text)') is null then
    raise exception 'Legacy Tourney trigger repair safety preconditions are not satisfied'
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
  insert into public.tourney_mirror_outbox(
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data, record_hash, status
  ) values(
    v_command_id, 'legacy', v_meta.generation, v_logical_table,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    v_key, v_data, v_hash, 'pending'
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.tourney_mirror_trigger_binding_status_v4()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with function_state as (
    select function.oid,
      pg_catalog.md5(function.prosrc) = '36214a1fe065a142c2d83684c9f8e7d6' body_matches,
      not function.prosecdef security_invoker,
      function.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype returns_trigger,
      language.lanname = 'plpgsql' language_matches,
      exists(
        select 1 from pg_catalog.unnest(coalesce(function.proconfig, '{}'::text[])) setting
        where pg_catalog.split_part(setting, '=', 1) = 'search_path'
          and pg_catalog.replace(pg_catalog.split_part(setting, '=', 2), '"', '') = ''
      ) empty_search_path,
      pg_catalog.md5(function.prosrc) body_hash
    from pg_catalog.pg_proc function
    join pg_catalog.pg_language language on language.oid = function.prolang
    where function.oid = pg_catalog.to_regprocedure('public.capture_tourney_mirror_event()')
  ), bindings as (
    select contract.logical_table,
      pg_catalog.to_regclass(
        pg_catalog.format('public.%I', contract.legacy_relation)
      ) relation_oid,
      trigger.oid trigger_oid,
      trigger.tgfoid,
      trigger.tgtype,
      trigger.tgenabled,
      trigger.tgisinternal
    from public.tourney_mirror_contracts contract
    left join pg_catalog.pg_trigger trigger
      on trigger.tgrelid = pg_catalog.to_regclass(
        pg_catalog.format('public.%I', contract.legacy_relation)
      )
     and trigger.tgname = 'capture_tourney_mirror_event'
    where contract.enabled
  ), summary as (
    select pg_catalog.count(*)::integer enabled_contracts,
      pg_catalog.count(*) filter(
        where binding.trigger_oid is not null
          and binding.tgfoid = function_state.oid
          and binding.tgtype = 29
          and binding.tgenabled = 'O'
          and not binding.tgisinternal
      )::integer correctly_bound,
      coalesce(
        pg_catalog.jsonb_agg(binding.logical_table order by binding.logical_table)
          filter(where binding.trigger_oid is null
            or binding.tgfoid is distinct from function_state.oid
            or binding.tgtype <> 29
            or binding.tgenabled <> 'O'
            or binding.tgisinternal),
        '[]'::jsonb
      ) drifted_tables
    from bindings binding
    cross join function_state
  )
  select pg_catalog.jsonb_build_object(
    'ready', coalesce(
      function_state.body_matches
      and function_state.security_invoker
      and function_state.returns_trigger
      and function_state.language_matches
      and function_state.empty_search_path
      and summary.enabled_contracts = 17
      and summary.correctly_bound = summary.enabled_contracts,
      false
    ),
    'contract_version', 'v4-fail-closed-20260715',
    'enabled_contracts', coalesce(summary.enabled_contracts, 0),
    'correctly_bound', coalesce(summary.correctly_bound, 0),
    'drifted_tables', coalesce(summary.drifted_tables, '[]'::jsonb),
    'function_oid', function_state.oid,
    'function_body_hash', function_state.body_hash,
    'function_body_matches', coalesce(function_state.body_matches, false),
    'security_invoker', coalesce(function_state.security_invoker, false),
    'empty_search_path', coalesce(function_state.empty_search_path, false)
  )
  from summary
  full join function_state on true
$$;

do $$
declare
  v_contract record;
  v_status jsonb;
begin
  for v_contract in
    select logical_table, legacy_relation
    from public.tourney_mirror_contracts
    where enabled
    order by logical_table
  loop
    execute pg_catalog.format(
      'drop trigger if exists capture_tourney_mirror_event on %s',
      pg_catalog.to_regclass(
        pg_catalog.format('public.%I', v_contract.legacy_relation)
      )
    );
    execute pg_catalog.format(
      'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function public.capture_tourney_mirror_event()',
      pg_catalog.to_regclass(
        pg_catalog.format('public.%I', v_contract.legacy_relation)
      )
    );
  end loop;
  v_status := public.tourney_mirror_trigger_binding_status_v4();
  if not coalesce((v_status->>'ready')::boolean, false) then
    raise exception 'Legacy Tourney mirror trigger repair verification failed'
      using errcode = '55000';
  end if;
  update public.tourney_cutover_metadata set
    clean_since = null,
    natural_mutation_verified_at = null,
    first_zero_drift_at = null,
    second_zero_drift_at = null,
    clock_last_reset_reason = 'mirror_trigger_binding_repaired',
    updated_at = pg_catalog.now()
  where id = 'tourney';
  insert into public.tourney_cutover_gate_events(
    event_kind, generation, actor, evidence
  ) values(
    'clock_reset', 1, 'mirror-trigger-binding-repair-v4',
    pg_catalog.jsonb_build_object(
      'reason', 'mirror_trigger_binding_repaired',
      'contract_version', v_status->>'contract_version',
      'correctly_bound', (v_status->>'correctly_bound')::integer
    )
  );
end;
$$;

revoke all on function public.capture_tourney_mirror_event() from public;
revoke all on function public.tourney_mirror_trigger_binding_status_v4()
  from public;
