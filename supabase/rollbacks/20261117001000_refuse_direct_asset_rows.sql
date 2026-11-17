set lock_timeout = '5s';
set statement_timeout = '120s';

drop trigger assets_require_record on cms.assets;
drop function migration.require_asset_record();

grant execute on function public.roo_upsert_asset(jsonb)
  to service_role;

notify pgrst, 'reload schema';
