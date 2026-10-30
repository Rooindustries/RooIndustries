set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_reconcile_auth_identity_links(
  p_user_id uuid,
  p_domain text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_domain text;
  v_count integer := 0;
  v_real_email text;
begin
  v_principal_id := accounts.ensure_principal_for_user(p_user_id, 'migration');
  v_domain := coalesce(
    nullif(lower(btrim(p_domain)), ''),
    accounts.principal_domain(v_principal_id)
  );
  if v_domain not in ('referral', 'tourney') then
    raise exception 'Identity link domain is invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from auth.identities identity
    join accounts.identity_links projected
      on projected.provider = identity.provider
     and projected.provider_subject = identity.provider_id
     and projected.domain = v_domain
    where identity.user_id in (
      select mapping.user_id from accounts.principal_auth_users mapping
      where mapping.principal_id = v_principal_id
    ) and projected.principal_id <> v_principal_id
  ) then
    raise exception 'Provider identity belongs to another principal'
      using errcode = '23505';
  end if;
  if exists (
    select identity.provider
    from auth.identities identity
    join accounts.principal_auth_users mapping on mapping.user_id = identity.user_id
    where mapping.principal_id = v_principal_id
      and identity.provider in ('google', 'discord', 'apple')
    group by identity.provider
    having count(distinct identity.provider_id) > 1
  ) then
    raise exception 'Principal has conflicting provider identities'
      using errcode = '23505';
  end if;

  delete from accounts.identity_links projected
  where projected.principal_id = v_principal_id
    and projected.domain = v_domain
    and projected.backend_owner = 'supabase'
    and not exists (
      select 1 from auth.identities identity
      where identity.user_id = projected.user_id
        and identity.provider = projected.provider
        and identity.provider_id = projected.provider_subject
    );

  with desired as (
    select
      identity.user_id,
      identity.provider,
      identity.provider_id as provider_subject,
      nullif(lower(btrim(coalesce(identity.email, identity.identity_data->>'email'))), '') as provider_email,
      case when identity.provider = 'email'
        then auth_user.email_confirmed_at is not null
          and lower(coalesce(identity.email, identity.identity_data->>'email', ''))
            = lower(coalesce(auth_user.email, ''))
        else lower(coalesce(identity.identity_data->>'email_verified', 'false')) = 'true'
      end as email_verified,
      coalesce(identity.created_at, now()) as linked_at,
      identity.last_sign_in_at as last_seen_at,
      coalesce(identity.identity_data, '{}'::jsonb) as metadata
    from auth.identities identity
    join auth.users auth_user on auth_user.id = identity.user_id
    join accounts.principal_auth_users mapping on mapping.user_id = identity.user_id
    where mapping.principal_id = v_principal_id
      and identity.provider in ('email', 'google', 'apple', 'discord')
  ), written as (
    insert into accounts.identity_links (
      user_id, principal_id, provider, provider_subject, provider_email,
      email_verified, linked_at, last_seen_at, metadata, backend_owner, domain
    )
    select
      desired.user_id,
      v_principal_id,
      desired.provider,
      desired.provider_subject,
      desired.provider_email,
      desired.email_verified,
      desired.linked_at,
      desired.last_seen_at,
      desired.metadata,
      'supabase',
      v_domain
    from desired
    where not exists (
      select 1 from accounts.identity_links link
      where link.domain = v_domain
        and link.provider = desired.provider
        and link.provider_subject = desired.provider_subject
        and link.user_id = desired.user_id
        and link.principal_id = v_principal_id
        and link.provider_email is not distinct from desired.provider_email
        and link.email_verified = desired.email_verified
        and link.last_seen_at is not distinct from desired.last_seen_at
        and link.metadata::text = desired.metadata::text
        and link.backend_owner = 'supabase'
    )
    on conflict (domain, provider, provider_subject) do update set
      user_id = excluded.user_id,
      principal_id = excluded.principal_id,
      provider_email = excluded.provider_email,
      email_verified = excluded.email_verified,
      last_seen_at = excluded.last_seen_at,
      metadata = excluded.metadata,
      backend_owner = 'supabase'
  )
  select count(*) into v_count from desired;

  v_real_email := accounts.real_verified_email(v_principal_id);

  update public.profiles profile set
    primary_email = case when mapping.is_primary then v_real_email end,
    updated_at = now()
  from accounts.principal_auth_users mapping
  where mapping.user_id = profile.user_id
    and mapping.principal_id = v_principal_id
    and case
      when not mapping.is_primary then profile.primary_email is not null
      else v_real_email is not null
        and profile.primary_email is distinct from v_real_email
        and not exists (
          select 1
          from public.profiles other
          where other.principal_id <> v_principal_id
            and lower(other.primary_email) = v_real_email
        )
    end;
  return jsonb_build_object(
    'user_id', p_user_id,
    'principal_id', v_principal_id,
    'domain', v_domain,
    'identity_count', v_count
  );
end;
$$;

revoke all on function public.roo_reconcile_auth_identity_links(uuid, text)
  from public, anon, authenticated;
grant execute on function public.roo_reconcile_auth_identity_links(uuid, text)
  to service_role;
