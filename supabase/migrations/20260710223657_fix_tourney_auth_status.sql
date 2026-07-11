create or replace function public.roo_resolve_tourney_account_alias(
  p_identifier text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.user_id,
    'primary_email', p.primary_email,
    'display_name', p.display_name,
    'status', p.status,
    'legacy_sanity_id', p.legacy_sanity_id,
    'credential_status', cm.status,
    'credential_kind', cm.credential_kind,
    'legacy_source', cm.legacy_source,
    'roles', jsonb_build_array(ta.role),
    'tourney_username', ta.username,
    'tourney_role', ta.role,
    'tourney_active', ta.active,
    'tourney_status', ta.legacy_payload->>'status',
    'credential_version', ta.credential_version
  )
  from accounts.login_aliases la
  join public.profiles p on p.user_id = la.user_id
  join accounts.tourney_accounts ta on ta.user_id = p.user_id
  left join accounts.credential_migrations cm on cm.user_id = p.user_id
  where la.alias_type in ('tourney_username', 'tourney_email', 'email')
    and la.normalized_value = lower(btrim(p_identifier))
  order by case la.alias_type
    when 'tourney_username' then 0
    when 'tourney_email' then 1
    else 2
  end
  limit 1;
$$;

revoke all on function public.roo_resolve_tourney_account_alias(text)
  from public, anon, authenticated;
grant execute on function public.roo_resolve_tourney_account_alias(text)
  to service_role;
