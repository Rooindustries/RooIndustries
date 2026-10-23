begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
create temporary table creator_review_session (unused boolean) on commit drop;

create or replace function pg_temp.creator_empty_code_previous(
  p_referral_legacy_id text,
  p_referral_code text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select booking.package_title, booking.booking_payload,
      booking.booking_payload->>'commissionCalculationVersion' = '2' as current_calculation,
      case when btrim(coalesce(booking.booking_payload->>'commissionAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionAmount')::numeric end as stored,
      case when btrim(coalesce(booking.booking_payload->>'netAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'netAmount')::numeric end as net,
      case when btrim(coalesce(booking.booking_payload->>'grossAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'grossAmount')::numeric end as gross,
      case when btrim(coalesce(booking.booking_payload->>'commissionPercent', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionPercent')::numeric end as percent,
      case when btrim(coalesce(booking.booking_payload->>'couponDiscountAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'couponDiscountAmount')::numeric end as coupon,
      case when btrim(coalesce(booking.booking_payload->>'commissionBaseAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionBaseAmount')::numeric end as basis
    from commerce.bookings booking
    where booking.status in ('captured', 'completed')
      and (booking.booking_payload#>>'{referral,_ref}' = p_referral_legacy_id
        or (coalesce(p_referral_code, '') <> ''
          and lower(booking.booking_payload->>'referralCode') = lower(p_referral_code))
        or (booking.booking_payload->>'commissionCalculationVersion' is distinct from '2'
          and coalesce(p_referral_code, '') = ''
          and coalesce(booking.booking_payload->>'referralCode', '') = ''))
  ), normalized as (
    select
      regexp_replace(coalesce(package_title, 'Unknown'), '\s*\(upgrade\)\s*$', '', 'i') as package_title,
      case when lower(coalesce(package_title, '')) like any(array[
        '%xoc%', '%extreme overclock%', '%performance vertex max%'
      ]) then 'xoc' else 'vertex' end as package_class,
      case
        when current_calculation then coalesce(round(stored, 2),
          round(greatest(0, coalesce(round(basis, 2), case when gross is not null then round(gross, 2) - round(coalesce(coupon, 0), 2) else round(coalesce(net, 0), 2) end)) * coalesce(percent, 0) / 100, 2))
        when stored is not null and (stored <> 0 or booking_payload ? 'dodoOriginalCommissionAmount') then stored
        else coalesce(nullif(net, 0), gross, 0) * coalesce(percent, 0) / 100
      end as earned
    from terms
  ), package_totals as (
    select package_title, round(sum(earned), 2) amount
    from normalized group by package_title
  )
  select jsonb_build_object(
    'xoc', coalesce(round(sum(earned) filter (where package_class = 'xoc'), 2), 0),
    'vertex', coalesce(round(sum(earned) filter (where package_class = 'vertex'), 2), 0),
    'total', coalesce(round(sum(earned), 2), 0),
    'byPackage', coalesce((select jsonb_object_agg(package_title, amount order by package_title) from package_totals), '{}'::jsonb)
  ) from normalized;
$$;

create temporary table creator_empty_code_before on commit drop as
select source.legacy_sanity_id, source.payload, source.source_revision,
  pg_temp.creator_empty_code_previous(source.legacy_sanity_id, '') as previous
from migration.source_documents source
where source.document_type = 'referral' and not source.tombstoned
  and coalesce(source.payload#>>'{slug,current}', '') = ''
  and not (source.payload ? 'emptyCodeReviewXoc');

create or replace function public.roo_referral_earnings_summary(
  p_referral_legacy_id text,
  p_referral_code text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select booking.package_title, booking.booking_payload,
      booking.booking_payload->>'commissionCalculationVersion' = '2' as current_calculation,
      case when btrim(coalesce(booking.booking_payload->>'commissionAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionAmount')::numeric end as stored,
      case when btrim(coalesce(booking.booking_payload->>'netAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'netAmount')::numeric end as net,
      case when btrim(coalesce(booking.booking_payload->>'grossAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'grossAmount')::numeric end as gross,
      case when btrim(coalesce(booking.booking_payload->>'commissionPercent', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionPercent')::numeric end as percent,
      case when btrim(coalesce(booking.booking_payload->>'couponDiscountAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'couponDiscountAmount')::numeric end as coupon,
      case when btrim(coalesce(booking.booking_payload->>'commissionBaseAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (booking.booking_payload->>'commissionBaseAmount')::numeric end as basis
    from commerce.bookings booking
    where booking.status in ('captured', 'completed')
      and (booking.booking_payload#>>'{referral,_ref}' = p_referral_legacy_id
        or (coalesce(p_referral_code, '') <> ''
          and nullif(booking.booking_payload#>>'{referral,_ref}', '') is null
          and booking.booking_payload->>'referralAttributionVersion' is distinct from '2'
          and lower(booking.booking_payload->>'referralCode') = lower(p_referral_code)))
  ), normalized as (
    select
      regexp_replace(coalesce(package_title, 'Unknown'), '\s*\(upgrade\)\s*$', '', 'i') as package_title,
      case when lower(coalesce(package_title, '')) like any(array[
        '%xoc%', '%extreme overclock%', '%performance vertex max%'
      ]) then 'xoc' else 'vertex' end as package_class,
      case
        when current_calculation then coalesce(round(stored, 2),
          round(greatest(0, coalesce(round(basis, 2), case when gross is not null then round(gross, 2) - round(coalesce(coupon, 0), 2) else round(coalesce(net, 0), 2) end)) * coalesce(percent, 0) / 100, 2))
        when stored is not null and (stored <> 0 or booking_payload ? 'dodoOriginalCommissionAmount') then stored
        else coalesce(nullif(net, 0), gross, 0) * coalesce(percent, 0) / 100
      end as earned
    from terms
  ), package_totals as (
    select package_title, round(sum(earned), 2) amount
    from normalized group by package_title
  )
  select jsonb_build_object(
    'xoc', coalesce(round(sum(earned) filter (where package_class = 'xoc'), 2), 0),
    'vertex', coalesce(round(sum(earned) filter (where package_class = 'vertex'), 2), 0),
    'total', coalesce(round(sum(earned), 2), 0),
    'byPackage', coalesce((select jsonb_object_agg(package_title, amount order by package_title) from package_totals), '{}'::jsonb)
  ) from normalized;
$$;

do $$
declare
  creator record;
  correct jsonb;
  review_xoc numeric;
  review_vertex numeric;
  paid_xoc numeric;
  paid_vertex numeric;
  protected_xoc numeric;
  protected_vertex numeric;
  doc jsonb;
begin
  for creator in select * from creator_empty_code_before loop
    correct := public.roo_referral_earnings_summary(creator.legacy_sanity_id, '');
    review_xoc := least(greatest(0, coalesce(case when btrim(coalesce(creator.payload->>'earnedXoc', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (creator.payload->>'earnedXoc')::numeric end, (creator.previous->>'xoc')::numeric) - (correct->>'xoc')::numeric), greatest(0, (creator.previous->>'xoc')::numeric - (correct->>'xoc')::numeric));
    review_vertex := least(greatest(0, coalesce(case when btrim(coalesce(creator.payload->>'earnedVertex', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (creator.payload->>'earnedVertex')::numeric end, (creator.previous->>'vertex')::numeric) - (correct->>'vertex')::numeric), greatest(0, (creator.previous->>'vertex')::numeric - (correct->>'vertex')::numeric));
    select coalesce(sum(case when btrim(coalesce(p->>'amount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (p->>'amount')::numeric else 0 end), 0) into paid_xoc from jsonb_array_elements(case when jsonb_typeof(creator.payload->'xocPayments') = 'array' then creator.payload->'xocPayments' else '[]'::jsonb end) p;
    select coalesce(sum(case when btrim(coalesce(p->>'amount', '')) ~ '^-?[0-9]+([.][0-9]+)?$' then (p->>'amount')::numeric else 0 end), 0) into paid_vertex from jsonb_array_elements(case when jsonb_typeof(creator.payload->'vertexPayments') = 'array' then creator.payload->'vertexPayments' else '[]'::jsonb end) p;
    protected_xoc := least(review_xoc, greatest(0, paid_xoc - (correct->>'xoc')::numeric));
    protected_vertex := least(review_vertex, greatest(0, paid_vertex - (correct->>'vertex')::numeric));
    doc := creator.payload || jsonb_build_object(
      'emptyCodeReviewXoc', review_xoc, 'emptyCodeReviewVertex', review_vertex,
      'emptyCodeProtectedPaidXoc', protected_xoc, 'emptyCodeProtectedPaidVertex', protected_vertex,
      'underReviewTotal', review_xoc + review_vertex - protected_xoc - protected_vertex + case when creator.payload->>'registrationStatus' = 'pending_email' then greatest(0, (correct->>'total')::numeric - paid_xoc - paid_vertex + protected_xoc + protected_vertex) else 0 end,
      'earnedXoc', (correct->>'xoc')::numeric, 'earnedVertex', (correct->>'vertex')::numeric, 'earnedTotal', (correct->>'total')::numeric,
      'paidXoc', paid_xoc, 'paidVertex', paid_vertex, 'paidTotal', paid_xoc + paid_vertex,
      'owedXoc', case when creator.payload->>'registrationStatus' = 'pending_email' then 0 else greatest(0, (correct->>'xoc')::numeric - paid_xoc + protected_xoc) end,
      'owedVertex', case when creator.payload->>'registrationStatus' = 'pending_email' then 0 else greatest(0, (correct->>'vertex')::numeric - paid_vertex + protected_vertex) end,
      'owedTotal', case when creator.payload->>'registrationStatus' = 'pending_email' then 0 else greatest(0, (correct->>'total')::numeric - paid_xoc - paid_vertex + protected_xoc + protected_vertex) end
    );
    perform public.roo_apply_document_mutations(jsonb_build_array(jsonb_build_object(
      'operation', 'replace', 'document', doc, 'expected_revision', creator.source_revision
    )));
  end loop;
end;
$$;

do $$
declare
  definition text := pg_get_functiondef('public.roo_consume_quote_rate_limit_and_get_pricing(text,timestamp with time zone,timestamp with time zone,integer,text[],text,text,text)'::regprocedure);
begin
  definition := replace(definition, E'      and coalesce(source.payload->>''registrationStatus'', '''') <> ''pending_email''', '');
  if position('''creatorEmail''' in definition) = 0 then
    definition := replace(definition, '''currentCommissionPercent'', source.payload->''currentCommissionPercent'',', '''creatorEmail'', source.payload->''creatorEmail'', ''currentCommissionPercent'', source.payload->''currentCommissionPercent'',');
  end if;
  execute definition;
end;
$$;

drop function pg_temp.creator_empty_code_previous(text, text);
commit;
