insert into licensing.products (
  sku,
  name,
  status,
  default_max_devices,
  metadata
)
values (
  'optimization-app',
  'Roo Industries Optimization App',
  'active',
  1,
  jsonb_build_object(
    'licensing_policy', 'one-active-pc-per-purchase',
    'reset_policy', 'manual-administrator-reset'
  )
)
on conflict (sku) do update
set
  name = excluded.name,
  status = excluded.status,
  default_max_devices = excluded.default_max_devices,
  metadata = licensing.products.metadata || excluded.metadata,
  updated_at = now();

create or replace function public.roo_upsert_native_creator_account(
  p_account jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_email text := lower(btrim(p_account->>'primary_email'));
  v_code text := lower(btrim(p_account->>'referral_code'));
  v_legacy_id text := nullif(p_account->>'legacy_sanity_id', '');
  v_source_hash text := nullif(lower(p_account->>'source_hash'), '');
begin
  if v_user_id is null
     or v_email is null
     or v_email = ''
     or v_code is null
     or v_code = '' then
    raise exception 'native creator account is incomplete'
      using errcode = '22023';
  end if;
  if v_source_hash is not null and v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'native creator source hash is invalid'
      using errcode = '22023';
  end if;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_revision,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_email,
    coalesce(p_account->>'display_name', v_code),
    'active',
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    primary_email = excluded.primary_email,
    display_name = excluded.display_name,
    status = 'active',
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, public.profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    source_backend = 'supabase',
    updated_at = now();

  insert into accounts.account_roles (
    user_id,
    role,
    source_backend,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    v_user_id,
    role,
    'supabase',
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase'
  from unnest(array['customer', 'creator']) role
  on conflict (user_id, role) do update
  set
    source_backend = 'supabase',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  insert into accounts.login_aliases (
    user_id,
    alias_type,
    normalized_value,
    verified,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values
    (
      v_user_id,
      'email',
      v_email,
      true,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    ),
    (
      v_user_id,
      'referral_code',
      v_code,
      true,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    )
  on conflict (alias_type, normalized_value) do update
  set
    verified = true,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now()
  where accounts.login_aliases.user_id = excluded.user_id;

  insert into accounts.credential_migrations (
    user_id,
    legacy_sanity_id,
    legacy_source,
    credential_kind,
    status,
    source_revision,
    source_hash,
    backend_owner,
    imported_at,
    upgraded_at,
    updated_at
  )
  values (
    v_user_id,
    v_legacy_id,
    'none',
    'bcrypt',
    'upgraded',
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now(),
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.credential_migrations.legacy_sanity_id),
    legacy_source = 'none',
    credential_kind = 'bcrypt',
    status = 'upgraded',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    imported_at = coalesce(accounts.credential_migrations.imported_at, now()),
    upgraded_at = coalesce(accounts.credential_migrations.upgraded_at, now()),
    failure_reason = null,
    updated_at = now();

  insert into accounts.creator_profiles (
    user_id,
    referral_code,
    paypal_email,
    contact_discord,
    active,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values (
    v_user_id,
    v_code,
    nullif(lower(btrim(p_account->>'paypal_email')), ''),
    nullif(p_account->>'contact_discord', ''),
    true,
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    referral_code = excluded.referral_code,
    paypal_email = excluded.paypal_email,
    contact_discord = excluded.contact_discord,
    active = true,
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.creator_profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now();

  insert into accounts.identity_links (
    user_id,
    provider,
    provider_subject,
    provider_email,
    email_verified,
    linked_at,
    last_seen_at,
    metadata,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  values (
    v_user_id,
    'email',
    'email:' || v_user_id::text,
    v_email,
    true,
    now(),
    now(),
    jsonb_build_object('native', true),
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase'
  )
  on conflict (provider, provider_subject) do update
  set
    provider_email = excluded.provider_email,
    email_verified = true,
    last_seen_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  return jsonb_build_object('user_id', v_user_id, 'upserted', true);
end;
$$;

create or replace function public.roo_account_by_user_id(
  p_user_id uuid
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
    'roles', coalesce(
      (
        select jsonb_agg(ar.role order by ar.role)
        from accounts.account_roles ar
        where ar.user_id = p.user_id
      ),
      '[]'::jsonb
    ),
    'referral_code', cp.referral_code,
    'tourney_username', ta.username,
    'tourney_role', ta.role,
    'tourney_active', ta.active,
    'credential_version', ta.credential_version
  )
  from public.profiles p
  left join accounts.creator_profiles cp on cp.user_id = p.user_id
  left join accounts.tourney_accounts ta on ta.user_id = p.user_id
  where p.user_id = p_user_id;
$$;

revoke all on function public.roo_upsert_native_creator_account(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_account_by_user_id(uuid)
  from public, anon, authenticated;
grant execute on function public.roo_upsert_native_creator_account(jsonb)
  to service_role;
grant execute on function public.roo_account_by_user_id(uuid)
  to service_role;
