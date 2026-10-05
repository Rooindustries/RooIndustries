set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  signatures text[] := array[
    'migration.project_commerce_document_ids_unserialized(text[])',
    'public.roo_project_operational_shadow()',
    'migration.project_commerce_extensions(text[])',
    'public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'
  ];
  definitions text[] := array[]::text[];
  signature text;
  definition text;
  booking_anchor text := $anchor$    migration.money_subunits(coalesce(
      source.payload->>'grossAmount',
      source.payload->>'netAmount',
      source.payload->'bookingPayload'->>'netAmount'
    )),$anchor$;
  booking_replacement text := $replacement$    migration.money_subunits(coalesce(
      source.payload->>'grossAmount',
      source.payload->>'netAmount',
      source.payload->'bookingPayload'->>'netAmount'
    ), migration.booking_currency(source.payload, source.legacy_sanity_id)),$replacement$;
  booking_currency_anchor text := $anchor$migration.currency_code(coalesce(
      source.payload->>'currency',
      source.payload->'bookingPayload'->>'currency'
    ))$anchor$;
  payment_anchor text := $anchor$    migration.money_subunits(coalesce(
      ranked.payload->'pricingSnapshot'->>'netAmount',
      ranked.payload->'bookingPayload'->>'netAmount',
      ranked.payload->'pricingSnapshot'->>'grossAmount',
      ranked.payload->'bookingPayload'->>'grossAmount'
    )),$anchor$;
  payment_replacement text := $replacement$    migration.money_subunits(coalesce(
      ranked.payload->'pricingSnapshot'->>'netAmount',
      ranked.payload->'bookingPayload'->>'netAmount',
      ranked.payload->'pricingSnapshot'->>'grossAmount',
      ranked.payload->'bookingPayload'->>'grossAmount'
    ), migration.payment_currency(ranked.payload, to_jsonb(booking.currency))),$replacement$;
  payment_currency_anchor text := $anchor$migration.currency_code(coalesce(
      ranked.payload->'pricingSnapshot'->>'currency',
      ranked.payload->'bookingPayload'->>'currency'
    ))$anchor$;
  recovery_anchor text := $anchor$    where not source.tombstoned$anchor$;
  recovery_replacement text := $replacement$    where not source.tombstoned
      and not (coalesce(source.payload->'providerRecoveryTerminal', 'false'::jsonb) = 'true'::jsonb
        and coalesce(source.payload->>'providerRecoveryTerminalReason', '')
          in ('payment_currency_mismatch', 'payment_currency_invalid'))$replacement$;
  refund_anchor text := $anchor$else migration.money_subunits_exact(refund.payload->'amount')$anchor$;
  refund_replacement text := $replacement$else round(
        migration.money_subunits_exact(refund.payload->'amount')::numeric *
        migration.money_subunits('1', migration.resolve_currency(jsonb_build_array(
          refund.payload->'currency', to_jsonb(payment.currency)
        ))) / 100
      )::bigint$replacement$;
