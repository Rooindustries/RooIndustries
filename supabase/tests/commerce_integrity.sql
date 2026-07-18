begin;

do $$
declare
  v_generation integer;
  v_quote jsonb;
  v_referral_result jsonb;
  v_referral_event_key text;
  v_cleanup_result jsonb;
  v_cleanup_replay jsonb;
begin
  select generation into v_generation
  from migration.commerce_control where singleton;

  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:too-many-mutations',
      (
        select jsonb_agg(jsonb_build_object(
          'operation', 'delete',
          'id', 'coupon.bound-' || item::text
        ))
        from generate_series(1, 101) item
      ),
      v_generation
    );
    raise exception 'commerce mutation count bound was not enforced';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:invalid-identifier',
      '[{"operation":"create","document":{"_id":"coupon..invalid","_type":"coupon","code":"INVALID"}}]'::jsonb,
      v_generation
    );
    raise exception 'commerce mutation identifier grammar was not enforced';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:oversized-document',
      jsonb_build_array(jsonb_build_object(
        'operation', 'create',
        'document', jsonb_build_object(
          '_id', 'coupon.oversized',
          '_type', 'coupon',
          'code', 'OVERSIZED',
          'notes', repeat('x', 262145)
        )
      )),
      v_generation
    );
    raise exception 'commerce mutation document size bound was not enforced';
  exception when sqlstate '22023' then null;
  end;

  perform public.roo_set_commerce_starts_paused(
    v_generation,
    true,
    'rolled-back paused-start fixture'
  );

  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:paused-hold',
      '[{"operation":"create","document":{"_id":"slotHold.paused","_type":"slotHold"}}]'::jsonb,
      v_generation
    );
    raise exception 'paused commerce start was accepted';
  exception when sqlstate '55006' then null;
  end;

  perform public.roo_set_commerce_starts_paused(
    v_generation,
    false,
    'rolled-back integrity fixture'
  );

  perform public.roo_apply_commerce_document_mutations(
    'fixture:create-hold',
    '[{"operation":"create","document":{"_id":"slotHold.fixture","_type":"slotHold","startTimeUTC":"2099-01-01T00:00:00.000Z","phase":"holding","expiresAt":"2099-01-01T00:20:00.000Z","holdNonce":"fixture"}}]'::jsonb,
    v_generation
  );

  if not exists (
    select 1
    from commerce.slot_claims claim
    join commerce.slot_holds hold on hold.id = claim.hold_id
    where hold.legacy_sanity_id = 'slotHold.fixture'
      and claim.claim_type = 'hold'
  ) then
    raise exception 'new hold did not acquire the authoritative slot claim';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:hold-payment',
    jsonb_build_array(jsonb_build_object(
      'operation', 'replace',
      'expected_revision', (
        select source_revision from migration.source_documents
        where legacy_sanity_id = 'slotHold.fixture'
      ),
      'document', (
        select payload || jsonb_build_object('phase', 'payment_pending')
        from migration.source_documents
        where legacy_sanity_id = 'slotHold.fixture'
      )
    )),
    v_generation
  );
  if not exists (
    select 1
    from commerce.slot_claims claim
    join commerce.slot_holds hold on hold.id = claim.hold_id
    where hold.legacy_sanity_id = 'slotHold.fixture'
      and hold.phase = 'payment'
      and claim.claim_type = 'hold'
  ) then
    raise exception 'payment transition did not retain hold claim ownership';
  end if;

  begin
    delete from commerce.slot_claims claim
    using commerce.slot_holds hold
    where hold.id = claim.hold_id
      and hold.legacy_sanity_id = 'slotHold.fixture';
    perform public.roo_apply_commerce_document_mutations(
      'fixture:payment-without-claim',
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace',
        'expected_revision', (
          select source_revision from migration.source_documents
          where legacy_sanity_id = 'slotHold.fixture'
        ),
        'document', (
          select payload || jsonb_build_object('expiresAt', '2099-01-01T00:25:00.000Z')
          from migration.source_documents
          where legacy_sanity_id = 'slotHold.fixture'
        )
      )),
      v_generation
    );
    raise exception 'payment transition without an owned claim was accepted';
  exception when unique_violation then null;
  end;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:booked-slot',
    '[
      {"operation":"create","document":{"_id":"booking.claimed-slot","_type":"booking","status":"captured","packageTitle":"Claim Fixture","startTimeUTC":"2099-02-01T00:00:00.000Z","grossAmount":10,"currency":"USD"}},
      {"operation":"create","document":{"_id":"bookingSlot.claimed-slot","_type":"bookingSlot","bookingId":"booking.claimed-slot","startTimeUTC":"2099-02-01T00:00:00.000Z","status":"active","lockedAt":"2099-01-01T00:00:00.000Z"}}
    ]'::jsonb,
    v_generation
  );
  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:hold-races-booking',
      '[{"operation":"create","document":{"_id":"slotHold.races-booking","_type":"slotHold","startTimeUTC":"2099-02-01T00:00:00.000Z","packageTitle":"Claim Fixture","phase":"holding","expiresAt":"2099-02-01T00:20:00.000Z","holdNonce":"racing-hold"}}]'::jsonb,
      v_generation
    );
    raise exception 'a hold acquired an already booked slot';
  exception when unique_violation then null;
  end;
  if exists (
    select 1 from migration.source_documents
    where legacy_sanity_id = 'slotHold.races-booking'
  ) or not exists (
    select 1 from commerce.slot_claims claim
    join commerce.bookings booking on booking.id = claim.booking_id
    where booking.legacy_sanity_id = 'booking.claimed-slot'
      and claim.claim_type = 'booking'
  ) then
    raise exception 'conflicting hold rollback damaged the booking claim';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:hold-before-recovery',
    '[{"operation":"create","document":{"_id":"slotHold.before-recovery","_type":"slotHold","startTimeUTC":"2099-02-02T00:00:00.000Z","packageTitle":"Claim Fixture","phase":"holding","expiresAt":"2099-02-02T00:20:00.000Z","holdNonce":"existing-hold"}}]'::jsonb,
    v_generation
  );
  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:recovery-races-hold',
      '[
        {"operation":"create","document":{"_id":"booking.races-hold","_type":"booking","status":"captured","packageTitle":"Claim Fixture","startTimeUTC":"2099-02-02T00:00:00.000Z","grossAmount":10,"currency":"USD"}},
        {"operation":"create","document":{"_id":"bookingSlot.races-hold","_type":"bookingSlot","bookingId":"booking.races-hold","startTimeUTC":"2099-02-02T00:00:00.000Z","status":"active","lockedAt":"2099-01-01T00:00:00.000Z"}}
      ]'::jsonb,
      v_generation
    );
    raise exception 'missing-hold recovery replaced another customer hold';
  exception when unique_violation then null;
  end;
  if exists (
    select 1 from migration.source_documents
    where legacy_sanity_id = 'booking.races-hold'
  ) or not exists (
    select 1 from commerce.slot_claims claim
    join commerce.slot_holds hold on hold.id = claim.hold_id
    where hold.legacy_sanity_id = 'slotHold.before-recovery'
      and claim.claim_type = 'hold'
  ) then
    raise exception 'conflicting recovery rollback damaged the hold claim';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:missing-hold-recovery',
    '[
      {"operation":"create","document":{"_id":"booking.missing-hold","_type":"booking","status":"captured","packageTitle":"Claim Fixture","startTimeUTC":"2099-02-03T00:00:00.000Z","grossAmount":10,"currency":"USD"}},
      {"operation":"create","document":{"_id":"bookingSlot.missing-hold","_type":"bookingSlot","bookingId":"booking.missing-hold","startTimeUTC":"2099-02-03T00:00:00.000Z","status":"active","lockedAt":"2099-01-01T00:00:00.000Z"}}
    ]'::jsonb,
    v_generation
  );
  if not exists (
    select 1 from commerce.slot_claims claim
    join commerce.bookings booking on booking.id = claim.booking_id
    where booking.legacy_sanity_id = 'booking.missing-hold'
      and claim.claim_type = 'booking'
  ) then
    raise exception 'missing-hold recovery did not atomically claim the slot';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:hold-for-booking',
    '[{"operation":"create","document":{"_id":"slotHold.for-booking","_type":"slotHold","startTimeUTC":"2099-02-04T00:00:00.000Z","packageTitle":"Claim Fixture","phase":"holding","expiresAt":"2099-02-04T00:20:00.000Z","holdNonce":"booking-hold"}}]'::jsonb,
    v_generation
  );
  perform public.roo_apply_commerce_document_mutations(
    'fixture:consume-hold-booking',
    jsonb_build_array(
      jsonb_build_object(
        'operation', 'create',
        'document', '{"_id":"booking.consumes-hold","_type":"booking","status":"captured","packageTitle":"Claim Fixture","startTimeUTC":"2099-02-04T00:00:00.000Z","grossAmount":10,"currency":"USD"}'::jsonb
      ),
      jsonb_build_object(
        'operation', 'create',
        'document', '{"_id":"bookingSlot.consumes-hold","_type":"bookingSlot","bookingId":"booking.consumes-hold","startTimeUTC":"2099-02-04T00:00:00.000Z","status":"active","lockedAt":"2099-01-01T00:00:00.000Z"}'::jsonb
      ),
      jsonb_build_object(
        'operation', 'replace',
        'expected_revision', (
          select source_revision from migration.source_documents
          where legacy_sanity_id = 'slotHold.for-booking'
        ),
        'document', (
          select payload || jsonb_build_object(
            'phase', 'consumed',
            'bookingId', 'booking.consumes-hold'
          )
          from migration.source_documents
          where legacy_sanity_id = 'slotHold.for-booking'
        )
      )
    ),
    v_generation
  );
  if not exists (
    select 1 from commerce.slot_claims claim
    join commerce.bookings booking on booking.id = claim.booking_id
    join commerce.slot_holds hold
      on hold.legacy_sanity_id = 'slotHold.for-booking'
    where booking.legacy_sanity_id = 'booking.consumes-hold'
      and claim.claim_type = 'booking'
      and hold.phase = 'consumed'
  ) then
    raise exception 'normal hold-to-booking transition did not transfer the slot claim';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:create-expired-supabase-hold',
    '[{"operation":"create","document":{"_id":"slotHold.cleanup-fixture","_type":"slotHold","startTimeUTC":"2000-01-01T00:00:00.000Z","packageTitle":"Cleanup Fixture","phase":"holding","expiresAt":"2000-01-01T00:20:00.000Z","holdNonce":"cleanup-fixture"}}]'::jsonb,
    v_generation
  );
  insert into commerce.slot_claims (
    start_time_utc, claim_type, hold_id, expires_at, legacy_sanity_id,
    source_revision, source_hash, backend_owner
  )
  select
    hold.start_time_utc, 'hold', hold.id, hold.expires_at,
    hold.legacy_sanity_id, hold.source_revision, hold.source_hash, 'supabase'
  from commerce.slot_holds hold
  where hold.legacy_sanity_id = 'slotHold.cleanup-fixture';

  v_cleanup_result := public.roo_cleanup_expired_supabase_holds(
    v_generation,
    10
  );
  if coalesce((v_cleanup_result->>'expired_holds')::integer, -1) <> 1
    or coalesce((v_cleanup_result->>'removed_slot_claims')::integer, -1) <> 1
    or coalesce((v_cleanup_result->>'mirror_events_enqueued')::integer, -1) <> 1
  then
    raise exception 'expired Supabase hold cleanup returned invalid counters';
  end if;
  if not exists (
    select 1
    from migration.source_documents source
    join commerce.slot_holds hold
      on hold.legacy_sanity_id = source.legacy_sanity_id
    where source.legacy_sanity_id = 'slotHold.cleanup-fixture'
      and source.backend_owner = 'supabase'
      and source.cutover_generation = v_generation
      and source.payload->>'phase' = 'expired'
      and source.payload->>'releaseReason' = 'expired_by_operational_cleanup'
      and nullif(source.payload->>'holdNonce', '') is not null
      and hold.backend_owner = 'supabase'
      and hold.cutover_generation = v_generation
      and hold.phase = 'expired'
      and hold.release_reason = 'expired_by_operational_cleanup'
  ) then
    raise exception 'expired Supabase hold cleanup did not converge canonical and typed state';
  end if;
  if exists (
    select 1 from commerce.slot_claims claim
    join commerce.slot_holds hold on hold.id = claim.hold_id
    where hold.legacy_sanity_id = 'slotHold.cleanup-fixture'
  ) then
    raise exception 'expired Supabase hold cleanup left its slot claim active';
  end if;
  if (
    select count(*)
    from migration.commerce_mirror_outbox mirror
    where mirror.document_ids @> array['slotHold.cleanup-fixture']::text[]
  ) <> 2 then
    raise exception 'expired Supabase hold cleanup did not enqueue exactly one new mirror event';
  end if;

  v_cleanup_replay := public.roo_cleanup_expired_supabase_holds(
    v_generation,
    10
  );
  if coalesce((v_cleanup_replay->>'expired_holds')::integer, -1) <> 0
    or coalesce((v_cleanup_replay->>'removed_slot_claims')::integer, -1) <> 0
    or coalesce((v_cleanup_replay->>'mirror_events_enqueued')::integer, -1) <> 0
  then
    raise exception 'expired Supabase hold cleanup replay was not idempotent';
  end if;
  begin
    perform public.roo_cleanup_expired_supabase_holds(v_generation + 1, 10);
    raise exception 'expired Supabase hold cleanup accepted a stale generation';
  exception when sqlstate '40001' then null;
  end;

  -- Exact response replay must succeed even if a pause begins after commit.
  perform public.roo_set_commerce_starts_paused(
    v_generation,
    true,
    'rolled-back replay fixture'
  );
  perform public.roo_apply_commerce_document_mutations(
    'fixture:create-hold',
    '[{"operation":"create","document":{"_id":"slotHold.fixture","_type":"slotHold","startTimeUTC":"2099-01-01T00:00:00.000Z","phase":"holding","expiresAt":"2099-01-01T00:20:00.000Z","holdNonce":"fixture"}}]'::jsonb,
    v_generation
  );

  begin
    perform public.roo_apply_commerce_document_mutations(
      'fixture:create-hold',
      '[{"operation":"create","document":{"_id":"slotHold.different","_type":"slotHold"}}]'::jsonb,
      v_generation
    );
    raise exception 'command id reuse with different input was accepted';
  exception when unique_violation then null;
  end;

  perform public.roo_set_commerce_starts_paused(
    v_generation,
    false,
    'rolled-back tombstone fixture'
  );
  perform public.roo_apply_commerce_document_mutations(
    'fixture:create-coupon',
    '[{"operation":"create","document":{"_id":"coupon.fixture","_type":"coupon","code":"FIXTURE","isActive":true}}]'::jsonb,
    v_generation
  );
  perform public.roo_apply_commerce_document_mutations(
    'fixture:delete-coupon',
    jsonb_build_array(jsonb_build_object(
      'operation', 'delete',
      'id', 'coupon.fixture',
      'expected_revision', (
        select source_revision from migration.source_documents
        where legacy_sanity_id = 'coupon.fixture'
      )
    )),
    v_generation
  );
  perform public.roo_apply_commerce_document_mutations(
    'fixture:recreate-coupon',
    '[{"operation":"create_if_missing","document":{"_id":"coupon.fixture","_type":"coupon","code":"FIXTURE","isActive":true}}]'::jsonb,
    v_generation
  );

  if not exists (
    select 1 from migration.source_documents
    where legacy_sanity_id = 'coupon.fixture' and not tombstoned
  ) then
    raise exception 'tombstoned compatibility document was not recreated';
  end if;
  if (select count(*) from commerce.coupons where legacy_sanity_id = 'coupon.fixture') <> 1 then
    raise exception 'tombstoned typed document was not recreated';
  end if;

  perform public.roo_apply_commerce_document_mutations(
    'fixture:canonical-payment-alias',
    '[
      {"operation":"create","document":{"_id":"booking.alias-fixture","_type":"booking","status":"captured","packageTitle":"Fixture","startTimeUTC":"2099-01-02T00:00:00.000Z","grossAmount":10,"currency":"USD","paymentRecordId":"payment.canonical-fixture"}},
      {"operation":"create","document":{"_id":"payment.canonical-fixture","_type":"paymentRecord","provider":"razorpay","status":"booked","bookingId":"booking.alias-fixture","providerOrderId":"order-canonical-fixture","pricingSnapshot":{"netAmount":10,"currency":"USD"}}},
      {"operation":"create","document":{"_id":"payment.duplicate-fixture","_type":"paymentRecord","provider":"razorpay","status":"booked","bookingId":"booking.alias-fixture","providerOrderId":"order-duplicate-fixture","duplicatePaymentRecord":true,"canonicalPaymentRecordId":"payment.canonical-fixture","pricingSnapshot":{"netAmount":0,"currency":"USD"}}}
    ]'::jsonb,
    v_generation
  );

  if not exists (
    select 1
    from commerce.payment_records duplicate
    join commerce.payment_records canonical
      on canonical.id = duplicate.canonical_payment_record_id
    where duplicate.legacy_sanity_id = 'payment.duplicate-fixture'
      and duplicate.duplicate_payment_record
      and canonical.legacy_sanity_id = 'payment.canonical-fixture'
  ) then
    raise exception 'duplicate payment alias was not projected';
  end if;

  if coalesce(
    (public.roo_supabase_port_readiness()->>'reciprocalLinkMismatches')::integer,
    -1
  ) <> 0 then
    raise exception 'canonical duplicate alias was reported as a broken reciprocal link';
  end if;

  insert into auth.users (id, email)
  values (
    '10000000-0000-4000-8000-000000000091',
    'referral-integrity-fixture@example.invalid'
  ) on conflict (id) do nothing;
  insert into migration.source_documents (
    legacy_sanity_id, document_type, source_revision, source_hash, payload,
    operational_imported, cms_imported, tombstoned, backend_owner,
    cutover_generation
  ) values (
    'referral.integrity-fixture',
    'referral',
    'referral-integrity-revision-1',
    repeat('d', 64),
    '{
      "_id":"referral.integrity-fixture",
      "_type":"referral",
      "name":"Referral Integrity Fixture",
      "creatorEmail":"referral-integrity-fixture@example.invalid",
      "slug":{"current":"referral-integrity-fixture"},
      "maxCommissionPercent":15,
      "currentCommissionPercent":10,
      "currentDiscountPercent":0,
      "successfulReferrals":0,
      "bypassUnlock":false
    }'::jsonb,
    true,
    true,
    false,
    'supabase',
    v_generation
  ) on conflict (legacy_sanity_id) do update set
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    payload = excluded.payload,
    tombstoned = false,
    backend_owner = excluded.backend_owner,
    cutover_generation = excluded.cutover_generation;
  insert into accounts.creator_profiles (
    user_id, referral_code, legacy_sanity_id, source_revision, source_hash,
    backend_owner
  ) values (
    '10000000-0000-4000-8000-000000000091',
    'referral-integrity-fixture',
    'referral.integrity-fixture',
    'referral-integrity-revision-1',
    repeat('d', 64),
    'supabase'
  ) on conflict (user_id) do update set
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = excluded.backend_owner,
    active = true;

  begin
    perform public.roo_admin_update_creator_terms(
      'fixture:referral-wrong-generation',
      '10000000-0000-4000-8000-000000000091',
      1, 2000, 1000, 1000, true,
      'Wrong generation fixture',
      v_generation + 1
    );
    raise exception 'stale referral generation was accepted';
  exception when sqlstate '40001' then null;
  end;

  update migration.commerce_control
  set primary_backend = 'sanity'
  where singleton;
  begin
    perform public.roo_admin_update_creator_terms(
      'fixture:referral-sanity-primary',
      '10000000-0000-4000-8000-000000000091',
      1, 2000, 1000, 1000, true,
      'Sanity primary fixture',
      v_generation
    );
    raise exception 'Sanity-primary referral mutation was accepted';
  exception when sqlstate '55000' then null;
  end;
  update migration.commerce_control
  set primary_backend = 'supabase'
  where singleton;

  v_referral_result := public.roo_admin_update_creator_terms(
    'fixture:referral-generation-one',
    '10000000-0000-4000-8000-000000000091',
    1, 2000, 1000, 1000, true,
    'Generation one referral fixture',
    v_generation
  );
  v_referral_event_key := v_referral_result->>'mirror_event_key';
  if coalesce((v_referral_result->>'terms_version')::bigint, 0) <> 2
    or coalesce((v_referral_result->>'total_basis_points')::integer, -1) <> 2000
    or coalesce((v_referral_result->>'bypass_referral_requirement')::boolean, false) is not true
  then
    raise exception 'generation-one referral terms were not projected';
  end if;
  if not exists (
    select 1
    from migration.commerce_mirror_outbox mirror
    where mirror.event_key = v_referral_event_key
      and mirror.status = 'pending'
      and mirror.cutover_generation = v_generation
      and mirror.document_ids @> array['referral.integrity-fixture']::text[]
      and mirror.canonical_hash ~ '^[0-9a-f]{64}$'
  ) then
    raise exception 'generation-one referral mirror event is incomplete';
  end if;
  if not exists (
    select 1
    from migration.source_documents source
    where source.legacy_sanity_id = 'referral.integrity-fixture'
      and source.backend_owner = 'supabase'
      and source.cutover_generation = v_generation
      and source.payload->>'maxCommissionPercent' = '20.0000000000000000'
      and source.payload->>'currentCommissionPercent' = '10.0000000000000000'
      and source.payload->>'currentDiscountPercent' = '10.0000000000000000'
      and source.payload->>'bypassUnlock' = 'true'
  ) then
    raise exception 'generation-one referral source document is incomplete';
  end if;
  if jsonb_array_length(public.roo_admin_list_creator_terms(
    'referral-integrity-fixture@example.invalid', 10, 0
  )) <> 1 then
    raise exception 'server-side referral creator search failed';
  end if;

  insert into migration.source_documents (
    legacy_sanity_id, document_type, source_hash, payload,
    operational_imported, cms_imported
  ) values (
    'package.quote-fixture',
    'package',
    repeat('c', 64),
    '{"_id":"package.quote-fixture","_type":"package","title":"Quote Fixture","price":"$42.00"}'::jsonb,
    true,
    true
  );
  v_quote := public.roo_consume_quote_rate_limit_and_get_pricing(
    repeat('b', 64),
    '2099-01-01T00:00:00Z'::timestamptz,
    '2099-01-01T00:15:00Z'::timestamptz,
    1,
    array['Quote Fixture'],
    '',
    '',
    ''
  );
  if coalesce((v_quote#>>'{rateLimit,allowed}')::boolean, false) is not true
    or v_quote#>>'{package,title}' <> 'Quote Fixture'
    or v_quote#>>'{package,price}' <> '$42.00'
  then
    raise exception 'atomic quote rate limit and pricing lookup failed';
  end if;
  v_quote := public.roo_consume_quote_rate_limit_and_get_pricing(
    repeat('b', 64),
    '2099-01-01T00:00:00Z'::timestamptz,
    '2099-01-01T00:15:00Z'::timestamptz,
    1,
    array['Quote Fixture'],
    '',
    '',
    ''
  );
  if coalesce((v_quote#>>'{rateLimit,allowed}')::boolean, true) is not false
    or v_quote ? 'package'
  then
    raise exception 'blocked quote exposed pricing or bypassed its limit';
  end if;
end;
$$;

do $$
begin
  if migration.canonical_business_hash(
    '{"_id":"booking.sequence-hash","_type":"booking","status":"captured"}'::jsonb
  ) <> migration.canonical_business_hash(
    '{"_id":"booking.sequence-hash","_type":"booking","status":"captured","_supabaseSequence":42}'::jsonb
  ) then
    raise exception 'Supabase mirror sequence changed the business hash';
  end if;

  if has_function_privilege('anon', 'public.roo_commerce_control()', 'execute')
    or has_function_privilege('authenticated', 'public.roo_commerce_control()', 'execute')
    or not has_function_privilege('service_role', 'public.roo_commerce_control()', 'execute')
  then
    raise exception 'commerce RPC privileges are unsafe';
  end if;
  if has_function_privilege(
    'anon',
    'public.roo_cleanup_expired_supabase_holds(integer,integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.roo_cleanup_expired_supabase_holds(integer,integer)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.roo_cleanup_expired_supabase_holds(integer,integer)',
    'execute'
  ) then
    raise exception 'expired Supabase hold cleanup RPC privileges are unsafe';
  end if;
  if has_function_privilege(
    'anon',
    'public.roo_admin_list_creator_terms(text,integer,integer)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.roo_admin_update_creator_terms(text,uuid,bigint,integer,integer,integer,boolean,text,integer)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.roo_admin_update_creator_terms(text,uuid,bigint,integer,integer,integer,boolean,text,integer)',
    'execute'
  ) then
    raise exception 'referral creator editor RPC privileges are unsafe';
  end if;
  if has_function_privilege(
    'anon',
    'public.roo_consume_quote_rate_limit_and_get_pricing(text,timestamptz,timestamptz,integer,text[],text,text,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.roo_consume_quote_rate_limit_and_get_pricing(text,timestamptz,timestamptz,integer,text[],text,text,text)',
    'execute'
  ) or not has_function_privilege(
    'service_role',
    'public.roo_consume_quote_rate_limit_and_get_pricing(text,timestamptz,timestamptz,integer,text[],text,text,text)',
    'execute'
  ) then
    raise exception 'atomic quote RPC privileges are unsafe';
  end if;
  if has_table_privilege(
    'anon', 'tourney.tourney_player_auth_operations', 'select'
  ) or has_table_privilege(
    'authenticated', 'migration.commerce_control', 'select'
  ) then
    raise exception 'private tables are browser-readable';
  end if;
end;
$$;

set role postgres;
create function public.fixture_default_privilege()
returns integer language sql as $$ select 1 $$;
reset role;

do $$
begin
  if has_function_privilege(
    'public', 'public.fixture_default_privilege()', 'execute'
  ) or has_function_privilege(
    'anon', 'public.fixture_default_privilege()', 'execute'
  ) or has_function_privilege(
    'authenticated', 'public.fixture_default_privilege()', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.fixture_default_privilege()', 'execute'
  ) then
    raise exception 'future function default privileges are unsafe';
  end if;

  insert into auth.users (id, email)
  values (
    '10000000-0000-4000-8000-000000000092',
    'inactive-licensing-fixture@example.invalid'
  ) on conflict (id) do nothing;
  insert into accounts.principals (id, status)
  values ('20000000-0000-4000-8000-000000000092', 'active');
  insert into accounts.principal_auth_users (
    principal_id,
    user_id,
    is_primary,
    verified_at,
    source
  ) values (
    '20000000-0000-4000-8000-000000000092',
    '10000000-0000-4000-8000-000000000092',
    true,
    now(),
    'migration'
  );
  insert into auth.sessions (user_id)
  values ('10000000-0000-4000-8000-000000000092');

  if public.roo_entitlement_status(
    '10000000-0000-4000-8000-000000000092'
  ) <> '[]'::jsonb then
    raise exception 'active licensing principal returned an invalid status payload';
  end if;

  update accounts.principals
  set status = 'disabled'
  where id = '20000000-0000-4000-8000-000000000092';

  if exists (
    select 1 from auth.sessions
    where user_id = '10000000-0000-4000-8000-000000000092'
  ) or not exists (
    select 1 from auth.users
    where id = '10000000-0000-4000-8000-000000000092'
      and banned_until = 'infinity'::timestamptz
  ) then
    raise exception 'disabling a principal did not revoke and ban its sessions';
  end if;

  begin
    perform public.roo_entitlement_status(
      '10000000-0000-4000-8000-000000000092'
    );
    raise exception 'disabled principal retained licensing access';
  exception when sqlstate 'P0002' then null;
  end;

  update accounts.principals
  set status = 'deleted'
  where id = '20000000-0000-4000-8000-000000000092';
  begin
    perform public.roo_claim_entitlement(
      '10000000-0000-4000-8000-000000000092',
      'inactive-licensing-fixture@example.invalid',
      null
    );
    raise exception 'deleted principal retained licensing access';
  exception when sqlstate 'P0002' then null;
  end;

  begin
    perform public.roo_entitlement_status(
      '10000000-0000-4000-8000-000000000099'
    );
    raise exception 'missing principal retained licensing access';
  exception when sqlstate 'P0002' then null;
  end;

  begin
    insert into licensing.products (sku, name, default_max_devices)
    values ('fixture-product', 'Fixture', 2);
    raise exception 'multi-device product was accepted';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
