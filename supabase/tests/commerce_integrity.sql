begin;

do $$
declare
  v_generation integer;
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
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.roo_commerce_control()', 'execute')
    or has_function_privilege('authenticated', 'public.roo_commerce_control()', 'execute')
    or not has_function_privilege('service_role', 'public.roo_commerce_control()', 'execute')
  then
    raise exception 'commerce RPC privileges are unsafe';
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
