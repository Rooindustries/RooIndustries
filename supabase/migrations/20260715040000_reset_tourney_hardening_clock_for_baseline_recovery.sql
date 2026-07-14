set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
declare
  v_meta tourney.cutover_metadata%rowtype;
  v_baselines integer;
  v_recovery_marked boolean;
begin
  select * into v_meta from tourney.cutover_metadata
  where id='tourney' for update;
  select count(*)::integer into v_baselines
  from tourney.shadow_latency_baselines;
  select exists(
    select 1 from tourney.cutover_gate_events
    where event_kind='clock_reset'
      and evidence @> '{"baseline_recovery_clock_reset":true}'::jsonb
  ) into v_recovery_marked;
  if v_meta.id is null or not v_meta.hardened_active
     or v_baselines <> 0 or v_recovery_marked then
    return;
  end if;
  if v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1
     or not v_meta.writes_paused
     or v_meta.fallback_read_only
     or coalesce((
       select schema_version from tourney.schema_metadata
       where schema_name='tourney'
     ),0) < 4
     or v_meta.clean_since is not null
     or v_meta.first_zero_drift_at is not null
     or v_meta.second_zero_drift_at is not null
     or exists(
       select 1 from tourney.cutover_gate_events
       where event_kind='hardened_activated'
         and evidence @> '{"baseline_recovery":true}'::jsonb
     ) then
    raise exception 'Tourney baseline recovery clock reset is not safe'
      using errcode='55000';
  end if;
  update tourney.cutover_metadata set
    clean_since=null,
    natural_mutation_verified_at=null,
    first_zero_drift_at=null,
    second_zero_drift_at=null,
    clock_last_evaluated_at=now(),
    clock_last_reset_reason='fresh_hardening_window',
    updated_at=now(),
    updated_by='schema-v4-baseline-recovery'
  where id='tourney';
  insert into tourney.cutover_gate_events(
    event_kind,generation,actor,evidence
  ) values(
    'clock_reset',v_meta.generation,'schema-v4-baseline-recovery',
    pg_catalog.jsonb_build_object(
      'reason','fresh_hardening_window',
      'baseline_recovery_clock_reset',true,
      'previous_natural_mutation_verified_at',
        v_meta.natural_mutation_verified_at
    )
  );
end;
$$;
