create or replace function public.roo_reconcile_shadow_sources(
  p_source_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tombstoned integer := 0;
  v_removed_cms integer := 0;
begin
  if p_source_ids is null then
    raise exception 'p_source_ids is required'
      using errcode = '22023';
  end if;

  update migration.source_documents source
  set
    tombstoned = true,
    last_seen_at = now()
  where not source.tombstoned
    and not (source.legacy_sanity_id = any(p_source_ids));
  get diagnostics v_tombstoned = row_count;

  delete from cms.documents document
  using migration.source_documents source
  where document.legacy_sanity_id = source.legacy_sanity_id
    and source.tombstoned;
  get diagnostics v_removed_cms = row_count;

  return jsonb_build_object(
    'tombstoned', v_tombstoned,
    'removed_cms_documents', v_removed_cms
  );
end;
$$;

create or replace function public.roo_prune_tombstoned_shadow_assets()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed_assets integer := 0;
begin
  delete from cms.assets asset
  using migration.source_documents source
  where asset.legacy_sanity_asset_id = source.legacy_sanity_id
    and source.tombstoned
    and not exists (
      select 1
      from cms.document_assets link
      where link.asset_id = asset.id
    );
  get diagnostics v_removed_assets = row_count;

  return jsonb_build_object('removed_asset_records', v_removed_assets);
end;
$$;

create or replace function public.roo_cleanup_operational_shadow()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expired_holds integer := 0;
  v_removed_source_holds integer := 0;
  v_released_slots integer := 0;
  v_released_slots_additional integer := 0;
  v_removed_claims integer := 0;
  v_removed_rate_buckets integer := 0;
begin
  update commerce.slot_holds hold
  set
    phase = 'expired',
    released_at = coalesce(hold.released_at, hold.expires_at, now()),
    release_reason = coalesce(hold.release_reason, 'Shadow hold expired'),
    updated_at = now()
  where hold.backend_owner = 'sanity'
    and hold.phase in ('active', 'payment')
    and hold.expires_at <= now();
  get diagnostics v_expired_holds = row_count;

  update commerce.slot_holds hold
  set
    phase = case when hold.expires_at <= now() then 'expired' else 'released' end,
    released_at = coalesce(hold.released_at, least(hold.expires_at, now())),
    release_reason = coalesce(hold.release_reason, 'Source hold removed'),
    updated_at = now()
  where hold.backend_owner = 'sanity'
    and hold.phase in ('active', 'payment')
    and not exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = hold.legacy_sanity_id
        and source.document_type = 'slotHold'
        and not source.tombstoned
    );
  get diagnostics v_removed_source_holds = row_count;

  update commerce.booking_slots slot
  set
    status = 'released',
    released_at = coalesce(slot.released_at, now()),
    release_reason = coalesce(slot.release_reason, 'Source slot lock removed'),
    updated_at = now()
  where slot.backend_owner = 'sanity'
    and slot.status = 'active'
    and slot.legacy_sanity_id not like 'bookingSlot.backfill.%'
    and not exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = slot.legacy_sanity_id
        and source.document_type = 'bookingSlot'
        and not source.tombstoned
    );
  get diagnostics v_released_slots = row_count;

  update commerce.booking_slots slot
  set
    status = 'released',
    released_at = coalesce(slot.released_at, now()),
    release_reason = coalesce(slot.release_reason, 'Booking is no longer active'),
    updated_at = now()
  from commerce.bookings booking
  where slot.backend_owner = 'sanity'
    and slot.booking_id = booking.id
    and slot.status = 'active'
    and (
      booking.status in ('cancelled', 'refunded', 'failed')
      or booking.requires_reschedule
    );
  get diagnostics v_released_slots_additional = row_count;
  v_released_slots := v_released_slots + v_released_slots_additional;

  delete from commerce.slot_claims claim
  where claim.backend_owner = 'sanity'
    and (
      claim.expires_at <= now()
      or (
        claim.hold_id is not null
        and not exists (
          select 1
          from commerce.slot_holds hold
          where hold.id = claim.hold_id
            and hold.phase in ('active', 'payment')
            and hold.expires_at > now()
        )
      )
      or (
        claim.booking_id is not null
        and not exists (
          select 1
          from commerce.booking_slots slot
          where slot.booking_id = claim.booking_id
            and slot.start_time_utc = claim.start_time_utc
            and slot.status = 'active'
        )
      )
    );
  get diagnostics v_removed_claims = row_count;

  delete from commerce.rate_limit_buckets bucket
  where bucket.backend_owner = 'sanity'
    and bucket.reset_at <= now();
  get diagnostics v_removed_rate_buckets = row_count;

  return jsonb_build_object(
    'expired_holds', v_expired_holds,
    'removed_source_holds', v_removed_source_holds,
    'released_slots', v_released_slots,
    'removed_claims', v_removed_claims,
    'removed_rate_buckets', v_removed_rate_buckets
  );
end;
$$;

revoke all on function public.roo_reconcile_shadow_sources(text[])
  from public, anon, authenticated;
revoke all on function public.roo_prune_tombstoned_shadow_assets()
  from public, anon, authenticated;

grant execute on function public.roo_reconcile_shadow_sources(text[])
  to service_role;
grant execute on function public.roo_prune_tombstoned_shadow_assets()
  to service_role;
