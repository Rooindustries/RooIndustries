begin;

do $$
declare
  v_generation integer;
  v_quote jsonb;
  v_referral_result jsonb;
  v_referral_event_key text;
begin
  select generation into v_generation
  from migration.commerce_control where singleton;

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

  begin
    insert into licensing.products (sku, name, default_max_devices)
    values ('fixture-product', 'Fixture', 2);
    raise exception 'multi-device product was accepted';
  exception when check_violation then null;
  end;
end;
$$;

rollback;
