set lock_timeout = '5s';
set statement_timeout = '120s';

-- Deploy this migration before the application release that links Discord across
-- domains. Existing single-argument callers keep working throughout.
--
-- accounts.identity_links carried a global unique (provider, provider_subject),
-- so one Discord account could be recorded against exactly one principal
-- site-wide. Tourney Discord role assignment resolves the guild member by joining
-- accounts.identity_links on the tourney principal (see
-- src/server/tourney/discordDesiredState.js), so a Discord already linked to a
-- person's referral principal could never be linked to their tourney principal:
-- the attempt returned discord_account_not_linkable and no guild role was ever
-- assigned.
--
-- Scope the uniqueness by domain so each domain records its own link row for the
-- same provider subject. Read paths continue to resolve by principal_id, so this
-- changes only what is permitted, never what is selected.

alter table accounts.identity_links
  add column if not exists domain text not null default 'referral';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'accounts.identity_links'::regclass
      and conname = 'identity_links_domain_check'
  ) then
    alter table accounts.identity_links
      add constraint identity_links_domain_check
      check (domain in ('referral', 'tourney'));
  end if;
end;
$$;

-- A principal's domain, used to derive the link domain when a caller does not
-- state one. Principals carrying both profiles resolve to 'referral': they hold a
-- single link row, and every read path filters by principal_id, so the value only
-- affects uniqueness.
create or replace function accounts.principal_domain(p_principal_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from accounts.creator_profiles creator
      where creator.principal_id = p_principal_id
    ) then 'referral'
    when exists (
      select 1 from accounts.tourney_accounts tourney
      where tourney.principal_id = p_principal_id
    ) then 'tourney'
    else 'referral'
  end;
$$;

update accounts.identity_links link
set domain = accounts.principal_domain(link.principal_id)
where link.principal_id is not null
  and link.domain is distinct from accounts.principal_domain(link.principal_id);

alter table accounts.identity_links
  drop constraint if exists identity_links_provider_provider_subject_key;

create unique index if not exists identity_links_domain_provider_subject_key
  on accounts.identity_links (domain, provider, provider_subject);

drop index if exists accounts.identity_links_one_social_provider_per_principal;
create unique index identity_links_one_social_provider_per_principal
  on accounts.identity_links (principal_id, domain, provider)
  where provider in ('google', 'discord', 'apple');

drop index if exists accounts.identity_links_one_social_provider_per_user;
create unique index identity_links_one_social_provider_per_user
  on accounts.identity_links (user_id, domain, provider)
  where provider in ('google', 'discord', 'apple');

-- Domain-scoped reconciliation. Identical to the previous behaviour except that
-- every conflict guard, the projection delete, and the upsert conflict target are
-- confined to a single domain, and rows owned by a cross-domain linker are never
-- garbage-collected for lacking an auth.identities backing.
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

  insert into accounts.identity_links (
    user_id, principal_id, provider, provider_subject, provider_email,
    email_verified, linked_at, last_seen_at, metadata, backend_owner, domain
  )
  select
    identity.user_id,
    v_principal_id,
    identity.provider,
    identity.provider_id,
    nullif(lower(btrim(coalesce(identity.email, identity.identity_data->>'email'))), ''),
    case when identity.provider = 'email'
      then auth_user.email_confirmed_at is not null
        and lower(coalesce(identity.email, identity.identity_data->>'email', ''))
          = lower(coalesce(auth_user.email, ''))
      else lower(coalesce(identity.identity_data->>'email_verified', 'false')) = 'true'
    end,
    coalesce(identity.created_at, now()),
    identity.last_sign_in_at,
    coalesce(identity.identity_data, '{}'::jsonb),
    'supabase',
    v_domain
  from auth.identities identity
  join auth.users auth_user on auth_user.id = identity.user_id
  join accounts.principal_auth_users mapping on mapping.user_id = identity.user_id
  where mapping.principal_id = v_principal_id
    and identity.provider in ('email', 'google', 'apple', 'discord')
  on conflict (domain, provider, provider_subject) do update set
    user_id = excluded.user_id,
    principal_id = excluded.principal_id,
    provider_email = excluded.provider_email,
    email_verified = excluded.email_verified,
    last_seen_at = excluded.last_seen_at,
    metadata = excluded.metadata,
    backend_owner = 'supabase';
  get diagnostics v_count = row_count;

  v_real_email := accounts.real_verified_email(v_principal_id);

  update public.profiles profile set
    primary_email = case
      when not mapping.is_primary then null
      when v_real_email is null then profile.primary_email
      when not exists (
        select 1
        from public.profiles other
        where other.principal_id <> v_principal_id
          and lower(other.primary_email) = v_real_email
      ) then v_real_email
      else profile.primary_email
    end,
    updated_at = now()
  from accounts.principal_auth_users mapping
  where mapping.user_id = profile.user_id
    and mapping.principal_id = v_principal_id;
  return jsonb_build_object(
    'user_id', p_user_id,
    'principal_id', v_principal_id,
    'domain', v_domain,
    'identity_count', v_count
  );
