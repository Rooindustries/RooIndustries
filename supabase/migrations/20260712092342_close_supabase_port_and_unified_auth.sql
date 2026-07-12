-- Roo Industries Supabase port closure. All browser roles remain denied; the
-- application reaches these private records through service-role-only RPCs.

create table accounts.principals (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active'
    check (status in ('active', 'disabled', 'deleted')),
  session_version bigint not null default 1 check (session_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts.principal_auth_users (
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_primary boolean not null default false,
  linked_at timestamptz not null default now(),
  verified_at timestamptz,
  source text not null default 'migration'
    check (source in ('migration', 'signup', 'link', 'merge')),
  primary key (principal_id, user_id),
  unique (user_id)
);

create unique index principal_auth_users_one_primary_idx
  on accounts.principal_auth_users (principal_id)
  where is_primary;

alter table accounts.principals enable row level security;
alter table accounts.principal_auth_users enable row level security;
revoke all on table accounts.principals from public, anon, authenticated;
revoke all on table accounts.principal_auth_users from public, anon, authenticated;
grant all on table accounts.principals to service_role;
grant all on table accounts.principal_auth_users to service_role;

insert into accounts.principals (id, status, created_at, updated_at)
select
  profile.user_id,
  case when profile.status = 'deleted' then 'deleted' else 'active' end,
  profile.created_at,
  profile.updated_at
from public.profiles profile
on conflict (id) do nothing;

insert into accounts.principal_auth_users (
  principal_id, user_id, is_primary, verified_at, source
)
select
  profile.user_id,
  profile.user_id,
  true,
  case when auth_user.email_confirmed_at is not null then now() else null end,
  'migration'
from public.profiles profile
join auth.users auth_user on auth_user.id = profile.user_id
on conflict (user_id) do nothing;

alter table public.profiles add column principal_id uuid;
alter table accounts.account_roles add column principal_id uuid;
alter table accounts.login_aliases add column principal_id uuid;
alter table accounts.identity_links add column principal_id uuid;
alter table accounts.credential_migrations add column principal_id uuid;
alter table accounts.creator_profiles add column principal_id uuid;
alter table accounts.tourney_accounts add column principal_id uuid;
alter table accounts.discord_role_assignments add column principal_id uuid;
alter table licensing.entitlements add column principal_id uuid;
alter table accounts.oauth_intents add column principal_id uuid;

update public.profiles set principal_id = user_id where principal_id is null;
update accounts.account_roles set principal_id = user_id where principal_id is null;
update accounts.login_aliases set principal_id = user_id where principal_id is null;
update accounts.identity_links set principal_id = user_id where principal_id is null;
update accounts.credential_migrations set principal_id = user_id where principal_id is null;
update accounts.creator_profiles set principal_id = user_id where principal_id is null;
update accounts.tourney_accounts set principal_id = user_id where principal_id is null;
update accounts.discord_role_assignments set principal_id = user_id where principal_id is null;
update licensing.entitlements set principal_id = user_id
  where user_id is not null and principal_id is null;
update accounts.oauth_intents intent
set principal_id = mapping.principal_id
from accounts.principal_auth_users mapping
where mapping.user_id = intent.target_user_id and intent.principal_id is null;

alter table public.profiles
  alter column principal_id set not null,
  add constraint profiles_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.account_roles
  alter column principal_id set not null,
  add constraint account_roles_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.login_aliases
  alter column principal_id set not null,
  add constraint login_aliases_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.identity_links
  alter column principal_id set not null,
  add constraint identity_links_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.credential_migrations
  alter column principal_id set not null,
  add constraint credential_migrations_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.creator_profiles
  alter column principal_id set not null,
  add constraint creator_profiles_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.tourney_accounts
  alter column principal_id set not null,
  add constraint tourney_accounts_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table accounts.discord_role_assignments
  alter column principal_id set not null,
  add constraint discord_role_assignments_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;
alter table licensing.entitlements
  add constraint entitlements_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete set null;
alter table accounts.oauth_intents
  add constraint oauth_intents_principal_id_fkey
    foreign key (principal_id) references accounts.principals(id) on delete cascade;

create unique index account_roles_principal_role_key
  on accounts.account_roles (principal_id, role);
create unique index creator_profiles_principal_key
  on accounts.creator_profiles (principal_id);
create unique index tourney_accounts_principal_key
  on accounts.tourney_accounts (principal_id);
create unique index identity_links_one_social_provider_per_principal
  on accounts.identity_links (principal_id, provider)
  where provider in ('google', 'discord', 'apple');
create unique index discord_role_assignments_principal_key
  on accounts.discord_role_assignments (principal_id);
create index profiles_principal_id_idx on public.profiles (principal_id);
create index login_aliases_principal_id_idx on accounts.login_aliases (principal_id);
create index credential_migrations_principal_id_idx
  on accounts.credential_migrations (principal_id);
create index entitlements_principal_id_idx on licensing.entitlements (principal_id);
create index oauth_intents_principal_id_idx on accounts.oauth_intents (principal_id);

create or replace function accounts.ensure_principal_for_user(
  p_user_id uuid,
  p_source text default 'migration'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users auth_user where auth_user.id = p_user_id
  ) then
    raise exception 'Auth user was not found' using errcode = 'P0002';
  end if;
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;
  if v_principal_id is not null then return v_principal_id; end if;

  insert into accounts.principals (id) values (p_user_id)
  on conflict (id) do nothing;
  insert into accounts.principal_auth_users (
    principal_id, user_id, is_primary, source
  ) values (
    p_user_id, p_user_id, true,
    case when p_source in ('migration', 'signup', 'link', 'merge')
      then p_source else 'migration' end
  ) on conflict (user_id) do nothing;
  return (
    select mapping.principal_id
    from accounts.principal_auth_users mapping
    where mapping.user_id = p_user_id
  );
end;
$$;

create or replace function accounts.assign_principal_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is null then
    new.principal_id := null;
    return new;
  end if;
  new.principal_id := accounts.ensure_principal_for_user(new.user_id, 'migration');
  return new;
end;
$$;

create trigger profiles_assign_principal
  before insert or update of user_id on public.profiles
  for each row execute function accounts.assign_principal_id();
create trigger account_roles_assign_principal
  before insert or update of user_id on accounts.account_roles
  for each row execute function accounts.assign_principal_id();
create trigger login_aliases_assign_principal
  before insert or update of user_id on accounts.login_aliases
  for each row execute function accounts.assign_principal_id();
create trigger identity_links_assign_principal
  before insert or update of user_id on accounts.identity_links
  for each row execute function accounts.assign_principal_id();
create trigger credential_migrations_assign_principal
  before insert or update of user_id on accounts.credential_migrations
  for each row execute function accounts.assign_principal_id();
create trigger creator_profiles_assign_principal
  before insert or update of user_id on accounts.creator_profiles
  for each row execute function accounts.assign_principal_id();
create trigger tourney_accounts_assign_principal
  before insert or update of user_id on accounts.tourney_accounts
  for each row execute function accounts.assign_principal_id();
create trigger discord_role_assignments_assign_principal
  before insert or update of user_id on accounts.discord_role_assignments
  for each row execute function accounts.assign_principal_id();
create trigger entitlements_assign_principal
  before insert or update of user_id on licensing.entitlements
  for each row execute function accounts.assign_principal_id();

revoke all on function accounts.ensure_principal_for_user(uuid, text)
  from public, anon, authenticated;
revoke all on function accounts.assign_principal_id()
  from public, anon, authenticated;
grant execute on function accounts.ensure_principal_for_user(uuid, text)
  to service_role;

create table accounts.reauth_grants (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  purpose text not null check (purpose in (
    'link_identity', 'unlink_identity', 'merge_account', 'change_password'
  )),
  provider text check (provider is null or provider in ('google', 'discord')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
create index reauth_grants_active_idx
  on accounts.reauth_grants (user_id, purpose, expires_at)
  where used_at is null;
alter table accounts.reauth_grants enable row level security;
revoke all on table accounts.reauth_grants from public, anon, authenticated;
grant all on table accounts.reauth_grants to service_role;

create table accounts.credential_operations (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  principal_id uuid not null references accounts.principals(id) on delete cascade,
  password_hash text not null check (password_hash ~ '^\$2[aby]\$[0-9]{2}\$'),
  status text not null default 'prepared'
    check (status in ('prepared', 'auth_applied', 'mirrored', 'failed')),
  source_revision text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  auth_applied_at timestamptz,
  mirrored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index credential_operations_pending_idx
  on accounts.credential_operations (status, updated_at)
  where status in ('prepared', 'auth_applied');
alter table accounts.credential_operations enable row level security;
revoke all on table accounts.credential_operations from public, anon, authenticated;
grant all on table accounts.credential_operations to service_role;

create table accounts.principal_merge_audit (
  id uuid primary key default gen_random_uuid(),
  primary_principal_id uuid not null,
  secondary_principal_id uuid not null,
  initiated_by_user_id uuid not null references auth.users(id) on delete restrict,
  result text not null check (result in ('merged', 'idempotent')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table accounts.principal_merge_audit enable row level security;
revoke all on table accounts.principal_merge_audit from public, anon, authenticated;
grant all on table accounts.principal_merge_audit to service_role;

alter table accounts.oauth_intents
  add column reauth_grant_id uuid references accounts.reauth_grants(id) on delete set null;
alter table accounts.oauth_intents drop constraint oauth_intents_action_check;
alter table accounts.oauth_intents add constraint oauth_intents_action_check
  check (action in ('signin', 'signup', 'link', 'reauth', 'merge'));
alter table accounts.oauth_intents drop constraint oauth_intents_check;
alter table accounts.oauth_intents add constraint oauth_intents_target_action_check
  check ((action in ('link', 'reauth', 'merge')) = (target_user_id is not null));

drop index if exists accounts.oauth_intents_one_active_link_idx;
create unique index oauth_intents_one_active_sensitive_action_idx
  on accounts.oauth_intents (target_user_id, provider, action)
  where action in ('link', 'reauth', 'merge') and status = 'pending';

create or replace function accounts.real_verified_email(p_principal_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with verified_email as (
    select
      identity_link.provider_email as email,
      case identity_link.provider
        when 'email' then 0 when 'google' then 1
        when 'discord' then 2 else 3
      end as priority,
      identity_link.linked_at as verified_at
    from accounts.identity_links identity_link
    where identity_link.principal_id = p_principal_id
      and identity_link.email_verified
      and identity_link.provider_email is not null
    union all
    select
      alias.normalized_value,
      4,
      alias.updated_at
    from accounts.login_aliases alias
    where alias.principal_id = p_principal_id
      and alias.alias_type in ('email', 'tourney_email')
      and alias.verified
  )
  select verified_email.email
  from verified_email
  where verified_email.email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    and verified_email.email !~* '@auth[.]rooindustries[.]invalid$'
  order by verified_email.priority, verified_email.verified_at
  limit 1;
$$;

create or replace function accounts.principal_account_json(
  p_principal_id uuid,
  p_login_user_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with selected_profile as (
    select profile.*
    from public.profiles profile
    join accounts.principal_auth_users mapping
      on mapping.user_id = profile.user_id
    where mapping.principal_id = p_principal_id
    order by
      case when profile.user_id = p_login_user_id then 0 else 1 end,
      case when mapping.is_primary then 0 else 1 end,
      profile.created_at
    limit 1
  ), selected_user as (
    select mapping.user_id
    from accounts.principal_auth_users mapping
    where mapping.principal_id = p_principal_id
    order by
      case when mapping.user_id = p_login_user_id then 0 else 1 end,
      case when mapping.is_primary then 0 else 1 end,
      mapping.linked_at
    limit 1
  )
  select jsonb_build_object(
    'principal_id', principal.id,
    'user_id', selected_user.user_id,
    'primary_email', lower(auth_user.email),
    'verified_real_email', accounts.real_verified_email(principal.id),
    'display_name', coalesce(profile.display_name, ''),
    'avatar_url', profile.avatar_url,
    'status', principal.status,
    'session_version', principal.session_version,
    'roles', coalesce((
      select jsonb_agg(role.role order by role.role)
      from accounts.account_roles role
      where role.principal_id = principal.id
    ), '[]'::jsonb),
    'connected_providers', coalesce((
      select jsonb_agg(distinct identity_link.provider order by identity_link.provider)
      from accounts.identity_links identity_link
      where identity_link.principal_id = principal.id
    ), '[]'::jsonb),
    'creator_legacy_sanity_id', creator.legacy_sanity_id,
    'legacy_sanity_id', coalesce(creator.legacy_sanity_id, tourney.legacy_sanity_id),
    'referral_code', creator.referral_code,
    'creator_active', creator.active,
    'tourney_legacy_player_id', tourney.legacy_sanity_id,
    'tourney_username', tourney.username,
    'tourney_role', tourney.role,
    'tourney_active', tourney.active,
    'tourney_status', tourney.lifecycle_status,
    'credential_version', tourney.credential_version,
    'credential_status', credential.status,
    'credential_kind', credential.credential_kind,
    'legacy_source', credential.legacy_source
  )
  from accounts.principals principal
  cross join selected_user
  join auth.users auth_user on auth_user.id = selected_user.user_id
  left join selected_profile profile on true
  left join accounts.creator_profiles creator
    on creator.principal_id = principal.id
  left join accounts.tourney_accounts tourney
    on tourney.principal_id = principal.id
  left join accounts.credential_migrations credential
    on credential.user_id = selected_user.user_id
  where principal.id = p_principal_id;
$$;

create or replace function public.roo_account_by_user_id(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select accounts.principal_account_json(mapping.principal_id, p_user_id)
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;
$$;

create or replace function public.roo_resolve_account_alias(p_identifier text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select accounts.principal_account_json(alias.principal_id, alias.user_id)
    || jsonb_build_object('legacy_sanity_id', creator.legacy_sanity_id)
  from accounts.login_aliases alias
  join accounts.creator_profiles creator
    on creator.principal_id = alias.principal_id
  where alias.normalized_value = lower(btrim(p_identifier))
    and alias.alias_type in ('email', 'referral_code')
  order by case alias.alias_type when 'email' then 0 else 1 end
  limit 1;
$$;

create or replace function public.roo_resolve_tourney_account_alias(p_identifier text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select accounts.principal_account_json(alias.principal_id, alias.user_id)
    || jsonb_build_object('legacy_sanity_id', tourney.legacy_sanity_id)
  from accounts.login_aliases alias
  join accounts.tourney_accounts tourney
    on tourney.principal_id = alias.principal_id
  where alias.normalized_value = lower(btrim(p_identifier))
    and alias.alias_type in ('tourney_username', 'tourney_email', 'email')
  order by case alias.alias_type
    when 'tourney_username' then 0 when 'tourney_email' then 1 else 2
  end
  limit 1;
$$;

create or replace function public.roo_reconcile_auth_identity_links(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_count integer := 0;
  v_real_email text;
begin
  v_principal_id := accounts.ensure_principal_for_user(p_user_id, 'migration');
  if exists (
    select 1
    from auth.identities identity
    join accounts.identity_links projected
      on projected.provider = identity.provider
     and projected.provider_subject = identity.provider_id
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
    and not exists (
      select 1 from auth.identities identity
      where identity.user_id = projected.user_id
        and identity.provider = projected.provider
        and identity.provider_id = projected.provider_subject
    );

  insert into accounts.identity_links (
    user_id, principal_id, provider, provider_subject, provider_email,
    email_verified, linked_at, last_seen_at, metadata, backend_owner
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
    'supabase'
  from auth.identities identity
  join auth.users auth_user on auth_user.id = identity.user_id
  join accounts.principal_auth_users mapping on mapping.user_id = identity.user_id
  where mapping.principal_id = v_principal_id
    and identity.provider in ('email', 'google', 'apple', 'discord')
  on conflict (provider, provider_subject) do update set
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
    'identity_count', v_count
  );
end;
$$;

create or replace function public.roo_bootstrap_native_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_principal_id uuid;
  v_email text;
  v_is_primary boolean;
  v_display_name text;
  v_avatar_url text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found then raise exception 'Auth user was not found' using errcode = 'P0002'; end if;
  v_principal_id := accounts.ensure_principal_for_user(p_user_id, 'signup');
  select mapping.is_primary into v_is_primary
  from accounts.principal_auth_users mapping where mapping.user_id = p_user_id;
  perform public.roo_reconcile_auth_identity_links(p_user_id);
  v_email := accounts.real_verified_email(v_principal_id);
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
  insert into public.profiles (
    user_id, principal_id, primary_email, display_name, avatar_url, status, source_backend
  ) values (
    p_user_id, v_principal_id, case when v_is_primary then v_email else null end,
    v_display_name, v_avatar_url, 'active', 'supabase'
  ) on conflict (user_id) do update set
    principal_id = excluded.principal_id,
    primary_email = excluded.primary_email,
    display_name = case when btrim(public.profiles.display_name) = ''
      then excluded.display_name else public.profiles.display_name end,
    avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
    updated_at = now();
  insert into accounts.account_roles (user_id, principal_id, role, source_backend)
  values (p_user_id, v_principal_id, 'customer', 'supabase')
  on conflict (user_id, role) do update set principal_id = excluded.principal_id;
  return accounts.principal_account_json(v_principal_id, p_user_id);
end;
$$;

create or replace function public.roo_read_oauth_intent(
  p_intent_id uuid,
  p_token_hash text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', intent.id,
    'action', intent.action,
    'domain_subject', intent.domain_subject,
    'expires_at', intent.expires_at,
    'flow', intent.flow,
    'provider', intent.provider,
    'return_path', intent.return_path,
    'status', intent.status,
    'target_user_id', intent.target_user_id,
    'principal_id', intent.principal_id
  )
  from accounts.oauth_intents intent
  where intent.id = p_intent_id
    and intent.token_hash = lower(btrim(p_token_hash));
$$;

alter table accounts.oauth_intents add column reauth_purpose text;
alter table accounts.oauth_intents add constraint oauth_intents_reauth_purpose_check
  check (
    (action = 'reauth') = (reauth_purpose is not null)
    and (
      reauth_purpose is null or reauth_purpose in (
        'link_identity', 'unlink_identity', 'merge_account', 'change_password'
      )
    )
  );

create or replace function public.roo_create_reauth_grant(
  p_user_id uuid,
  p_token_hash text,
  p_purpose text,
  p_provider text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_grant accounts.reauth_grants%rowtype;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$'
     or p_purpose not in ('link_identity', 'unlink_identity', 'merge_account', 'change_password')
     or (p_provider is not null and p_provider not in ('google', 'discord')) then
    raise exception 'Reauthentication grant is invalid' using errcode = '22023';
  end if;
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;
  if v_principal_id is null then
    raise exception 'Account principal was not found' using errcode = 'P0002';
  end if;
  insert into accounts.reauth_grants (
    token_hash, user_id, principal_id, purpose, provider, expires_at
  ) values (
    lower(p_token_hash), p_user_id, v_principal_id, p_purpose, p_provider,
    now() + interval '10 minutes'
  ) returning * into v_grant;
  return jsonb_build_object(
    'id', v_grant.id,
    'principal_id', v_principal_id,
    'purpose', v_grant.purpose,
    'provider', v_grant.provider,
    'expires_at', v_grant.expires_at
  );
end;
$$;

create or replace function public.roo_consume_reauth_grant(
  p_token_hash text,
  p_user_id uuid,
  p_purpose text,
  p_provider text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_grant accounts.reauth_grants%rowtype;
begin
  update accounts.reauth_grants grant_row set used_at = now()
  where grant_row.token_hash = lower(btrim(p_token_hash))
    and grant_row.user_id = p_user_id
    and grant_row.purpose = p_purpose
    and grant_row.provider is not distinct from p_provider
    and grant_row.used_at is null and grant_row.expires_at > now()
  returning * into v_grant;
  if not found then raise exception 'Recent authentication is required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'id', v_grant.id, 'principal_id', v_grant.principal_id,
    'purpose', v_grant.purpose, 'provider', v_grant.provider
  );
end;
$$;

create or replace function public.roo_create_oauth_intent(p_intent jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flow text := lower(btrim(p_intent->>'flow'));
  v_action text := lower(btrim(p_intent->>'action'));
  v_provider text := lower(btrim(p_intent->>'provider'));
  v_token_hash text := lower(btrim(p_intent->>'token_hash'));
  v_target_user_id uuid := nullif(p_intent->>'target_user_id', '')::uuid;
  v_domain_subject text := nullif(btrim(p_intent->>'domain_subject'), '');
  v_return_path text := p_intent->>'return_path';
  v_expires_at timestamptz := (p_intent->>'expires_at')::timestamptz;
  v_reauth_hash text := lower(btrim(coalesce(p_intent->>'reauth_token_hash', '')));
  v_reauth_purpose text := nullif(lower(btrim(p_intent->>'reauth_purpose')), '');
  v_principal_id uuid;
  v_reauth_grant_id uuid;
  v_id uuid;
begin
  if v_flow not in ('referral', 'tourney')
     or v_action not in ('signin', 'signup', 'link', 'reauth', 'merge')
     or v_provider not in ('google', 'discord')
     or v_token_hash !~ '^[0-9a-f]{64}$'
     or v_return_path is null
     or left(v_return_path, 1) <> '/'
     or left(v_return_path, 2) = '//'
     or v_return_path ~ '[[:cntrl:]\\]'
     or char_length(v_return_path) > 500
     or v_expires_at <= now()
     or v_expires_at > now() + interval '15 minutes 10 seconds'
     or ((v_action in ('link', 'reauth', 'merge')) <> (v_target_user_id is not null))
     or ((v_action = 'reauth') <> (v_reauth_purpose is not null)) then
    raise exception 'OAuth intent is invalid' using errcode = '22023';
  end if;
  if v_reauth_purpose is not null and v_reauth_purpose not in (
    'link_identity', 'unlink_identity', 'merge_account', 'change_password'
  ) then
    raise exception 'OAuth reauthentication purpose is invalid' using errcode = '22023';
  end if;

  if v_target_user_id is not null then
    select mapping.principal_id into v_principal_id
    from accounts.principal_auth_users mapping
    where mapping.user_id = v_target_user_id;
    if v_principal_id is null then
      raise exception 'OAuth target principal was not found' using errcode = 'P0002';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_principal_id::text || ':' || v_provider || ':' || v_action, 0)
    );
  end if;

  if v_action = 'link' and v_reauth_hash <> '' then
    select grant_row.id into v_reauth_grant_id
    from accounts.reauth_grants grant_row
    where grant_row.token_hash = v_reauth_hash
      and grant_row.user_id = v_target_user_id
      and grant_row.principal_id = v_principal_id
      and grant_row.purpose = 'link_identity'
      and (grant_row.provider is null or grant_row.provider = v_provider)
      and grant_row.used_at is null
      and grant_row.expires_at > now()
    for update;
    if v_reauth_grant_id is null then
      raise exception 'Recent authentication is required' using errcode = '42501';
    end if;
  end if;

  if v_target_user_id is not null then
    update accounts.oauth_intents
    set status = 'replaced', failure_code = 'replaced', updated_at = now()
    where target_user_id = v_target_user_id
      and provider = v_provider
      and action = v_action
      and status = 'pending';
  end if;
  insert into accounts.oauth_intents (
    token_hash, flow, action, provider, target_user_id, principal_id,
    domain_subject, return_path, expires_at, reauth_grant_id, reauth_purpose
  ) values (
    v_token_hash, v_flow, v_action, v_provider, v_target_user_id, v_principal_id,
    v_domain_subject, v_return_path, v_expires_at, v_reauth_grant_id, v_reauth_purpose
  ) returning id into v_id;
  return jsonb_build_object('id', v_id, 'expires_at', v_expires_at);
end;
$$;

drop function if exists public.roo_finalize_oauth_intent(text, uuid, text, text);
create or replace function public.roo_finalize_oauth_intent(
  p_token_hash text,
  p_user_id uuid,
  p_provider text,
  p_guild_id text default null,
  p_reauth_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent accounts.oauth_intents%rowtype;
  v_provider text := lower(btrim(p_provider));
  v_provider_subject text;
  v_principal_id uuid;
  v_grant jsonb;
  v_discord jsonb := jsonb_build_object('queued', false, 'reason', 'not_required');
begin
  select * into v_intent from accounts.oauth_intents intent
  where intent.token_hash = lower(btrim(p_token_hash)) for update;
  if not found then raise exception 'OAuth intent was not found' using errcode = 'P0002'; end if;
  if v_intent.provider <> v_provider then raise exception 'OAuth provider changed' using errcode = '22023'; end if;
  if v_intent.status = 'completed' then
    if v_intent.claimed_user_id <> p_user_id then
      raise exception 'OAuth intent belongs to another user' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'flow', v_intent.flow, 'action', v_intent.action,
      'provider', v_intent.provider, 'user_id', p_user_id,
      'principal_id', v_intent.principal_id, 'return_path', v_intent.return_path,
      'completed', true, 'idempotent', true
    );
  end if;
  if v_intent.status <> 'pending' or v_intent.expires_at <= now() then
    update accounts.oauth_intents set
      status = case when status = 'pending' then 'expired' else status end,
      updated_at = now()
    where id = v_intent.id;
    raise exception 'OAuth intent is no longer active' using errcode = '22023';
  end if;
  if v_intent.target_user_id is not null
     and v_intent.target_user_id <> p_user_id
     and v_intent.action <> 'reauth' then
    raise exception 'OAuth target user changed' using errcode = '42501';
  end if;

  select identity.provider_id into v_provider_subject
  from auth.identities identity
  where identity.user_id = p_user_id and identity.provider = v_provider
  order by identity.last_sign_in_at desc nulls last, identity.created_at desc
  limit 1;
  if v_provider_subject is null then
    raise exception 'OAuth identity was not linked' using errcode = 'P0002';
  end if;
  if (select count(*) from auth.identities identity
      where identity.user_id = p_user_id and identity.provider = v_provider) <> 1 then
    raise exception 'OAuth identity is ambiguous' using errcode = '23505';
  end if;

  v_principal_id := accounts.ensure_principal_for_user(
    p_user_id,
    case when v_intent.action = 'signup' then 'signup' else 'link' end
  );
  if v_intent.principal_id is not null and v_intent.principal_id <> v_principal_id then
    raise exception 'OAuth principal changed' using errcode = '42501';
  end if;
  perform public.roo_reconcile_auth_identity_links(p_user_id);

  if v_intent.action = 'link' and v_intent.reauth_grant_id is not null then
    update accounts.reauth_grants set used_at = now()
    where id = v_intent.reauth_grant_id
      and user_id = p_user_id and principal_id = v_principal_id
      and purpose = 'link_identity' and (provider is null or provider = v_provider)
      and used_at is null and expires_at > now();
    if not found then raise exception 'Recent authentication expired' using errcode = '42501'; end if;
  elsif v_intent.action = 'reauth' then
    if lower(btrim(coalesce(p_reauth_token_hash, ''))) !~ '^[0-9a-f]{64}$' then
      raise exception 'Reauthentication token is invalid' using errcode = '22023';
    end if;
    v_grant := public.roo_create_reauth_grant(
      p_user_id,
      lower(btrim(p_reauth_token_hash)),
      v_intent.reauth_purpose,
      case when v_intent.reauth_purpose = 'unlink_identity'
        then v_provider else null end
    );
  end if;

  update accounts.oauth_intents set
    claimed_user_id = p_user_id,
    principal_id = v_principal_id,
    provider_subject = v_provider_subject,
    status = 'completed', completed_at = now(), updated_at = now()
  where id = v_intent.id;
  if v_provider = 'discord' and p_guild_id ~ '^[0-9]{5,30}$' then
    v_discord := public.roo_refresh_discord_role_assignment(p_user_id, p_guild_id);
  end if;
  return jsonb_build_object(
    'flow', v_intent.flow, 'action', v_intent.action,
    'provider', v_provider, 'user_id', p_user_id,
    'principal_id', v_principal_id, 'provider_subject', v_provider_subject,
    'return_path', v_intent.return_path, 'completed', true,
    'reauth_grant', v_grant, 'discord_role', v_discord
  );
end;
$$;

create or replace function public.roo_merge_account_principals(
  p_primary_grant_hash text,
  p_secondary_grant_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_primary accounts.reauth_grants%rowtype;
  v_secondary accounts.reauth_grants%rowtype;
begin
  select * into v_primary from accounts.reauth_grants grant_row
  where grant_row.token_hash = lower(btrim(p_primary_grant_hash))
    and grant_row.purpose = 'merge_account'
    and grant_row.used_at is null and grant_row.expires_at > now()
  for update;
  select * into v_secondary from accounts.reauth_grants grant_row
  where grant_row.token_hash = lower(btrim(p_secondary_grant_hash))
    and grant_row.purpose = 'merge_account'
    and grant_row.used_at is null and grant_row.expires_at > now()
  for update;
  if v_primary.id is null or v_secondary.id is null
     or v_primary.principal_id = v_secondary.principal_id then
    raise exception 'Two recent account authentications are required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(least(v_primary.principal_id, v_secondary.principal_id)::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(greatest(v_primary.principal_id, v_secondary.principal_id)::text, 0)
  );
  if exists (
    select 1 from accounts.creator_profiles left_creator
    join accounts.creator_profiles right_creator on true
    where left_creator.principal_id = v_primary.principal_id
      and right_creator.principal_id = v_secondary.principal_id
      and left_creator.legacy_sanity_id is distinct from right_creator.legacy_sanity_id
  ) or exists (
    select 1 from accounts.tourney_accounts left_tourney
    join accounts.tourney_accounts right_tourney on true
    where left_tourney.principal_id = v_primary.principal_id
      and right_tourney.principal_id = v_secondary.principal_id
      and left_tourney.legacy_sanity_id is distinct from right_tourney.legacy_sanity_id
  ) or exists (
    select 1 from accounts.identity_links left_identity
    join accounts.identity_links right_identity
      on right_identity.provider = left_identity.provider
    where left_identity.principal_id = v_primary.principal_id
      and right_identity.principal_id = v_secondary.principal_id
      and left_identity.provider in ('google', 'discord', 'apple')
      and left_identity.provider_subject <> right_identity.provider_subject
  ) then
    raise exception 'Account domains or providers conflict' using errcode = '23505';
  end if;

  delete from accounts.account_roles secondary_role
  where secondary_role.principal_id = v_secondary.principal_id
    and exists (
      select 1 from accounts.account_roles primary_role
      where primary_role.principal_id = v_primary.principal_id
        and primary_role.role = secondary_role.role
    );
  update accounts.account_roles set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update public.profiles set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.login_aliases set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.identity_links set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.credential_migrations set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.creator_profiles set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.tourney_accounts set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.discord_role_assignments set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update licensing.entitlements set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.oauth_intents set principal_id = v_primary.principal_id
    where principal_id = v_secondary.principal_id;
  update accounts.principal_auth_users set
    principal_id = v_primary.principal_id, is_primary = false, source = 'merge'
  where principal_id = v_secondary.principal_id;
  update accounts.principals set status = 'deleted', updated_at = now()
    where id = v_secondary.principal_id;
  update accounts.reauth_grants set used_at = now()
    where id in (v_primary.id, v_secondary.id);
  insert into accounts.principal_merge_audit (
    primary_principal_id, secondary_principal_id, initiated_by_user_id, result, details
  ) values (
    v_primary.principal_id, v_secondary.principal_id, v_primary.user_id, 'merged',
    jsonb_build_object('secondary_user_id', v_secondary.user_id)
  );
  perform public.roo_reconcile_auth_identity_links(v_primary.user_id);
  return accounts.principal_account_json(v_primary.principal_id, v_primary.user_id);
end;
$$;

create or replace function public.roo_rotate_principal_sessions(p_principal_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare v_version bigint;
begin
  update accounts.principals set session_version = session_version + 1, updated_at = now()
  where id = p_principal_id and status = 'active'
  returning session_version into v_version;
  if v_version is null then raise exception 'Active principal was not found' using errcode = 'P0002'; end if;
  delete from auth.sessions session
  where session.user_id in (
    select mapping.user_id from accounts.principal_auth_users mapping
    where mapping.principal_id = p_principal_id
  );
  return v_version;
end;
$$;

create or replace function public.roo_validate_referral_session(
  p_creator_legacy_id text,
  p_session_version bigint default 1
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select accounts.principal_account_json(creator.principal_id, creator.user_id)
  from accounts.creator_profiles creator
  join accounts.principals principal on principal.id = creator.principal_id
  where creator.legacy_sanity_id = p_creator_legacy_id
    and creator.active
    and principal.status = 'active'
    and principal.session_version = coalesce(p_session_version, 1);
$$;

create or replace function public.roo_prepare_credential_operation(
  p_operation_key text,
  p_user_id uuid,
  p_password_hash text,
  p_source_revision text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_principal_id uuid; v_row accounts.credential_operations%rowtype;
begin
  select principal_id into v_principal_id from accounts.principal_auth_users where user_id = p_user_id;
  if v_principal_id is null or p_password_hash !~ '^[$]2[aby][$][0-9]{2}[$]'
     or nullif(btrim(p_operation_key), '') is null then
    raise exception 'Credential operation is invalid' using errcode = '22023';
  end if;
  insert into accounts.credential_operations (
    operation_key, user_id, principal_id, password_hash, source_revision
  ) values (
    p_operation_key, p_user_id, v_principal_id, p_password_hash, p_source_revision
  ) on conflict (operation_key) do update set updated_at = now()
  where accounts.credential_operations.user_id = excluded.user_id
    and accounts.credential_operations.password_hash = excluded.password_hash
  returning * into v_row;
  if v_row.id is null then raise exception 'Credential operation conflicts' using errcode = '23505'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'principal_id', v_principal_id);
end;
$$;

create or replace function public.roo_mark_credential_operation(
  p_operation_key text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_row accounts.credential_operations%rowtype;
begin
  if p_status not in ('auth_applied', 'mirrored', 'failed') then
    raise exception 'Credential status is invalid' using errcode = '22023';
  end if;
  update accounts.credential_operations set
    status = p_status,
    attempt_count = attempt_count + 1,
    last_error_code = nullif(left(coalesce(p_error_code, ''), 128), ''),
    auth_applied_at = case when p_status = 'auth_applied' then coalesce(auth_applied_at, now()) else auth_applied_at end,
    mirrored_at = case when p_status = 'mirrored' then coalesce(mirrored_at, now()) else mirrored_at end,
    updated_at = now()
  where operation_key = p_operation_key returning * into v_row;
  if not found then raise exception 'Credential operation was not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;

create or replace function public.roo_complete_credential_operation(
  p_operation_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation accounts.credential_operations%rowtype;
  v_version bigint;
begin
  select * into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;
  if not found then
    raise exception 'Credential operation was not found' using errcode = 'P0002';
  end if;
  select principal.session_version into v_version
  from accounts.principals principal
  where principal.id = v_operation.principal_id
  for update;
  if v_operation.status = 'mirrored' then
    return jsonb_build_object(
      'status', 'mirrored',
      'session_version', v_version,
      'idempotent', true
    );
  end if;
  if v_operation.status <> 'auth_applied' then
    raise exception 'Credential operation is not ready to complete'
      using errcode = '55000';
  end if;
  update accounts.principals principal set
    session_version = principal.session_version + 1,
    updated_at = now()
  where principal.id = v_operation.principal_id
    and principal.status = 'active'
  returning principal.session_version into v_version;
  if v_version is null then
    raise exception 'Active principal was not found' using errcode = 'P0002';
  end if;
  delete from auth.sessions session
  where session.user_id in (
    select mapping.user_id
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_operation.principal_id
  );
  update accounts.credential_operations operation set
    status = 'mirrored',
    attempt_count = operation.attempt_count + 1,
    last_error_code = null,
    mirrored_at = coalesce(operation.mirrored_at, now()),
    updated_at = now()
  where operation.id = v_operation.id;
  return jsonb_build_object(
    'status', 'mirrored',
    'session_version', v_version,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_list_credential_recovery(p_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  update accounts.credential_operations operation set
    status = 'auth_applied', auth_applied_at = coalesce(auth_applied_at, now()),
    updated_at = now()
  from auth.users auth_user
  where operation.user_id = auth_user.id
    and operation.status = 'prepared'
    and auth_user.encrypted_password = operation.password_hash;
  select coalesce(jsonb_agg(jsonb_build_object(
    'operation_key', operation.operation_key,
    'user_id', operation.user_id,
    'principal_id', operation.principal_id,
    'password_hash', operation.password_hash,
    'status', operation.status,
    'source_revision', operation.source_revision,
    'creator_legacy_sanity_id', creator.legacy_sanity_id,
    'attempt_count', operation.attempt_count
  ) order by operation.created_at), '[]'::jsonb) into v_result
  from (
    select candidate.* from accounts.credential_operations candidate
    where candidate.status in ('prepared', 'auth_applied')
    order by candidate.created_at for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  ) operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id;
  return v_result;
end;
$$;

create or replace function public.roo_import_tourney_player_account_v2(p_account jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_result jsonb; v_user_id uuid := (p_account->>'user_id')::uuid; v_status text;
begin
  v_result := public.roo_import_tourney_player_account(p_account);
  v_status := lower(coalesce(p_account->>'status', 'pending'));
  update accounts.tourney_accounts set
    lifecycle_status = case when v_status in ('pending','approved','denied','withdrawn','removed','disabled')
      then v_status else 'pending' end,
    active = v_status = 'approved', updated_at = now()
  where user_id = v_user_id;
  perform public.roo_reconcile_auth_identity_links(v_user_id);
  return v_result || jsonb_build_object('lifecycle_status', v_status);
end;
$$;

create or replace function public.roo_import_account_v2(p_account jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_result jsonb; v_user_id uuid := (p_account->>'user_id')::uuid; v_active boolean;
begin
  v_result := public.roo_import_account(p_account);
  if jsonb_typeof(p_account->'tourney_account') = 'object' then
    v_active := coalesce((p_account#>>'{tourney_account,active}')::boolean, true);
    update accounts.tourney_accounts set
      lifecycle_status = case when v_active then 'approved' else 'disabled' end,
      active = v_active, updated_at = now()
    where user_id = v_user_id;
  end if;
  perform public.roo_reconcile_auth_identity_links(v_user_id);
  return v_result;
end;
$$;

create or replace function public.roo_refresh_discord_role_assignment(
  p_user_id uuid,
  p_guild_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_discord_user_id text;
  v_tourney accounts.tourney_accounts%rowtype;
  v_desired_role text := 'none';
  v_row accounts.discord_role_assignments%rowtype;
begin
  if p_user_id is null or p_guild_id !~ '^[0-9]{5,30}$' then
    raise exception 'Discord role assignment request is invalid' using errcode = '22023';
  end if;
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping where mapping.user_id = p_user_id;
  if v_principal_id is null then
    raise exception 'Account principal was not found' using errcode = 'P0002';
  end if;
  select * into v_tourney from accounts.tourney_accounts account
  where account.principal_id = v_principal_id;
  select identity_link.provider_subject into v_discord_user_id
  from accounts.identity_links identity_link
  where identity_link.principal_id = v_principal_id
    and identity_link.provider = 'discord'
  limit 1;

  if v_tourney.user_id is null then
    return jsonb_build_object('queued', false, 'reason', 'tourney_not_linked');
  end if;
  v_desired_role := case
    when not v_tourney.active or v_tourney.lifecycle_status <> 'approved' then 'none'
    when v_tourney.role = 'tourney_player' then 'participant'
    when v_tourney.role in ('tourney_owner', 'tourney_caster') then 'host'
    else 'none'
  end;

  if v_discord_user_id is null then
    update accounts.discord_role_assignments assignment set
      previous_discord_user_id = assignment.discord_user_id,
      desired_role = 'none', tourney_role = v_tourney.role,
      generation = case when assignment.desired_role <> 'none'
        then assignment.generation + 1 else assignment.generation end,
      status = case when assignment.applied_role = 'none'
        then 'applied' else 'pending' end,
      last_error = null, updated_at = now()
    where assignment.principal_id = v_principal_id returning * into v_row;
    if not found then
      return jsonb_build_object('queued', false, 'reason', 'discord_not_linked');
    end if;
  else
    insert into accounts.discord_role_assignments (
      user_id, principal_id, discord_user_id, guild_id, tourney_role,
      desired_role, status
    ) values (
      v_tourney.user_id, v_principal_id, v_discord_user_id, p_guild_id,
      v_tourney.role, v_desired_role, 'pending'
    ) on conflict (principal_id) do update set
      previous_discord_user_id = case
        when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
          then accounts.discord_role_assignments.discord_user_id
        else accounts.discord_role_assignments.previous_discord_user_id end,
      discord_user_id = excluded.discord_user_id,
      guild_id = excluded.guild_id,
      tourney_role = excluded.tourney_role,
      desired_role = excluded.desired_role,
      generation = case when
        accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        or accounts.discord_role_assignments.guild_id <> excluded.guild_id
        or accounts.discord_role_assignments.tourney_role is distinct from excluded.tourney_role
        or accounts.discord_role_assignments.desired_role <> excluded.desired_role
        then accounts.discord_role_assignments.generation + 1
        else accounts.discord_role_assignments.generation end,
      status = case when
        accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
        and accounts.discord_role_assignments.guild_id = excluded.guild_id
        and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
        and accounts.discord_role_assignments.desired_role = excluded.desired_role
        and accounts.discord_role_assignments.applied_generation = accounts.discord_role_assignments.generation
        and accounts.discord_role_assignments.applied_role = excluded.desired_role
        then 'applied' else 'pending' end,
      last_error = null, updated_at = now()
    returning * into v_row;
  end if;
  return jsonb_build_object(
    'queued', true, 'user_id', v_row.user_id,
    'principal_id', v_row.principal_id,
    'discord_user_id', v_row.discord_user_id,
    'previous_discord_user_id', v_row.previous_discord_user_id,
    'guild_id', v_row.guild_id, 'tourney_role', v_row.tourney_role,
    'desired_role', v_row.desired_role, 'applied_role', v_row.applied_role,
    'generation', v_row.generation, 'status', v_row.status
  );
end;
$$;

create or replace function public.roo_get_discord_role_assignment(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', assignment.user_id,
    'principal_id', assignment.principal_id,
    'discord_user_id', assignment.discord_user_id,
    'previous_discord_user_id', assignment.previous_discord_user_id,
    'guild_id', assignment.guild_id,
    'tourney_role', assignment.tourney_role,
    'desired_role', assignment.desired_role,
    'applied_role', assignment.applied_role,
    'generation', assignment.generation,
    'applied_generation', assignment.applied_generation,
    'status', assignment.status,
    'last_error', assignment.last_error
  )
  from accounts.discord_role_assignments assignment
  join accounts.principal_auth_users mapping
    on mapping.principal_id = assignment.principal_id
  where mapping.user_id = p_user_id;
$$;

create or replace function public.roo_complete_discord_role_assignment(
  p_user_id uuid,
  p_generation bigint,
  p_applied_role text,
  p_status text,
  p_error text default null,
  p_joined boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_principal_id uuid; v_row accounts.discord_role_assignments%rowtype;
begin
  if p_applied_role not in ('none', 'participant', 'host')
     or p_status not in ('applied', 'retry', 'blocked') then
    raise exception 'Discord role completion is invalid' using errcode = '22023';
  end if;
  select principal_id into v_principal_id
  from accounts.principal_auth_users where user_id = p_user_id;
  update accounts.discord_role_assignments set
    applied_role = case when p_status = 'applied' then p_applied_role else applied_role end,
    applied_generation = case when p_status = 'applied' then p_generation else applied_generation end,
    status = p_status, attempt_count = attempt_count + 1,
    last_error = nullif(left(coalesce(p_error, ''), 120), ''),
    joined_at = case when p_joined then coalesce(joined_at, now()) else joined_at end,
    applied_at = case when p_status = 'applied' then now() else applied_at end,
    previous_discord_user_id = case when p_status = 'applied' then null else previous_discord_user_id end,
    updated_at = now()
  where principal_id = v_principal_id and generation = p_generation
  returning * into v_row;
  if not found then raise exception 'Discord role generation changed' using errcode = '40001'; end if;
  return jsonb_build_object(
    'user_id', v_row.user_id, 'principal_id', v_row.principal_id,
    'generation', v_row.generation, 'status', v_row.status,
    'applied_role', v_row.applied_role
  );
end;
$$;

create or replace function public.roo_referral_earnings_rows(
  p_referral_legacy_id text,
  p_referral_code text,
  p_after_id text default null,
  p_limit integer default 250
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    '_id', booking.legacy_sanity_id,
    'packageTitle', booking.package_title,
    'commissionAmount', booking.booking_payload->'commissionAmount',
    'commissionPercent', booking.booking_payload->'commissionPercent',
    'netAmount', booking.booking_payload->'netAmount',
    'grossAmount', booking.booking_payload->'grossAmount'
  ) order by booking.legacy_sanity_id), '[]'::jsonb)
  from (
    select candidate.* from commerce.bookings candidate
    where candidate.status in ('captured', 'completed')
      and candidate.legacy_sanity_id > coalesce(p_after_id, '')
      and (
        candidate.booking_payload#>>'{referral,_ref}' = p_referral_legacy_id
        or lower(coalesce(candidate.booking_payload->>'referralCode', ''))
          = lower(coalesce(p_referral_code, ''))
      )
    order by candidate.legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 250), 500))
  ) booking;
$$;

create or replace function public.roo_referral_earnings_summary(
  p_referral_legacy_id text,
  p_referral_code text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with normalized as (
    select
      regexp_replace(coalesce(booking.package_title, 'Unknown'), '\s*\(upgrade\)\s*$', '', 'i') as package_title,
      case when lower(coalesce(booking.package_title, '')) like any(array[
        '%xoc%', '%extreme overclock%', '%performance vertex max%'
      ]) then 'xoc' else 'vertex' end as package_class,
      case
        when btrim(coalesce(booking.booking_payload->>'commissionAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
          and (booking.booking_payload->>'commissionAmount')::numeric <> 0
          then (booking.booking_payload->>'commissionAmount')::numeric
        else coalesce(
          case when btrim(coalesce(booking.booking_payload->>'netAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            and (booking.booking_payload->>'netAmount')::numeric <> 0
            then (booking.booking_payload->>'netAmount')::numeric end,
          case when btrim(coalesce(booking.booking_payload->>'grossAmount', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            then (booking.booking_payload->>'grossAmount')::numeric end,
          0
        ) * coalesce(
          case when btrim(coalesce(booking.booking_payload->>'commissionPercent', '')) ~ '^-?[0-9]+([.][0-9]+)?$'
            then (booking.booking_payload->>'commissionPercent')::numeric / 100 end,
          0
        )
      end as earned
    from commerce.bookings booking
    where booking.status in ('captured', 'completed')
      and (
        booking.booking_payload#>>'{referral,_ref}' = p_referral_legacy_id
        or lower(coalesce(booking.booking_payload->>'referralCode', ''))
          = lower(coalesce(p_referral_code, ''))
      )
  ), package_totals as (
    select package_title, round(sum(earned), 2) amount
    from normalized group by package_title
  )
  select jsonb_build_object(
    'xoc', coalesce(round(sum(earned) filter (where package_class = 'xoc'), 2), 0),
    'vertex', coalesce(round(sum(earned) filter (where package_class = 'vertex'), 2), 0),
    'total', coalesce(round(sum(earned), 2), 0),
    'byPackage', coalesce((select jsonb_object_agg(package_title, amount order by package_title) from package_totals), '{}'::jsonb)
  ) from normalized;
$$;

create or replace function public.roo_upgrade_booking_chain(
  p_root_legacy_id text,
  p_after_id text default null,
  p_limit integer default 250
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    booking.booking_payload || jsonb_build_object(
      '_id', booking.legacy_sanity_id,
      'status', booking.status,
      'packageTitle', booking.package_title,
      'netAmount', booking.booking_payload->'netAmount',
      'grossAmount', booking.booking_payload->'grossAmount',
      'packagePrice', booking.booking_payload->'packagePrice'
    ) order by booking.legacy_sanity_id
  ), '[]'::jsonb)
  from (
    select candidate.* from commerce.bookings candidate
    where candidate.status in ('captured', 'completed')
      and candidate.legacy_sanity_id > coalesce(p_after_id, '')
      and (
        candidate.legacy_sanity_id = p_root_legacy_id
        or candidate.booking_payload->>'originalOrderId' = p_root_legacy_id
      )
    order by candidate.legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 250), 500))
  ) booking;
$$;

create or replace function public.roo_commerce_derived_count(
  p_kind text,
  p_value text
)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_kind = 'referral_success' then
    return (
      select count(*) from commerce.bookings booking
      where booking.status in ('captured', 'completed')
        and booking.booking_payload#>>'{referral,_ref}' = p_value
    );
  elsif p_kind = 'coupon_usage' then
    return (
      select count(*) from commerce.bookings booking
      where booking.status in ('captured', 'completed')
        and lower(coalesce(booking.coupon_code, '')) = lower(coalesce(p_value, ''))
    );
  elsif p_kind = 'coupon_redemptions' then
    return (
      select count(*) from commerce.coupon_redemptions redemption
      join commerce.coupons coupon on coupon.id = redemption.coupon_id
      where coupon.legacy_sanity_id = p_value and redemption.state = 'consumed'
    );
  end if;
  raise exception 'Commerce count kind is invalid' using errcode = '22023';
end;
$$;

create or replace function public.roo_asset_manifest_for_refs(
  p_asset_ids text[] default null,
  p_source_urls text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'legacy_sanity_asset_id', asset.legacy_sanity_asset_id,
    'source_url', asset.source_url,
    'storage_bucket', asset.storage_bucket,
    'storage_path', asset.storage_path,
    'mime_type', asset.mime_type,
    'byte_size', asset.byte_size,
    'width', asset.width,
    'height', asset.height,
    'sha256', asset.sha256,
    'migration_status', asset.migration_status
  ) order by asset.legacy_sanity_asset_id), '[]'::jsonb)
  from cms.assets asset
  where (
    coalesce(cardinality(p_asset_ids), 0) > 0
    and asset.legacy_sanity_asset_id = any(p_asset_ids)
  ) or (
    coalesce(cardinality(p_source_urls), 0) > 0
    and asset.source_url = any(p_source_urls)
  );
$$;

create or replace function migration.mark_cms_source_imported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update migration.source_documents source set cms_imported = true
  where source.legacy_sanity_id = new.legacy_sanity_id
    and source.source_hash = new.content_hash
    and not source.tombstoned;
  return new;
end;
$$;
create trigger cms_documents_mark_source_imported
  after insert or update of content_hash on cms.documents
  for each row execute function migration.mark_cms_source_imported();

update migration.source_documents source set cms_imported = true
from cms.documents document
where document.legacy_sanity_id = source.legacy_sanity_id
  and document.content_hash = source.source_hash
  and not source.tombstoned;

create or replace function public.roo_project_referral_account_shadow(
  p_legacy_sanity_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_creators integer := 0;
begin
  update accounts.creator_profiles creator set
    referral_code = coalesce(
      nullif(lower(btrim(source.payload#>>'{slug,current}')), ''), creator.referral_code
    ),
    paypal_email = nullif(lower(btrim(source.payload->>'paypalEmail')), ''),
    contact_discord = nullif(source.payload->>'contactDiscord', ''),
    commission_basis_points = case
      when btrim(coalesce(source.payload->>'currentCommissionPercent', '')) ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0, round((source.payload->>'currentCommissionPercent')::numeric * 100)::integer))
      else creator.commission_basis_points end,
    discount_basis_points = case
      when btrim(coalesce(source.payload->>'currentDiscountPercent', '')) ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0, round((source.payload->>'currentDiscountPercent')::numeric * 100)::integer))
      else creator.discount_basis_points end,
    successful_referrals = case
      when btrim(coalesce(source.payload->>'successfulReferrals', '')) ~ '^[0-9]+$'
      then least(2147483647::numeric, (source.payload->>'successfulReferrals')::numeric)::integer
      else creator.successful_referrals end,
    payout_details = jsonb_build_object(
      'paypal_email', nullif(lower(btrim(source.payload->>'paypalEmail')), '')
    ),
    accounting_totals = jsonb_build_object(
      'earned_total', coalesce(source.payload->'earnedTotal', '0'::jsonb),
      'owed_total', coalesce(source.payload->'owedTotal', '0'::jsonb),
      'paid_total', coalesce(source.payload->'paidTotal', '0'::jsonb),
      'earned_vertex', coalesce(source.payload->'earnedVertex', '0'::jsonb),
      'earned_xoc', coalesce(source.payload->'earnedXoc', '0'::jsonb),
      'owed_vertex', coalesce(source.payload->'owedVertex', '0'::jsonb),
      'owed_xoc', coalesce(source.payload->'owedXoc', '0'::jsonb),
      'paid_vertex', coalesce(source.payload->'paidVertex', '0'::jsonb),
      'paid_xoc', coalesce(source.payload->'paidXoc', '0'::jsonb)
    ),
    active = not source.tombstoned
      and lower(coalesce(source.payload->>'active', 'true')) <> 'false',
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = source.backend_owner,
    updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and (p_legacy_sanity_ids is null or source.legacy_sanity_id = any(p_legacy_sanity_ids));
  get diagnostics v_creators = row_count;
  return jsonb_build_object('profiles', 0, 'creator_profiles', v_creators);
end;
$$;

create or replace function migration.project_referral_source_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.document_type = 'referral' then
    perform public.roo_project_referral_account_shadow(array[new.legacy_sanity_id]);
  end if;
  return new;
end;
$$;
create trigger source_documents_project_referral
  after insert or update of payload, source_hash, tombstoned
  on migration.source_documents
  for each row execute function migration.project_referral_source_change();

do $$
declare v_ids text[];
begin
  select array_agg(source.legacy_sanity_id) into v_ids
  from migration.source_documents source
  join accounts.creator_profiles creator
    on creator.legacy_sanity_id = source.legacy_sanity_id
  where source.document_type = 'referral'
    and source.source_hash is distinct from creator.source_hash;
  if coalesce(cardinality(v_ids), 0) > 1 then
    raise exception 'Multiple creator projections require explicit review';
  end if;
  if coalesce(cardinality(v_ids), 0) = 1 then
    perform public.roo_project_referral_account_shadow(v_ids);
  end if;
end;
$$;

create or replace function public.roo_claim_commerce_mirror_events(
  p_lease_id text,
  p_limit integer default 25,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if nullif(btrim(coalesce(p_lease_id, '')), '') is null then
    raise exception 'mirror lease id is required' using errcode = '22023';
  end if;
  with candidates as (
    select candidate.id
    from migration.commerce_mirror_outbox candidate
    where (
      (candidate.status in ('pending', 'retry') and (
        coalesce(p_force, false)
        or coalesce(candidate.next_attempt_at, '-infinity'::timestamptz) <= now()
      )) or (candidate.status = 'processing' and candidate.lease_expires_at <= now())
    ) and not exists (
      select 1 from migration.commerce_mirror_outbox earlier
      where earlier.sequence_no < candidate.sequence_no
        and earlier.status not in ('mirrored', 'superseded')
        and earlier.document_ids && candidate.document_ids
    )
    order by candidate.sequence_no
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update migration.commerce_mirror_outbox outbox set
      status = 'processing', lease_id = p_lease_id,
      lease_expires_at = now() + interval '2 minutes',
      attempt_count = attempt_count + 1
    from candidates where outbox.id = candidates.id returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence_no', claimed.sequence_no,
    'event_key', claimed.event_key,
    'document_ids', to_jsonb(claimed.document_ids),
    'documents', coalesce((
      select jsonb_agg(document.value || jsonb_build_object(
        '_supabaseCanonicalHash', migration.canonical_business_hash(document.value),
        '_supabaseSequence', claimed.sequence_no
      ) order by document.value->>'_id')
      from jsonb_array_elements(claimed.documents) document(value)
    ), '[]'::jsonb),
    'deleted_ids', to_jsonb(claimed.deleted_ids),
    'delete_guards', claimed.delete_guards,
    'canonical_hash', claimed.canonical_hash,
    'cutover_generation', claimed.cutover_generation,
    'attempt_count', claimed.attempt_count
  ) order by claimed.sequence_no), '[]'::jsonb) into v_result
  from claimed;
  return v_result;
end;
$$;

create or replace function public.roo_complete_commerce_mirror_event(
  p_event_key text,
  p_lease_id text,
  p_success boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_event migration.commerce_mirror_outbox%rowtype; v_checkpoint jsonb; v_status text;
begin
  select * into v_event from migration.commerce_mirror_outbox
  where event_key = p_event_key for update;
  if not found then raise exception 'mirror event not found' using errcode = 'P0002'; end if;
  if v_event.status in ('mirrored', 'superseded') then
    return jsonb_build_object('event_key', p_event_key, 'status', v_event.status, 'idempotent', true);
  end if;
  if v_event.lease_id is distinct from p_lease_id then
    raise exception 'mirror event lease conflict' using errcode = '40001';
  end if;
  if p_success then
    v_status := case when p_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE'
      then 'superseded' else 'mirrored' end;
    update migration.commerce_mirror_outbox set
      status = v_status, mirrored_at = case when v_status = 'mirrored' then now() else mirrored_at end,
      resolved_at = case when v_status = 'superseded' then now() else resolved_at end,
      resolution_reason = case when v_status = 'superseded' then 'newer_sanity_sequence' else resolution_reason end,
      lease_id = null, lease_expires_at = null, next_attempt_at = null,
      last_error_code = null
    where event_key = p_event_key;
    if v_status = 'mirrored' then
      insert into migration.commerce_mirror_checkpoints (
        event_key, canonical_hash, cutover_generation, document_count, sequence_no
      ) values (
        p_event_key, v_event.canonical_hash, v_event.cutover_generation,
        cardinality(v_event.document_ids), v_event.sequence_no
      ) on conflict (event_key) do update set
        sequence_no = excluded.sequence_no, mirrored_at = now();
    end if;
    v_checkpoint := migration.recompute_commerce_mirror_checkpoint();
  else
    update migration.commerce_mirror_outbox set
      status = case when attempt_count >= 12 then 'dead_letter' else 'retry' end,
      next_attempt_at = case when attempt_count >= 12 then null else
        now() + least(interval '1 hour', interval '1 minute' * power(2, least(attempt_count, 6))) end,
      lease_id = null, lease_expires_at = null,
      last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED'), 128)
    where event_key = p_event_key;
    v_status := case when v_event.attempt_count >= 12 then 'dead_letter' else 'retry' end;
  end if;
  return jsonb_build_object(
    'event_key', p_event_key, 'status', v_status,
    'checkpoint', v_checkpoint
  );
end;
$$;

create or replace function public.roo_reconcile_account_security(
  p_guild_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_user record; v_reconciled integer := 0; v_failed integer := 0; v_expired integer := 0; v_purged integer := 0;
begin
  update accounts.oauth_intents set status = 'expired', failure_code = 'expired', updated_at = now()
  where status = 'pending' and expires_at <= now();
  get diagnostics v_expired = row_count;
  delete from accounts.oauth_intents
  where status in ('completed', 'failed', 'expired', 'replaced')
    and updated_at < now() - interval '7 days';
  get diagnostics v_purged = row_count;
  for v_user in select auth_user.id from auth.users auth_user order by auth_user.id loop
    begin
      perform accounts.ensure_principal_for_user(v_user.id, 'migration');
      perform public.roo_reconcile_auth_identity_links(v_user.id);
      if p_guild_id ~ '^[0-9]{5,30}$' then
        perform public.roo_refresh_discord_role_assignment(v_user.id, p_guild_id);
      end if;
      v_reconciled := v_reconciled + 1;
    exception when others then
      v_failed := v_failed + 1;
    end;
  end loop;
  return jsonb_build_object(
    'reconciled', v_reconciled, 'failed', v_failed,
    'expired_intents', v_expired, 'purged_intents', v_purged
  );
end;
$$;

create or replace function public.roo_record_reconciliation_checkpoint(
  p_counters jsonb default '{}'::jsonb,
  p_parity jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_run_id uuid; v_cursor text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  insert into migration.sync_runs (
    direction, mode, status, started_at, completed_at, source_cursor, counters
  ) values (
    'compare', 'shadow', 'completed', now(), now(), v_cursor,
    coalesce(p_counters, '{}'::jsonb) || jsonb_build_object('parity', coalesce(p_parity, '{}'::jsonb))
  ) returning id into v_run_id;
  insert into migration.sync_cursors (
    stream_name, cursor_value, source_updated_at, last_successful_run_id, updated_at
  ) values (
    'commerce_reconciliation', v_cursor, now(), v_run_id, now()
  ) on conflict (stream_name) do update set
    cursor_value = excluded.cursor_value,
    source_updated_at = excluded.source_updated_at,
    last_successful_run_id = excluded.last_successful_run_id,
    lease_id = null, lease_expires_at = null, last_error_code = null,
    updated_at = now();
  return jsonb_build_object('run_id', v_run_id, 'cursor', v_cursor);
end;
$$;

create or replace function public.roo_supabase_port_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'credentialRecovery', jsonb_build_object(
      'pending', (select count(*) from accounts.credential_operations where status in ('prepared','auth_applied')),
      'oldestAt', (select min(created_at) from accounts.credential_operations where status in ('prepared','auth_applied'))
    ),
    'identityDrift', jsonb_build_object(
      'missing', (select count(*) from auth.identities identity
        join accounts.principal_auth_users mapping on mapping.user_id = identity.user_id
        where identity.provider in ('email','google','apple','discord')
          and not exists (select 1 from accounts.identity_links projected
            where projected.provider = identity.provider
              and projected.provider_subject = identity.provider_id
              and projected.principal_id = mapping.principal_id)),
      'stale', (select count(*) from accounts.identity_links projected
        where not exists (select 1 from auth.identities identity
          where identity.user_id = projected.user_id
            and identity.provider = projected.provider
            and identity.provider_id = projected.provider_subject))
    ),
    'creatorProjectionDrift', (select count(*)
      from accounts.creator_profiles creator
      join migration.source_documents source
        on source.legacy_sanity_id = creator.legacy_sanity_id
      where source.source_hash is distinct from creator.source_hash),
    'parityAgeSeconds', (
      select case when max(completed_at) is null then null
        else extract(epoch from now() - max(completed_at)) end
      from migration.sync_runs
      where direction = 'compare' and status = 'completed'
    ),
    'staleProviderRecovery', (select count(*) from commerce.payment_records payment
      where payment.status = 'needs_recovery'
        and payment.updated_at < now() - interval '15 minutes'),
    'capturedWithoutBooking', (select count(*) from commerce.payment_records payment
      where payment.status in ('captured','booked','email_partial')
        and payment.booking_id is null and not payment.requires_reschedule),
    'reciprocalLinkMismatches', (
      select count(*) from commerce.payment_records payment
      full join commerce.bookings booking
        on booking.id = payment.booking_id or payment.id = booking.payment_record_id
      where (payment.booking_id is not null and booking.id is distinct from payment.booking_id)
        or (booking.payment_record_id is not null and payment.id is distinct from booking.payment_record_id)
    ),
    'rescheduleCases', (select count(*) from commerce.recovery_cases recovery
      where recovery.requires_reschedule and recovery.status <> 'resolved'),
    'discordRetry', jsonb_build_object(
      'pending', (select count(*) from accounts.discord_role_assignments
        where status in ('pending','retry','processing')),
      'oldestAt', (select min(updated_at) from accounts.discord_role_assignments
        where status in ('pending','retry','processing'))
    ),
    'oauthIntents', jsonb_build_object(
      'expiredPending', (select count(*) from accounts.oauth_intents
        where status = 'pending' and expires_at <= now()),
      'terminalOlderThanSevenDays', (select count(*) from accounts.oauth_intents
        where status in ('completed','failed','expired','replaced')
          and updated_at < now() - interval '7 days')
    )
  );
$$;

revoke all on function accounts.real_verified_email(uuid) from public, anon, authenticated;
revoke all on function accounts.principal_account_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.roo_account_by_user_id(uuid) from public, anon, authenticated;
revoke all on function public.roo_resolve_account_alias(text) from public, anon, authenticated;
revoke all on function public.roo_resolve_tourney_account_alias(text) from public, anon, authenticated;
revoke all on function public.roo_reconcile_auth_identity_links(uuid) from public, anon, authenticated;
revoke all on function public.roo_bootstrap_native_account(uuid) from public, anon, authenticated;
revoke all on function public.roo_read_oauth_intent(uuid, text) from public, anon, authenticated;
revoke all on function public.roo_create_reauth_grant(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.roo_consume_reauth_grant(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.roo_create_oauth_intent(jsonb) from public, anon, authenticated;
revoke all on function public.roo_finalize_oauth_intent(text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.roo_merge_account_principals(text, text) from public, anon, authenticated;
revoke all on function public.roo_rotate_principal_sessions(uuid) from public, anon, authenticated;
revoke all on function public.roo_validate_referral_session(text, bigint) from public, anon, authenticated;
revoke all on function public.roo_prepare_credential_operation(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.roo_mark_credential_operation(text, text, text) from public, anon, authenticated;
revoke all on function public.roo_complete_credential_operation(text) from public, anon, authenticated;
revoke all on function public.roo_list_credential_recovery(integer) from public, anon, authenticated;
revoke all on function public.roo_import_tourney_player_account_v2(jsonb) from public, anon, authenticated;
revoke all on function public.roo_import_account_v2(jsonb) from public, anon, authenticated;
revoke all on function public.roo_refresh_discord_role_assignment(uuid, text) from public, anon, authenticated;
revoke all on function public.roo_get_discord_role_assignment(uuid) from public, anon, authenticated;
revoke all on function public.roo_complete_discord_role_assignment(uuid, bigint, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.roo_referral_earnings_rows(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.roo_referral_earnings_summary(text, text) from public, anon, authenticated;
revoke all on function public.roo_upgrade_booking_chain(text, text, integer) from public, anon, authenticated;
revoke all on function public.roo_commerce_derived_count(text, text) from public, anon, authenticated;
revoke all on function public.roo_asset_manifest_for_refs(text[], text[]) from public, anon, authenticated;
revoke all on function public.roo_project_referral_account_shadow(text[]) from public, anon, authenticated;
revoke all on function public.roo_claim_commerce_mirror_events(text, integer, boolean) from public, anon, authenticated;
revoke all on function public.roo_complete_commerce_mirror_event(text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.roo_reconcile_account_security(text) from public, anon, authenticated;
revoke all on function public.roo_record_reconciliation_checkpoint(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.roo_supabase_port_readiness() from public, anon, authenticated;

grant execute on function public.roo_account_by_user_id(uuid) to service_role;
grant execute on function public.roo_resolve_account_alias(text) to service_role;
grant execute on function public.roo_resolve_tourney_account_alias(text) to service_role;
grant execute on function public.roo_reconcile_auth_identity_links(uuid) to service_role;
grant execute on function public.roo_bootstrap_native_account(uuid) to service_role;
grant execute on function public.roo_read_oauth_intent(uuid, text) to service_role;
grant execute on function public.roo_create_reauth_grant(uuid, text, text, text) to service_role;
grant execute on function public.roo_consume_reauth_grant(text, uuid, text, text) to service_role;
grant execute on function public.roo_create_oauth_intent(jsonb) to service_role;
grant execute on function public.roo_finalize_oauth_intent(text, uuid, text, text, text) to service_role;
grant execute on function public.roo_merge_account_principals(text, text) to service_role;
grant execute on function public.roo_rotate_principal_sessions(uuid) to service_role;
grant execute on function public.roo_validate_referral_session(text, bigint) to service_role;
grant execute on function public.roo_prepare_credential_operation(text, uuid, text, text) to service_role;
grant execute on function public.roo_mark_credential_operation(text, text, text) to service_role;
grant execute on function public.roo_complete_credential_operation(text) to service_role;
grant execute on function public.roo_list_credential_recovery(integer) to service_role;
grant execute on function public.roo_import_tourney_player_account_v2(jsonb) to service_role;
grant execute on function public.roo_import_account_v2(jsonb) to service_role;
grant execute on function public.roo_refresh_discord_role_assignment(uuid, text) to service_role;
grant execute on function public.roo_get_discord_role_assignment(uuid) to service_role;
grant execute on function public.roo_complete_discord_role_assignment(uuid, bigint, text, text, text, boolean) to service_role;
grant execute on function public.roo_referral_earnings_rows(text, text, text, integer) to service_role;
grant execute on function public.roo_referral_earnings_summary(text, text) to service_role;
grant execute on function public.roo_upgrade_booking_chain(text, text, integer) to service_role;
grant execute on function public.roo_commerce_derived_count(text, text) to service_role;
grant execute on function public.roo_asset_manifest_for_refs(text[], text[]) to service_role;
grant execute on function public.roo_project_referral_account_shadow(text[]) to service_role;
grant execute on function public.roo_claim_commerce_mirror_events(text, integer, boolean) to service_role;
grant execute on function public.roo_complete_commerce_mirror_event(text, text, boolean, text) to service_role;
grant execute on function public.roo_reconcile_account_security(text) to service_role;
grant execute on function public.roo_record_reconciliation_checkpoint(jsonb, jsonb) to service_role;
grant execute on function public.roo_supabase_port_readiness() to service_role;
