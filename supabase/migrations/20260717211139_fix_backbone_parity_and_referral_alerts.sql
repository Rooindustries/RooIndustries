set lock_timeout = '5s';
set statement_timeout = '120s';

-- Credential delivery material is intentionally excluded from commerce parity.
-- It is owned by the account recovery state machine rather than the business
-- document mirror, and sealed delivery tokens can legitimately differ.
create or replace function migration.canonical_business_document(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_payload->>'_type' = 'referral' then p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash', '_supabaseSequence',
      '_commerceCutoverGeneration', '_supabaseMirroredAt',
      'creatorPassword', 'resetToken', 'resetTokenHash',
      'resetTokenExpiresAt', 'resetDeliveryToken',
      'registrationVerificationTokenHash',
      'registrationVerificationExpiresAt',
      'registrationVerificationDeliveryToken',
      'passwordResetRequired', 'credentialVersion'
    ]
    else p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash', '_supabaseSequence',
      '_commerceCutoverGeneration', '_supabaseMirroredAt'
    ]
  end;
$$;

revoke all on function migration.canonical_business_document(jsonb)
  from public, anon, authenticated;
grant execute on function migration.canonical_business_document(jsonb)
  to service_role;

-- Report active parity separately from retained tombstoned audit history.
create or replace function public.roo_commerce_typed_gap_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active as (
    select * from migration.source_documents where not tombstoned
  ), refund_sources as (
    select count(*)::bigint as count
    from active source
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(source.payload->'refunds') = 'array'
        then source.payload->'refunds' else '[]'::jsonb end
    ) refund(payload)
    where source.document_type = 'paymentRecord'
      and coalesce(
        nullif(refund.payload->>'providerRefundId', ''),
        refund.payload->>'_key'
      ) is not null
  ), expected_emails as (
    select booking.id booking_id,
      'booking_confirmation'::text dispatch_kind,
      recipient.recipient_type
    from active source
    join commerce.bookings booking
      on booking.legacy_sanity_id = source.legacy_sanity_id
    cross join (values ('customer'::text), ('owner'::text)) recipient(recipient_type)
    where source.document_type = 'booking'
    union all
    select booking.id,
      'reschedule'::text,
      recipient.recipient_type
    from active source
    join commerce.bookings booking
      on booking.legacy_sanity_id = source.legacy_sanity_id
    cross join (values ('customer'::text), ('owner'::text)) recipient(recipient_type)
    where source.document_type = 'booking'
      and coalesce(migration.try_boolean(source.payload->>'requiresReschedule'), false)
  ), active_email_dispatches as (
    select dispatch.*
    from commerce.email_dispatches dispatch
    join commerce.bookings booking on booking.id = dispatch.booking_id
    join active source
      on source.document_type = 'booking'
      and source.legacy_sanity_id = booking.legacy_sanity_id
  )
  select jsonb_build_object(
    'bookings', jsonb_build_object(
      'source', (select count(*) from active where document_type = 'booking'),
      'typed', (
        select count(*) from commerce.bookings target
        join active source
          on source.document_type = 'booking'
          and source.legacy_sanity_id = target.legacy_sanity_id
      ),
      'preserved_tombstoned_history', (
        select count(*) from commerce.bookings target
        join migration.source_documents source
          on source.document_type = 'booking'
          and source.legacy_sanity_id = target.legacy_sanity_id
          and source.tombstoned
      ),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.bookings target
          on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'booking'
          and target.source_hash <> source.source_hash
      )
    ),
    'payments', jsonb_build_object(
      'source', (select count(*) from active where document_type = 'paymentRecord'),
      'typed', (
        select count(*) from commerce.payment_records target
        join active source
          on source.document_type = 'paymentRecord'
          and source.legacy_sanity_id = target.legacy_sanity_id
      ),
      'preserved_tombstoned_history', (
        select count(*) from commerce.payment_records target
        join migration.source_documents source
          on source.document_type = 'paymentRecord'
          and source.legacy_sanity_id = target.legacy_sanity_id
          and source.tombstoned
      ),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.payment_records target
          on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'paymentRecord'
          and target.source_hash <> source.source_hash
      )
    ),
    'coupons', jsonb_build_object(
      'source', (select count(*) from active where document_type = 'coupon'),
      'typed', (
        select count(*) from commerce.coupons target
        join active source
          on source.document_type = 'coupon'
          and source.legacy_sanity_id = target.legacy_sanity_id
      ),
      'preserved_tombstoned_history', (
        select count(*) from commerce.coupons target
        join migration.source_documents source
          on source.document_type = 'coupon'
          and source.legacy_sanity_id = target.legacy_sanity_id
          and source.tombstoned
      ),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.coupons target
          on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'coupon'
          and target.source_hash <> source.source_hash
      )
    ),
    'holds', jsonb_build_object(
      'source', (select count(*) from active where document_type = 'slotHold'),
      'typed', (
        select count(*) from commerce.slot_holds target
        join active source
          on source.document_type = 'slotHold'
          and source.legacy_sanity_id = target.legacy_sanity_id
      ),
      'preserved_tombstoned_history', (
        select count(*) from commerce.slot_holds target
        join migration.source_documents source
          on source.document_type = 'slotHold'
          and source.legacy_sanity_id = target.legacy_sanity_id
          and source.tombstoned
      ),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.slot_holds target
          on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'slotHold'
          and target.source_hash <> source.source_hash
      )
    ),
    'email_dispatches', jsonb_build_object(
      'expected', (select count(*) from expected_emails),
      'typed', (select count(*) from active_email_dispatches),
      'preserved_tombstoned_history', (
        select count(*)
        from commerce.email_dispatches dispatch
        join commerce.bookings booking on booking.id = dispatch.booking_id
        join migration.source_documents source
          on source.document_type = 'booking'
          and source.legacy_sanity_id = booking.legacy_sanity_id
          and source.tombstoned
      ),
      'missing_required', (
        select count(*)
        from expected_emails expected
        left join active_email_dispatches dispatch
          on dispatch.booking_id = expected.booking_id
          and dispatch.dispatch_kind = expected.dispatch_kind
          and dispatch.recipient_type = expected.recipient_type
        where dispatch.id is null
      ),
      'unexpected_active', (
        select count(*)
        from active_email_dispatches dispatch
        left join expected_emails expected
          on expected.booking_id = dispatch.booking_id
          and expected.dispatch_kind = dispatch.dispatch_kind
          and expected.recipient_type = dispatch.recipient_type
        where expected.booking_id is null
      ),
      'unsafe_historical_retries', (
        select count(*) from commerce.email_dispatches
        where payload->>'historical_backfill' = 'true'
          and sent_at is null and status <> 'historical_unknown'
      )
    ),
    'referral_ledger', jsonb_build_object(
      'expected', (
        select count(*) from active
        where document_type in ('owedReferral', 'creatorPayout')
      ),
      'typed', (select count(*) from commerce.referral_ledger),
      'missing_creator_links', (
        select count(*) from commerce.referral_ledger
        where creator_user_id is null
      )
    ),
    'refunds', jsonb_build_object(
      'expected', (select count from refund_sources),
      'typed', (select count(*) from commerce.refunds)
    ),
    'duplicate_provider_orders', (
      select count(*) from (
        select provider, provider_order_id from commerce.payment_records
        where provider_order_id is not null
        group by provider, provider_order_id having count(*) > 1
      ) duplicate
    ),
    'duplicate_provider_payments', (
      select count(*) from (
        select provider, provider_payment_id from commerce.payment_records
        where provider_payment_id is not null
        group by provider, provider_payment_id having count(*) > 1
      ) duplicate
    ),
    'duplicate_email_keys', (
      select count(*) from (
        select idempotency_key from commerce.email_dispatches
        group by idempotency_key having count(*) > 1
      ) duplicate
    )
  );
