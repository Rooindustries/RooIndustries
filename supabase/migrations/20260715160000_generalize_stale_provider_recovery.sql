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
    where recovery.case_type = 'payment'
      and recovery.status in ('open', 'retrying')
      and not recovery.requires_reschedule
      and payment.provider in ('paypal', 'razorpay')
      and recovery.reason = payment.provider || '_lookup_failed_404'
      and payment.status = 'needs_recovery'
      and payment.booking_id is null
      and payment.provider_payment_id is null
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

revoke all on function migration.terminalize_stale_provider_recoveries(boolean)
  from public, anon, authenticated, service_role;
