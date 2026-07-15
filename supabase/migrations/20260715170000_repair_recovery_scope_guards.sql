set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function migration.terminalize_stale_provider_recoveries(
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
  v_generation integer := 0;
  v_mutations jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_primary_backend text := '';
  v_starts_paused boolean := false;
begin
  select primary_backend, generation, starts_paused
  into v_primary_backend, v_generation, v_starts_paused
  from migration.commerce_control
  where singleton
  for share;

  if p_apply and (
    v_primary_backend is distinct from 'supabase'
    or v_generation <> 1
    or not v_starts_paused
  ) then
    raise exception 'stale provider recovery repair requires paused Supabase generation 1'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from commerce.recovery_cases recovery
    join commerce.payment_records payment
      on payment.id = recovery.payment_record_id
    join migration.source_documents payment_source
      on payment_source.legacy_sanity_id = payment.legacy_sanity_id
      and payment_source.document_type = 'paymentRecord'
      and not payment_source.tombstoned
    join migration.source_documents recovery_source
      on recovery_source.legacy_sanity_id = recovery.legacy_sanity_id
      and recovery_source.document_type = 'paymentRecoveryCase'
      and not recovery_source.tombstoned
    where recovery.case_type = 'payment'
      and recovery.status in ('open', 'retrying')
      and not recovery.requires_reschedule
      and payment.provider in ('paypal', 'razorpay')
      and recovery.reason = payment.provider || '_lookup_failed_404'
      and payment.status = 'needs_recovery'
      and payment.booking_id is null
      and payment.provider_payment_id is null
      and not payment.requires_reschedule
      and not payment.resource_release_pending
      and payment.recovery_attempt_count >= 24
      and coalesce(payment.source_created_at, payment.created_at)
        < v_now - interval '24 hours'
      and not exists (
        select 1
        from commerce.slot_holds hold
        where hold.payment_record_id = payment.id
          and hold.phase in ('active', 'payment')
      )
      and not exists (
        select 1
        from commerce.coupon_redemptions redemption
        where redemption.payment_record_id = payment.id
          and redemption.state = 'reserved'
      )
    group by payment.id
    having count(*) <> 1
  ) then
    raise exception 'ambiguous stale provider recovery cases'
      using errcode = '21000';
  end if;

  with candidates as (
    select
      payment.id payment_id,
      payment_source.legacy_sanity_id payment_document_id,
      payment_source.source_revision payment_revision,
      payment_source.payload payment_payload,
      recovery_source.legacy_sanity_id recovery_document_id,
      recovery_source.source_revision recovery_revision,
      recovery_source.payload recovery_payload
    from commerce.recovery_cases recovery
    join commerce.payment_records payment
      on payment.id = recovery.payment_record_id
    join migration.source_documents payment_source
      on payment_source.legacy_sanity_id = payment.legacy_sanity_id
      and payment_source.document_type = 'paymentRecord'
      and not payment_source.tombstoned
    join migration.source_documents recovery_source
      on recovery_source.legacy_sanity_id = recovery.legacy_sanity_id
      and recovery_source.document_type = 'paymentRecoveryCase'
      and not recovery_source.tombstoned
    where recovery.case_type = 'payment'
      and recovery.status in ('open', 'retrying')
      and not recovery.requires_reschedule
      and payment.provider in ('paypal', 'razorpay')
      and recovery.reason = payment.provider || '_lookup_failed_404'
      and payment.status = 'needs_recovery'
      and payment.booking_id is null
      and payment.provider_payment_id is null
      and not payment.requires_reschedule
      and not payment.resource_release_pending
      and payment.recovery_attempt_count >= 24
      and coalesce(payment.source_created_at, payment.created_at)
        < v_now - interval '24 hours'
      and not exists (
        select 1
        from commerce.slot_holds hold
        where hold.payment_record_id = payment.id
          and hold.phase in ('active', 'payment')
      )
      and not exists (
        select 1
        from commerce.coupon_redemptions redemption
        where redemption.payment_record_id = payment.id
          and redemption.state = 'reserved'
      )
  ), mutation_rows as (
    select
      payment_document_id document_id,
      jsonb_build_object(
        'operation', 'replace',
        'expected_revision', payment_revision,
        'document', payment_payload || jsonb_build_object(
          'status', 'abandoned',
          'recoveryReason', 'provider_order_not_found_after_recovery_window',
          'nextRecoveryAt', '',
          'lateCaptureWatchUntil', '',
          'resourceReleasePending', false,
          'resourceReleaseTargetStatus', '',
          'resourceReleaseReason', '',
          'providerRecoveryTerminal', true,
          'providerRecoveryTerminalAt', v_now,
          'providerRecoveryTerminalReason',
            'provider_order_not_found_after_recovery_window',
          'events', (
            case
              when jsonb_typeof(payment_payload->'events') = 'array'
                then payment_payload->'events'
              else '[]'::jsonb
            end
          ) || jsonb_build_array(jsonb_build_object(
            'status', 'abandoned',
            'source', 'migration',
            'reason', 'provider_order_not_found_after_recovery_window',
            'occurredAt', v_now
          ))
        )
      ) mutation
    from candidates
    union all
    select
      recovery_document_id,
      jsonb_build_object(
        'operation', 'replace',
        'expected_revision', recovery_revision,
        'document', recovery_payload || jsonb_build_object(
          'status', 'abandoned',
          'reason', 'provider_order_not_found_after_recovery_window',
          'nextAttemptAt', '',
          'leaseId', '',
          'leaseExpiresAt', '',
          'abandonedAt', v_now,
          'resolution', 'provider_order_not_found_after_recovery_window'
        )
      )
    from candidates
  )
  select
    (select count(*) from candidates),
    encode(extensions.digest(coalesce(
      (select string_agg(
        payment_document_id || ':' || coalesce(payment_revision, '') || ':' ||
        recovery_document_id || ':' || coalesce(recovery_revision, ''),
        '|' order by payment_document_id
      ) from candidates),
      ''
    ), 'sha256'), 'hex'),
    coalesce(jsonb_agg(mutation order by document_id), '[]'::jsonb)
  into v_candidate_count, v_candidate_digest, v_mutations
  from mutation_rows;

  if v_candidate_count = 0 or not p_apply then
    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'candidateCount', v_candidate_count,
      'candidateDigest', v_candidate_digest
    );
  end if;

  v_command_id := 'provider-recovery-terminal:' || v_candidate_digest;
  perform public.roo_apply_commerce_document_mutations(
    v_command_id,
    v_mutations,
    v_generation
  );

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'candidateCount', v_candidate_count,
    'candidateDigest', v_candidate_digest,
    'commandId', v_command_id
  );
end;
$$;

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
      from accounts.principal_auth_users auth_mapping
      join auth.identities identity
        on identity.user_id = auth_mapping.user_id
        and identity.provider = 'discord'
      where auth_mapping.principal_id = assignment.principal_id
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
        from accounts.principal_auth_users auth_mapping
        join auth.identities identity
          on identity.user_id = auth_mapping.user_id
          and identity.provider = 'discord'
        where auth_mapping.principal_id = assignment.principal_id
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
      from accounts.principal_auth_users auth_mapping
      join auth.identities identity
        on identity.user_id = auth_mapping.user_id
        and identity.provider = 'discord'
      where auth_mapping.principal_id = assignment.principal_id
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

revoke all on function migration.terminalize_stale_provider_recoveries(boolean)
  from public, anon, authenticated, service_role;
revoke all on function migration.block_legacy_discord_reauth(boolean)
  from public, anon, authenticated, service_role;