$$;

revoke all on function public.roo_commerce_typed_gap_summary()
  from public, anon, authenticated;
grant execute on function public.roo_commerce_typed_gap_summary()
  to service_role;

-- Availability is an active-source projection. Typed rows retained for a
-- tombstoned source remain audit history and must not re-enter live slots.
create or replace function public.roo_fetch_commerce_availability()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        '_id', booking.legacy_sanity_id,
        'startTimeUTC', to_char(
          booking.start_time_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'packageTitle', booking.package_title,
        'originalOrderId', coalesce(booking.booking_payload->>'originalOrderId', ''),
        'status', booking.status
      ) order by booking.start_time_utc, booking.legacy_sanity_id)
      from commerce.bookings booking
      join migration.source_documents source
        on source.document_type = 'booking'
        and source.legacy_sanity_id = booking.legacy_sanity_id
        and not source.tombstoned
      where booking.start_time_utc is not null
        and booking.legacy_sanity_id is not null
    ), '[]'::jsonb),
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
        '_id', hold.legacy_sanity_id,
        'startTimeUTC', to_char(
          hold.start_time_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'phase', coalesce(nullif(hold.payload->>'phase', ''), hold.phase),
        'expiresAt', to_char(
          hold.expires_at at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      ) order by hold.start_time_utc, hold.legacy_sanity_id)
      from commerce.slot_holds hold
      join migration.source_documents source
        on source.document_type = 'slotHold'
        and source.legacy_sanity_id = hold.legacy_sanity_id
        and not source.tombstoned
      where hold.legacy_sanity_id is not null
        and hold.phase not in ('released', 'consumed', 'expired')
        and hold.expires_at > now()
    ), '[]'::jsonb),
    'slotLocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        '_id', slot.legacy_sanity_id,
        'bookingId', booking.legacy_sanity_id,
        'startTimeUTC', to_char(
          slot.start_time_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'status', slot.status
      ) order by slot.start_time_utc, slot.legacy_sanity_id)
      from commerce.booking_slots slot
      join commerce.bookings booking on booking.id = slot.booking_id
      join migration.source_documents slot_source
        on slot_source.document_type = 'bookingSlot'
        and slot_source.legacy_sanity_id = slot.legacy_sanity_id
        and not slot_source.tombstoned
      join migration.source_documents booking_source
        on booking_source.document_type = 'booking'
        and booking_source.legacy_sanity_id = booking.legacy_sanity_id
        and not booking_source.tombstoned
      where slot.legacy_sanity_id is not null and slot.status = 'active'
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.roo_fetch_commerce_availability()
  from public, anon, authenticated;
