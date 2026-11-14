set lock_timeout = '5s';
set statement_timeout = '120s';

lock table commerce.bookings in access exclusive mode;

drop function if exists public.roo_ack_booking_paid_events(text[]);
drop function if exists public.roo_claim_booking_paid_events(integer);
drop trigger if exists commerce_bookings_record_booking_paid_event on commerce.bookings;
drop function if exists migration.record_booking_paid_event();
drop function if exists migration.booking_paid_event_fields(jsonb);
drop function if exists migration.booking_paid_event_id(text);
drop table if exists ops.booking_paid_events;

notify pgrst, 'reload schema';
