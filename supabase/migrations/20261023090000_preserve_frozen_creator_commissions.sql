begin;

do $$
declare
  v_booking migration.source_documents%rowtype;
  v_generation integer;
begin
  perform 1 from migration.source_documents
  where document_type in ('booking', 'referral', 'creatorPayout') and not tombstoned
  order by legacy_sanity_id for update;
  select generation into v_generation from migration.commerce_control where singleton;
  for v_booking in
    select booking.* from migration.source_documents booking
    where booking.document_type = 'booking' and not booking.tombstoned
      and coalesce(booking.payload->>'commissionCalculationVersion', '') <> '2'
      and exists (
        select 1 from migration.source_documents creator
        where creator.document_type = 'referral' and not creator.tombstoned
          and (creator.legacy_sanity_id = booking.payload#>>'{referral,_ref}'
            or (nullif(booking.payload->>'referralCode', '') is not null
              and lower(creator.payload#>>'{slug,current}') = lower(booking.payload->>'referralCode')))
      )
      and not exists (
        select 1 from migration.source_documents creator
        where creator.document_type = 'referral' and not creator.tombstoned
          and (creator.legacy_sanity_id = booking.payload#>>'{referral,_ref}'
            or (nullif(booking.payload->>'referralCode', '') is not null
              and lower(creator.payload#>>'{slug,current}') = lower(booking.payload->>'referralCode')))
          and (
            coalesce(creator.payload->'xocPayments', '[]'::jsonb) not in ('[]'::jsonb, 'null'::jsonb)
            or coalesce(creator.payload->'vertexPayments', '[]'::jsonb) not in ('[]'::jsonb, 'null'::jsonb)
            or coalesce(migration.try_numeric(creator.payload->>'paidTotal'), 0) <> 0
            or coalesce(migration.try_numeric(creator.payload->>'paidXoc'), 0) <> 0
            or coalesce(migration.try_numeric(creator.payload->>'paidVertex'), 0) <> 0
            or exists (
              select 1 from migration.source_documents payout
              where payout.document_type = 'creatorPayout' and not payout.tombstoned
                and (payout.payload->>'referralId' = creator.legacy_sanity_id
                  or payout.payload#>>'{creator,_ref}' = creator.legacy_sanity_id)
            )
          )
      )
    order by booking.legacy_sanity_id
  loop
    perform public.roo_apply_commerce_document_mutations(
      'commission-v2:' || md5(v_booking.legacy_sanity_id || ':' || v_booking.source_revision),
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace',
        'document', v_booking.payload || jsonb_build_object('commissionCalculationVersion', 2),
        'expected_revision', v_booking.source_revision
      )), v_generation
    );
  end loop;
end;
$$;

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
        or lower(coalesce(booking.booking_payload->>'referralCode', '')) = lower(coalesce(p_referral_code, '')))
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

commit;
