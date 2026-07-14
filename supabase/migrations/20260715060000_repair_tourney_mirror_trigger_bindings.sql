set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
begin
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  select schema_version into v_schema_version
  from tourney.schema_metadata
  where schema_name = 'tourney'
  for update;
  if v_meta.id is null then
    raise exception 'Supabase Tourney trigger repair metadata is unavailable'
      using errcode = '55000';
  end if;
  if v_meta.hardened_active and (
    v_meta.primary_backend <> 'supabase'
    or v_meta.generation <> 1
    or not v_meta.writes_paused
    or v_meta.fallback_read_only
    or coalesce(v_schema_version, 0) < 4
  ) then
    raise exception 'Supabase Tourney trigger repair safety preconditions are not satisfied'
      using errcode = '55000';
  end if;
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

create or replace function tourney.mirror_trigger_binding_status_v4()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with function_state as (
    select function.oid,
      pg_catalog.md5(function.prosrc) = '1be94fec31148130bf7137c33dc45d52' body_matches,
      function.prosecdef security_definer,
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
    where function.oid = pg_catalog.to_regprocedure('tourney.capture_mirror_event_v4()')
  ), bindings as (
    select contract.logical_table,
      contract.supabase_relation::pg_catalog.regclass relation_oid,
      trigger.oid trigger_oid,
      trigger.tgfoid,
      trigger.tgtype,
      trigger.tgenabled,
      trigger.tgisinternal
    from tourney.mirror_contracts contract
    left join pg_catalog.pg_trigger trigger
      on trigger.tgrelid = contract.supabase_relation::pg_catalog.regclass
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
      and function_state.security_definer
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
    'security_definer', coalesce(function_state.security_definer, false),
    'empty_search_path', coalesce(function_state.empty_search_path, false)
  )
  from summary
  full join function_state on true
$$;

do $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_schema_version integer;
  v_contract record;
  v_status jsonb;
begin
  select * into v_meta
  from tourney.cutover_metadata
  where id = 'tourney'
  for update;
  select schema_version into v_schema_version
  from tourney.schema_metadata
  where schema_name = 'tourney'
  for update;
  if v_meta.id is null then
    raise exception 'Supabase Tourney trigger repair metadata is unavailable'
      using errcode = '55000';
  end if;
  if v_meta.hardened_active then
    if v_meta.primary_backend <> 'supabase'
       or v_meta.generation <> 1
       or not v_meta.writes_paused
       or v_meta.fallback_read_only
       or coalesce(v_schema_version, 0) < 4 then
      raise exception 'Supabase Tourney trigger repair safety preconditions are not satisfied'
        using errcode = '55000';
    end if;
    for v_contract in
      select logical_table, supabase_relation
      from tourney.mirror_contracts
      where enabled
      order by logical_table
    loop
      execute pg_catalog.format(
        'drop trigger if exists capture_tourney_mirror_event on %s',
        v_contract.supabase_relation::pg_catalog.regclass
      );
      execute pg_catalog.format(
        'create trigger capture_tourney_mirror_event after insert or update or delete on %s for each row execute function tourney.capture_mirror_event_v4()',
        v_contract.supabase_relation::pg_catalog.regclass
      );
    end loop;
    v_status := tourney.mirror_trigger_binding_status_v4();
    if not coalesce((v_status->>'ready')::boolean, false) then
      raise exception 'Supabase Tourney mirror trigger repair verification failed'
        using errcode = '55000';
    end if;
    update tourney.cutover_metadata set
      clean_since = null,
      natural_mutation_verified_at = null,
      first_zero_drift_at = null,
      second_zero_drift_at = null,
      clock_last_reset_reason = 'mirror_trigger_binding_repaired',
      updated_at = pg_catalog.now(),
      updated_by = 'mirror-trigger-binding-repair-v4'
    where id = 'tourney';
    insert into tourney.cutover_gate_events(
      event_kind, generation, actor, evidence
    ) values(
      'clock_reset', v_meta.generation, 'mirror-trigger-binding-repair-v4',
      pg_catalog.jsonb_build_object(
        'reason', 'mirror_trigger_binding_repaired',
        'contract_version', v_status->>'contract_version',
        'correctly_bound', (v_status->>'correctly_bound')::integer
      )
    );
  end if;
