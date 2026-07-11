-- The first version reached the hosted migration history before its fixture
-- exposed nullable imported identity timestamps. Reapply the complete function
-- so live and fresh databases share the same defensive behavior.
create or replace function public.roo_bootstrap_native_account(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, accounts, auth
as $$
declare
  v_user auth.users%rowtype;
  v_email text;
  v_display_name text;
  v_avatar_url text;
  v_conflicting_user_id uuid;
  v_identity_count integer := 0;
begin
  if p_user_id is null then
    raise exception 'Auth user id is required' using errcode = '22023';
  end if;

  select auth_user.*
  into v_user
  from auth.users auth_user
  where auth_user.id = p_user_id;

  if not found then
    raise exception 'Auth user was not found' using errcode = 'P0002';
  end if;

  v_email := nullif(lower(btrim(v_user.email)), '');
  v_display_name := coalesce(
    nullif(btrim(v_user.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(v_user.raw_user_meta_data->>'name'), ''),
    nullif(btrim(v_user.raw_user_meta_data->>'user_name'), ''),
    nullif(split_part(coalesce(v_email, ''), '@', 1), ''),
    'Roo Industries customer'
  );
  v_avatar_url := coalesce(
    nullif(btrim(v_user.raw_user_meta_data->>'avatar_url'), ''),
    nullif(btrim(v_user.raw_user_meta_data->>'picture'), '')
  );

  if v_email is not null then
    select profile.user_id
    into v_conflicting_user_id
    from public.profiles profile
    where lower(profile.primary_email) = v_email
      and profile.user_id <> p_user_id
    limit 1;

    if v_conflicting_user_id is not null then
      raise exception 'Verified email is already linked to another account'
        using errcode = '23505';
    end if;
  end if;

  if exists (
    select 1
    from auth.identities auth_identity
    join accounts.identity_links identity_link
      on identity_link.provider = auth_identity.provider
     and identity_link.provider_subject = auth_identity.provider_id
    where auth_identity.user_id = p_user_id
      and identity_link.user_id <> p_user_id
  ) then
    raise exception 'Provider identity is already linked to another account'
      using errcode = '23505';
  end if;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    avatar_url,
    status,
    source_backend
  ) values (
    p_user_id,
    v_email,
    v_display_name,
    v_avatar_url,
    'active',
    'supabase'
  )
  on conflict (user_id) do update
  set
    primary_email = coalesce(public.profiles.primary_email, excluded.primary_email),
    display_name = case
      when btrim(public.profiles.display_name) = '' then excluded.display_name
      else public.profiles.display_name
    end,
    avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
    updated_at = now();

  insert into accounts.account_roles (
    user_id,
    role,
    source_backend
  ) values (
    p_user_id,
    'customer',
    'supabase'
  )
  on conflict (user_id, role) do nothing;

  if v_email is not null then
    insert into accounts.login_aliases (
      user_id,
      alias_type,
      normalized_value,
      verified
    ) values (
      p_user_id,
      'email',
      v_email,
      v_user.email_confirmed_at is not null
    )
    on conflict (alias_type, normalized_value) do update
    set
      verified = accounts.login_aliases.verified or excluded.verified,
      updated_at = now()
    where accounts.login_aliases.user_id = excluded.user_id;
  end if;

  insert into accounts.identity_links (
    user_id,
    provider,
    provider_subject,
    provider_email,
    email_verified,
    linked_at,
    last_seen_at,
    metadata
  )
  select
    p_user_id,
    auth_identity.provider,
    auth_identity.provider_id,
    nullif(lower(btrim(coalesce(
      auth_identity.email,
      auth_identity.identity_data->>'email'
    ))), ''),
    lower(coalesce(auth_identity.identity_data->>'email_verified', 'false')) = 'true'
      or v_user.email_confirmed_at is not null,
    coalesce(auth_identity.created_at, now()),
    auth_identity.last_sign_in_at,
    coalesce(auth_identity.identity_data, '{}'::jsonb)
  from auth.identities auth_identity
  where auth_identity.user_id = p_user_id
    and auth_identity.provider in ('email', 'google', 'apple', 'discord')
  on conflict (provider, provider_subject) do update
  set
    provider_email = coalesce(
      excluded.provider_email,
      accounts.identity_links.provider_email
    ),
    email_verified = accounts.identity_links.email_verified
      or excluded.email_verified,
    last_seen_at = greatest(
      accounts.identity_links.last_seen_at,
      excluded.last_seen_at
    ),
    metadata = excluded.metadata
  where accounts.identity_links.user_id = excluded.user_id;

  get diagnostics v_identity_count = row_count;

  insert into accounts.credential_migrations (
    user_id,
    legacy_source,
    credential_kind,
    status,
    upgraded_at
  ) values (
    p_user_id,
    'none',
    'none',
    'upgraded',
    now()
  )
  on conflict (user_id) do nothing;

  return jsonb_build_object(
    'user_id', p_user_id,
    'email', v_email,
    'identity_count', v_identity_count
  );
end;
$$;

revoke all on function public.roo_bootstrap_native_account(uuid)
  from public, anon, authenticated;
grant execute on function public.roo_bootstrap_native_account(uuid)
  to service_role;

comment on function public.roo_bootstrap_native_account(uuid) is
  'Creates the private Roo Industries account projection after a verified Supabase Auth callback.';
