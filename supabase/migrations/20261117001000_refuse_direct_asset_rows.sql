set lock_timeout = '5s';
set statement_timeout = '120s';

revoke execute on function public.roo_upsert_asset(jsonb)
  from service_role;

notify pgrst, 'reload schema';
