set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_booking_referral_audit(p_booking_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bookingId', source.legacy_sanity_id,
    'revision', source.source_revision,
    'projected', coalesce(
      booking.source_revision = source.source_revision
      and booking.source_hash = source.source_hash
      and booking.booking_payload = source.payload
      and booking.status = source.payload->>'status'
      and booking.backend_owner = source.backend_owner
      and booking.cutover_generation = source.cutover_generation,
      false
    )
  )
  from migration.source_documents source
  left join commerce.bookings booking on booking.legacy_sanity_id = source.legacy_sanity_id
  where source.legacy_sanity_id = p_booking_id
    and source.document_type = 'booking'
    and not source.tombstoned
    and p_booking_id ~ '^[A-Za-z0-9_.:/-]{1,80}$';
$$;

revoke all on function public.roo_booking_referral_audit(text) from public, anon, authenticated;
grant execute on function public.roo_booking_referral_audit(text) to service_role;

notify pgrst, 'reload schema';