end;
$$;

alter function public.roo_tourney_readiness()
  rename to roo_tourney_readiness_before_trigger_binding_v4;

create function public.roo_tourney_readiness()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_binding jsonb;
  v_blockers jsonb;
  v_ready boolean;
  v_shadow_reads jsonb;
begin
  v_result := public.roo_tourney_readiness_before_trigger_binding_v4();
  v_binding := tourney.mirror_trigger_binding_status_v4();
  v_ready := coalesce((v_binding->>'ready')::boolean, false);
  v_blockers := coalesce(v_result->'clock_blockers', '[]'::jsonb);
  if not v_ready and not exists(
    select 1 from pg_catalog.jsonb_array_elements_text(v_blockers) blocker
    where blocker = 'mirror_trigger_binding_drift'
  ) then
    v_blockers := v_blockers || pg_catalog.jsonb_build_array('mirror_trigger_binding_drift');
  end if;
  with ranked as (
    select observation.*,
      pg_catalog.row_number() over(
        partition by observation.route
        order by observation.observed_at desc, observation.id desc
      ) sample_rank
    from tourney.shadow_observations observation
  ), summary as (
    select route,
      pg_catalog.count(*)::integer samples,
      pg_catalog.count(*) filter(where not(
        shape_match and value_match and ordering_match and error_match
        and coalesce(primary_status between 200 and 299, false)
        and coalesce(shadow_status between 200 and 299, false)
      ))::integer mismatches,
      pg_catalog.percentile_cont(0.95) within group(
        order by primary_latency_ms
      )::integer primary_p95_ms,
      pg_catalog.percentile_cont(0.95) within group(
        order by shadow_latency_ms
      )::integer shadow_p95_ms,
      pg_catalog.max(observed_at) last_observed_at
    from ranked
    where sample_rank <= 30
    group by route
  )
  select coalesce(
    pg_catalog.jsonb_object_agg(route, pg_catalog.to_jsonb(summary)-'route'),
    '{}'::jsonb
  ) into v_shadow_reads
  from summary;
  return v_result || pg_catalog.jsonb_build_object(
    'mirror_trigger_bindings', v_binding,
    'clock_blockers', v_blockers,
    'shadow_reads_since_natural_mutation',
      coalesce(v_result->'shadow_reads', '{}'::jsonb),
    'shadow_reads', v_shadow_reads,
    'legacy_read_only_eligible',
      coalesce((v_result->>'legacy_read_only_eligible')::boolean, false)
      and v_ready
  );
end;
$$;

alter function public.roo_activate_tourney_schema_v4(text)
  rename to roo_activate_tourney_schema_v4_before_trigger_binding_v4;

create function public.roo_activate_tourney_schema_v4(p_actor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_binding jsonb;
begin
  v_result := public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(p_actor);
  v_binding := tourney.mirror_trigger_binding_status_v4();
  if not coalesce((v_binding->>'ready')::boolean, false) then
    raise exception 'Supabase Tourney activation mirror trigger verification failed'
      using errcode = '55000';
  end if;
  return v_result || pg_catalog.jsonb_build_object(
    'mirror_trigger_bindings_verified', true,
    'mirror_trigger_contract_version', v_binding->>'contract_version'
  );
end;
$$;

revoke all on function tourney.capture_mirror_event_v4()
  from public, anon, authenticated, service_role;
revoke all on function tourney.mirror_trigger_binding_status_v4()
  from public, anon, authenticated, service_role;
revoke all on function public.roo_tourney_readiness_before_trigger_binding_v4()
  from public, anon, authenticated, service_role;
revoke all on function public.roo_activate_tourney_schema_v4_before_trigger_binding_v4(text)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_tourney_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_activate_tourney_schema_v4(text)
  from public, anon, authenticated;
grant execute on function public.roo_tourney_readiness() to service_role;
grant execute on function public.roo_activate_tourney_schema_v4(text)
  to service_role;