begin
  if to_regprocedure('migration.try_numeric(text)') is null
    or to_regprocedure('migration.currency_code(text)') is null
    or to_regprocedure('migration.money_subunits(text)') is null
    or to_regprocedure('migration.restore_commerce_owners(text[])') is null
    or to_regprocedure('migration.money_subunits_exact(jsonb)') is null
    or to_regprocedure('migration.money_subunits(text,text)') is not null
    or to_regprocedure('migration.resolve_currency(jsonb)') is not null
    or to_regprocedure('migration.payment_currency(jsonb,jsonb)') is not null
    or to_regprocedure('migration.booking_currency(jsonb,text)') is not null
    or to_regrole('service_role') is null
    or (
      select count(*) from pg_catalog.pg_attribute
      where attrelid = to_regclass('migration.source_documents')
        and not attisdropped and attnotnull
        and ((attname in ('legacy_sanity_id', 'document_type') and atttypid = 'text'::regtype)
          or (attname = 'payload' and atttypid = 'jsonb'::regtype)
          or (attname = 'tombstoned' and atttypid = 'boolean'::regtype))
    ) <> 4
    or (
      select count(*) from pg_catalog.pg_attribute
      where attrelid in (to_regclass('commerce.bookings'), to_regclass('commerce.payment_records'))
        and not attisdropped and attnotnull
        and ((attname = 'amount_subunits' and atttypid = 'bigint'::regtype)
          or (attname = 'currency' and atttypid = 'text'::regtype))
    ) <> 4 then
    raise exception 'currency projection migration requires the current booking/payment amount contract';
  end if;
  foreach signature in array signatures loop
    if to_regprocedure(signature) is null or not exists (
      select 1 from pg_catalog.pg_proc where oid = to_regprocedure(signature)
        and prosecdef = (signature <> 'migration.project_commerce_extensions(text[])')
        and proconfig @> array['search_path=""']::text[]
    ) then
      raise exception 'currency projection migration requires current projector %', signature;
    end if;
    definition := pg_get_functiondef(to_regprocedure(signature));
    if signature like 'public.roo_fetch_recovery_payment_documents(%' then
      if (length(definition) - length(replace(definition, recovery_anchor, ''))) <> length(recovery_anchor)
        or position('payment.refund_requires_booking_sync' in definition) = 0
        or position('limit greatest(1, least(coalesce(p_limit, 50), 100))' in definition) = 0 then
        raise exception 'currency projection migration: unexpected recovery selector contract';
      end if;
      definitions := array_append(definitions, replace(definition, recovery_anchor, recovery_replacement));
      continue;
    end if;
    if signature = 'migration.project_commerce_extensions(text[])' then
      if (length(definition) - length(replace(definition, refund_anchor, ''))) <> length(refund_anchor) then
        raise exception 'currency projection migration: unexpected refund amount anchor';
      end if;
      if (length(definition) - length(replace(definition, 'migration.currency_code(coalesce(refund.payload->>''currency'', payment.currency))', ''))) <> length('migration.currency_code(coalesce(refund.payload->>''currency'', payment.currency))') then
        raise exception 'currency projection migration: unexpected refund currency anchor';
      end if;
      definitions := array_append(definitions, replace(replace(definition, refund_anchor, refund_replacement),
        'migration.currency_code(coalesce(refund.payload->>''currency'', payment.currency))',
        'migration.resolve_currency(jsonb_build_array(refund.payload->''currency'', to_jsonb(payment.currency)))'));
      continue;
    end if;
    if (length(definition) - length(replace(definition, booking_anchor, ''))) <> length(booking_anchor)
      or (length(definition) - length(replace(definition, payment_anchor, ''))) <> length(payment_anchor)
      or (length(definition) - length(replace(definition, booking_currency_anchor, ''))) <> length(booking_currency_anchor)
      or (length(definition) - length(replace(definition, payment_currency_anchor, ''))) <> length(payment_currency_anchor) then
      raise exception 'currency projection migration: unexpected projector amount anchor %', signature;
    end if;
    if signature = 'public.roo_project_operational_shadow()' then
      if (length(definition) - length(replace(definition, '  return v_counts;', ''))) <> length('  return v_counts;')
        or position('perform migration.restore_commerce_owners(null)' in definition) <> 0 then
        raise exception 'currency projection migration: unexpected full projector ownership anchor';
      end if;
      definition := replace(definition, '  return v_counts;', E'  perform migration.restore_commerce_owners(null);\n  return v_counts;');
    end if;
    definitions := array_append(definitions, replace(replace(replace(replace(definition,
      booking_anchor, booking_replacement), payment_anchor, payment_replacement),
      booking_currency_anchor, 'migration.booking_currency(source.payload, source.legacy_sanity_id)'),
      payment_currency_anchor, 'migration.payment_currency(ranked.payload, to_jsonb(booking.currency))'));
  end loop;
  execute $helper$
    create function migration.resolve_currency(p_values jsonb)
    returns text
    language plpgsql
    immutable
    set search_path = ''
    as $body$
    declare
      value jsonb;
      code text;
      resolved text;
    begin
      for value in select jsonb_array_elements(p_values) loop
        if value is null or value = 'null'::jsonb then continue; end if;
        if jsonb_typeof(value) <> 'string' then
          raise exception using errcode = '22023', message = 'payment_currency_invalid';
        end if;
        code := upper(btrim(value #>> '{}'));
        if code = '' then continue; end if;
        if code !~ '^[A-Z]{3}$' then
          raise exception using errcode = '22023', message = 'payment_currency_invalid';
        end if;
        if resolved is not null and resolved <> code then
          raise exception using errcode = '22023', message = 'payment_currency_mismatch';
        end if;
        resolved := code;
      end loop;
      return coalesce(resolved, 'USD');
    end;
    $body$;
  $helper$;
  execute $helper$
    create function migration.payment_currency(p_payload jsonb, p_currency jsonb default null)
    returns text
    language sql
    immutable
    set search_path = ''
    as $body$
      with currencies as (
        select jsonb_build_array(
          p_payload->'pricingSnapshot'->'currency', p_payload->'bookingPayload'->'currency',
          p_payload->'providerPublicData'->'currency', p_payload->'refundCurrency'
        ) || coalesce((select jsonb_agg(refund->'currency')
          from jsonb_array_elements(case when jsonb_typeof(p_payload->'refunds') = 'array'
            then p_payload->'refunds' else '[]'::jsonb end) refund), '[]'::jsonb) currency_values
      )
      select migration.resolve_currency(currency_values || case when exists (
        select 1 from jsonb_array_elements(currency_values) value
        where value <> 'null'::jsonb
          and (jsonb_typeof(value) <> 'string' or btrim(value #>> '{}') <> '')
      ) then '[]'::jsonb else jsonb_build_array(p_currency) end)
      from currencies;
    $body$;
  $helper$;
  execute $helper$
    create function migration.booking_currency(p_payload jsonb, p_legacy_id text)
    returns text
    language plpgsql
    stable
    set search_path = ''
    as $body$
    declare
      currency_values jsonb := jsonb_build_array(p_payload->'currency', p_payload->'bookingPayload'->'currency');
      payment jsonb;
    begin
      for payment in select source.payload from migration.source_documents source
        where source.document_type = 'paymentRecord' and not source.tombstoned
          and (source.legacy_sanity_id = nullif(p_payload->>'paymentRecordId', '')
            or source.payload->>'bookingId' = p_legacy_id) loop
        currency_values := currency_values || to_jsonb(migration.payment_currency(payment, to_jsonb(migration.resolve_currency(jsonb_build_array(
          p_payload->'currency', p_payload->'bookingPayload'->'currency')))));
      end loop;
      return migration.resolve_currency(currency_values);
    end;
    $body$;
  $helper$;
  execute $helper$
    create function migration.money_subunits(p_value text, p_currency text)
    returns bigint
    language sql
    immutable
    set search_path = ''
    as $body$
      select greatest(0, coalesce(round(migration.try_numeric(p_value) *
        case
          when migration.currency_code(p_currency) in
            ('BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF') then 1
          when migration.currency_code(p_currency) in
            ('BHD','IQD','JOD','KWD','LYD','OMR','TND') then 1000
          else 100
        end), 0)::bigint);
    $body$;
  $helper$;
  execute 'revoke all on function migration.money_subunits(text,text) from public, anon, authenticated';
  execute 'grant execute on function migration.money_subunits(text,text) to service_role';
  execute 'revoke all on function migration.resolve_currency(jsonb), migration.payment_currency(jsonb,jsonb), migration.booking_currency(jsonb,text) from public, anon, authenticated';
  execute 'grant execute on function migration.resolve_currency(jsonb), migration.payment_currency(jsonb,jsonb), migration.booking_currency(jsonb,text) to service_role';
  foreach definition in array definitions loop
    execute definition;
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
