-- Keep Tourney account imports monotonic and preserve Discord retry state when
-- canonical account synchronization refreshes an unchanged assignment.

alter table accounts.discord_role_assignments
  add column if not exists stale_discord_user_ids text[] not null default '{}'::text[];

create or replace function public.roo_import_tourney_player_account_v2(p_account jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_player_id text := btrim(p_account->>'player_id');
  v_status text := lower(coalesce(p_account->>'status', 'pending'));
  v_source_hash text := lower(btrim(p_account->>'source_hash'));
  v_version_text text := coalesce(nullif(p_account->>'credential_version', ''), '1');
  v_version bigint;
  v_existing accounts.tourney_accounts%rowtype;
begin
  if v_player_id = ''
     or coalesce(v_source_hash, '') !~ '^[0-9a-f]{64}$'
     or v_version_text !~ '^[0-9]+$'
     or v_status not in ('pending','approved','denied','withdrawn','removed','disabled') then
    raise exception 'tourney player account version is invalid' using errcode = '22023';
  end if;
  v_version := v_version_text::bigint;
  if v_version < 1 then
    raise exception 'tourney player account version is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('tourney-player-import:' || v_player_id, 0)
  );
  select * into v_existing
  from accounts.tourney_accounts account
  where account.user_id = v_user_id
     or account.legacy_sanity_id = v_player_id
  order by (account.user_id = v_user_id) desc
  limit 1
  for update;

  if found then
    if v_existing.credential_version !~ '^[0-9]+$' then
      raise exception 'stored tourney player account version is invalid' using errcode = '22023';
    end if;
    if v_existing.credential_version::bigint > v_version
       or (
         v_existing.credential_version::bigint = v_version
         and (
           v_existing.lifecycle_status <> v_status
           or v_existing.source_hash is distinct from v_source_hash
         )
       ) then
      return jsonb_build_object(
        'user_id', v_existing.user_id,
        'imported', false,
        'stale', true,
        'credential_version', v_existing.credential_version,
        'lifecycle_status', v_existing.lifecycle_status
      );
    end if;
  end if;

  v_result := public.roo_import_tourney_player_account(p_account);
  update accounts.tourney_accounts account
  set lifecycle_status = v_status,
      active = v_status = 'approved',
      updated_at = now()
  where account.user_id = v_user_id
    and account.credential_version = v_version_text;
  perform public.roo_reconcile_auth_identity_links(v_user_id);
  return v_result || jsonb_build_object(
    'stale', false,
    'credential_version', v_version_text,
    'lifecycle_status', v_status
  );
end;
$$;

