begin;

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

commit;