end;
$$;

-- Preserved single-argument signature so existing callers keep working unchanged.
create or replace function public.roo_reconcile_auth_identity_links(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.roo_reconcile_auth_identity_links(p_user_id, null::text);
$$;

-- Record a Discord account against a tourney principal when that Discord is an
-- auth identity of a different principal (typically the same person's referral
-- account). Supabase permits one auth.identities row per (provider, provider_id),
-- so the tourney side records a projected link instead. backend_owner marks it as
-- externally owned so the reconciler above never garbage-collects it.
create or replace function public.roo_link_tourney_discord_identity(
  p_principal_id uuid,
  p_provider_subject text,
  p_provider_email text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject text := btrim(coalesce(p_provider_subject, ''));
  v_email text := nullif(lower(btrim(coalesce(p_provider_email, ''))), '');
  v_user_id uuid;
  v_linked integer := 0;
begin
  if p_principal_id is null or v_subject !~ '^[0-9]{5,30}$' then
    raise exception 'Tourney Discord link request is invalid' using errcode = '22023';
  end if;

  select tourney.user_id into v_user_id
  from accounts.tourney_accounts tourney
  where tourney.principal_id = p_principal_id;
  if v_user_id is null then
    raise exception 'Tourney account was not found' using errcode = 'P0002';
  end if;

  insert into accounts.identity_links (
    user_id, principal_id, provider, provider_subject, provider_email,
    email_verified, linked_at, last_seen_at, metadata, backend_owner, domain
  )
  values (
    v_user_id, p_principal_id, 'discord', v_subject, v_email,
    false, now(), now(), coalesce(p_metadata, '{}'::jsonb), 'tourney_link', 'tourney'
  )
  on conflict (domain, provider, provider_subject) do update set
    user_id = excluded.user_id,
    provider_email = coalesce(excluded.provider_email, accounts.identity_links.provider_email),
    last_seen_at = now(),
    metadata = excluded.metadata,
    backend_owner = 'tourney_link'
  where accounts.identity_links.principal_id = excluded.principal_id;
  get diagnostics v_linked = row_count;

  if v_linked = 0 then
    raise exception 'Discord identity belongs to another tourney account'
      using errcode = '23505';
  end if;

  return jsonb_build_object(
    'principal_id', p_principal_id,
    'user_id', v_user_id,
    'provider_subject', v_subject,
    'domain', 'tourney'
  );
end;
$$;

revoke all on function accounts.principal_domain(uuid)
  from public, anon, authenticated;
revoke all on function public.roo_reconcile_auth_identity_links(uuid, text)
  from public, anon, authenticated;
revoke all on function public.roo_reconcile_auth_identity_links(uuid)
  from public, anon, authenticated;
revoke all on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function accounts.principal_domain(uuid)
  to service_role;
grant execute on function public.roo_reconcile_auth_identity_links(uuid, text)
  to service_role;
grant execute on function public.roo_reconcile_auth_identity_links(uuid)
  to service_role;
grant execute on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  to service_role;
