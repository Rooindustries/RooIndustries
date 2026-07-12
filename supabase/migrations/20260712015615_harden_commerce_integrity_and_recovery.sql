-- Forward-only integrity closure for Supabase-primary commerce. Existing public
-- RPC signatures remain compatible while all privileged objects stay service-only.

create table if not exists migration.commerce_control (
  singleton boolean primary key default true check (singleton),
  primary_backend text not null check (primary_backend in ('sanity', 'supabase')),
  generation integer not null check (generation >= 0),
  starts_paused boolean not null default true,
  change_reason text not null default 'migration_bootstrap',
  updated_at timestamptz not null default now()
);

create table if not exists migration.commerce_control_events (
  id bigint generated always as identity primary key,
  previous_backend text,
  next_backend text not null check (next_backend in ('sanity', 'supabase')),
  previous_generation integer,
  next_generation integer not null check (next_generation >= 0),
  starts_paused boolean not null,
  reason text not null,
  changed_at timestamptz not null default now()
);

insert into migration.commerce_control (
  singleton, primary_backend, generation, starts_paused, change_reason
)
select
  true,
  'supabase',
  greatest(
    coalesce((select max(cutover_generation) from migration.source_documents), 0),
    coalesce((select max(cutover_generation) from migration.commerce_commands), 0),
    coalesce((select max(cutover_generation) from migration.commerce_mirror_outbox), 0)
  ),
  true,
  'integrity_repair_rollout'
on conflict (singleton) do nothing;

alter table migration.commerce_commands
  add column if not exists operation text not null default 'document_mutation',
  add column if not exists completed_at timestamptz not null default now();

alter table commerce.payment_records
  add column if not exists refund_requires_booking_sync boolean not null default false,
  add column if not exists resource_release_pending boolean not null default false,
  add column if not exists late_capture_watch_until timestamptz;

alter table commerce.payment_proof_claims
  add column if not exists released_at timestamptz,
  add column if not exists release_reason text;

alter table migration.commerce_mirror_outbox
  add column if not exists sequence_no bigint generated always as identity,
  add column if not exists requeue_count integer not null default 0,
  add column if not exists last_requeued_at timestamptz,
  add column if not exists resolved_by_event_key text,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_reason text;

create unique index if not exists commerce_mirror_outbox_sequence_no_key
  on migration.commerce_mirror_outbox (sequence_no);

alter table migration.commerce_mirror_outbox
  drop constraint if exists commerce_mirror_outbox_status_check;
alter table migration.commerce_mirror_outbox
  add constraint commerce_mirror_outbox_status_check
  check (status in (
    'pending', 'processing', 'retry', 'mirrored', 'dead_letter', 'superseded'
  ));

alter table migration.commerce_mirror_checkpoints
  add column if not exists sequence_no bigint;

update migration.commerce_mirror_checkpoints checkpoint
set sequence_no = outbox.sequence_no
from migration.commerce_mirror_outbox outbox
where checkpoint.event_key = outbox.event_key
  and checkpoint.sequence_no is null;

create unique index if not exists commerce_mirror_checkpoints_sequence_no_key
  on migration.commerce_mirror_checkpoints (sequence_no)
  where sequence_no is not null;

