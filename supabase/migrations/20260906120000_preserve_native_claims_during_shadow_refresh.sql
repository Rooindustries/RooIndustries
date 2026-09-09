set lock_timeout = '5s';
set statement_timeout = '120s';

-- The legacy projector temporarily labels projected slots as Sanity-owned;
-- roo_refresh_operational_shadow restores their canonical owners afterward.
-- Do not reinsert an identical booking claim that Supabase already owns.
-- Other bookings, slot identities, and hold conflicts must still fail closed.
do $migration$
declare
  v_definition text := pg_get_functiondef(
    'public.roo_project_operational_shadow()'::regprocedure
  );
  v_previous text := $previous$  from commerce.booking_slots slot
  where slot.status = 'active'
    and slot.backend_owner = 'sanity';$previous$;
  v_replacement text := $replacement$  from commerce.booking_slots slot
  where slot.status = 'active'
    and slot.backend_owner = 'sanity'
    and not exists (
      select 1
      from commerce.slot_claims claim
      where claim.start_time_utc = slot.start_time_utc
        and claim.claim_type = 'booking'
        and claim.booking_id = slot.booking_id
        and claim.legacy_sanity_id = slot.legacy_sanity_id
        and claim.backend_owner = 'supabase'
    );$replacement$;
begin
  if length(v_definition) - length(replace(v_definition, v_previous, ''))
      <> length(v_previous) then
    raise exception 'Expected exactly one legacy booking-claim insertion clause';
  end if;
  execute replace(v_definition, v_previous, v_replacement);
end;
$migration$;
