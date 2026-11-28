set lock_timeout = '5s';
set statement_timeout = '120s';

create function public.roo_migration_history()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'version', history.version,
    'name', history.name
  ) order by history.version), '[]'::jsonb)
  from supabase_migrations.schema_migrations history;
$$;

revoke all on function public.roo_migration_history()
  from public, anon, authenticated;
grant execute on function public.roo_migration_history()
  to service_role;

notify pgrst, 'reload schema';
