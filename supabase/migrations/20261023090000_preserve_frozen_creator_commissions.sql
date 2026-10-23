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
  with normalized as (
    select
      regexp_replace(coalesce(booking.package_title, 'Unknown'), '\s*\(upgrade\)\s*$', '', 'i') as package_title,
      case when lower(coalesce(booking.package_title, '')) like any(array[
        '%xoc%', '%extreme overclock%', '%performance vertex max%'
      ]) then 'xoc' else 'vertex' end as package_class,
      case
        when btrim(coalesce(booking.booking_payload->>'commissionAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          then (booking.booking_payload->>'commissionAmount')::numeric
        else round(coalesce(
          case when btrim(coalesce(booking.booking_payload->>'netAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            and (booking.booking_payload->>'netAmount')::numeric <> 0
            then (booking.booking_payload->>'netAmount')::numeric end,
          case when btrim(coalesce(booking.booking_payload->>'grossAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            then (booking.booking_payload->>'grossAmount')::numeric end,
          0
        ) * coalesce(
          case when btrim(coalesce(booking.booking_payload->>'commissionPercent', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            then (booking.booking_payload->>'commissionPercent')::numeric / 100 end,
          0
        ), 2)
      end as earned
    from commerce.bookings booking
    where booking.status in ('captured', 'completed')
      and (
        booking.booking_payload#>>'{referral,_ref}' = p_referral_legacy_id
        or lower(coalesce(booking.booking_payload->>'referralCode', ''))
          = lower(coalesce(p_referral_code, ''))
      )
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
