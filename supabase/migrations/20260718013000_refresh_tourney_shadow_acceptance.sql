set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function tourney.current_shadow_acceptance_gate_passes()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
    from (values
      ('public_roster', 750),
      ('public_bracket', 750),
      ('admin_players', 1000),
      ('appeals', 1000),
      ('payouts', 1000)
    ) required(route, maximum_p95_ms)
    left join lateral (
      select
        count(*)::integer samples,
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
        select observation.*
        from tourney.shadow_observations observation
        where observation.route = required.route
          and observation.observed_at >= coalesce((
            select metadata.natural_mutation_verified_at
            from tourney.cutover_metadata metadata
            where metadata.id = 'tourney'
          ), 'infinity'::timestamptz)
        order by observation.observed_at desc, observation.id desc
        limit 30
      ) sample
    ) summary on true
    left join tourney.shadow_latency_baselines baseline
      on baseline.route = required.route
    where coalesce(summary.samples, 0) < 30
      or coalesce(summary.mismatches, 0) > 0
      or coalesce(summary.primary_p95_ms, 2147483647) >= required.maximum_p95_ms
      or coalesce(summary.shadow_p95_ms, 2147483647) >= required.maximum_p95_ms
      or baseline.route is null
      or summary.primary_p95_ms > baseline.primary_p95_ms * 1.2
  );
$$;

update tourney.cutover_metadata metadata
set
  clock_last_reset_reason = null,
  clock_last_evaluated_at = pg_catalog.clock_timestamp(),
  updated_at = pg_catalog.clock_timestamp(),
  updated_by = 'current_shadow_acceptance_contract'
where metadata.id = 'tourney'
  and metadata.clock_last_reset_reason = 'shadow_acceptance_gate_failed'
  and tourney.current_shadow_acceptance_gate_passes();

revoke all on function tourney.current_shadow_acceptance_gate_passes()
  from public, anon, authenticated, service_role;
