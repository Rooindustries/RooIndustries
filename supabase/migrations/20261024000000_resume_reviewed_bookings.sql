set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function commerce.payment_review_can_resume(payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(payload->>'status', '') in
      ('started', 'needs_recovery', 'finalizing', 'captured_client', 'captured_webhook')
    and coalesce(payload->'holdSnapshot'->>'slotHoldId', '') != ''
    and coalesce(payload->'holdSnapshot'->>'slotHoldToken', '') != ''
    and coalesce(payload->'bookingPayload'->>'startTimeUTC', '') != ''
    and coalesce(payload->'bookingPayload'->>'packageTitle', '') != ''
    and coalesce(payload->>'bookingId', '') = ''
    and coalesce(payload->'bookingPayload'->>'originalOrderId', '') = ''
    and coalesce(payload->>'resourceReleasePending', 'false') != 'true'
    and coalesce(payload->>'dodoDisputeActive', 'false') != 'true'
    and coalesce(payload->>'refundState', '') != 'full'
    and coalesce(payload->>'providerRefundDetailsMissing', 'false') != 'true'
    and coalesce(payload->>'providerRecoveryTerminal', 'false') != 'true'
    and (coalesce(payload->>'reviewPending', 'false') = 'true'
      or coalesce(payload->>'reconciliationRecoveryTerminal', 'false') = 'true');
$$;

create or replace function migration.require_payment_hold_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim commerce.slot_claims%rowtype;
  v_previous commerce.slot_holds%rowtype;
begin
  if new.phase <> 'payment' then return new; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commerce-slot:' || new.start_time_utc::text, 0)
  );
  select * into v_claim from commerce.slot_claims
    where start_time_utc = new.start_time_utc for update;
  if found then
    if v_claim.claim_type = 'hold' and v_claim.hold_id = new.id then return new; end if;
    raise exception 'payment start requires an owned slot claim'
      using errcode = '23505', constraint = 'slot_claims_pkey';
  end if;
  select * into v_previous from commerce.slot_holds where id = new.id;
  if v_previous.phase in ('released', 'expired')
    and v_previous.release_reason in ('payment_recovery_hold_expired', 'expired_by_operational_cleanup')
    and v_previous.start_time_utc = new.start_time_utc
    and new.expires_at > pg_catalog.clock_timestamp()
    and exists (
      select 1 from commerce.payment_records payment
      join migration.source_documents source using (legacy_sanity_id)
      join migration.source_documents hold_source on hold_source.legacy_sanity_id = new.legacy_sanity_id
      where payment.id = new.payment_record_id and not source.tombstoned and not hold_source.tombstoned
        and source.backend_owner = hold_source.backend_owner
        and source.cutover_generation = hold_source.cutover_generation
        and source.payload->'holdSnapshot'->>'slotHoldId' = new.legacy_sanity_id
        and migration.try_timestamptz(source.payload->'bookingPayload'->>'startTimeUTC') = new.start_time_utc
        and commerce.payment_review_can_resume(source.payload)
    )
    and not exists (
      select 1 from commerce.booking_slots slot
      where slot.start_time_utc = new.start_time_utc and slot.status = 'active'
    )
    and not exists (
      select 1 from commerce.slot_holds hold
      where hold.start_time_utc = new.start_time_utc and hold.id <> new.id
        and hold.phase in ('active', 'payment') and hold.expires_at > pg_catalog.clock_timestamp()
    ) then
      insert into commerce.slot_claims (
        start_time_utc, claim_type, hold_id, expires_at, claimed_at,
        legacy_sanity_id, source_revision, source_hash, backend_owner
      ) values (
        new.start_time_utc, 'hold', new.id, new.expires_at, pg_catalog.clock_timestamp(),
        new.legacy_sanity_id, new.source_revision, new.source_hash, new.backend_owner
      );
      return new;
  end if;
  raise exception 'payment start requires an owned slot claim'
    using errcode = '23505', constraint = 'slot_claims_pkey';
end;
$$;

create or replace function public.roo_fetch_recovery_payment_documents(
  p_backend text,
  p_statuses text[],
  p_refunded_status text,
  p_booked_status text,
  p_abandoned_status text,
  p_now timestamptz,
  p_limit integer default 50,
  p_dodo_enabled boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at, source.payload
    from commerce.payment_records payment
    join migration.source_documents source
      on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and (coalesce(source.payload->>'reconciliationRecoveryTerminal', 'false') != 'true'
        or commerce.payment_review_can_resume(source.payload))
      and not (coalesce(source.payload->>'providerRecoveryTerminal', 'false') = 'true'
        and coalesce(source.payload->>'providerRecoveryTerminalReason', '')
          in ('payment_currency_mismatch', 'payment_currency_invalid'))
      and (
        lower(btrim(payment.status)) not in ('email_partial', lower(btrim(p_booked_status)))
        or payment.refund_requires_booking_sync
        or payment.resource_release_pending
        or coalesce(source.payload->>'requiresReschedule', 'false') = 'true'
        or not exists (
          select 1 from commerce.bookings booking
          where (booking.id = payment.booking_id
            or booking.legacy_sanity_id = source.payload->>'bookingId')
            and commerce.booking_confirmation_is_inactive(booking.id)
        )
      )
      and (
        payment.provider != 'dodo'
        or (p_dodo_enabled and coalesce(source.payload->>'providerRecoveryTerminal', 'false') != 'true')
        or payment.refund_requires_booking_sync
        or payment.resource_release_pending
        or (payment.status = 'email_partial' and source.payload->>'requiresReschedule' = 'true')
        or (payment.status in ('email_partial', lower(p_booked_status)) and payment.email_dispatch_required)
      )
      and (
        payment.status = any(coalesce(p_statuses, '{}'::text[]))
        or payment.refund_requires_booking_sync
        or (payment.status = lower(p_booked_status) and payment.email_dispatch_required)
        or (payment.status = lower(p_abandoned_status)
          and (payment.resource_release_pending or payment.late_capture_watch_until is not null))
      )
      and (payment.next_recovery_at is null or payment.next_recovery_at <= p_now
        or (source.payload->>'reconciliationRecoveryTerminal' = 'true'
          and commerce.payment_review_can_resume(source.payload)))
    order by coalesce(payment.next_recovery_at, '-infinity'::timestamptz), payment.updated_at, payment.id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  select coalesce(jsonb_agg(payload order by updated_at, legacy_sanity_id), '[]'::jsonb)
  from candidates;
$$;

revoke all on function commerce.payment_review_can_resume(jsonb) from public, anon, authenticated;
grant execute on function commerce.payment_review_can_resume(jsonb) to service_role;
revoke all on function public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)
  from public, anon, authenticated;
grant execute on function public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)
  to service_role;
