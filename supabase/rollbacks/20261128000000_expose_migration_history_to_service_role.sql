set lock_timeout = '5s';
set statement_timeout = '120s';

drop function public.roo_migration_history();

notify pgrst, 'reload schema';
