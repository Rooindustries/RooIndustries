set lock_timeout = '5s';
set statement_timeout = '120s';

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
  v_recovery boolean := false;
begin
  if nullif(pg_catalog.btrim(p_actor), '') is null or length(p_actor) > 120 then
    raise exception 'Tourney latency baseline actor is invalid' using errcode='22023';
  end if;
  select * into v_meta from tourney.cutover_metadata
  where id='tourney' for update;
  v_recovery := coalesce(v_meta.hardened_active,false);
  if v_meta.id is null
     or (
       v_meta.hardened_active
       and (
         exists(select 1 from tourney.shadow_latency_baselines)
         or v_meta.clean_since is not null
         or v_meta.natural_mutation_verified_at is not null
         or v_meta.first_zero_drift_at is not null
         or v_meta.second_zero_drift_at is not null
         or exists(
           select 1 from tourney.cutover_gate_events
           where event_kind='hardened_activated'
             and evidence @> '{"baseline_recovery":true}'::jsonb
         )
         or coalesce((
           select schema_version from tourney.schema_metadata
           where schema_name='tourney'
         ),0) < 4
       )
     )
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
  if v_recovery then
    insert into tourney.cutover_gate_events(
      event_kind,generation,actor,evidence
    ) values(
      'hardened_activated',v_meta.generation,pg_catalog.btrim(p_actor),
      pg_catalog.jsonb_build_object(
        'baseline_recovery',true,'captured',v_captured
      )
    );
  end if;
  return jsonb_build_object('captured',v_captured);
end;
$$;

revoke all on function public.roo_capture_tourney_shadow_latency_baseline(text)
  from public, anon, authenticated;
grant execute on function public.roo_capture_tourney_shadow_latency_baseline(text)
  to service_role;
