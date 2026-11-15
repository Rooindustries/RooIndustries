set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
begin
  lock table commerce.bookings in access exclusive mode;

  create or replace function migration.skip_unchanged_commerce_projection()
  returns trigger
  language plpgsql
  security invoker
  set search_path = ''
  as $$
  begin
    if (to_jsonb(new) - array['updated_at', 'imported_at', 'sales_attribution']) =
       (to_jsonb(old) - array['updated_at', 'imported_at', 'sales_attribution']) then
      return null;
    end if;
    return new;
  end;
  $$;

  alter table commerce.bookings
    add column if not exists sales_attribution jsonb
    generated always as (booking_payload -> 'salesAttribution') stored;

  notify pgrst, 'reload schema';
end;
$migration$;
