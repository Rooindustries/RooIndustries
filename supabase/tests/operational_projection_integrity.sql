begin;

do $$
declare
  v_generation integer;
  v_native_claims jsonb;
  v_documents jsonb;
begin
  select generation into v_generation from migration.commerce_control where singleton;
  perform public.roo_advance_commerce_generation(
    v_generation, 'supabase', false, 'rolled-back operational projection fixture'
  );
  v_generation := v_generation + 1;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:projection-native',
    '[
      {"operation":"create","document":{"_id":"booking.projection-regression","_type":"booking","status":"captured","packageTitle":"Projection Fixture","startTimeUTC":"2098-02-03T00:00:00Z","grossAmount":10,"currency":"USD"}},
      {"operation":"create","document":{"_id":"bookingSlot.projection-regression","_type":"bookingSlot","bookingId":"booking.projection-regression","startTimeUTC":"2098-02-03T00:00:00Z","status":"active","lockedAt":"2098-01-01T00:00:00Z"}},
      {"operation":"create","document":{"_id":"slotHold.projection-regression","_type":"slotHold","startTimeUTC":"2098-02-04T00:00:00Z","phase":"holding","expiresAt":"2098-02-04T00:20:00Z","holdNonce":"projection-regression"}}
    ]'::jsonb,
    v_generation
  );
  -- Reconcile the authoritative claims after native owner restoration, as the
  -- payment lifecycle does when it updates an existing hold or booking.
  perform migration.reconcile_slot_claims_for_times(
    array['2098-02-03T00:00:00Z', '2098-02-04T00:00:00Z']::timestamptz[]
  );
  select jsonb_agg(to_jsonb(claim) order by start_time_utc)
  into v_native_claims
  from commerce.slot_claims claim
  where start_time_utc in ('2098-02-03T00:00:00Z', '2098-02-04T00:00:00Z');
  if jsonb_array_length(v_native_claims) <> 2 or exists (
    select 1 from jsonb_array_elements(v_native_claims) claim
    where claim->>'backend_owner' <> 'supabase'
  ) then
    raise exception 'fixture requires authoritative Supabase booking and hold claims';
  end if;

  -- A genuine projected global mutation, followed by the same refresh used by
  -- the document compatibility client. It must coexist with native claims.
  perform public.roo_apply_document_mutations(
    '[{"operation":"create","document":{"_id":"coupon.projection-regression","_type":"coupon","code":"PROJECTIONREGRESSION","discountPercent":5,"active":true}}]'::jsonb
  );
  v_documents := '[
    {"_id":"booking.projection-legacy","_type":"booking","_rev":"fixture-legacy-1","status":"captured","packageTitle":"Legacy Projection Fixture","startTimeUTC":"2098-02-05T00:00:00Z","grossAmount":10,"currency":"USD"},
    {"_id":"bookingSlot.projection-legacy","_type":"bookingSlot","_rev":"fixture-legacy-1","bookingId":"booking.projection-legacy","startTimeUTC":"2098-02-05T00:00:00Z","status":"active","lockedAt":"2098-01-01T00:00:00Z"}
  ]'::jsonb;
  perform public.roo_import_shadow_batch((
    select jsonb_agg(jsonb_build_object(
      'payload', document,
      'source_hash', encode(extensions.digest(document::text, 'sha256'), 'hex')
    )) from jsonb_array_elements(v_documents) document
  ));
  perform public.roo_refresh_operational_shadow();

  if not exists (
    select 1 from commerce.coupons where legacy_sanity_id = 'coupon.projection-regression'
  ) then
    raise exception 'global coupon mutation was not projected';
  end if;
  if not exists (
    select 1 from commerce.slot_claims claim
    join commerce.bookings booking on booking.id = claim.booking_id
    where booking.legacy_sanity_id = 'booking.projection-legacy'
      and claim.backend_owner = 'sanity'
  ) then
    raise exception 'legacy booking no longer acquires its claim';
  end if;
  if v_native_claims is distinct from (
    select jsonb_agg(to_jsonb(claim) order by start_time_utc)
    from commerce.slot_claims claim
    where start_time_utc in ('2098-02-03T00:00:00Z', '2098-02-04T00:00:00Z')
  ) then
    raise exception 'operational refresh changed authoritative Supabase claims';
  end if;
  if not exists (
    select 1 from commerce.booking_slots
    where legacy_sanity_id = 'bookingSlot.projection-regression'
      and backend_owner = 'supabase' and status = 'active'
  ) or not exists (
    select 1 from commerce.slot_holds
    where legacy_sanity_id = 'slotHold.projection-regression'
      and backend_owner = 'supabase' and phase = 'active'
  ) then
    raise exception 'operational refresh changed native slot ownership';
  end if;

  -- A different legacy booking at the occupied time must still fail closed.
  begin
    v_documents := '[
      {"_id":"booking.projection-conflict","_type":"booking","_rev":"fixture-conflict-1","status":"captured","packageTitle":"Conflicting Projection Fixture","startTimeUTC":"2098-02-03T00:00:00Z","grossAmount":10,"currency":"USD"},
      {"_id":"bookingSlot.projection-conflict","_type":"bookingSlot","_rev":"fixture-conflict-1","bookingId":"booking.projection-conflict","startTimeUTC":"2098-02-03T00:00:00Z","status":"active","lockedAt":"2098-01-01T00:00:00Z"}
    ]'::jsonb;
    perform public.roo_import_shadow_batch((
      select jsonb_agg(jsonb_build_object(
        'payload', document,
        'source_hash', encode(extensions.digest(document::text, 'sha256'), 'hex')
      )) from jsonb_array_elements(v_documents) document
    ));
    perform public.roo_refresh_operational_shadow();
    raise exception 'conflicting legacy booking replaced the native slot claim';
  exception when unique_violation then null;
  end;
  if v_native_claims is distinct from (
    select jsonb_agg(to_jsonb(claim) order by start_time_utc)
    from commerce.slot_claims claim
    where start_time_utc in ('2098-02-03T00:00:00Z', '2098-02-04T00:00:00Z')
  ) then
    raise exception 'conflicting projection damaged authoritative claims';
  end if;
end;
$$;

set constraints all immediate;
rollback;
