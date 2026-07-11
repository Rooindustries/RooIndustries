
create or replace function migration.document_uuid(p_kind text, p_legacy_id text)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select extensions.uuid_generate_v5(
    '6b18b9d2-c7f4-4d04-b02b-9f9db840c632'::uuid,
    p_kind || ':' || p_legacy_id
  );
$$;

create or replace function migration.try_timestamptz(p_value text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return p_value::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function migration.try_numeric(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return p_value::numeric;
exception when others then
  return null;
end;
$$;

create or replace function migration.try_boolean(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  if lower(btrim(p_value)) in ('true', 't', '1', 'yes', 'on') then
    return true;
  end if;
  if lower(btrim(p_value)) in ('false', 'f', '0', 'no', 'off') then
    return false;
  end if;
  return null;
end;
$$;

create or replace function migration.money_subunits(p_value text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select greatest(
    0,
    coalesce(round(migration.try_numeric(p_value) * 100), 0)::bigint
  );
$$;

create or replace function migration.currency_code(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when upper(btrim(coalesce(p_value, ''))) ~ '^[A-Z]{3}$'
      then upper(btrim(p_value))
    else 'USD'
  end;
$$;

create unique index if not exists booking_slots_one_active_per_time
  on commerce.booking_slots (start_time_utc)
  where status = 'active';

create unique index if not exists payment_start_claims_legacy_sanity_id_key
  on commerce.payment_start_claims (legacy_sanity_id);

create unique index if not exists payment_events_legacy_sanity_id_key
  on commerce.payment_events (legacy_sanity_id);

create unique index if not exists refunds_legacy_sanity_id_key
  on commerce.refunds (legacy_sanity_id);

create unique index if not exists referral_ledger_legacy_sanity_id_key
  on commerce.referral_ledger (legacy_sanity_id);

create unique index if not exists email_dispatches_legacy_sanity_id_key
  on commerce.email_dispatches (legacy_sanity_id);

create unique index if not exists rate_limit_buckets_legacy_sanity_id_key
  on commerce.rate_limit_buckets (legacy_sanity_id);

create or replace function public.roo_project_operational_shadow()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  insert into commerce.booking_settings (
    id,
    payload,
    legacy_sanity_id,
    source_revision,
    source_hash,
    source_backend,
    source_updated_at,
    imported_at,
    updated_at
  )
  select
    'default',
    source.payload,
    source.legacy_sanity_id,
    source.source_revision,
    source.source_hash,
    'sanity',
    source.source_updated_at,
    now(),
    now()
  from migration.source_documents source
  where source.document_type = 'bookingSettings'
    and not source.tombstoned
  order by source.source_updated_at desc nulls last
  limit 1
  on conflict (id) do update
  set
    payload = excluded.payload,
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    source_backend = 'sanity',
    source_updated_at = excluded.source_updated_at,
    imported_at = now(),
    updated_at = now();

  insert into commerce.bookings (
    id,
    legacy_sanity_id,
    source_backend,
    source_revision,
    source_hash,
    status,
    customer_email,
    payer_email,
    customer_name,
    package_legacy_id,
    package_title,
    start_time_utc,
    customer_timezone,
    amount_subunits,
    currency,
    coupon_code,
    requires_reschedule,
    cancelled_at,
    refunded_at,
    completed_at,
    booking_payload,
    source_created_at,
    source_updated_at,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('booking', source.legacy_sanity_id),
    source.legacy_sanity_id,
    'sanity',
    source.source_revision,
    source.source_hash,
    case lower(coalesce(source.payload->>'status', 'pending'))
      when 'canceled' then 'cancelled'
      when 'cancelled' then 'cancelled'
      when 'captured' then 'captured'
      when 'completed' then 'completed'
      when 'failed' then 'failed'
      when 'refunded' then 'refunded'
      else 'pending'
    end,
    nullif(lower(btrim(source.payload->>'email')), ''),
    nullif(lower(btrim(source.payload->>'payerEmail')), ''),
    nullif(btrim(coalesce(
      source.payload->>'customerName',
      source.payload->'bookingPayload'->>'customerName'
    )), ''),
    nullif(source.payload->>'packageId', ''),
    coalesce(
      nullif(source.payload->>'packageTitle', ''),
      nullif(source.payload->'bookingPayload'->>'packageTitle', ''),
      'Unknown package'
    ),
    coalesce(
      migration.try_timestamptz(source.payload->>'startTimeUTC'),
      migration.try_timestamptz(source.payload->>'originalRequestedStartTimeUTC')
    ),
    nullif(coalesce(
      source.payload->>'localTimeZone',
      source.payload->>'customerTimeZone'
    ), ''),
    migration.money_subunits(coalesce(
      source.payload->>'grossAmount',
      source.payload->>'netAmount',
      source.payload->'bookingPayload'->>'netAmount'
    )),
    migration.currency_code(coalesce(
      source.payload->>'currency',
      source.payload->'bookingPayload'->>'currency'
    )),
    nullif(lower(btrim(source.payload->>'couponCode')), ''),
    coalesce(migration.try_boolean(source.payload->>'requiresReschedule'), false),
    case
      when lower(coalesce(source.payload->>'status', '')) in ('cancelled', 'canceled')
        then coalesce(
          migration.try_timestamptz(source.payload->>'cancelledAt'),
          source.source_updated_at
        )
      else null
    end,
    case
      when lower(coalesce(source.payload->>'status', '')) = 'refunded'
        then coalesce(
          migration.try_timestamptz(source.payload->>'refundedAt'),
          source.source_updated_at
        )
      else null
    end,
    case
      when lower(coalesce(source.payload->>'status', '')) = 'completed'
        then coalesce(
          migration.try_timestamptz(source.payload->>'completedAt'),
          source.source_updated_at
        )
      else null
    end,
    source.payload,
    source.source_created_at,
    source.source_updated_at,
    now(),
    now(),
    'sanity'
  from migration.source_documents source
  where source.document_type = 'booking'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    status = excluded.status,
    customer_email = excluded.customer_email,
    payer_email = excluded.payer_email,
    customer_name = excluded.customer_name,
    package_legacy_id = excluded.package_legacy_id,
    package_title = excluded.package_title,
    start_time_utc = excluded.start_time_utc,
    customer_timezone = excluded.customer_timezone,
    amount_subunits = excluded.amount_subunits,
    currency = excluded.currency,
    coupon_code = excluded.coupon_code,
    requires_reschedule = excluded.requires_reschedule,
    cancelled_at = excluded.cancelled_at,
    refunded_at = excluded.refunded_at,
    completed_at = excluded.completed_at,
    booking_payload = excluded.booking_payload,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  insert into commerce.coupons (
    id,
    legacy_sanity_id,
    code,
    active,
    discount_kind,
    discount_basis_points,
    discount_amount_subunits,
    currency,
    maximum_uses,
    consumed_uses,
    reserved_uses,
    expires_at,
    source_revision,
    source_hash,
    source_backend,
    payload,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('coupon', source.legacy_sanity_id),
    source.legacy_sanity_id,
    lower(btrim(source.payload->>'code')),
    coalesce(migration.try_boolean(source.payload->>'isActive'), false),
    case
      when lower(source.payload->>'discountType') = 'fixed'
        and migration.try_numeric(source.payload->>'discountAmount') is not null
        then 'fixed'
      else 'percent'
    end,
    case
      when lower(source.payload->>'discountType') = 'fixed'
        and migration.try_numeric(source.payload->>'discountAmount') is not null
        then null
      else least(
        10000,
        greatest(
          0,
          coalesce(round(migration.try_numeric(source.payload->>'discountPercent') * 100), 0)::integer
        )
      )
    end,
    case
      when lower(source.payload->>'discountType') = 'fixed'
        and migration.try_numeric(source.payload->>'discountAmount') is not null
        then migration.money_subunits(source.payload->>'discountAmount')
      else null
    end,
    case
      when lower(source.payload->>'discountType') = 'fixed'
        and migration.try_numeric(source.payload->>'discountAmount') is not null
        then migration.currency_code(source.payload->>'currency')
      else null
    end,
    greatest(0, migration.try_numeric(source.payload->>'maxUses')::integer),
    greatest(0, coalesce(migration.try_numeric(source.payload->>'timesUsed')::integer, 0)),
    greatest(0, coalesce(migration.try_numeric(source.payload->>'activeReservations')::integer, 0)),
    migration.try_timestamptz(source.payload->>'validTo'),
    source.source_revision,
    source.source_hash,
    'sanity',
    source.payload,
    now(),
    now(),
    'sanity'
  from migration.source_documents source
  where source.document_type = 'coupon'
    and not source.tombstoned
    and nullif(lower(btrim(source.payload->>'code')), '') is not null
  on conflict (legacy_sanity_id) do update
  set
    code = excluded.code,
    active = excluded.active,
    discount_kind = excluded.discount_kind,
    discount_basis_points = excluded.discount_basis_points,
    discount_amount_subunits = excluded.discount_amount_subunits,
    currency = excluded.currency,
    maximum_uses = excluded.maximum_uses,
    consumed_uses = excluded.consumed_uses,
    reserved_uses = excluded.reserved_uses,
    expires_at = excluded.expires_at,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    payload = excluded.payload,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  with payment_sources as (
    select
      source.*,
      lower(coalesce(nullif(source.payload->>'provider', ''), 'free')) as normalized_provider,
      nullif(source.payload->>'providerOrderId', '') as normalized_order_id,
      nullif(source.payload->>'providerPaymentId', '') as normalized_payment_id
    from migration.source_documents source
    where source.document_type = 'paymentRecord'
      and not source.tombstoned
  ), ranked as (
    select
      payment_sources.*,
      row_number() over (
        partition by normalized_provider, normalized_order_id
        order by source_updated_at desc nulls last, legacy_sanity_id
      ) as order_rank,
      row_number() over (
        partition by normalized_provider, normalized_payment_id
        order by source_updated_at desc nulls last, legacy_sanity_id
      ) as payment_rank
    from payment_sources
  )
  insert into commerce.payment_records (
    id,
    legacy_sanity_id,
    source_backend,
    source_revision,
    source_hash,
    provider,
    status,
    session_scope,
    quote_fingerprint,
    pricing_fingerprint,
    provider_idempotency_key,
    provider_order_id,
    provider_payment_id,
    amount_subunits,
    currency,
    booking_id,
    provider_public_data,
    booking_payload,
    pricing_snapshot,
    immutable_snapshot_hash,
    session_expires_at,
    recovery_attempt_count,
    next_recovery_at,
    requires_reschedule,
    refund_state,
    email_dispatch_required,
    source_created_at,
    source_updated_at,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('payment_record', ranked.legacy_sanity_id),
    ranked.legacy_sanity_id,
    'sanity',
    ranked.source_revision,
    ranked.source_hash,
    case ranked.normalized_provider
      when 'paypal' then 'paypal'
      when 'razorpay' then 'razorpay'
      else 'free'
    end,
    case lower(coalesce(ranked.payload->>'status', 'failed'))
      when 'started' then 'started'
      when 'order_pending' then 'order_pending'
      when 'order_created' then 'order_created'
      when 'captured' then 'captured'
      when 'captured_client' then 'captured'
      when 'captured_webhook' then 'captured'
      when 'verified_server' then 'captured'
      when 'finalizing' then 'finalizing'
      when 'booked' then 'booked'
      when 'needs_recovery' then 'needs_recovery'
      when 'email_partial' then 'email_partial'
      when 'abandoned' then 'abandoned'
      when 'refunded' then 'refunded'
      when 'reversed' then 'reversed'
      else 'failed'
    end,
    coalesce(
      nullif(ranked.payload->>'sessionScope', ''),
      'legacy:' || ranked.legacy_sanity_id
    ),
    coalesce(
      nullif(ranked.payload->>'quoteFingerprint', ''),
      'legacy:' || ranked.source_hash
    ),
    nullif(ranked.payload->>'pricingFingerprint', ''),
    coalesce(
      nullif(ranked.payload->>'providerIdempotencyKey', ''),
      'legacy:' || ranked.legacy_sanity_id
    ),
    case
      when ranked.normalized_order_id is null or ranked.order_rank = 1
        then ranked.normalized_order_id
      else null
    end,
    case
      when ranked.normalized_payment_id is null or ranked.payment_rank = 1
        then ranked.normalized_payment_id
      else null
    end,
    migration.money_subunits(coalesce(
      ranked.payload->'pricingSnapshot'->>'netAmount',
      ranked.payload->'bookingPayload'->>'netAmount',
      ranked.payload->'pricingSnapshot'->>'grossAmount',
      ranked.payload->'bookingPayload'->>'grossAmount'
    )),
    migration.currency_code(coalesce(
      ranked.payload->'pricingSnapshot'->>'currency',
      ranked.payload->'bookingPayload'->>'currency'
    )),
    booking.id,
    coalesce(ranked.payload->'providerPublicData', '{}'::jsonb),
    coalesce(ranked.payload->'bookingPayload', '{}'::jsonb),
    coalesce(ranked.payload->'pricingSnapshot', '{}'::jsonb),
    coalesce(
      nullif(ranked.payload->>'pricingFingerprint', ''),
      ranked.source_hash
    ),
    coalesce(
      migration.try_timestamptz(ranked.payload->>'sessionExpiresAt'),
      ranked.source_updated_at,
      ranked.source_created_at,
      now()
    ),
    greatest(0, coalesce(
      migration.try_numeric(ranked.payload->>'recoveryAttemptCount')::integer,
      0
    )),
    migration.try_timestamptz(ranked.payload->>'nextRecoveryAt'),
    coalesce(migration.try_boolean(ranked.payload->>'requiresReschedule'), false),
    nullif(ranked.payload->>'refundState', ''),
    coalesce(migration.try_boolean(ranked.payload->>'emailDispatchRequired'), false),
    ranked.source_created_at,
    ranked.source_updated_at,
    now(),
    now(),
    'sanity'
  from ranked
  left join commerce.bookings booking
    on booking.legacy_sanity_id = nullif(ranked.payload->>'bookingId', '')
  on conflict (legacy_sanity_id) do update
  set
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    provider = excluded.provider,
    status = excluded.status,
    session_scope = excluded.session_scope,
    quote_fingerprint = excluded.quote_fingerprint,
    pricing_fingerprint = excluded.pricing_fingerprint,
    provider_idempotency_key = excluded.provider_idempotency_key,
    provider_order_id = excluded.provider_order_id,
    provider_payment_id = excluded.provider_payment_id,
    amount_subunits = excluded.amount_subunits,
    currency = excluded.currency,
    booking_id = excluded.booking_id,
    provider_public_data = excluded.provider_public_data,
    booking_payload = excluded.booking_payload,
    pricing_snapshot = excluded.pricing_snapshot,
    immutable_snapshot_hash = excluded.immutable_snapshot_hash,
    session_expires_at = excluded.session_expires_at,
    recovery_attempt_count = excluded.recovery_attempt_count,
    next_recovery_at = excluded.next_recovery_at,
    requires_reschedule = excluded.requires_reschedule,
    refund_state = excluded.refund_state,
    email_dispatch_required = excluded.email_dispatch_required,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  update commerce.bookings booking
  set
    payment_record_id = payment.id,
    updated_at = now()
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = nullif(source.payload->>'paymentRecordId', '')
  where source.document_type = 'booking'
    and not source.tombstoned
    and booking.legacy_sanity_id = source.legacy_sanity_id;

  delete from commerce.payment_events where backend_owner = 'sanity';

  insert into commerce.payment_events (
    id,
    payment_record_id,
    event_key,
    status,
    source,
    reason,
    occurred_at,
    payload,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    migration.document_uuid(
      'payment_event',
      source.legacy_sanity_id || ':' || coalesce(event.payload->>'_key', md5(event.payload::text))
    ),
    payment.id,
    coalesce(event.payload->>'_key', md5(event.payload::text)),
    nullif(event.payload->>'status', ''),
    nullif(event.payload->>'source', ''),
    nullif(event.payload->>'reason', ''),
    coalesce(
      migration.try_timestamptz(event.payload->>'at'),
      source.source_updated_at,
      source.source_created_at,
      now()
    ),
    event.payload,
    source.legacy_sanity_id || ':' || coalesce(event.payload->>'_key', md5(event.payload::text)),
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = source.legacy_sanity_id
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(source.payload->'events') = 'array'
        then source.payload->'events'
      else '[]'::jsonb
    end
  ) event(payload)
  where source.document_type = 'paymentRecord'
    and not source.tombstoned;

  insert into commerce.payment_start_claims (
    id,
    legacy_sanity_id,
    scope,
    payment_record_id,
    provider,
    quote_fingerprint,
    created_at,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    migration.document_uuid('payment_start_claim', source.legacy_sanity_id),
    source.legacy_sanity_id,
    coalesce(nullif(source.payload->>'scope', ''), 'legacy:' || source.legacy_sanity_id),
    payment.id,
    payment.provider,
    coalesce(
      nullif(source.payload->>'quoteFingerprint', ''),
      payment.quote_fingerprint
    ),
    coalesce(
      migration.try_timestamptz(source.payload->>'createdAt'),
      source.source_created_at,
      now()
    ),
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = source.payload->>'paymentRecordId'
  where source.document_type = 'paymentStartClaim'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    scope = excluded.scope,
    payment_record_id = excluded.payment_record_id,
    provider = excluded.provider,
    quote_fingerprint = excluded.quote_fingerprint,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity';

  insert into commerce.payment_proof_claims (
    id,
    legacy_sanity_id,
    payment_record_id,
    provider,
    provider_order_id,
    provider_payment_id,
    booking_id,
    status,
    claimed_at,
    updated_at,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    migration.document_uuid('payment_proof_claim', source.legacy_sanity_id),
    source.legacy_sanity_id,
    payment.id,
    payment.provider,
    nullif(source.payload->>'providerOrderId', ''),
    nullif(source.payload->>'providerPaymentId', ''),
    booking.id,
    case lower(coalesce(source.payload->>'status', 'claimed'))
      when 'booked' then 'booked'
      when 'released' then 'released'
      else 'claimed'
    end,
    coalesce(
      migration.try_timestamptz(source.payload->>'claimedAt'),
      source.source_created_at,
      now()
    ),
    now(),
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = source.payload->>'paymentRecordId'
  left join commerce.bookings booking
    on booking.legacy_sanity_id = nullif(source.payload->>'bookingId', '')
  where source.document_type = 'paymentProofClaim'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    payment_record_id = excluded.payment_record_id,
    provider = excluded.provider,
    provider_order_id = excluded.provider_order_id,
    provider_payment_id = excluded.provider_payment_id,
    booking_id = excluded.booking_id,
    status = excluded.status,
    claimed_at = excluded.claimed_at,
    updated_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity';

  insert into commerce.payment_upgrade_locks (
    id,
    legacy_sanity_id,
    scope,
    payment_record_id,
    provider,
    quote_fingerprint,
    created_at,
    updated_at,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    migration.document_uuid('payment_upgrade_lock', source.legacy_sanity_id),
    source.legacy_sanity_id,
    coalesce(nullif(source.payload->>'scope', ''), 'legacy:' || source.legacy_sanity_id),
    payment.id,
    payment.provider,
    coalesce(
      nullif(source.payload->>'quoteFingerprint', ''),
      payment.quote_fingerprint
    ),
    coalesce(source.source_created_at, now()),
    now(),
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = source.payload->>'paymentRecordId'
  where source.document_type = 'paymentUpgradeLock'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    scope = excluded.scope,
    payment_record_id = excluded.payment_record_id,
    provider = excluded.provider,
    quote_fingerprint = excluded.quote_fingerprint,
    updated_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity';

  insert into commerce.webhook_receipts (
    id,
    legacy_sanity_id,
    provider,
    event_id,
    event_type,
    status,
    payment_record_id,
    lease_id,
    lease_expires_at,
    http_status,
    payload_hash,
    received_at,
    processed_at,
    updated_at,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    migration.document_uuid('webhook_receipt', source.legacy_sanity_id),
    source.legacy_sanity_id,
    case lower(source.payload->>'provider')
      when 'razorpay' then 'razorpay'
      else 'paypal'
    end,
    coalesce(nullif(source.payload->>'eventId', ''), source.legacy_sanity_id),
    coalesce(nullif(source.payload->>'eventType', ''), 'unknown'),
    case lower(coalesce(source.payload->>'status', 'received'))
      when 'processing' then 'processing'
      when 'processed' then 'processed'
      when 'ignored' then 'ignored'
      when 'retry' then 'retry'
      else 'received'
    end,
    payment.id,
    nullif(source.payload->>'leaseId', ''),
    migration.try_timestamptz(source.payload->>'leaseExpiresAt'),
    migration.try_numeric(source.payload->>'httpStatus')::integer,
    source.source_hash,
    coalesce(source.source_created_at, now()),
    migration.try_timestamptz(source.payload->>'processedAt'),
    now(),
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  left join commerce.payment_records payment
    on payment.legacy_sanity_id = nullif(source.payload->>'paymentRecordId', '')
  where source.document_type = 'paymentWebhookReceipt'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    provider = excluded.provider,
    event_id = excluded.event_id,
    event_type = excluded.event_type,
    status = excluded.status,
    payment_record_id = excluded.payment_record_id,
    lease_id = excluded.lease_id,
    lease_expires_at = excluded.lease_expires_at,
    http_status = excluded.http_status,
    payload_hash = excluded.payload_hash,
    processed_at = excluded.processed_at,
    updated_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity';

  insert into commerce.coupon_redemptions (
    id,
    legacy_sanity_id,
    coupon_id,
    payment_record_id,
    booking_id,
    redemption_key,
    state,
    reservation_expires_at,
    consumed_at,
    released_at,
    restored_at,
    source_revision,
    source_hash,
    payload,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('coupon_redemption', source.legacy_sanity_id),
    source.legacy_sanity_id,
    coupon.id,
    payment.id,
    booking.id,
    coalesce(
      nullif(source.payload->>'ownerId', ''),
      source.legacy_sanity_id
    ),
    case lower(coalesce(source.payload->>'status', 'reserved'))
      when 'consumed' then 'consumed'
      when 'released' then 'released'
      when 'refunded' then 'refunded'
      else 'reserved'
    end,
    migration.try_timestamptz(source.payload->>'expiresAt'),
    migration.try_timestamptz(source.payload->>'consumedAt'),
    migration.try_timestamptz(source.payload->>'releasedAt'),
    migration.try_timestamptz(source.payload->>'refundedAt'),
    source.source_revision,
    source.source_hash,
    source.payload,
    now(),
    'sanity'
  from migration.source_documents source
  join commerce.coupons coupon
    on coupon.legacy_sanity_id = source.payload->'coupon'->>'_ref'
  left join commerce.payment_records payment
    on payment.legacy_sanity_id = nullif(source.payload->>'paymentRecordId', '')
  left join commerce.bookings booking
    on booking.legacy_sanity_id = nullif(source.payload->>'bookingId', '')
  where source.document_type = 'couponRedemption'
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    coupon_id = excluded.coupon_id,
    payment_record_id = excluded.payment_record_id,
    booking_id = excluded.booking_id,
    redemption_key = excluded.redemption_key,
    state = excluded.state,
    reservation_expires_at = excluded.reservation_expires_at,
    consumed_at = excluded.consumed_at,
    released_at = excluded.released_at,
    restored_at = excluded.restored_at,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    payload = excluded.payload,
    updated_at = now(),
    backend_owner = 'sanity';

  update commerce.payment_records payment
  set
    coupon_redemption_id = redemption.id,
    updated_at = now()
  from migration.source_documents source
  join commerce.coupon_redemptions redemption
    on redemption.legacy_sanity_id = source.payload->>'couponReservationId'
  where source.document_type = 'paymentRecord'
    and not source.tombstoned
    and payment.legacy_sanity_id = source.legacy_sanity_id;

  insert into commerce.recovery_cases (
    id,
    legacy_sanity_id,
    case_type,
    payment_record_id,
    booking_id,
    status,
    reason,
    requires_reschedule,
    attempt_count,
    next_attempt_at,
    lease_id,
    lease_expires_at,
    payload,
    source_revision,
    source_hash,
    opened_at,
    resolved_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('recovery_case', source.legacy_sanity_id),
    source.legacy_sanity_id,
    case
      when source.document_type = 'bookingRecoveryCase' then 'booking'
      else 'payment'
    end,
    payment.id,
    booking.id,
    case lower(coalesce(source.payload->>'status', 'open'))
      when 'retrying' then 'retrying'
      when 'resolved' then 'resolved'
      when 'abandoned' then 'abandoned'
      else 'open'
    end,
    coalesce(nullif(source.payload->>'reason', ''), 'Legacy recovery case'),
    coalesce(
      migration.try_boolean(source.payload->>'requiresReschedule'),
      source.document_type = 'bookingRecoveryCase'
    ),
    greatest(0, coalesce(
      migration.try_numeric(source.payload->>'attemptCount')::integer,
      0
    )),
    migration.try_timestamptz(source.payload->>'nextAttemptAt'),
    nullif(source.payload->>'leaseId', ''),
    migration.try_timestamptz(source.payload->>'leaseExpiresAt'),
    source.payload,
    source.source_revision,
    source.source_hash,
    coalesce(
      migration.try_timestamptz(source.payload->>'createdAt'),
      source.source_created_at,
      now()
    ),
    case
      when lower(source.payload->>'status') = 'resolved'
        then coalesce(
          migration.try_timestamptz(source.payload->>'resolvedAt'),
          source.source_updated_at
        )
      else null
    end,
    now(),
    'sanity'
  from migration.source_documents source
  left join commerce.payment_records payment
    on payment.legacy_sanity_id = nullif(source.payload->>'paymentRecordId', '')
  left join commerce.bookings booking
    on booking.legacy_sanity_id = nullif(source.payload->>'bookingId', '')
  where source.document_type in ('paymentRecoveryCase', 'bookingRecoveryCase')
    and not source.tombstoned
  on conflict (legacy_sanity_id) do update
  set
    case_type = excluded.case_type,
    payment_record_id = excluded.payment_record_id,
    booking_id = excluded.booking_id,
    status = excluded.status,
    reason = excluded.reason,
    requires_reschedule = excluded.requires_reschedule,
    attempt_count = excluded.attempt_count,
    next_attempt_at = excluded.next_attempt_at,
    lease_id = excluded.lease_id,
    lease_expires_at = excluded.lease_expires_at,
    payload = excluded.payload,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    opened_at = excluded.opened_at,
    resolved_at = excluded.resolved_at,
    updated_at = now(),
    backend_owner = 'sanity';

  insert into commerce.slot_holds (
    id,
    legacy_sanity_id,
    source_backend,
    source_revision,
    source_hash,
    start_time_utc,
    package_legacy_id,
    package_title,
    phase,
    expires_at,
    owner_token_hash,
    payment_record_id,
    released_at,
    release_reason,
    payload,
    source_created_at,
    source_updated_at,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('slot_hold', source.legacy_sanity_id),
    source.legacy_sanity_id,
    'sanity',
    source.source_revision,
    source.source_hash,
    migration.try_timestamptz(source.payload->>'startTimeUTC'),
    nullif(source.payload->>'packageId', ''),
    coalesce(nullif(source.payload->>'packageTitle', ''), 'Unknown package'),
    case lower(coalesce(source.payload->>'phase', 'active'))
      when 'holding' then 'active'
      when 'payment_pending' then 'payment'
      when 'payment' then 'payment'
      when 'consumed' then 'consumed'
      when 'released' then 'released'
      when 'expired' then 'expired'
      else 'active'
    end,
    migration.try_timestamptz(source.payload->>'expiresAt'),
    case
      when nullif(source.payload->>'holdNonce', '') is null then null
      else encode(
        extensions.digest(convert_to(source.payload->>'holdNonce', 'UTF8'), 'sha256'),
        'hex'
      )
    end,
    payment.id,
    case
      when lower(source.payload->>'phase') in ('released', 'expired')
        then coalesce(
          migration.try_timestamptz(source.payload->>'releasedAt'),
          migration.try_timestamptz(source.payload->>'expiresAt')
        )
      else null
    end,
    nullif(source.payload->>'releaseReason', ''),
    source.payload - 'holdNonce',
    source.source_created_at,
    source.source_updated_at,
    now(),
    now(),
    'sanity'
  from migration.source_documents source
  left join commerce.payment_records payment
    on payment.legacy_sanity_id = nullif(source.payload->>'paymentRecordId', '')
  where source.document_type = 'slotHold'
    and not source.tombstoned
    and migration.try_timestamptz(source.payload->>'startTimeUTC') is not null
    and migration.try_timestamptz(source.payload->>'expiresAt') is not null
  on conflict (legacy_sanity_id) do update
  set
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    start_time_utc = excluded.start_time_utc,
    package_legacy_id = excluded.package_legacy_id,
    package_title = excluded.package_title,
    phase = excluded.phase,
    expires_at = excluded.expires_at,
    owner_token_hash = excluded.owner_token_hash,
    payment_record_id = excluded.payment_record_id,
    released_at = excluded.released_at,
    release_reason = excluded.release_reason,
    payload = excluded.payload,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  insert into commerce.booking_slots (
    id,
    legacy_sanity_id,
    booking_id,
    start_time_utc,
    status,
    locked_at,
    released_at,
    release_reason,
    source_backend,
    source_revision,
    source_hash,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('booking_slot', source.legacy_sanity_id),
    source.legacy_sanity_id,
    booking.id,
    migration.try_timestamptz(source.payload->>'startTimeUTC'),
    case
      when lower(source.payload->>'status') = 'released' then 'released'
      else 'active'
    end,
    coalesce(
      migration.try_timestamptz(source.payload->>'lockedAt'),
      source.source_created_at,
      now()
    ),
    case
      when lower(source.payload->>'status') = 'released'
        then coalesce(
          migration.try_timestamptz(source.payload->>'releasedAt'),
          source.source_updated_at,
          now()
        )
      else null
    end,
    nullif(source.payload->>'releaseReason', ''),
    'sanity',
    source.source_revision,
    source.source_hash,
    now(),
    now(),
    'sanity'
  from migration.source_documents source
  join commerce.bookings booking
    on booking.legacy_sanity_id = source.payload->>'bookingId'
  where source.document_type = 'bookingSlot'
    and not source.tombstoned
    and migration.try_timestamptz(source.payload->>'startTimeUTC') is not null
  on conflict (legacy_sanity_id) do update
  set
    booking_id = excluded.booking_id,
    start_time_utc = excluded.start_time_utc,
    status = excluded.status,
    locked_at = excluded.locked_at,
    released_at = excluded.released_at,
    release_reason = excluded.release_reason,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  insert into commerce.booking_slots (
    id,
    legacy_sanity_id,
    booking_id,
    start_time_utc,
    status,
    locked_at,
    source_backend,
    source_revision,
    source_hash,
    imported_at,
    updated_at,
    backend_owner
  )
  select
    migration.document_uuid('booking_slot_backfill', booking.legacy_sanity_id),
    'bookingSlot.backfill.' || booking.legacy_sanity_id,
    booking.id,
    booking.start_time_utc,
    'active',
    coalesce(booking.source_created_at, now()),
    'sanity',
    booking.source_revision,
    booking.source_hash,
    now(),
    now(),
    'sanity'
  from commerce.bookings booking
  where booking.backend_owner = 'sanity'
    and booking.start_time_utc > now()
    and booking.status in ('pending', 'captured', 'completed')
    and not exists (
      select 1
      from commerce.booking_slots slot
      where slot.start_time_utc = booking.start_time_utc
        and slot.status = 'active'
    )
  on conflict (legacy_sanity_id) do update
  set
    booking_id = excluded.booking_id,
    start_time_utc = excluded.start_time_utc,
    status = 'active',
    released_at = null,
    release_reason = null,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    imported_at = now(),
    updated_at = now(),
    backend_owner = 'sanity';

  delete from commerce.slot_claims where backend_owner = 'sanity';

  insert into commerce.slot_claims (
    start_time_utc,
    claim_type,
    booking_id,
    claimed_at,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    slot.start_time_utc,
    'booking',
    slot.booking_id,
    slot.locked_at,
    slot.legacy_sanity_id,
    slot.source_revision,
    slot.source_hash,
    'sanity'
  from commerce.booking_slots slot
  where slot.status = 'active'
    and slot.backend_owner = 'sanity';

  insert into commerce.slot_claims (
    start_time_utc,
    claim_type,
    hold_id,
    expires_at,
    claimed_at,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    hold.start_time_utc,
    'hold',
    hold.id,
    hold.expires_at,
    coalesce(hold.source_created_at, now()),
    hold.legacy_sanity_id,
    hold.source_revision,
    hold.source_hash,
    'sanity'
  from commerce.slot_holds hold
  where hold.backend_owner = 'sanity'
    and hold.phase in ('active', 'payment')
    and hold.expires_at > now()
  on conflict (start_time_utc) do nothing;

  insert into commerce.rate_limit_buckets (
    bucket_key_hmac,
    window_started_at,
    count,
    reset_at,
    created_at,
    updated_at,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    lower(source.payload->>'keyHash'),
    coalesce(source.source_created_at, source.source_updated_at, now() - interval '15 minutes'),
    greatest(0, coalesce(migration.try_numeric(source.payload->>'count')::integer, 0)),
    migration.try_timestamptz(source.payload->>'resetAt'),
    coalesce(source.source_created_at, now()),
    now(),
    source.legacy_sanity_id,
    source.source_revision,
    source.source_hash,
    'sanity'
  from migration.source_documents source
  where source.document_type = 'refRateLimitBucket'
    and not source.tombstoned
    and lower(source.payload->>'keyHash') ~ '^[0-9a-f]{64}$'
    and migration.try_timestamptz(source.payload->>'resetAt')
      > coalesce(source.source_created_at, source.source_updated_at, now() - interval '15 minutes')
  on conflict (legacy_sanity_id) do update
  set
    bucket_key_hmac = excluded.bucket_key_hmac,
    window_started_at = excluded.window_started_at,
    count = excluded.count,
    reset_at = excluded.reset_at,
    updated_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity';

  update migration.source_documents
  set operational_imported = true
  where document_type in (
    'bookingSettings',
    'booking',
    'slotHold',
    'bookingSlot',
    'paymentRecord',
    'paymentStartClaim',
    'paymentProofClaim',
    'paymentUpgradeLock',
    'paymentWebhookReceipt',
    'paymentRecoveryCase',
    'bookingRecoveryCase',
    'coupon',
    'couponRedemption',
    'refRateLimitBucket'
  )
    and not tombstoned;

  select jsonb_build_object(
    'booking_settings', (select count(*) from commerce.booking_settings),
    'bookings', (select count(*) from commerce.bookings where backend_owner = 'sanity'),
    'slot_holds', (select count(*) from commerce.slot_holds where backend_owner = 'sanity'),
    'booking_slots', (select count(*) from commerce.booking_slots where backend_owner = 'sanity'),
    'slot_claims', (select count(*) from commerce.slot_claims where backend_owner = 'sanity'),
    'payment_records', (select count(*) from commerce.payment_records where backend_owner = 'sanity'),
    'payment_events', (select count(*) from commerce.payment_events where backend_owner = 'sanity'),
    'payment_start_claims', (select count(*) from commerce.payment_start_claims where backend_owner = 'sanity'),
    'payment_proof_claims', (select count(*) from commerce.payment_proof_claims where backend_owner = 'sanity'),
    'webhook_receipts', (select count(*) from commerce.webhook_receipts where backend_owner = 'sanity'),
    'coupons', (select count(*) from commerce.coupons where backend_owner = 'sanity'),
    'coupon_redemptions', (select count(*) from commerce.coupon_redemptions where backend_owner = 'sanity'),
    'recovery_cases', (select count(*) from commerce.recovery_cases where backend_owner = 'sanity'),
    'rate_limit_buckets', (select count(*) from commerce.rate_limit_buckets where backend_owner = 'sanity')
  ) into v_counts;

  return v_counts;
end;
$$;

create or replace function public.roo_operational_shadow_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'source_operational_documents', (
      select count(*)
      from migration.source_documents
      where document_type in (
        'bookingSettings', 'booking', 'slotHold', 'bookingSlot',
        'paymentRecord', 'paymentStartClaim', 'paymentProofClaim',
        'paymentUpgradeLock', 'paymentWebhookReceipt', 'paymentRecoveryCase',
        'bookingRecoveryCase', 'coupon', 'couponRedemption',
        'refRateLimitBucket'
      ) and not tombstoned
    ),
    'operational_imported', (
      select count(*)
      from migration.source_documents
      where operational_imported and not tombstoned
    ),
    'bookings', (select count(*) from commerce.bookings where backend_owner = 'sanity'),
    'payment_records', (select count(*) from commerce.payment_records where backend_owner = 'sanity'),
    'payment_proof_claims', (select count(*) from commerce.payment_proof_claims where backend_owner = 'sanity'),
    'coupons', (select count(*) from commerce.coupons where backend_owner = 'sanity'),
    'recovery_cases', (select count(*) from commerce.recovery_cases where backend_owner = 'sanity'),
    'active_booking_slots', (
      select count(*) from commerce.booking_slots
      where backend_owner = 'sanity' and status = 'active'
    ),
    'active_slot_claims', (
      select count(*) from commerce.slot_claims where backend_owner = 'sanity'
    )
  );
$$;

revoke all on function public.roo_project_operational_shadow()
  from public, anon, authenticated;
revoke all on function public.roo_operational_shadow_summary()
  from public, anon, authenticated;

grant execute on function public.roo_project_operational_shadow()
  to service_role;
grant execute on function public.roo_operational_shadow_summary()
  to service_role;
