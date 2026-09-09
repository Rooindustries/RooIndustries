begin;

do $$
declare
  v_filter jsonb := '[{"path":"paypalOrderId","op":"eq","value":"lookup-fixture-order"}]';
  v_result jsonb;
begin
  insert into migration.source_documents
    (legacy_sanity_id, document_type, source_hash, payload, tombstoned, backend_owner)
  values
    ('lookup-fixture.00-missing', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.00-missing","_type":"booking"}', false, 'supabase'),
    ('lookup-fixture.01-null', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.01-null","_type":"booking","paypalOrderId":null}', false, 'supabase'),
    ('lookup-fixture.02-deleted', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.02-deleted","_type":"booking","paypalOrderId":"lookup-fixture-order"}', true, 'supabase'),
    ('lookup-fixture.03-other-type', 'paymentRecord', repeat('a', 64), '{"_id":"lookup-fixture.03-other-type","_type":"paymentRecord","paypalOrderId":"lookup-fixture-order"}', false, 'supabase'),
    ('lookup-fixture.10-match', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.10-match","_type":"booking","paypalOrderId":"lookup-fixture-order","status":"captured"}', false, 'supabase'),
    ('lookup-fixture.20-match', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.20-match","_type":"booking","paypalOrderId":"lookup-fixture-order","status":"captured"}', false, 'sanity'),
    ('lookup-fixture.30-number', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.30-number","_type":"booking","paypalOrderId":123}', false, 'supabase'),
    ('lookup-fixture.40-string', 'booking', repeat('a', 64), '{"_id":"lookup-fixture.40-string","_type":"booking","paypalOrderId":"123"}', false, 'supabase');

  v_result := public.roo_fetch_shadow_documents_targeted(array['booking'], null, v_filter, 1);
  if v_result #>> '{0,_id}' is distinct from 'lookup-fixture.10-match' or jsonb_array_length(v_result) <> 1 then
    raise exception 'missing, null, deleted or other-type booking hid matching order: %', v_result;
  end if;
  v_result := public.roo_fetch_shadow_documents_targeted(array['booking'], null, v_filter, 10);
  if v_result #>> '{0,_id}' is distinct from 'lookup-fixture.10-match'
    or v_result #>> '{1,_id}' is distinct from 'lookup-fixture.20-match'
    or jsonb_array_length(v_result) <> 2 then
    raise exception 'duplicate order lookup changed lexical order or source ownership: %', v_result;
  end if;
  v_result := public.roo_fetch_shadow_documents_targeted(array['booking'], null,
    '[{"path":"paypalOrderId","op":"eq","value":"123"}]', 1);
  if v_result #>> '{0,_id}' is distinct from 'lookup-fixture.40-string' then
    raise exception 'order lookup coerced a numeric provider ID: %', v_result;
  end if;
  v_result := public.roo_fetch_shadow_documents_targeted(array['booking'], null,
    '[{"path":"paypalOrderId","op":"eq","value":"LOOKUP-FIXTURE-ORDER"}]', 1);
  if v_result <> '[]'::jsonb then
    raise exception 'order lookup changed case sensitivity: %', v_result;
  end if;

  v_result := public.roo_fetch_shadow_documents_targeted(array['booking'],
    array['lookup-fixture.20-match','lookup-fixture.02-deleted','lookup-fixture.10-match','lookup-fixture.10-match','lookup-fixture.03-other-type'], '[]', 10);
  if v_result #>> '{0,_id}' is distinct from 'lookup-fixture.10-match'
    or v_result #>> '{1,_id}' is distinct from 'lookup-fixture.20-match'
    or jsonb_array_length(v_result) <> 2 then
    raise exception 'ID lookup changed filtering, deduplication or lexical order: %', v_result;
  end if;
  if public.roo_fetch_shadow_documents_targeted(null, array[]::text[], '[]', 10) <> '[]'::jsonb then
    raise exception 'empty ID list should return no documents';
  end if;
  if jsonb_array_length(public.roo_fetch_shadow_documents_targeted(null,
    array['lookup-fixture.10-match','lookup-fixture.20-match'], '[]', 0)) <> 1 then
    raise exception 'ID lookup changed minimum result limit';
  end if;
  v_result := public.roo_fetch_shadow_documents_targeted(null,
    array['lookup-fixture.10-match'], '[{"path":"status","op":"eq","value":"refunded"}]', 10);
  if v_result <> '[]'::jsonb then
    raise exception 'ID lookup ignored remaining filters: %', v_result;
  end if;
end;
$$;

rollback;
