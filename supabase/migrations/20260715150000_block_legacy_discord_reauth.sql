set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function migration.block_legacy_discord_reauth(
  p_apply boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate_count integer := 0;
  v_candidate_digest text := '';
  v_command_id text := '';
  v_control record;
  v_updated_count integer := 0;
  v_unresolved_count integer := 0;
begin
  select primary_backend, generation, writes_paused, hardened_active
  into v_control
  from tourney.cutover_metadata
  where id = 'tourney'
  for share;

  if not found then
    raise exception 'Tourney cutover controls are unavailable'
      using errcode = '55000';
  end if;

  select count(*)
  into v_unresolved_count
  from accounts.discord_role_assignments assignment
  where assignment.status in ('pending', 'retry', 'processing')
    and not exists (
      select 1
      from accounts.identity_links projected
      where projected.principal_id = assignment.principal_id
        and projected.provider = 'discord'
    )
    and not exists (
      select 1
      from auth.identities identity
      where identity.user_id = assignment.user_id
        and identity.provider = 'discord'
    );

  with candidates as (
    select assignment.principal_id, assignment.user_id,
      assignment.discord_user_id
    from accounts.discord_role_assignments assignment
    join accounts.principals principal
      on principal.id = assignment.principal_id
      and principal.status = 'active'
    join accounts.principal_auth_users mapping
      on mapping.user_id = assignment.user_id
      and mapping.principal_id = assignment.principal_id
    join tourney.tourney_players player
      on player.id = assignment.player_id
      and player.principal_id = assignment.principal_id
    where assignment.status in ('pending', 'retry', 'processing')
      and (
        assignment.status <> 'processing'
        or assignment.lease_expires_at is null
        or assignment.lease_expires_at <= now()
      )
      and assignment.lease_id is null
      and assignment.tourney_role = 'tourney_player'
      and assignment.desired_role = 'none'
      and assignment.applied_role = 'participant'
      and not exists (
        select 1
        from accounts.identity_links projected
        where projected.principal_id = assignment.principal_id
          and projected.provider = 'discord'
      )
      and not exists (
        select 1
        from auth.identities identity
        where identity.user_id = assignment.user_id
          and identity.provider = 'discord'
      )
      and not exists (
        select 1
        from tourney.external_operations operation
        where operation.operation_kind in (
            'discord_membership', 'discord_role_reconcile'
          )
          and operation.status in ('pending', 'processing', 'retry')
          and (
            operation.desired_state#>>'{assignment,principalId}' =
              assignment.principal_id::text
            or operation.desired_state#>>'{oauthProjection,principalId}' =
              assignment.principal_id::text
            or operation.entity_id = assignment.principal_id::text
          )
      )
  )
  select count(*), encode(extensions.digest(coalesce(string_agg(
    principal_id::text || ':' || user_id::text || ':' || discord_user_id,
    '|' order by principal_id
  ), ''), 'sha256'), 'hex')
  into v_candidate_count, v_candidate_digest
  from candidates;

  if p_apply and v_candidate_count <> v_unresolved_count then
    raise exception 'Ambiguous Discord re-auth assignments require review'
      using errcode = '21000',
        detail = pg_catalog.format(
          'eligible=%s unresolved=%s', v_candidate_count, v_unresolved_count
        );
  end if;

  if not p_apply or v_candidate_count = 0 then
    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'candidateCount', v_candidate_count,
      'unresolvedCount', v_unresolved_count,
      'candidateDigest', v_candidate_digest
    );
  end if;

  if v_control.primary_backend is distinct from 'supabase'
    or v_control.generation <> 1
    or not v_control.writes_paused
    or not v_control.hardened_active
  then
    raise exception 'Discord re-auth repair requires paused hardened Supabase generation 1'
      using errcode = '55000';
  end if;

  v_command_id := 'discord-reauth-block:' || v_candidate_digest;
  perform set_config('roo.tourney_backend', 'supabase', true);
  perform set_config('roo.tourney_mirror_enabled', '1', true);
  perform set_config('roo.tourney_generation', '1', true);
  perform set_config('roo.tourney_mirror_apply', '0', true);
  perform set_config('roo.tourney_command_id', v_command_id, true);

  insert into tourney.command_receipts (
    command_id, purpose, request_hash, status, result_status, result_body,
    generation, committed_at, completed_at, updated_at
  ) values (
    v_command_id,
    'discord:legacy-reauth-block',
    encode(extensions.digest(v_command_id, 'sha256'), 'hex'),
    'completed',
    200,
    jsonb_build_object(
      'ok', true,
      'blockedReauth', v_candidate_count,
      'reason', 'discord_auth_reconnect_required'
    ),
    1,
    now(),
    now(),
    now()
  ) on conflict (command_id) do nothing;

  update accounts.discord_role_assignments assignment
  set status = 'blocked_reauth',
    last_error = 'discord_auth_reconnect_required',
    blocked_at = now(),
    lease_id = null,
    lease_expires_at = null,
    updated_at = now()
  where assignment.status in ('pending', 'retry', 'processing')
    and (
      assignment.status <> 'processing'
      or assignment.lease_expires_at is null
      or assignment.lease_expires_at <= now()
    )
    and assignment.lease_id is null
    and assignment.tourney_role = 'tourney_player'
    and assignment.desired_role = 'none'
    and assignment.applied_role = 'participant'
    and exists (
      select 1
      from accounts.principals principal
      where principal.id = assignment.principal_id
        and principal.status = 'active'
    )
    and exists (
      select 1
      from accounts.principal_auth_users mapping
      where mapping.user_id = assignment.user_id
        and mapping.principal_id = assignment.principal_id
    )
    and exists (
      select 1
      from tourney.tourney_players player
      where player.id = assignment.player_id
        and player.principal_id = assignment.principal_id
    )
    and not exists (
      select 1
      from accounts.identity_links projected
      where projected.principal_id = assignment.principal_id
        and projected.provider = 'discord'
    )
    and not exists (
      select 1
      from auth.identities identity
      where identity.user_id = assignment.user_id
        and identity.provider = 'discord'
    )
    and not exists (
      select 1
      from tourney.external_operations operation
      where operation.operation_kind in (
          'discord_membership', 'discord_role_reconcile'
        )
        and operation.status in ('pending', 'processing', 'retry')
        and (
          operation.desired_state#>>'{assignment,principalId}' =
            assignment.principal_id::text
          or operation.desired_state#>>'{oauthProjection,principalId}' =
            assignment.principal_id::text
          or operation.entity_id = assignment.principal_id::text
        )
    );
  get diagnostics v_updated_count = row_count;

  if v_updated_count <> v_candidate_count then
    raise exception 'Discord re-auth repair candidate set changed'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'candidateCount', v_candidate_count,
    'unresolvedCount', v_unresolved_count,
    'candidateDigest', v_candidate_digest,
    'commandId', v_command_id
  );
end;
$$;

revoke all on function migration.block_legacy_discord_reauth(boolean)
  from public, anon, authenticated, service_role;
