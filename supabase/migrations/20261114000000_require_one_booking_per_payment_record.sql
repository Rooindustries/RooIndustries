set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  v_duplicates text;
begin
  lock table commerce.bookings in access exclusive mode;

  select string_agg(duplicate.summary, '; ' order by duplicate.summary)
  into v_duplicates
  from (
    select format(
      '%s (%s)',
      booking.payment_record_id,
      string_agg(coalesce(booking.legacy_sanity_id, booking.id::text), ', '
        order by coalesce(booking.legacy_sanity_id, booking.id::text))
    ) as summary
    from commerce.bookings booking
    where booking.payment_record_id is not null
    group by booking.payment_record_id
    having count(*) > 1
  ) duplicate;

  if v_duplicates is not null then
    raise exception 'duplicate bookings share a payment record: %', v_duplicates
      using errcode = '23505';
  end if;

  create unique index if not exists bookings_payment_record_id_key
    on commerce.bookings (payment_record_id)
    where payment_record_id is not null;

  drop index if exists commerce.bookings_payment_record_id_idx;
end;
$migration$;
