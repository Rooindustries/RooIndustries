create or replace function public.roo_list_pending_discord_role_assignments(
  p_limit integer default 25
)
returns table (user_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select assignment.user_id
  from accounts.discord_role_assignments assignment
  where assignment.status in ('pending', 'retry')
  order by assignment.updated_at asc
  limit greatest(1, least(coalesce(p_limit, 25), 100));
$$;

revoke all on function public.roo_list_pending_discord_role_assignments(integer)
  from public, anon, authenticated;
grant execute on function public.roo_list_pending_discord_role_assignments(integer)
  to service_role;
