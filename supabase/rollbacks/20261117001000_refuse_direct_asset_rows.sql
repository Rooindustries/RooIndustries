set lock_timeout = '5s';
set statement_timeout = '120s';

grant execute on function public.roo_upsert_asset(jsonb)
  to service_role;

notify pgrst, 'reload schema';
