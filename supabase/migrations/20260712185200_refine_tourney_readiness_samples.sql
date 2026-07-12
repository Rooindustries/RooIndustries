create or replace function public.roo_tourney_readiness()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with player_counts as (
    select status, count(*)::integer as count
    from tourney.tourney_players group by status
  ), ranked_shadow as (
    select observation.*, row_number() over (
      partition by route order by observed_at desc, id desc
    ) as sample_rank
    from tourney.shadow_observations observation
  ), shadow as (
    select route,
      count(*) filter (where shape_match and value_match and ordering_match and error_match)::integer as matching,
      count(*)::integer as sampled,
      percentile_cont(0.95) within group (order by primary_latency_ms)::integer as primary_p95_ms,
      percentile_cont(0.95) within group (order by shadow_latency_ms)::integer as shadow_p95_ms
    from ranked_shadow
    where sample_rank <= 30
    group by route
  )
  select jsonb_build_object(
    'control', (select to_jsonb(metadata) - 'updated_by' from tourney.cutover_metadata metadata where id = 'tourney'),
    'player_counts', coalesce((select jsonb_object_agg(status, count) from player_counts), '{}'::jsonb),
    'table_counts', jsonb_build_object(
      'players', (select count(*) from tourney.tourney_players),
      'tokens', (select count(*) from tourney.tourney_player_tokens),
      'teams', (select count(*) from tourney.tourney_bracket_teams),
      'team_members', (select count(*) from tourney.tourney_bracket_team_members),
      'appeals', (select count(*) from tourney.tourney_appeals),
      'payouts', (select count(*) from tourney.tourney_payouts)
    ),
    'mirror', jsonb_build_object(
      'pending', (select count(*) from tourney.mirror_outbox where applied_at is null),
      'oldest_pending_at', (select min(occurred_at) from tourney.mirror_outbox where applied_at is null),
      'failed', (select count(*) from tourney.mirror_outbox where applied_at is null and last_error_at is not null)
    ),
    'identity_conflicts', (select count(*) from tourney.identity_conflicts where resolved_at is null),
    'email_retries', (select count(*) from tourney.email_dispatches where status in ('pending', 'retry', 'sending', 'failed')),
    'discord_retries', (select count(*) from accounts.discord_role_assignments where desired_role <> applied_role or last_error is not null),
    'last_parity', (select to_jsonb(run) from tourney.parity_runs run order by created_at desc limit 1),
    'shadow_reads', coalesce((select jsonb_object_agg(route, to_jsonb(shadow) - 'route') from shadow), '{}'::jsonb)
  )
$$;

revoke all on function public.roo_tourney_readiness() from public, anon, authenticated;
grant execute on function public.roo_tourney_readiness() to service_role;