create table if not exists migration.commerce_mirror_state (
  singleton boolean primary key default true check (singleton),
  checkpoint_sequence_no bigint not null default 0 check (checkpoint_sequence_no >= 0),
  checkpoint_event_key text,
  checkpoint_hash text,
  checkpoint_generation integer not null default 0 check (checkpoint_generation >= 0),
  mirrored_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into migration.commerce_mirror_state (singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists migration.commerce_mirror_actions (
  id bigint generated always as identity primary key,
  event_key text not null,
  action text not null check (action in ('requeue', 'supersede')),
  expected_attempt_count integer,
  replacement_event_key text,
  reason text not null,
  acted_at timestamptz not null default now()
);

create index if not exists commerce_mirror_actions_event_key_idx
  on migration.commerce_mirror_actions (event_key, acted_at desc);

create index if not exists payment_records_recovery_due_idx
  on commerce.payment_records (
    backend_owner,
    (coalesce(next_recovery_at, '-infinity'::timestamptz)),
    updated_at,
    id
  )
  where status in (
    'started', 'captured', 'finalizing', 'needs_recovery', 'email_partial',
    'refunded', 'booked', 'abandoned'
  );

alter table migration.commerce_control enable row level security;
alter table migration.commerce_control_events enable row level security;
alter table migration.commerce_mirror_state enable row level security;
alter table migration.commerce_mirror_actions enable row level security;

revoke all on migration.commerce_control,
  migration.commerce_control_events,
  migration.commerce_mirror_state,
  migration.commerce_mirror_actions
  from public, anon, authenticated;
grant select on migration.commerce_control,
  migration.commerce_control_events,
  migration.commerce_mirror_state,
  migration.commerce_mirror_actions
  to service_role;
grant insert on migration.commerce_control_events,
  migration.commerce_mirror_actions
  to service_role;
grant usage, select on all sequences in schema migration to service_role;

create policy "commerce_control_deny_browser"
  on migration.commerce_control for all to anon, authenticated
  using (false) with check (false);
create policy "commerce_control_events_deny_browser"
  on migration.commerce_control_events for all to anon, authenticated
  using (false) with check (false);
create policy "commerce_mirror_state_deny_browser"
  on migration.commerce_mirror_state for all to anon, authenticated
  using (false) with check (false);
create policy "commerce_mirror_actions_deny_browser"
  on migration.commerce_mirror_actions for all to anon, authenticated
  using (false) with check (false);

create or replace function migration.commerce_command_hash(
  p_operation text,
  p_payload jsonb,
  p_generation integer
)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(
    extensions.digest(
      jsonb_build_object(
        'operation', p_operation,
        'payload', p_payload,
        'generation', p_generation
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function migration.assert_commerce_write_fence(
  p_generation integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control migration.commerce_control%rowtype;
begin
  select * into v_control
  from migration.commerce_control
  where singleton
  for share;
  if not found or v_control.primary_backend <> 'supabase' then
    raise exception 'Supabase is not the authoritative commerce writer'
      using errcode = '55000';
  end if;
  if coalesce(p_generation, -1) <> v_control.generation then
    raise exception 'Commerce generation is stale'
      using errcode = '40001';
  end if;
end;
$$;

create or replace function migration.assert_commerce_start_fence(
  p_generation integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control migration.commerce_control%rowtype;
begin
  perform migration.assert_commerce_write_fence(p_generation);
  select * into v_control
  from migration.commerce_control
  where singleton
  for share;
  if v_control.starts_paused then
    raise exception 'New commerce starts are paused'
      using errcode = '55006';
  end if;
end;
$$;

create or replace function public.roo_commerce_control()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'primary_backend', primary_backend,
    'generation', generation,
    'starts_paused', starts_paused,
    'change_reason', change_reason,
    'updated_at', updated_at
  )
  from migration.commerce_control
  where singleton;
$$;

create or replace function public.roo_set_commerce_starts_paused(
  p_expected_generation integer,
  p_paused boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous migration.commerce_control%rowtype;
  v_next migration.commerce_control%rowtype;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A commerce-control reason is required' using errcode = '22023';
  end if;
  select * into v_previous from migration.commerce_control
  where singleton for update;
  if not found or v_previous.generation <> p_expected_generation then
    raise exception 'Commerce generation changed' using errcode = '40001';
  end if;
  update migration.commerce_control
  set starts_paused = p_paused,
      change_reason = left(btrim(p_reason), 240),
      updated_at = now()
  where singleton
  returning * into v_next;
  insert into migration.commerce_control_events (
    previous_backend, next_backend, previous_generation, next_generation,
    starts_paused, reason
  ) values (
    v_previous.primary_backend, v_next.primary_backend,
    v_previous.generation, v_next.generation,
    v_next.starts_paused, left(btrim(p_reason), 240)
  );
  return public.roo_commerce_control();
end;
$$;

create or replace function public.roo_advance_commerce_generation(
  p_expected_generation integer,
  p_primary_backend text,
  p_starts_paused boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous migration.commerce_control%rowtype;
  v_next migration.commerce_control%rowtype;
  v_backend text := lower(btrim(coalesce(p_primary_backend, '')));
begin
  if v_backend not in ('sanity', 'supabase')
    or nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Invalid commerce generation change' using errcode = '22023';
  end if;
  select * into v_previous from migration.commerce_control
  where singleton for update;
  if not found or v_previous.generation <> p_expected_generation then
    raise exception 'Commerce generation changed' using errcode = '40001';
  end if;
  update migration.commerce_control
  set primary_backend = v_backend,
      generation = generation + 1,
      starts_paused = coalesce(p_starts_paused, true),
      change_reason = left(btrim(p_reason), 240),
      updated_at = now()
  where singleton
  returning * into v_next;
  insert into migration.commerce_control_events (
    previous_backend, next_backend, previous_generation, next_generation,
    starts_paused, reason
  ) values (
    v_previous.primary_backend, v_next.primary_backend,
    v_previous.generation, v_next.generation,
    v_next.starts_paused, left(btrim(p_reason), 240)
  );
  return public.roo_commerce_control();
end;
$$;

create or replace function migration.skip_unchanged_commerce_projection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'imported_at']) =
     (to_jsonb(old) - array['updated_at', 'imported_at']) then
    return null;
  end if;
  return new;
end;
$$;

do $$
declare
  v_table regclass;
  v_name text;
begin
  foreach v_table in array array[
    'commerce.booking_settings'::regclass,
    'commerce.bookings'::regclass,
    'commerce.slot_holds'::regclass,
    'commerce.booking_slots'::regclass,
    'commerce.payment_records'::regclass,
    'commerce.payment_events'::regclass,
    'commerce.payment_start_claims'::regclass,
    'commerce.payment_proof_claims'::regclass,
    'commerce.payment_upgrade_locks'::regclass,
    'commerce.webhook_receipts'::regclass,
    'commerce.coupons'::regclass,
    'commerce.coupon_redemptions'::regclass,
    'commerce.recovery_cases'::regclass
  ] loop
    v_name := replace(v_table::text, '.', '_') || '_skip_unchanged_projection';
    execute format('drop trigger if exists %I on %s', v_name, v_table);
    execute format(
      'create trigger %I before update on %s for each row execute function migration.skip_unchanged_commerce_projection()',
      v_name,
      v_table
    );
  end loop;
end;
$$;


create or replace function migration.project_commerce_document_ids(
  p_document_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  if p_document_ids is null
    or cardinality(p_document_ids) < 1
    or cardinality(p_document_ids) > 500
    or exists (
      select 1 from unnest(p_document_ids) document_id
      where nullif(btrim(coalesce(document_id, '')), '') is null
    ) then
    raise exception 'A valid list of at most 500 commerce document IDs is required'
      using errcode = '22023';
  end if;

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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'bookingSettings'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'booking'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'coupon'
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
    where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentRecord'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'booking'
    and not source.tombstoned
    and booking.legacy_sanity_id = source.legacy_sanity_id;

  delete from commerce.payment_events event
  where event.payment_record_id in (
    select payment.id
    from commerce.payment_records payment
    where payment.legacy_sanity_id = any(p_document_ids)
  );

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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentRecord'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentStartClaim'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentProofClaim'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentUpgradeLock'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentWebhookReceipt'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'couponRedemption'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'paymentRecord'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type in ('paymentRecoveryCase', 'bookingRecoveryCase')
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'slotHold'
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'bookingSlot'
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
    and booking.legacy_sanity_id = any(p_document_ids)
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

  delete from commerce.slot_claims claim
  where claim.hold_id in (
      select hold.id from commerce.slot_holds hold
      where hold.legacy_sanity_id = any(p_document_ids)
    )
    or claim.booking_id in (
      select booking.id from commerce.bookings booking
      where booking.legacy_sanity_id = any(p_document_ids)
    )
    or claim.start_time_utc in (
      select slot.start_time_utc from commerce.booking_slots slot
      where slot.legacy_sanity_id = any(p_document_ids)
    );

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
    and slot.backend_owner = 'sanity'
    and slot.legacy_sanity_id = any(p_document_ids);

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
    and hold.legacy_sanity_id = any(p_document_ids)
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
  where source.legacy_sanity_id = any(p_document_ids)
    and source.document_type = 'refRateLimitBucket'
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
  where legacy_sanity_id = any(p_document_ids)
    and document_type in (
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

create or replace function migration.project_commerce_recovery_fields(
  p_document_ids text[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  update commerce.payment_records payment
  set
    refund_requires_booking_sync = coalesce(
      migration.try_boolean(source.payload->>'refundRequiresBookingSync'), false
    ),
    resource_release_pending = coalesce(
      migration.try_boolean(source.payload->>'resourceReleasePending'), false
    ),
    late_capture_watch_until = migration.try_timestamptz(
      source.payload->>'lateCaptureWatchUntil'
    )
  from migration.source_documents source
  where source.document_type = 'paymentRecord'
    and not source.tombstoned
    and payment.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

create or replace function migration.cleanup_commerce_document_ids(
  p_document_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_holds integer := 0;
  v_slots integer := 0;
  v_coupons integer := 0;
  v_claims integer := 0;
begin
  if p_document_ids is null or cardinality(p_document_ids) < 1 then
    return jsonb_build_object(
      'released_holds', 0,
      'released_slots', 0,
      'disabled_coupons', 0,
      'removed_slot_claims', 0
    );
  end if;

  delete from commerce.slot_claims claim
  where claim.hold_id in (
      select hold.id
      from commerce.slot_holds hold
      join migration.source_documents source
        on source.legacy_sanity_id = hold.legacy_sanity_id
      where source.tombstoned
        and source.legacy_sanity_id = any(p_document_ids)
    )
    or claim.booking_id in (
      select slot.booking_id
      from commerce.booking_slots slot
      join migration.source_documents source
        on source.legacy_sanity_id = slot.legacy_sanity_id
      where source.tombstoned
        and source.legacy_sanity_id = any(p_document_ids)
    );
  get diagnostics v_claims = row_count;

  update commerce.slot_holds hold
  set phase = case when hold.expires_at <= now() then 'expired' else 'released' end,
      released_at = coalesce(hold.released_at, now()),
      release_reason = coalesce(hold.release_reason, 'source_tombstoned'),
      updated_at = now()
  from migration.source_documents source
  where source.legacy_sanity_id = hold.legacy_sanity_id
    and source.tombstoned
    and source.legacy_sanity_id = any(p_document_ids)
    and hold.phase not in ('released', 'expired', 'consumed');
  get diagnostics v_holds = row_count;

  update commerce.booking_slots slot
  set status = 'released',
      released_at = coalesce(slot.released_at, now()),
      release_reason = coalesce(slot.release_reason, 'source_tombstoned'),
      updated_at = now()
  from migration.source_documents source
  where source.legacy_sanity_id = slot.legacy_sanity_id
    and source.tombstoned
    and source.legacy_sanity_id = any(p_document_ids)
    and slot.status = 'active';
  get diagnostics v_slots = row_count;

  update commerce.coupons coupon
  set active = false,
      updated_at = now()
  from migration.source_documents source
  where source.legacy_sanity_id = coupon.legacy_sanity_id
    and source.tombstoned
    and source.legacy_sanity_id = any(p_document_ids)
    and coupon.active;
  get diagnostics v_coupons = row_count;

  return jsonb_build_object(
    'released_holds', v_holds,
    'released_slots', v_slots,
    'disabled_coupons', v_coupons,
    'removed_slot_claims', v_claims
  );
end;
$$;

create or replace function public.roo_refresh_operational_shadow()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_projection jsonb;
  v_extensions jsonb;
  v_cleanup jsonb;
  v_recovery_fields integer;
begin
  v_projection := public.roo_project_operational_shadow();
  v_extensions := migration.project_commerce_extensions(null);
  perform migration.restore_commerce_owners(null);
  v_recovery_fields := migration.project_commerce_recovery_fields(null);
  v_cleanup := public.roo_cleanup_operational_shadow();
  return jsonb_build_object(
    'projection', v_projection,
    'extensions', v_extensions,
    'recovery_fields', v_recovery_fields,
    'cleanup', v_cleanup
  );
end;
$$;


create or replace function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command_id text := btrim(coalesce(p_command_id, ''));
  v_request_hash text;
  v_legacy_request_hash text;
  v_existing migration.commerce_commands%rowtype;
  v_mutation jsonb;
  v_operation text;
  v_id text;
  v_expected_revision text;
  v_current migration.source_documents%rowtype;
  v_payload jsonb;
  v_type text;
  v_revision text;
  v_hash text;
  v_now timestamptz;
  v_results jsonb := '[]'::jsonb;
  v_changed_ids text[] := '{}';
  v_deleted_ids text[] := '{}';
  v_documents jsonb;
  v_canonical_hash text;
  v_event_key text;
  v_result jsonb;
  v_starts_new_commerce boolean := false;
begin
  if v_command_id !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid commerce command id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_mutations) <> 'array' or jsonb_array_length(p_mutations) < 1 then
    raise exception 'p_mutations must be a nonempty JSON array' using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, 0) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  v_legacy_request_hash := encode(
    extensions.digest(
      (p_mutations || jsonb_build_object('generation', p_cutover_generation))::text,
      'sha256'
    ),
    'hex'
  );
  v_request_hash := migration.commerce_command_hash(
    'document_mutation',
    p_mutations,
    p_cutover_generation
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_command_id, 0)
  );

  select * into v_existing
  from migration.commerce_commands
  where command_id = v_command_id
  for update;
  if found then
    if v_existing.request_hash not in (v_request_hash, v_legacy_request_hash) then
      raise exception 'commerce command id was reused with different input'
        using errcode = '23505';
    end if;
    return v_existing.result;
  end if;

  select exists (
    select 1
    from jsonb_array_elements(p_mutations) item(value)
    where item.value->>'operation' in ('create', 'create_if_missing')
      and item.value->'document'->>'_type' in (
        'slotHold', 'paymentStartClaim', 'paymentUpgradeLock'
      )
  ) into v_starts_new_commerce;

  if v_starts_new_commerce then
    perform migration.assert_commerce_start_fence(p_cutover_generation);
  else
    perform migration.assert_commerce_write_fence(p_cutover_generation);
  end if;

  for v_mutation in
    select value
    from jsonb_array_elements(p_mutations)
    order by coalesce(value->>'id', value->'document'->>'_id')
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_type := nullif(btrim(coalesce(v_mutation->'document'->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');
    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(v_id, '')), '') is null then
      raise exception 'document mutation is missing id' using errcode = '22023';
    end if;
    if v_operation <> 'delete' and (
      v_type is null or not (v_type = any(array[
        'booking', 'slotHold', 'bookingSlot',
        'paymentRecord', 'paymentStartClaim', 'paymentUpgradeLock',
        'paymentProofClaim', 'paymentWebhookReceipt', 'paymentRecoveryCase',
        'bookingRecoveryCase', 'coupon', 'couponRedemption', 'referral',
        'owedReferral', 'creatorPayout'
      ]::text[]))
    ) then
      raise exception 'document type is outside the commerce domain: %', coalesce(v_type, '')
        using errcode = '22023';
    end if;
    if v_type = 'referral' and v_operation <> 'replace' then
      raise exception 'referral commerce mutations must patch an existing record'
        using errcode = '22023';
    end if;

    select * into v_current
    from migration.source_documents
    where legacy_sanity_id = v_id
    for update;

    if v_operation = 'create' and found and not v_current.tombstoned then
      raise exception 'document already exists: %', v_id using errcode = '23505';
    end if;
    if v_operation = 'create_if_missing' and found and not v_current.tombstoned then
      v_results := v_results || jsonb_build_array(v_current.payload);
      continue;
    end if;
    if v_operation in ('replace', 'delete') and (not found or v_current.tombstoned) then
      raise exception 'document not found: %', v_id using errcode = 'P0002';
    end if;
    if v_operation = 'delete' and found and not (
      v_current.document_type = any(array[
        'booking', 'slotHold', 'bookingSlot',
        'paymentRecord', 'paymentStartClaim', 'paymentUpgradeLock',
        'paymentProofClaim', 'paymentWebhookReceipt', 'paymentRecoveryCase',
        'bookingRecoveryCase', 'coupon', 'couponRedemption',
        'owedReferral', 'creatorPayout'
      ]::text[])
    ) then
      raise exception 'document type is outside the commerce domain: %', v_current.document_type
        using errcode = '22023';
    end if;
    if v_operation = 'replace' and v_current.document_type is distinct from v_type then
      raise exception 'document type cannot change during replacement'
        using errcode = '22023';
    end if;
    if v_expected_revision is not null
      and found and not v_current.tombstoned
      and v_current.source_revision is distinct from v_expected_revision then
      raise exception 'document revision conflict: %', v_id using errcode = '40001';
    end if;

    if v_operation = 'delete' then
      update migration.source_documents
      set
        tombstoned = true,
        tombstoned_at = now(),
        last_seen_at = now(),
        backend_owner = 'supabase',
        cutover_generation = p_cutover_generation
      where legacy_sanity_id = v_id;
      delete from cms.documents where legacy_sanity_id = v_id;
      v_deleted_ids := array_append(v_deleted_ids, v_id);
      v_changed_ids := array_append(v_changed_ids, v_id);
      v_results := v_results || jsonb_build_array(jsonb_build_object('_id', v_id, 'deleted', true));
      continue;
    end if;

    v_payload := v_mutation->'document';
    if v_payload is null or nullif(btrim(coalesce(v_type, '')), '') is null then
      raise exception 'document mutation is missing document type' using errcode = '22023';
    end if;
    if v_type = 'referral' then
      v_payload := (
        v_current.payload - array[
          'successfulReferrals',
          'currentCommissionPercent',
          'currentDiscountPercent',
          'isFirstTime',
          'xocPayments',
          'vertexPayments',
          'earnedXoc',
          'earnedVertex',
          'earnedTotal',
          'paidXoc',
          'paidVertex',
          'paidTotal',
          'owedXoc',
          'owedVertex',
          'owedTotal',
          'notes'
        ]
      ) || migration.referral_commerce_patch(v_payload);
    end if;

    v_now := clock_timestamp();
    v_revision := replace(gen_random_uuid()::text, '-', '');
    v_payload := v_payload || jsonb_build_object(
      '_id', v_id,
      '_type', v_type,
      '_rev', v_revision,
      '_updatedAt', v_now,
      'backendOwner', 'supabase',
      'cutoverGeneration', p_cutover_generation
    );
    if not (v_payload ? '_createdAt') then
      v_payload := v_payload || jsonb_build_object(
        '_createdAt', coalesce(v_current.payload->'_createdAt', to_jsonb(v_now))
      );
    end if;
    v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, first_seen_at, last_seen_at,
      operational_imported, cms_imported, tombstoned, tombstoned_at,
      backend_owner, cutover_generation
    ) values (
      v_id, v_type, v_revision, v_hash, v_payload,
      nullif(v_payload->>'_createdAt', '')::timestamptz, v_now, now(), now(),
      false, false, false, null, 'supabase', p_cutover_generation
    )
    on conflict (legacy_sanity_id) do update set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_created_at = coalesce(migration.source_documents.source_created_at, excluded.source_created_at),
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false,
      tombstoned_at = null,
      backend_owner = 'supabase',
      cutover_generation = excluded.cutover_generation;
    perform cms.sync_document_from_source(v_payload, v_hash);
    v_changed_ids := array_append(v_changed_ids, v_id);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;

  select coalesce(array_agg(distinct changed_id order by changed_id), '{}'::text[])
  into v_changed_ids
  from unnest(v_changed_ids) changed_id;

  if cardinality(v_changed_ids) > 0 then
    perform migration.project_commerce_document_ids(v_changed_ids);
    perform migration.project_commerce_extensions(v_changed_ids);
    perform migration.restore_commerce_owners(v_changed_ids);
    perform migration.project_commerce_recovery_fields(v_changed_ids);
    perform migration.cleanup_commerce_document_ids(v_changed_ids);
  end if;

  select coalesce(jsonb_agg(source.payload order by source.legacy_sanity_id), '[]'::jsonb)
  into v_documents
  from migration.source_documents source
  where source.legacy_sanity_id = any(v_changed_ids) and not source.tombstoned;
  select coalesce(array_agg(distinct deleted_id order by deleted_id), '{}'::text[])
  into v_deleted_ids
  from unnest(v_deleted_ids) deleted_id
  where not exists (
    select 1 from migration.source_documents source
    where source.legacy_sanity_id = deleted_id and not source.tombstoned
  );
  select coalesce(array_agg(distinct changed_id order by changed_id), '{}'::text[])
  into v_changed_ids
  from unnest(v_changed_ids) changed_id;
  v_canonical_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'documents', coalesce((
          select jsonb_agg(
            migration.canonical_business_document(item.value)
            order by item.value->>'_id'
          ) from jsonb_array_elements(v_documents) item(value)
        ), '[]'::jsonb),
        'deleted_ids', to_jsonb(v_deleted_ids),
        'generation', p_cutover_generation
      )::text,
      'sha256'
    ),
    'hex'
  );
  v_event_key := 'commerce-mirror:' || encode(
    extensions.digest(v_command_id || ':' || v_canonical_hash, 'sha256'),
    'hex'
  );
  v_result := jsonb_build_object(
    'results', v_results,
    'event_key', v_event_key,
    'command_id', v_command_id,
    'cutover_generation', p_cutover_generation
  );

  insert into migration.commerce_commands (
    command_id, request_hash, cutover_generation, operation, result, completed_at
  ) values (
    v_command_id, v_request_hash, p_cutover_generation,
    'document_mutation', v_result, now()
  );

  insert into migration.commerce_mirror_outbox (
    command_id, event_key, document_ids, documents, deleted_ids,
    canonical_hash, cutover_generation
  ) values (
    v_command_id, v_event_key, v_changed_ids, v_documents, v_deleted_ids,
    v_canonical_hash, p_cutover_generation
  ) on conflict (event_key) do nothing;

  return v_result;
end;
$$;

create or replace function public.roo_fetch_recovery_payment_documents(
  p_backend text,
  p_statuses text[],
  p_refunded_status text,
  p_booked_status text,
  p_abandoned_status text,
  p_now timestamptz,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at
    from commerce.payment_records payment
    where payment.backend_owner = case
        when lower(p_backend) = 'supabase' then 'supabase' else 'sanity' end
      and payment.legacy_sanity_id is not null
      and (
        payment.status = any(coalesce(p_statuses, '{}'::text[]))
        or (payment.status = lower(p_refunded_status)
          and payment.refund_requires_booking_sync)
        or (payment.status = lower(p_booked_status)
          and payment.email_dispatch_required)
        or (payment.status = lower(p_abandoned_status)
          and (payment.resource_release_pending
            or payment.late_capture_watch_until is not null))
      )
      and (payment.next_recovery_at is null or payment.next_recovery_at <= p_now)
    order by coalesce(payment.next_recovery_at, '-infinity'::timestamptz),
      payment.updated_at,
      payment.id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  select coalesce(
    jsonb_agg(source.payload order by candidates.updated_at, candidates.legacy_sanity_id),
    '[]'::jsonb
  )
  from candidates
  join migration.source_documents source
    on source.legacy_sanity_id = candidates.legacy_sanity_id
  where not source.tombstoned;
$$;

create or replace function migration.recompute_commerce_mirror_checkpoint()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence bigint := 0;
  v_event migration.commerce_mirror_outbox%rowtype;
begin
  select coalesce(
    (select min(sequence_no) - 1
      from migration.commerce_mirror_outbox
      where status not in ('mirrored', 'superseded')),
    (select max(sequence_no) from migration.commerce_mirror_outbox),
    0
  ) into v_sequence;

  if v_sequence > 0 then
    select * into v_event
    from migration.commerce_mirror_outbox
    where sequence_no = v_sequence;
  end if;

  update migration.commerce_mirror_state
  set checkpoint_sequence_no = v_sequence,
      checkpoint_event_key = v_event.event_key,
      checkpoint_hash = v_event.canonical_hash,
      checkpoint_generation = coalesce(v_event.cutover_generation, 0),
      mirrored_at = v_event.mirrored_at,
      updated_at = now()
  where singleton;
  return (
    select jsonb_build_object(
      'sequence_no', checkpoint_sequence_no,
      'event_key', checkpoint_event_key,
      'canonical_hash', checkpoint_hash,
      'generation', checkpoint_generation,
      'mirrored_at', mirrored_at,
      'updated_at', updated_at
    )
    from migration.commerce_mirror_state
    where singleton
  );
end;
$$;

create or replace function public.roo_claim_commerce_mirror_events(
  p_lease_id text,
  p_limit integer default 25,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if nullif(btrim(coalesce(p_lease_id, '')), '') is null then
    raise exception 'mirror lease id is required' using errcode = '22023';
  end if;
  with candidates as (
    select id
    from migration.commerce_mirror_outbox
    where (
      status in ('pending', 'retry')
      and (coalesce(p_force, false)
        or coalesce(next_attempt_at, '-infinity'::timestamptz) <= now())
    ) or (status = 'processing' and lease_expires_at <= now())
    order by sequence_no
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update migration.commerce_mirror_outbox outbox
    set status = 'processing',
        lease_id = p_lease_id,
        lease_expires_at = now() + interval '2 minutes',
        attempt_count = attempt_count + 1
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence_no', claimed.sequence_no,
    'event_key', claimed.event_key,
    'document_ids', to_jsonb(claimed.document_ids),
    'documents', coalesce((
      select jsonb_agg(
        document.value || jsonb_build_object(
          '_supabaseCanonicalHash',
          migration.canonical_business_hash(document.value)
        ) order by document.value->>'_id'
      )
      from jsonb_array_elements(claimed.documents) document(value)
    ), '[]'::jsonb),
    'deleted_ids', to_jsonb(claimed.deleted_ids),
    'delete_guards', claimed.delete_guards,
    'canonical_hash', claimed.canonical_hash,
    'cutover_generation', claimed.cutover_generation,
    'attempt_count', claimed.attempt_count
  ) order by claimed.sequence_no), '[]'::jsonb)
  into v_result
  from claimed;
  return v_result;
end;
$$;

create or replace function public.roo_complete_commerce_mirror_event(
  p_event_key text,
  p_lease_id text,
  p_success boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
  v_checkpoint jsonb;
begin
  select * into v_event
  from migration.commerce_mirror_outbox
  where event_key = p_event_key
  for update;
  if not found then
    raise exception 'mirror event not found' using errcode = 'P0002';
  end if;
  if v_event.status = 'mirrored' then
    return jsonb_build_object(
      'event_key', p_event_key, 'mirrored', true, 'idempotent', true
    );
  end if;
  if v_event.lease_id is distinct from p_lease_id then
    raise exception 'mirror event lease conflict' using errcode = '40001';
  end if;

  if p_success then
    update migration.commerce_mirror_outbox
    set status = 'mirrored',
        mirrored_at = now(),
        lease_id = null,
        lease_expires_at = null,
        next_attempt_at = null,
        last_error_code = null
    where event_key = p_event_key;
    insert into migration.commerce_mirror_checkpoints (
      event_key, canonical_hash, cutover_generation, document_count, sequence_no
    ) values (
      p_event_key,
      v_event.canonical_hash,
      v_event.cutover_generation,
      cardinality(v_event.document_ids),
      v_event.sequence_no
    ) on conflict (event_key) do update
      set sequence_no = excluded.sequence_no,
          mirrored_at = now();
    v_checkpoint := migration.recompute_commerce_mirror_checkpoint();
  else
    update migration.commerce_mirror_outbox
    set status = case when attempt_count >= 12 then 'dead_letter' else 'retry' end,
        next_attempt_at = case
          when attempt_count >= 12 then null
          else now() + least(
            interval '1 hour',
            interval '1 minute' * power(2, least(attempt_count, 6))
          )
        end,
        lease_id = null,
        lease_expires_at = null,
        last_error_code = left(
          coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED'), 128
        )
    where event_key = p_event_key;
  end if;
  return jsonb_build_object(
    'event_key', p_event_key,
    'mirrored', p_success,
    'checkpoint', v_checkpoint
  );
end;
$$;

create or replace function public.roo_requeue_commerce_mirror_event(
  p_event_key text,
  p_expected_attempt_count integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A requeue reason is required' using errcode = '22023';
  end if;
  select * into v_event
  from migration.commerce_mirror_outbox
  where event_key = p_event_key
  for update;
  if not found then
    raise exception 'mirror event not found' using errcode = 'P0002';
  end if;
  if v_event.status <> 'dead_letter'
    or v_event.attempt_count <> p_expected_attempt_count then
    raise exception 'mirror event changed or is not dead-lettered'
      using errcode = '40001';
  end if;
  update migration.commerce_mirror_outbox
  set status = 'retry',
      next_attempt_at = now(),
      lease_id = null,
      lease_expires_at = null,
      requeue_count = requeue_count + 1,
      last_requeued_at = now(),
      resolution_reason = left(btrim(p_reason), 240)
  where event_key = p_event_key;
  insert into migration.commerce_mirror_actions (
    event_key, action, expected_attempt_count, reason
  ) values (
    p_event_key, 'requeue', p_expected_attempt_count, left(btrim(p_reason), 240)
  );
  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'retry',
    'requeue_count', v_event.requeue_count + 1
  );
end;
$$;

create or replace function public.roo_supersede_commerce_mirror_event(
  p_event_key text,
  p_replacement_event_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
  v_replacement migration.commerce_mirror_outbox%rowtype;
  v_checkpoint jsonb;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null
    or p_event_key = p_replacement_event_key then
    raise exception 'Invalid mirror supersession' using errcode = '22023';
  end if;
  select * into v_event from migration.commerce_mirror_outbox
  where event_key = p_event_key for update;
  select * into v_replacement from migration.commerce_mirror_outbox
  where event_key = p_replacement_event_key for share;
  if v_event.status <> 'dead_letter'
    or v_replacement.status <> 'mirrored'
    or v_replacement.cutover_generation < v_event.cutover_generation
    or not (v_event.document_ids <@ v_replacement.document_ids) then
    raise exception 'Mirror supersession is not safe' using errcode = '40001';
  end if;
  update migration.commerce_mirror_outbox
  set status = 'superseded',
      resolved_by_event_key = p_replacement_event_key,
      resolved_at = now(),
      resolution_reason = left(btrim(p_reason), 240),
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = null
  where event_key = p_event_key;
  insert into migration.commerce_mirror_actions (
    event_key, action, replacement_event_key, reason
  ) values (
    p_event_key, 'supersede', p_replacement_event_key, left(btrim(p_reason), 240)
  );
  v_checkpoint := migration.recompute_commerce_mirror_checkpoint();
  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'superseded',
    'replacement_event_key', p_replacement_event_key,
    'checkpoint', v_checkpoint
  );
end;
$$;

create or replace function public.roo_commerce_mirror_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending', count(*) filter (
      where status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'actionable', count(*) filter (where status in ('pending', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'dead_letters', count(*) filter (where status = 'dead_letter'),
    'superseded', count(*) filter (where status = 'superseded'),
    'oldest_created_at', min(created_at) filter (
      where status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'oldest_age_seconds', coalesce(extract(epoch from now() - min(created_at)
      filter (where status in ('pending', 'retry', 'processing', 'dead_letter')))::bigint, 0),
    'checkpoint', (
      select jsonb_build_object(
        'sequence_no', checkpoint_sequence_no,
        'event_key', checkpoint_event_key,
        'generation', checkpoint_generation,
        'mirrored_at', mirrored_at
      ) from migration.commerce_mirror_state where singleton
    )
  )
  from migration.commerce_mirror_outbox;
$$;

create or replace function public.roo_commerce_mirror_status_for_ids(
  p_document_ids text[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select coalesce(array_agg(distinct btrim(id) order by btrim(id)), '{}'::text[]) ids
    from unnest(coalesce(p_document_ids, '{}'::text[])) id
    where nullif(btrim(id), '') is not null
  )
  select jsonb_build_object(
    'pending', count(*) filter (
      where event.status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'dead_letters', count(*) filter (where event.status = 'dead_letter'),
    'oldest_created_at', min(event.created_at) filter (
      where event.status in ('pending', 'retry', 'processing', 'dead_letter')
    )
  )
  from migration.commerce_mirror_outbox event
  cross join requested
  where cardinality(requested.ids) > 0
    and event.document_ids && requested.ids;
$$;

create or replace function public.roo_commerce_integrity_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'control', public.roo_commerce_control(),
    'mirror', public.roo_commerce_mirror_backlog(),
    'orphan_claimed_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      left join commerce.bookings booking on booking.id = proof.booking_id
      where proof.status = 'claimed'
        and (proof.booking_id is null or booking.id is null)
    ),
    'orphan_free_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      join commerce.payment_records payment on payment.id = proof.payment_record_id
      where proof.provider = 'free'
        and proof.status = 'claimed'
        and proof.booking_id is null
        and payment.booking_id is null
        and payment.status in ('failed', 'abandoned')
    ),
    'command_conflicts', 0,
    'full_projector_calls_in_commands', 0
  );
$$;

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
        '_type', 'booking',
        'startTimeUTC', to_char(
          booking.start_time_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'packageTitle', booking.package_title,
        'originalOrderId', coalesce(booking.booking_payload->>'originalOrderId', ''),
        'status', booking.status
      ) order by booking.start_time_utc, booking.legacy_sanity_id)
      from commerce.bookings booking
      where booking.start_time_utc is not null
        and booking.legacy_sanity_id is not null
    ), '[]'::jsonb),
    'holds', coalesce((
      select jsonb_agg(jsonb_build_object(
        '_id', hold.legacy_sanity_id,
        '_type', 'slotHold',
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
      where hold.legacy_sanity_id is not null
        and hold.phase not in ('released', 'consumed', 'expired')
        and hold.expires_at > now()
    ), '[]'::jsonb),
    'slotLocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        '_id', slot.legacy_sanity_id,
        '_type', 'bookingSlot',
        'bookingId', booking.legacy_sanity_id,
        'startTimeUTC', to_char(
          slot.start_time_utc at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'status', slot.status
      ) order by slot.start_time_utc, slot.legacy_sanity_id)
      from commerce.booking_slots slot
      join commerce.bookings booking on booking.id = slot.booking_id
      where slot.legacy_sanity_id is not null and slot.status = 'active'
    ), '[]'::jsonb)
  );
$$;

-- Licensing is intentionally a one-purchase/one-PC product. Keep the columns
-- for API compatibility, but make the database agree with the activation RPC
-- and the partial unique index.
update licensing.products
set default_max_devices = 1,
    updated_at = now()
where default_max_devices <> 1;

update licensing.entitlements
set max_devices = 1,
    updated_at = now()
where max_devices <> 1;

alter table licensing.products
  alter column default_max_devices set default 1,
  drop constraint if exists products_default_max_devices_check,
  add constraint products_default_max_devices_check
    check (default_max_devices = 1);

alter table licensing.entitlements
  alter column max_devices set default 1,
  drop constraint if exists entitlements_max_devices_check,
  add constraint entitlements_max_devices_check
    check (max_devices = 1);

-- Supabase Tourney remains dormant in this release. These objects close its
-- database integrity gaps without changing the active legacy runtime.
create table if not exists tourney.schema_metadata (
  schema_name text primary key,
  schema_version integer not null check (schema_version > 0),
  updated_at timestamptz not null default now()
);

insert into tourney.schema_metadata (schema_name, schema_version, updated_at)
values ('tourney', 2, now())
on conflict (schema_name) do update
set schema_version = greatest(tourney.schema_metadata.schema_version, excluded.schema_version),
    updated_at = now();

create table if not exists tourney.tourney_player_auth_operations (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  player_id text not null
    references tourney.tourney_players(id) on delete cascade,
  token_id text
    references tourney.tourney_player_tokens(id) on delete set null,
  operation_kind text not null
    check (operation_kind in ('decision', 'password_reset', 'player_sync')),
  desired_status text
    check (desired_status is null or desired_status in (
      'pending', 'approved', 'denied', 'withdrawn', 'removed'
    )),
  desired_role text
    check (desired_role is null or desired_role in ('player', 'viewer', 'caster', 'owner')),
  desired_registration_pool text
    check (desired_registration_pool is null or desired_registration_pool in ('main', 'substitute')),
  desired_credential_version text,
  password_hash text,
  operation_payload jsonb not null default '{}'::jsonb,
  operation_status text not null default 'pending'
    check (operation_status in (
      'pending', 'processing', 'auth_applied', 'completed', 'retry'
    )),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (char_length(operation_key) between 8 and 240),
  check (
    password_hash is null
    or (
      operation_kind = 'password_reset'
      and password_hash ~ '^\$2[aby]\$[0-9]{2}\$'
    )
  ),
  check (
    (operation_status = 'processing' and lease_id is not null and lease_expires_at is not null)
    or operation_status <> 'processing'
  ),
  check (
    (operation_status = 'completed' and completed_at is not null)
    or operation_status <> 'completed'
  )
);

create unique index if not exists tourney_auth_operations_one_active_decision
  on tourney.tourney_player_auth_operations (player_id)
  where operation_kind = 'decision'
    and operation_status in ('pending', 'processing', 'auth_applied', 'retry');

create unique index if not exists tourney_auth_operations_one_per_token
  on tourney.tourney_player_auth_operations (token_id)
  where token_id is not null;

create index if not exists tourney_auth_operations_pending_idx
  on tourney.tourney_player_auth_operations (operation_status, next_attempt_at, created_at)
  where operation_status in ('pending', 'retry', 'processing', 'auth_applied');

create index if not exists tourney_auth_operations_player_idx
  on tourney.tourney_player_auth_operations (player_id, created_at desc);

create index if not exists tourney_players_created_cursor_idx
  on tourney.tourney_players (created_at desc, id desc);

create index if not exists tourney_players_approved_roster_idx
  on tourney.tourney_players (registration_pool, role_play, display_name, id)
  where status = 'approved';

create index if not exists tourney_appeals_created_cursor_idx
  on tourney.tourney_appeals (created_at desc, id desc);

create index if not exists tourney_appeals_player_cursor_idx
  on tourney.tourney_appeals (submitter_player_id, created_at desc, id desc)
  where submitter_player_id is not null;

create index if not exists tourney_payouts_created_cursor_idx
  on tourney.tourney_payouts (created_at desc, id desc);

create index if not exists tourney_payouts_player_cursor_idx
  on tourney.tourney_payouts (player_id, created_at desc, id desc);

create index if not exists tourney_bracket_audit_created_cursor_idx
  on tourney.tourney_bracket_audit (created_at desc, id desc);

alter table tourney.tourney_registration_config
  drop constraint if exists tourney_registration_config_team_count_check,
  add constraint tourney_registration_config_team_count_check
    check (team_count between 2 and 64);

alter table tourney.tourney_appeals
  drop constraint if exists tourney_appeals_type_check,
  drop constraint if exists tourney_appeals_status_check,
  add constraint tourney_appeals_type_check
    check (type in ('team-appeal', 'captain-complaint')),
  add constraint tourney_appeals_status_check
    check (status in ('open', 'reviewing', 'upheld', 'denied', 'closed'));

alter table tourney.tourney_payouts
  drop constraint if exists tourney_payouts_payout_type_check,
  drop constraint if exists tourney_payouts_status_check,
  drop constraint if exists tourney_payouts_amount_usd_check,
  add constraint tourney_payouts_payout_type_check
    check (payout_type in ('placement', 'mvp', 'proceeds', 'adjustment')),
  add constraint tourney_payouts_status_check
    check (status in ('pending', 'ready', 'paid', 'void')),
  add constraint tourney_payouts_amount_usd_check
    check (amount_usd >= 0);

alter table tourney.tourney_bracket_entities
  drop constraint if exists tourney_bracket_entities_entity_type_check,
  add constraint tourney_bracket_entities_entity_type_check
    check (entity_type in ('participant', 'stage', 'group', 'round', 'match', 'match_game'));

alter table tourney.tourney_bracket_counters
  drop constraint if exists tourney_bracket_counters_entity_type_check,
  drop constraint if exists tourney_bracket_counters_next_id_check,
  add constraint tourney_bracket_counters_entity_type_check
    check (entity_type in ('participant', 'stage', 'group', 'round', 'match', 'match_game')),
  add constraint tourney_bracket_counters_next_id_check
    check (next_id >= 0);

alter table tourney.schema_metadata enable row level security;
alter table tourney.tourney_player_auth_operations enable row level security;

revoke all on table tourney.schema_metadata,
  tourney.tourney_player_auth_operations
  from public, anon, authenticated;
grant all on table tourney.schema_metadata,
  tourney.tourney_player_auth_operations
  to service_role;

create policy "tourney_schema_metadata_deny_browser"
  on tourney.schema_metadata for all to anon, authenticated
  using (false) with check (false);
create policy "tourney_auth_operations_deny_browser"
  on tourney.tourney_player_auth_operations for all to anon, authenticated
  using (false) with check (false);

alter function public.roo_import_tourney_snapshot(jsonb, text)
  rename to roo_import_tourney_snapshot_unchecked;

create function public.roo_import_tourney_snapshot(
  p_snapshot jsonb,
  p_source_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from tourney.tourney_player_auth_operations
    where operation_status in ('pending', 'processing', 'auth_applied', 'retry')
  ) then
    raise exception 'Tourney snapshot import is blocked by an active Auth operation'
      using errcode = '55006';
  end if;
  return public.roo_import_tourney_snapshot_unchecked(p_snapshot, p_source_hash);
end;
$$;

revoke all on function public.roo_import_tourney_snapshot_unchecked(jsonb, text)
  from public, anon, authenticated, service_role;

-- PostgreSQL gives PUBLIC execute on newly created functions unless the global
-- default is revoked. A per-schema revoke alone does not override that default.
alter default privileges for role postgres
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role postgres in schema public
  grant execute on functions to service_role;
alter default privileges for role postgres in schema migration
  grant execute on functions to service_role;
alter default privileges for role postgres in schema tourney
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema tourney
  grant execute on functions to service_role;
alter default privileges for role postgres in schema tourney
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema tourney
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema tourney
  grant all on tables to service_role;
alter default privileges for role postgres in schema tourney
  grant usage, select on sequences to service_role;

revoke all on function migration.commerce_command_hash(text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function migration.assert_commerce_write_fence(integer)
  from public, anon, authenticated;
revoke all on function migration.assert_commerce_start_fence(integer)
  from public, anon, authenticated;
revoke all on function migration.skip_unchanged_commerce_projection()
  from public, anon, authenticated;
revoke all on function migration.project_commerce_document_ids(text[])
  from public, anon, authenticated;
revoke all on function migration.project_commerce_recovery_fields(text[])
  from public, anon, authenticated;
revoke all on function migration.cleanup_commerce_document_ids(text[])
  from public, anon, authenticated;
revoke all on function migration.recompute_commerce_mirror_checkpoint()
  from public, anon, authenticated;

grant execute on function migration.commerce_command_hash(text, jsonb, integer)
  to service_role;
grant execute on function migration.assert_commerce_write_fence(integer)
  to service_role;
grant execute on function migration.assert_commerce_start_fence(integer)
  to service_role;
grant execute on function migration.skip_unchanged_commerce_projection()
  to service_role;
grant execute on function migration.project_commerce_document_ids(text[])
  to service_role;
grant execute on function migration.project_commerce_recovery_fields(text[])
  to service_role;
grant execute on function migration.cleanup_commerce_document_ids(text[])
  to service_role;
grant execute on function migration.recompute_commerce_mirror_checkpoint()
  to service_role;

revoke all on function public.roo_commerce_control()
  from public, anon, authenticated;
revoke all on function public.roo_set_commerce_starts_paused(integer, boolean, text)
  from public, anon, authenticated;
revoke all on function public.roo_advance_commerce_generation(integer, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.roo_refresh_operational_shadow()
  from public, anon, authenticated;
revoke all on function public.roo_apply_commerce_document_mutations(text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.roo_complete_commerce_mirror_event(text, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.roo_requeue_commerce_mirror_event(text, integer, text)
  from public, anon, authenticated;
revoke all on function public.roo_supersede_commerce_mirror_event(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_mirror_backlog()
  from public, anon, authenticated;
revoke all on function public.roo_commerce_mirror_status_for_ids(text[])
  from public, anon, authenticated;
revoke all on function public.roo_commerce_integrity_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_fetch_commerce_availability()
  from public, anon, authenticated;

grant execute on function public.roo_commerce_control()
  to service_role;
grant execute on function public.roo_set_commerce_starts_paused(integer, boolean, text)
  to service_role;
grant execute on function public.roo_advance_commerce_generation(integer, text, boolean, text)
  to service_role;
grant execute on function public.roo_refresh_operational_shadow()
  to service_role;
grant execute on function public.roo_apply_commerce_document_mutations(text, jsonb, integer)
  to service_role;
grant execute on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer)
  to service_role;
grant execute on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  to service_role;
grant execute on function public.roo_complete_commerce_mirror_event(text, text, boolean, text)
  to service_role;
grant execute on function public.roo_requeue_commerce_mirror_event(text, integer, text)
  to service_role;
grant execute on function public.roo_supersede_commerce_mirror_event(text, text, text)
  to service_role;
grant execute on function public.roo_commerce_mirror_backlog()
  to service_role;
grant execute on function public.roo_commerce_mirror_status_for_ids(text[])
  to service_role;
grant execute on function public.roo_commerce_integrity_readiness()
  to service_role;
grant execute on function public.roo_fetch_commerce_availability()
  to service_role;

revoke all on function public.roo_import_tourney_snapshot(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.roo_import_tourney_player_account(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_resolve_tourney_account_alias(text)
  from public, anon, authenticated;
grant execute on function public.roo_import_tourney_snapshot(jsonb, text)
  to service_role;
grant execute on function public.roo_import_tourney_player_account(jsonb)
  to service_role;
grant execute on function public.roo_resolve_tourney_account_alias(text)
  to service_role;