create or replace function public.roo_refresh_discord_role_assignment(
  p_user_id uuid,
  p_guild_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_discord_user_id text;
  v_tourney accounts.tourney_accounts%rowtype;
  v_desired_role text := 'none';
  v_row accounts.discord_role_assignments%rowtype;
begin
  if p_user_id is null or p_guild_id !~ '^[0-9]{5,30}$' then
    raise exception 'Discord role assignment request is invalid' using errcode = '22023';
  end if;
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping where mapping.user_id = p_user_id;
  if v_principal_id is null then
    raise exception 'Account principal was not found' using errcode = 'P0002';
  end if;
  select * into v_tourney from accounts.tourney_accounts account
  where account.principal_id = v_principal_id;
  select identity_link.provider_subject into v_discord_user_id
  from accounts.identity_links identity_link
  where identity_link.principal_id = v_principal_id
    and identity_link.provider = 'discord'
  limit 1;

  if v_tourney.user_id is null then
    return jsonb_build_object('queued', false, 'reason', 'tourney_not_linked');
  end if;
  v_desired_role := case
    when not v_tourney.active or v_tourney.lifecycle_status <> 'approved' then 'none'
    when v_tourney.role = 'tourney_player' then 'participant'
    when v_tourney.role in ('tourney_owner', 'tourney_caster') then 'host'
    else 'none'
  end;

  if v_discord_user_id is null then
    update accounts.discord_role_assignments assignment set
      user_id = v_tourney.user_id,
      player_id = case when v_tourney.role = 'tourney_player'
        then v_tourney.legacy_sanity_id else null end,
      previous_discord_user_id = assignment.discord_user_id,
      desired_role = 'none', tourney_role = v_tourney.role,
      generation = case when assignment.desired_role <> 'none'
        then assignment.generation + 1 else assignment.generation end,
      status = case
        when assignment.desired_role = 'none'
          and assignment.status = 'applied'
          and assignment.applied_role = 'none'
          and assignment.applied_generation = assignment.generation
          then 'applied'
        else 'pending' end,
      attempt_count = case when assignment.desired_role <> 'none'
        then 0 else assignment.attempt_count end,
      lease_id = null, lease_expires_at = null,
      last_error = null, blocked_at = null, updated_at = now()
    where assignment.principal_id = v_principal_id returning * into v_row;
    if not found then
      return jsonb_build_object('queued', false, 'reason', 'discord_not_linked');
    end if;
  else
    insert into accounts.discord_role_assignments (
      user_id, principal_id, player_id, discord_user_id, guild_id, tourney_role,
      desired_role, status
    ) values (
      v_tourney.user_id, v_principal_id,
      case when v_tourney.role = 'tourney_player' then v_tourney.legacy_sanity_id else null end,
      v_discord_user_id, p_guild_id, v_tourney.role, v_desired_role, 'pending'
    ) on conflict (principal_id) do update set
      user_id = excluded.user_id,
      player_id = excluded.player_id,
      stale_discord_user_ids = case
        when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        then array(
          select distinct stale_id from unnest(
            coalesce(accounts.discord_role_assignments.stale_discord_user_ids, '{}'::text[])
            || array[accounts.discord_role_assignments.discord_user_id]
          ) stale_id
          where stale_id is not null and stale_id <> excluded.discord_user_id
        )
        else accounts.discord_role_assignments.stale_discord_user_ids end,
      previous_discord_user_id = case
        when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
          then accounts.discord_role_assignments.discord_user_id
        else accounts.discord_role_assignments.previous_discord_user_id end,
      discord_user_id = excluded.discord_user_id,
      guild_id = excluded.guild_id,
      tourney_role = excluded.tourney_role,
      desired_role = excluded.desired_role,
      generation = case when
        accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        or accounts.discord_role_assignments.guild_id <> excluded.guild_id
        or accounts.discord_role_assignments.tourney_role is distinct from excluded.tourney_role
        or accounts.discord_role_assignments.desired_role <> excluded.desired_role
        then accounts.discord_role_assignments.generation + 1
        else accounts.discord_role_assignments.generation end,
      status = case
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          and accounts.discord_role_assignments.status in ('blocked','blocked_reauth')
          then 'blocked_reauth'
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          and accounts.discord_role_assignments.status = 'applied'
          and accounts.discord_role_assignments.applied_generation = accounts.discord_role_assignments.generation
          and accounts.discord_role_assignments.applied_role = excluded.desired_role
          then 'applied'
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          then accounts.discord_role_assignments.status
        else 'pending' end,
      attempt_count = case when
        accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        or accounts.discord_role_assignments.guild_id <> excluded.guild_id
        or accounts.discord_role_assignments.tourney_role is distinct from excluded.tourney_role
        or accounts.discord_role_assignments.desired_role <> excluded.desired_role
        then 0 else accounts.discord_role_assignments.attempt_count end,
      lease_id = case
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          and accounts.discord_role_assignments.status = 'processing'
          then accounts.discord_role_assignments.lease_id
        else null end,
      lease_expires_at = case
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          and accounts.discord_role_assignments.status = 'processing'
          then accounts.discord_role_assignments.lease_expires_at
        else null end,
      last_error = case
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          then accounts.discord_role_assignments.last_error
        else null end,
      blocked_at = case
        when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
          and accounts.discord_role_assignments.guild_id = excluded.guild_id
          and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
          and accounts.discord_role_assignments.desired_role = excluded.desired_role
          and accounts.discord_role_assignments.status in ('blocked','blocked_reauth')
          then coalesce(
            accounts.discord_role_assignments.blocked_at,
            accounts.discord_role_assignments.updated_at
          )
        else null end,
      updated_at = now()
    returning * into v_row;
  end if;
  return jsonb_build_object(
    'queued', true, 'user_id', v_row.user_id,
    'principal_id', v_row.principal_id,
    'player_id', v_row.player_id,
    'discord_user_id', v_row.discord_user_id,
    'previous_discord_user_id', v_row.previous_discord_user_id,
    'stale_discord_user_ids', v_row.stale_discord_user_ids,
    'guild_id', v_row.guild_id, 'tourney_role', v_row.tourney_role,
    'desired_role', v_row.desired_role, 'applied_role', v_row.applied_role,
    'generation', v_row.generation, 'status', v_row.status
  );
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
    when exists (
      select 1 from accounts.discord_role_assignments
      where status in ('dead_letter','blocked','blocked_reauth')
    ) then 'discord_blocker'
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
      case when exists(select 1 from accounts.discord_role_assignments where status in ('dead_letter','blocked','blocked_reauth')) then 'discord_blocker' end,
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
