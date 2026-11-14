set lock_timeout = '5s';
set statement_timeout = '120s';

lock table commerce.bookings in access exclusive mode;

alter table commerce.bookings drop column if exists sales_attribution;

create or replace function migration.skip_unchanged_commerce_projection()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['updated_at', 'imported_at']) =
     (to_jsonb(old) - array['updated_at', 'imported_at']) then
    return null;
  end if;
  return new;
end;
$$;

notify pgrst, 'reload schema';
