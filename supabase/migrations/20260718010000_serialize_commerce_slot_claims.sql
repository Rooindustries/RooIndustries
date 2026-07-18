set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function migration.commerce_document_start_times(
  p_document_ids text[]
)
returns timestamptz[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    array_agg(distinct candidate.start_time_utc order by candidate.start_time_utc),
    '{}'::timestamptz[]
  )
  from (
    select migration.try_timestamptz(source.payload->>'startTimeUTC') start_time_utc
    from migration.source_documents source
    where source.legacy_sanity_id = any(p_document_ids)
    union all
    select hold.start_time_utc
    from commerce.slot_holds hold
    where hold.legacy_sanity_id = any(p_document_ids)
    union all
    select slot.start_time_utc
    from commerce.booking_slots slot
    where slot.legacy_sanity_id = any(p_document_ids)
    union all
    select slot.start_time_utc
    from commerce.booking_slots slot
    join commerce.bookings booking on booking.id = slot.booking_id
    where booking.legacy_sanity_id = any(p_document_ids)
  ) candidate
  where candidate.start_time_utc is not null;
$$;

create or replace function migration.reconcile_slot_claims_for_times(
  p_start_times timestamptz[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start_time timestamptz;
  v_booking_count integer;
  v_hold_count integer;
  v_booking_slot commerce.booking_slots%rowtype;
  v_hold commerce.slot_holds%rowtype;
begin
  for v_start_time in
    select distinct start_time
    from unnest(coalesce(p_start_times, '{}'::timestamptz[])) start_time
    where start_time is not null
    order by start_time
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('commerce-slot:' || v_start_time::text, 0)
    );

    select count(*)::integer into v_booking_count
    from commerce.booking_slots slot
    where slot.start_time_utc = v_start_time
      and slot.status = 'active';

    select count(*)::integer into v_hold_count
    from commerce.slot_holds hold
    where hold.start_time_utc = v_start_time
      and hold.phase in ('active', 'payment')
      and hold.expires_at > pg_catalog.clock_timestamp();

    if v_booking_count + v_hold_count > 1 then
      raise exception 'commerce slot % has conflicting active owners', v_start_time
        using errcode = '23505', constraint = 'slot_claims_pkey';
    end if;

    delete from commerce.slot_claims claim
    where claim.start_time_utc = v_start_time;

    if v_booking_count = 1 then
      select * into strict v_booking_slot
      from commerce.booking_slots slot
      where slot.start_time_utc = v_start_time
        and slot.status = 'active';

      insert into commerce.slot_claims (
        start_time_utc,
        claim_type,
        booking_id,
        claimed_at,
        legacy_sanity_id,
        source_revision,
        source_hash,
        backend_owner
      ) values (
        v_start_time,
        'booking',
        v_booking_slot.booking_id,
        v_booking_slot.locked_at,
        v_booking_slot.legacy_sanity_id,
        v_booking_slot.source_revision,
        v_booking_slot.source_hash,
        v_booking_slot.backend_owner
      );
    elsif v_hold_count = 1 then
      select * into strict v_hold
      from commerce.slot_holds hold
      where hold.start_time_utc = v_start_time
        and hold.phase in ('active', 'payment')
        and hold.expires_at > pg_catalog.clock_timestamp();

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
      ) values (
        v_start_time,
        'hold',
        v_hold.id,
        v_hold.expires_at,
        coalesce(v_hold.source_created_at, pg_catalog.clock_timestamp()),
        v_hold.legacy_sanity_id,
        v_hold.source_revision,
        v_hold.source_hash,
        v_hold.backend_owner
      );
    end if;
  end loop;
end;
$$;

alter function migration.project_commerce_document_ids(text[])
  rename to project_commerce_document_ids_unserialized;

