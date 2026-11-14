set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  v_unreported integer := 0;
begin
  lock table commerce.bookings in access exclusive mode;

  if to_regclass('ops.booking_paid_events') is not null then
    lock table ops.booking_paid_events in access exclusive mode;
    select count(*) into v_unreported
    from ops.booking_paid_events
    where status in ('pending', 'claimed');
  end if;
  if v_unreported > 0 then
    raise exception 'paid booking events were never reported: %', v_unreported
      using errcode = '55000',
        hint = 'Let the reconcile cron report every ops.booking_paid_events row before rolling back.';
  end if;

  drop function if exists public.roo_ack_booking_paid_events(text[]);
  drop function if exists public.roo_claim_booking_paid_events(integer);
  drop trigger if exists commerce_bookings_record_booking_paid_event on commerce.bookings;
  drop function if exists migration.record_booking_paid_event();
  drop function if exists migration.booking_paid_event_fields(jsonb);
  drop function if exists migration.booking_paid_event_id(text);
  drop table if exists ops.booking_paid_events;

  notify pgrst, 'reload schema';
end;
$rollback$;
