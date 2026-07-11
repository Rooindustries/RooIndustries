create or replace function public.roo_account_shadow_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'auth_users', (select count(*) from auth.users),
    'profiles', (select count(*) from public.profiles),
    'roles', (select count(*) from accounts.account_roles),
    'login_aliases', (select count(*) from accounts.login_aliases),
    'identity_links', (select count(*) from accounts.identity_links),
    'credential_migrations', (
      select count(*) from accounts.credential_migrations
    ),
    'creator_profiles', (select count(*) from accounts.creator_profiles),
    'tourney_accounts', (select count(*) from accounts.tourney_accounts),
    'tourney_player_accounts', (
      select count(*)
      from accounts.tourney_accounts
      where role = 'tourney_player'
    ),
    'tourney_shadow_players', (select count(*) from tourney.tourney_players),
    'pending_credentials', (
      select count(*)
      from accounts.credential_migrations
      where status = 'pending'
    )
  );
$$;

revoke all on function public.roo_account_shadow_summary()
  from public, anon, authenticated;
grant execute on function public.roo_account_shadow_summary()
  to service_role;