grant execute on function public.roo_fetch_commerce_availability()
  to service_role;

-- Add an audited terminal resolution that cannot be claimed or resent.
alter table accounts.referral_email_dispatches
  drop constraint referral_email_dispatches_status_check,
  add column resolved_at timestamptz,
  add column resolution_code text,
  add constraint referral_email_dispatches_status_check
    check (status in (
      'pending', 'sending', 'retry', 'sent', 'dead_letter', 'resolved'
    )),
  add constraint referral_email_dispatches_resolution_check check (
    (status = 'resolved' and resolved_at is not null and resolution_code is not null)
    or (status <> 'resolved' and resolved_at is null and resolution_code is null)
  );

alter table accounts.referral_email_dispatch_actions
  drop constraint referral_email_dispatch_actions_action_check,
  drop constraint referral_email_dispatch_actions_actor_check,
  add column reason_code text,
  add constraint referral_email_dispatch_actions_action_check
    check (action in ('requeue', 'resolve_without_resend')),
  add constraint referral_email_dispatch_actions_actor_check
    check (actor in ('service_role_recovery', 'service_role_resolution')),
  add constraint referral_email_dispatch_actions_reason_check check (
    (action = 'requeue' and reason_code is null)
    or (action = 'resolve_without_resend' and reason_code is not null)
  );

create or replace function accounts.guard_referral_email_dispatch_terminal_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status in ('sent', 'resolved') and new is distinct from old then
    raise exception 'A terminal referral email dispatch is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.roo_resolve_referral_email_dispatch(
  p_idempotency_key text,
  p_resolution_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_resolution_code text := left(
    regexp_replace(
      lower(btrim(coalesce(p_resolution_code, ''))),
      '[^a-z0-9_.:-]',
      '_',
      'g'
    ),
    128
  );
  v_dispatch accounts.referral_email_dispatches%rowtype;
begin
  if v_key !~ '^referral-email-[0-9a-f]{64}$'
    or v_resolution_code = '' then
    raise exception 'invalid referral email resolution request'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-email-resolution:' || v_key, 0)
  );

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where idempotency_key = v_key
  for update;

  if not found then
    raise exception 'referral email dispatch not found'
      using errcode = 'P0002';
  end if;
  if v_dispatch.status = 'resolved' then
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'status', v_dispatch.status,
      'resolved', true,
      'idempotent', true,
      'resolution_code', v_dispatch.resolution_code
    );
  end if;
  if v_dispatch.status <> 'dead_letter' then
    raise exception 'only a dead-letter referral email dispatch can be resolved'
      using errcode = '55000';
  end if;

  insert into accounts.referral_email_dispatch_actions (
    dispatch_id,
    action,
    previous_status,
    previous_attempt_count,
    actor,
    reason_code
  ) values (
    v_dispatch.id,
    'resolve_without_resend',
    v_dispatch.status,
    v_dispatch.attempt_count,
    'service_role_resolution',
    v_resolution_code
  );

  update accounts.referral_email_dispatches
  set status = 'resolved',
      resolved_at = now(),
      resolution_code = v_resolution_code,
      lease_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = v_dispatch.id
    and status = 'dead_letter'
  returning * into v_dispatch;

  if not found then
    raise exception 'referral email dispatch resolution conflict'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'dispatch_id', v_dispatch.id,
    'status', v_dispatch.status,
    'resolved', true,
    'idempotent', false,
    'resolution_code', v_dispatch.resolution_code
  );
end;
$$;

revoke all on function public.roo_resolve_referral_email_dispatch(text, text)
  from public, anon, authenticated;
grant execute on function public.roo_resolve_referral_email_dispatch(text, text)
  to service_role;