create function migration.project_commerce_document_ids(
  p_document_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before timestamptz[];
  v_after timestamptz[];
  v_affected timestamptz[];
  v_result jsonb;
begin
  v_before := migration.commerce_document_start_times(p_document_ids);
  v_result := migration.project_commerce_document_ids_unserialized(p_document_ids);
  v_after := migration.commerce_document_start_times(p_document_ids);

  select coalesce(
    array_agg(distinct start_time order by start_time),
    '{}'::timestamptz[]
  ) into v_affected
  from unnest(
    coalesce(v_before, '{}'::timestamptz[])
      || coalesce(v_after, '{}'::timestamptz[])
  ) start_time
  where start_time is not null;

  perform migration.reconcile_slot_claims_for_times(v_affected);
  return v_result;
end;
$$;

create or replace function migration.require_payment_hold_claim()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim commerce.slot_claims%rowtype;
begin
  if new.phase <> 'payment' then
    return new;
  end if;

  select * into v_claim
  from commerce.slot_claims claim
  where claim.start_time_utc = new.start_time_utc
  for update;

  if not found
     or v_claim.claim_type <> 'hold'
     or v_claim.hold_id is distinct from new.id then
    raise exception 'payment start requires an owned slot claim'
      using errcode = '23505', constraint = 'slot_claims_pkey';
  end if;

  return new;
end;
$$;

create trigger slot_holds_require_payment_claim
before insert or update on commerce.slot_holds
for each row execute function migration.require_payment_hold_claim();

create or replace function migration.assert_slot_claim_integrity(
  p_start_time timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking_count integer;
  v_hold_count integer;
  v_booking_id uuid;
  v_hold_id uuid;
  v_claim commerce.slot_claims%rowtype;
  v_claim_found boolean;
begin
  if p_start_time is null then
    return;
  end if;

  select
    count(*)::integer,
    (array_agg(slot.booking_id order by slot.booking_id))[1]
  into v_booking_count, v_booking_id
  from commerce.booking_slots slot
  where slot.start_time_utc = p_start_time
    and slot.status = 'active';

  select
    count(*)::integer,
    (array_agg(hold.id order by hold.id))[1]
  into v_hold_count, v_hold_id
  from commerce.slot_holds hold
  where hold.start_time_utc = p_start_time
    and hold.phase in ('active', 'payment')
    and hold.expires_at > pg_catalog.clock_timestamp();

  select * into v_claim
  from commerce.slot_claims claim
  where claim.start_time_utc = p_start_time;
  v_claim_found := found;

  if v_booking_count + v_hold_count > 1
     or (
       v_booking_count = 1
       and (
         not v_claim_found
         or v_claim.claim_type <> 'booking'
         or v_claim.booking_id is distinct from v_booking_id
       )
     )
     or (
       v_hold_count = 1
       and (
         not v_claim_found
         or v_claim.claim_type <> 'hold'
         or v_claim.hold_id is distinct from v_hold_id
       )
     )
     or (v_booking_count + v_hold_count = 0 and v_claim_found) then
    raise exception 'commerce slot claim invariant failed for %', p_start_time
      using errcode = '23505', constraint = 'slot_claims_pkey';
  end if;
end;
$$;

create or replace function migration.check_slot_claim_integrity_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    perform migration.assert_slot_claim_integrity(old.start_time_utc);
  end if;
  if tg_op <> 'DELETE'
     and (tg_op = 'INSERT' or new.start_time_utc is distinct from old.start_time_utc) then
    perform migration.assert_slot_claim_integrity(new.start_time_utc);
  elsif tg_op = 'UPDATE' then
    perform migration.assert_slot_claim_integrity(new.start_time_utc);
  end if;
  return null;
end;
$$;

create constraint trigger slot_holds_claim_integrity
after insert or update or delete on commerce.slot_holds
deferrable initially deferred
for each row execute function migration.check_slot_claim_integrity_trigger();

create constraint trigger booking_slots_claim_integrity
after insert or update or delete on commerce.booking_slots
deferrable initially deferred
for each row execute function migration.check_slot_claim_integrity_trigger();

create constraint trigger slot_claims_integrity
after insert or update or delete on commerce.slot_claims
deferrable initially deferred
for each row execute function migration.check_slot_claim_integrity_trigger();

revoke all on function migration.commerce_document_start_times(text[])
  from public, anon, authenticated, service_role;
revoke all on function migration.reconcile_slot_claims_for_times(timestamptz[])
  from public, anon, authenticated, service_role;
revoke all on function migration.project_commerce_document_ids_unserialized(text[])
  from public, anon, authenticated, service_role;
revoke all on function migration.project_commerce_document_ids(text[])
  from public, anon, authenticated, service_role;
revoke all on function migration.require_payment_hold_claim()
  from public, anon, authenticated, service_role;
revoke all on function migration.assert_slot_claim_integrity(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function migration.check_slot_claim_integrity_trigger()
  from public, anon, authenticated, service_role;
