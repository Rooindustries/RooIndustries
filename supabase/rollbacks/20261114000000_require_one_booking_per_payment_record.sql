set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
begin
  lock table commerce.bookings in access exclusive mode;

  create index if not exists bookings_payment_record_id_idx
    on commerce.bookings (payment_record_id);

  drop index if exists commerce.bookings_payment_record_id_key;
end;
$rollback$;
