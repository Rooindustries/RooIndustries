set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
begin
  lock table commerce.bookings in share row exclusive mode;

  create table if not exists ops.booking_paid_events (
    event_id text primary key check (event_id ~ '^[a-f0-9]{40}$'),
    booking_id uuid not null,
    payment_record_ref text not null unique,
    provider text,
    value numeric(12, 2),
    currency text,
    package_title text,
    attribution jsonb,
    status text not null default 'pending'
      check (status in ('pending', 'claimed', 'reported', 'baseline')),
    claimed_until timestamptz,
    created_at timestamptz not null default now(),
    reported_at timestamptz,
    check ((status = 'claimed') = (claimed_until is not null))
  );

  create index if not exists booking_paid_events_unreported_idx
    on ops.booking_paid_events (created_at, event_id)
    where status in ('pending', 'claimed');

  alter table ops.booking_paid_events enable row level security;

  revoke all on table ops.booking_paid_events
    from public, anon, authenticated;

  create or replace function migration.booking_paid_event_id(p_payment_record_ref text)
  returns text
  language sql
  immutable
  set search_path = ''
  as $$
    select left(encode(sha256(convert_to('booking-confirmed:' || p_payment_record_ref, 'UTF8')), 'hex'), 40);
  $$;

  create or replace function migration.booking_paid_event_fields(p_payload jsonb)
  returns table (
    payment_record_ref text,
    provider text,
    value numeric,
    attribution jsonb
  )
  language sql
  immutable
  set search_path = ''
  as $$
    select
      fields.payment_record_ref,
      fields.provider,
      fields.value,
      case
        when jsonb_typeof(p_payload->'salesAttribution') = 'object'
          then p_payload->'salesAttribution'
      end
    from (
      select
        nullif(btrim(coalesce(p_payload->>'paymentRecordId', '')), '') as payment_record_ref,
        lower(btrim(coalesce(p_payload->>'paymentProvider', ''))) as provider,
        round(migration.try_numeric(p_payload->>'netAmount'), 2) as value
    ) fields
    where fields.payment_record_ref is not null
      and fields.provider in ('paypal', 'razorpay', 'dodo')
      and fields.value > 0
      and fields.value < 10000000000;
  $$;

  create or replace function migration.record_booking_paid_event()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
  as $$
  begin
    insert into ops.booking_paid_events (
      event_id,
      booking_id,
      payment_record_ref,
      provider,
      value,
      currency,
      package_title,
      attribution
    )
    select
      migration.booking_paid_event_id(fields.payment_record_ref),
      new.id,
      fields.payment_record_ref,
      fields.provider,
      fields.value,
      new.currency,
      left(new.package_title, 120),
      fields.attribution
    from migration.booking_paid_event_fields(new.booking_payload) fields
    on conflict do nothing;
    return null;
  end;
  $$;

  create or replace trigger commerce_bookings_record_booking_paid_event
  after insert on commerce.bookings
  for each row execute function migration.record_booking_paid_event();

  insert into ops.booking_paid_events (
    event_id,
    booking_id,
    payment_record_ref,
    provider,
    value,
    currency,
    package_title,
    attribution,
    status
  )
  select
    migration.booking_paid_event_id(fields.payment_record_ref),
    booking.id,
    fields.payment_record_ref,
    fields.provider,
    fields.value,
    booking.currency,
    left(booking.package_title, 120),
    fields.attribution,
    'baseline'
  from commerce.bookings booking
  cross join lateral migration.booking_paid_event_fields(booking.booking_payload) fields
  order by booking.created_at, booking.id
  on conflict do nothing;

  create or replace function public.roo_claim_booking_paid_events(p_limit integer)
  returns table (
    event_id text,
    booking_id uuid,
    payment_record_ref text,
    provider text,
    value numeric,
    currency text,
    package_title text,
    attribution jsonb,
    created_at timestamptz,
    claimed_until timestamptz
  )
  language sql
  security definer
  set search_path = ''
  as $$
    with claimable as (
      select pending.event_id
      from ops.booking_paid_events pending
      where pending.status = 'pending'
        or (pending.status = 'claimed' and pending.claimed_until <= now())
      order by pending.created_at, pending.event_id
      limit greatest(1, least(coalesce(p_limit, 50), 200))
      for update skip locked
    )
    update ops.booking_paid_events paid
    set status = 'claimed', claimed_until = now() + interval '5 minutes'
    from claimable
    where paid.event_id = claimable.event_id
    returning
      paid.event_id,
      paid.booking_id,
      paid.payment_record_ref,
      paid.provider,
      paid.value,
      paid.currency,
      paid.package_title,
      paid.attribution,
      paid.created_at,
      paid.claimed_until;
  $$;

  create or replace function public.roo_ack_booking_paid_events(p_event_ids text[])
  returns integer
  language sql
  security definer
  set search_path = ''
  as $$
    with acknowledged as (
      update ops.booking_paid_events paid
      set status = 'reported', reported_at = now(), claimed_until = null
      where paid.event_id = any(coalesce(p_event_ids, array[]::text[]))
        and paid.status = 'claimed'
      returning paid.event_id
    )
    select count(*)::integer from acknowledged;
  $$;

  revoke all on function migration.booking_paid_event_id(text)
    from public, anon, authenticated;
  revoke all on function migration.booking_paid_event_fields(jsonb)
    from public, anon, authenticated;
  revoke all on function migration.record_booking_paid_event()
    from public, anon, authenticated;
  revoke all on function public.roo_claim_booking_paid_events(integer)
    from public, anon, authenticated;
  grant execute on function public.roo_claim_booking_paid_events(integer)
    to service_role;
  revoke all on function public.roo_ack_booking_paid_events(text[])
    from public, anon, authenticated;
  grant execute on function public.roo_ack_booking_paid_events(text[])
    to service_role;

  notify pgrst, 'reload schema';
end;
$migration$;