-- Keep the ops view security-invoker while exposing only safe referral fields.
create or replace function ops.referral_email_failure_rows()
returns table (
  email text,
  "orderId" text,
  "bookingId" uuid,
  "emailDispatchId" uuid,
  "emailType" text,
  "recipientType" text,
  "emailStatus" text,
  "emailFailureReason" text,
  "emailAttempts" integer,
  "providerMessageId" text,
  "recoveryCaseId" uuid,
  verdict text,
  "nextAttemptUTC" timestamptz,
  "nextAttemptIST" text,
  "leaseExpiresUTC" timestamptz,
  "leaseExpiresIST" text,
  "sentUTC" timestamptz,
  "sentIST" text,
  "createdUTC" timestamptz,
  "createdIST" text,
  "updatedUTC" timestamptz,
  "updatedIST" text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    dispatch.recipient_email,
    dispatch.referral_id,
    null::uuid,
    dispatch.id,
    dispatch.dispatch_kind,
    'creator'::text,
    dispatch.status,
    coalesce(dispatch.last_error_code, 'no failure reason recorded'),
    dispatch.attempt_count,
    dispatch.provider_message_id,
    null::uuid,
    'referral dead letter'::text,
    dispatch.next_attempt_at,
    to_char(
      dispatch.next_attempt_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST',
    dispatch.lease_expires_at,
    case when dispatch.lease_expires_at is not null then to_char(
      dispatch.lease_expires_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' end,
    dispatch.sent_at,
    case when dispatch.sent_at is not null then to_char(
      dispatch.sent_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' end,
    dispatch.created_at,
    to_char(
      dispatch.created_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST',
    dispatch.updated_at,
    to_char(
      dispatch.updated_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST'
  from accounts.referral_email_dispatches dispatch
  where dispatch.status = 'dead_letter';
$$;

revoke all on function ops.referral_email_failure_rows()
  from public, anon, authenticated;
grant execute on function ops.referral_email_failure_rows()
  to service_role;

create or replace view ops.email_failures
with (security_invoker = true)
as
select *
from (
  select
    booking.customer_email as email,
    coalesce(
      booking.legacy_sanity_id,
      recovery.legacy_sanity_id,
      booking.id::text
    ) as "orderId",
    booking.id as "bookingId",
    dispatch.id as "emailDispatchId",
    dispatch.dispatch_kind as "emailType",
    dispatch.recipient_type as "recipientType",
    dispatch.status as "emailStatus",
    coalesce(
      dispatch.last_error_code,
      case when dispatch.status = 'historical_unknown'
        then 'historical delivery state was not recorded; entry is terminal and is not retried'
      end,
      'no failure reason recorded'
    ) as "emailFailureReason",
    dispatch.attempt_count as "emailAttempts",
    dispatch.provider_message_id as "providerMessageId",
    dispatch.recovery_case_id as "recoveryCaseId",
    case
      when dispatch.status = 'failed' then 'failed'
      when dispatch.status = 'retry' and dispatch.next_attempt_at <= now()
        then 'retry due'
      when dispatch.status = 'retry' then 'retry scheduled'
      when dispatch.status = 'sending' and dispatch.lease_expires_at <= now()
        then 'sending lease expired'
      when dispatch.status = 'sending' then 'sending'
      when dispatch.status = 'pending' then 'pending'
      when dispatch.status = 'historical_unknown' then 'historical unknown'
      else dispatch.status
    end as verdict,
    dispatch.next_attempt_at as "nextAttemptUTC",
    case when dispatch.next_attempt_at is not null then to_char(
      dispatch.next_attempt_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' end as "nextAttemptIST",
    dispatch.lease_expires_at as "leaseExpiresUTC",
    case when dispatch.lease_expires_at is not null then to_char(
      dispatch.lease_expires_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' end as "leaseExpiresIST",
    dispatch.sent_at as "sentUTC",
    case when dispatch.sent_at is not null then to_char(
      dispatch.sent_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' end as "sentIST",
    dispatch.created_at as "createdUTC",
    to_char(
      dispatch.created_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' as "createdIST",
    dispatch.updated_at as "updatedUTC",
    to_char(
      dispatch.updated_at at time zone 'Asia/Kolkata',
      'DD Mon YYYY, HH12:MI AM'
    ) || ' IST' as "updatedIST"
  from commerce.email_dispatches dispatch
  left join commerce.recovery_cases recovery
    on recovery.id = dispatch.recovery_case_id
  left join commerce.bookings booking
    on booking.id = coalesce(dispatch.booking_id, recovery.booking_id)
  where dispatch.status <> 'sent'
  union all
  select * from ops.referral_email_failure_rows()
) failures
order by "updatedUTC" desc, "createdUTC" desc, "emailDispatchId" desc;

revoke all on table ops.email_failures from public, anon, authenticated;
grant select on table ops.email_failures to service_role;
