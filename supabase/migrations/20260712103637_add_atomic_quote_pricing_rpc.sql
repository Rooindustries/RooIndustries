create or replace function public.roo_consume_quote_rate_limit_and_get_pricing(
  p_bucket_key_hmac text,
  p_window_started_at timestamptz,
  p_reset_at timestamptz,
  p_max integer,
  p_package_titles text[],
  p_referral_id text,
  p_referral_code text,
  p_coupon_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit jsonb;
  v_package jsonb;
  v_referral jsonb;
  v_coupon jsonb;
begin
  if coalesce(array_length(p_package_titles, 1), 0) not between 1 and 12
    or exists (
      select 1 from unnest(p_package_titles) title
      where length(btrim(title)) not between 1 and 160
    )
    or length(coalesce(p_referral_id, '')) > 200
    or length(coalesce(p_referral_code, '')) > 160
    or length(coalesce(p_coupon_code, '')) > 160
  then
    raise exception 'invalid quote pricing command' using errcode = '22023';
  end if;

  v_limit := public.roo_consume_rate_limit(
    p_bucket_key_hmac,
    p_window_started_at,
    p_reset_at,
    p_max
  );
  if coalesce((v_limit->>'allowed')::boolean, false) is not true then
    return jsonb_build_object('rateLimit', v_limit);
  end if;

  select jsonb_build_object(
    '_id', source.legacy_sanity_id,
    'title', source.payload->'title',
    'price', source.payload->'price'
  ) into v_package
  from migration.source_documents source
  where source.document_type = 'package'
    and not source.tombstoned
    and source.payload->>'title' = any(p_package_titles)
  order by array_position(p_package_titles, source.payload->>'title')
  limit 1;

  if btrim(coalesce(p_referral_id, '')) <> '' then
    select jsonb_build_object(
      '_id', source.legacy_sanity_id,
      'slug', source.payload->'slug',
      'currentCommissionPercent', source.payload->'currentCommissionPercent',
      'currentDiscountPercent', source.payload->'currentDiscountPercent'
    ) into v_referral
    from migration.source_documents source
    where source.document_type = 'referral'
      and not source.tombstoned
      and source.legacy_sanity_id = btrim(p_referral_id)
      and coalesce(source.payload->>'registrationStatus', '') <> 'pending_email'
    limit 1;
  elsif btrim(coalesce(p_referral_code, '')) <> '' then
    select jsonb_build_object(
      '_id', source.legacy_sanity_id,
      'slug', source.payload->'slug',
      'currentCommissionPercent', source.payload->'currentCommissionPercent',
      'currentDiscountPercent', source.payload->'currentDiscountPercent'
    ) into v_referral
    from migration.source_documents source
    where source.document_type = 'referral'
      and not source.tombstoned
      and lower(source.payload#>>'{slug,current}') = lower(btrim(p_referral_code))
      and coalesce(source.payload->>'registrationStatus', '') <> 'pending_email'
    order by source.legacy_sanity_id
    limit 1;
  end if;

  if btrim(coalesce(p_coupon_code, '')) <> '' then
    select jsonb_build_object(
      '_id', source.legacy_sanity_id,
      'code', source.payload->'code',
      'isActive', source.payload->'isActive',
      'timesUsed', source.payload->'timesUsed',
      'maxUses', source.payload->'maxUses',
      'validFrom', source.payload->'validFrom',
      'validTo', source.payload->'validTo',
      'canCombineWithReferral', source.payload->'canCombineWithReferral',
      'discountType', source.payload->'discountType',
      'discountPercent', source.payload->'discountPercent',
      'discountAmount', source.payload->'discountAmount',
      'eligiblePackages', coalesce(source.payload->'eligiblePackages', '[]'::jsonb)
    ) into v_coupon
    from migration.source_documents source
    where source.document_type = 'coupon'
      and not source.tombstoned
      and lower(source.payload->>'code') = lower(btrim(p_coupon_code))
    order by source.legacy_sanity_id
    limit 1;
  end if;

  return jsonb_build_object(
    'rateLimit', v_limit,
    'package', v_package,
    'referral', v_referral,
    'coupon', v_coupon
  );
end;
$$;

revoke all on function public.roo_consume_quote_rate_limit_and_get_pricing(
  text, timestamptz, timestamptz, integer, text[], text, text, text
) from public, anon, authenticated;
grant execute on function public.roo_consume_quote_rate_limit_and_get_pricing(
  text, timestamptz, timestamptz, integer, text[], text, text, text
) to service_role;
