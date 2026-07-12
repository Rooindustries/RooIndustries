create table accounts.oauth_intents (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  flow text not null check (flow in ('referral', 'tourney')),
  action text not null check (action in ('signin', 'signup', 'link')),
  provider text not null check (provider in ('google', 'discord')),
  target_user_id uuid references auth.users(id) on delete cascade,
  claimed_user_id uuid references auth.users(id) on delete cascade,
  domain_subject text,
  return_path text not null,
  provider_subject text,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired', 'replaced')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((action = 'link') = (target_user_id is not null)),
  check (
    left(return_path, 1) = '/'
    and left(return_path, 2) <> '//'
    and return_path !~ '[[:cntrl:]\\]'
    and char_length(return_path) <= 500
  ),
  check (domain_subject is null or char_length(domain_subject) <= 300),
  check (provider_subject is null or char_length(provider_subject) <= 300)
);

create index oauth_intents_expiry_idx
  on accounts.oauth_intents (status, expires_at);

create unique index oauth_intents_one_active_link_idx
  on accounts.oauth_intents (target_user_id, provider)
  where action = 'link' and status = 'pending';

alter table accounts.oauth_intents enable row level security;
revoke all on table accounts.oauth_intents from public, anon, authenticated;
grant all on table accounts.oauth_intents to service_role;

create table accounts.discord_role_assignments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  discord_user_id text not null unique,
  previous_discord_user_id text,
  guild_id text not null,
  tourney_role text
    check (tourney_role is null or tourney_role in (
      'tourney_player', 'tourney_viewer', 'tourney_caster', 'tourney_owner'
    )),
  desired_role text not null default 'none'
    check (desired_role in ('none', 'participant', 'host')),
  applied_role text not null default 'none'
    check (applied_role in ('none', 'participant', 'host')),
  generation bigint not null default 1 check (generation > 0),
  applied_generation bigint not null default 0 check (applied_generation >= 0),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'applied', 'retry', 'blocked')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  joined_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (guild_id ~ '^[0-9]{5,30}$'),
  check (discord_user_id ~ '^[0-9]{5,30}$'),
  check (
    previous_discord_user_id is null
    or previous_discord_user_id ~ '^[0-9]{5,30}$'
  )
);

create index discord_role_assignments_retry_idx
  on accounts.discord_role_assignments (status, updated_at)
  where status in ('pending', 'retry');

alter table accounts.discord_role_assignments enable row level security;
revoke all on table accounts.discord_role_assignments
  from public, anon, authenticated;
grant all on table accounts.discord_role_assignments to service_role;

do $$
begin
  if exists (
    select 1
    from accounts.identity_links projected
    join auth.identities identity
      on identity.provider = projected.provider
     and identity.provider_id = projected.provider_subject
    where identity.user_id <> projected.user_id
  ) then
    raise exception 'An Auth identity is projected to another account'
      using errcode = '23505';
  end if;
  if exists (
    select account.legacy_sanity_id
    from accounts.tourney_accounts account
    where account.legacy_sanity_id is not null
    group by account.legacy_sanity_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate Tourney legacy account ids must be repaired first'
      using errcode = '23505';
  end if;
end;
$$;

-- Remove invented or stale projections and rebuild from Supabase Auth truth.
with selected_identity as (
  select distinct on (identity.user_id, identity.provider)
    identity.user_id,
    identity.provider,
    identity.provider_id
  from auth.identities identity
  where identity.provider in ('email', 'google', 'apple', 'discord')
  order by
    identity.user_id,
    identity.provider,
    identity.last_sign_in_at desc nulls last,
    identity.created_at desc nulls last,
    identity.id desc
)
delete from accounts.identity_links projected
where not exists (
  select 1
  from selected_identity selected
  where selected.user_id = projected.user_id
    and selected.provider = projected.provider
    and selected.provider_id = projected.provider_subject
);

insert into accounts.identity_links (
  user_id,
  provider,
  provider_subject,
  provider_email,
  email_verified,
  linked_at,
  last_seen_at,
  metadata,
  backend_owner
)
select distinct on (identity.user_id, identity.provider)
  identity.user_id,
  identity.provider,
  identity.provider_id,
  nullif(lower(btrim(coalesce(
    identity.email,
    identity.identity_data->>'email'
  ))), ''),
  case
    when identity.provider = 'email'
      then auth_user.email_confirmed_at is not null
    else lower(coalesce(identity.identity_data->>'email_verified', 'false')) = 'true'
  end,
  coalesce(identity.created_at, now()),
  identity.last_sign_in_at,
  coalesce(identity.identity_data, '{}'::jsonb),
  'supabase'
from auth.identities identity
join auth.users auth_user on auth_user.id = identity.user_id
where identity.provider in ('email', 'google', 'apple', 'discord')
order by
  identity.user_id,
  identity.provider,
  identity.last_sign_in_at desc nulls last,
  identity.created_at desc nulls last,
  identity.id desc
on conflict (provider, provider_subject) do update
set
  user_id = excluded.user_id,
  provider_email = excluded.provider_email,
  email_verified = excluded.email_verified,
  last_seen_at = excluded.last_seen_at,
  metadata = excluded.metadata,
  backend_owner = 'supabase';

create unique index identity_links_one_social_provider_per_user
  on accounts.identity_links (user_id, provider)
  where provider in ('google', 'discord', 'apple');

create unique index tourney_accounts_legacy_id_unique
  on accounts.tourney_accounts (legacy_sanity_id)
  where legacy_sanity_id is not null;

alter table accounts.tourney_accounts
  add column lifecycle_status text not null default 'approved'
    check (lifecycle_status in (
      'pending', 'approved', 'denied', 'withdrawn', 'removed', 'disabled'
    ));

update accounts.tourney_accounts account
set lifecycle_status = case
  when account.legacy_payload->>'status' in (
    'pending', 'approved', 'denied', 'withdrawn', 'removed'
  ) then account.legacy_payload->>'status'
  when account.active then 'approved'
  else 'disabled'
end;

update public.profiles profile
set status = 'active', updated_at = now()
where exists (
  select 1
  from accounts.tourney_accounts account
  where account.user_id = profile.user_id
);

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
    'user_id', profile.user_id,
    'primary_email', profile.primary_email,
    'display_name', profile.display_name,
    'status', profile.status,
    'legacy_sanity_id', profile.legacy_sanity_id,
    'roles', coalesce(
      (
        select jsonb_agg(account_role.role order by account_role.role)
        from accounts.account_roles account_role
        where account_role.user_id = profile.user_id
      ),
      '[]'::jsonb
    ),
    'referral_code', creator.referral_code,
    'tourney_username', tourney.username,
    'tourney_role', tourney.role,
    'tourney_active', tourney.active,
    'tourney_status', tourney.lifecycle_status,
    'credential_version', tourney.credential_version
  )
  from public.profiles profile
  left join accounts.creator_profiles creator
    on creator.user_id = profile.user_id
  left join accounts.tourney_accounts tourney
    on tourney.user_id = profile.user_id
  where profile.user_id = p_user_id;
$$;

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
    'user_id', profile.user_id,
    'primary_email', profile.primary_email,
    'display_name', profile.display_name,
    'status', profile.status,
    'legacy_sanity_id', profile.legacy_sanity_id,
    'credential_status', credential.status,
    'credential_kind', credential.credential_kind,
    'legacy_source', credential.legacy_source,
    'roles', jsonb_build_array(tourney.role),
    'tourney_username', tourney.username,
    'tourney_role', tourney.role,
    'tourney_active', tourney.active,
    'tourney_status', tourney.lifecycle_status,
    'credential_version', tourney.credential_version
  )
  from accounts.login_aliases alias
  join public.profiles profile on profile.user_id = alias.user_id
  join accounts.tourney_accounts tourney on tourney.user_id = profile.user_id
  left join accounts.credential_migrations credential
    on credential.user_id = profile.user_id
  where alias.alias_type in ('tourney_username', 'tourney_email', 'email')
    and alias.normalized_value = lower(btrim(p_identifier))
  order by case alias.alias_type
    when 'tourney_username' then 0
    when 'tourney_email' then 1
    else 2
  end
  limit 1;
$$;

create or replace function public.roo_reconcile_auth_identity_links(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users auth_user where auth_user.id = p_user_id
  ) then
    raise exception 'Auth user was not found' using errcode = 'P0002';
  end if;
  if exists (
    select 1
    from auth.identities identity
    join accounts.identity_links projected
      on projected.provider = identity.provider
     and projected.provider_subject = identity.provider_id
    where identity.user_id = p_user_id
      and projected.user_id <> p_user_id
  ) then
    raise exception 'Provider identity belongs to another account'
      using errcode = '23505';
  end if;

  with selected_identity as (
    select distinct on (identity.provider)
      identity.provider,
      identity.provider_id
    from auth.identities identity
    where identity.user_id = p_user_id
      and identity.provider in ('email', 'google', 'apple', 'discord')
    order by
      identity.provider,
      identity.last_sign_in_at desc nulls last,
      identity.created_at desc nulls last,
      identity.id desc
  )
  delete from accounts.identity_links projected
  where projected.user_id = p_user_id
    and not exists (
      select 1
      from selected_identity selected
      where selected.provider = projected.provider
        and selected.provider_id = projected.provider_subject
    );

  insert into accounts.identity_links (
    user_id,
    provider,
    provider_subject,
    provider_email,
    email_verified,
    linked_at,
    last_seen_at,
    metadata,
    backend_owner
  )
  select distinct on (identity.provider)
    p_user_id,
    identity.provider,
    identity.provider_id,
    nullif(lower(btrim(coalesce(
      identity.email,
      identity.identity_data->>'email'
    ))), ''),
    case
      when identity.provider = 'email'
        then auth_user.email_confirmed_at is not null
      else lower(coalesce(identity.identity_data->>'email_verified', 'false')) = 'true'
    end,
    coalesce(identity.created_at, now()),
    identity.last_sign_in_at,
    coalesce(identity.identity_data, '{}'::jsonb),
    'supabase'
  from auth.identities identity
  join auth.users auth_user on auth_user.id = identity.user_id
  where identity.user_id = p_user_id
    and identity.provider in ('email', 'google', 'apple', 'discord')
  order by
    identity.provider,
    identity.last_sign_in_at desc nulls last,
    identity.created_at desc nulls last,
    identity.id desc
  on conflict (provider, provider_subject) do update
  set
    provider_email = excluded.provider_email,
    email_verified = excluded.email_verified,
    last_seen_at = excluded.last_seen_at,
    metadata = excluded.metadata,
    backend_owner = 'supabase'
  where accounts.identity_links.user_id = excluded.user_id;

  get diagnostics v_count = row_count;
  return jsonb_build_object('user_id', p_user_id, 'identity_count', v_count);
end;
$$;

create or replace function public.roo_create_oauth_intent(
  p_intent jsonb
)
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
  v_id uuid;
begin
  if v_flow not in ('referral', 'tourney')
     or v_action not in ('signin', 'signup', 'link')
     or v_provider not in ('google', 'discord')
     or v_token_hash !~ '^[0-9a-f]{64}$'
     or v_return_path is null
     or left(v_return_path, 1) <> '/'
     or left(v_return_path, 2) = '//'
     or v_return_path ~ '[[:cntrl:]\\]'
     or char_length(v_return_path) > 500
     or v_expires_at <= now()
     or v_expires_at > now() + interval '20 minutes'
     or ((v_action = 'link') <> (v_target_user_id is not null)) then
    raise exception 'OAuth intent is invalid' using errcode = '22023';
  end if;

  if v_action = 'link' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_target_user_id::text || ':' || v_provider, 0)
    );
    update accounts.oauth_intents
    set status = 'replaced', failure_code = 'replaced', updated_at = now()
    where target_user_id = v_target_user_id
      and provider = v_provider
      and action = 'link'
      and status = 'pending';
  end if;

  insert into accounts.oauth_intents (
    token_hash,
    flow,
    action,
    provider,
    target_user_id,
    domain_subject,
    return_path,
    expires_at
  ) values (
    v_token_hash,
    v_flow,
    v_action,
    v_provider,
    v_target_user_id,
    v_domain_subject,
    v_return_path,
    v_expires_at
  ) returning id into v_id;

  return jsonb_build_object('id', v_id, 'expires_at', v_expires_at);
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
  v_discord_user_id text;
  v_tourney_role text;
  v_tourney_active boolean;
  v_desired_role text := 'none';
  v_row accounts.discord_role_assignments%rowtype;
begin
  if p_user_id is null or p_guild_id !~ '^[0-9]{5,30}$' then
    raise exception 'Discord role assignment request is invalid'
      using errcode = '22023';
  end if;

  select projected.provider_subject
  into v_discord_user_id
  from accounts.identity_links projected
  where projected.user_id = p_user_id
    and projected.provider = 'discord'
  limit 1;

  if v_discord_user_id is null then
    update accounts.discord_role_assignments assignment
    set
      tourney_role = null,
      desired_role = 'none',
      generation = case
        when assignment.desired_role <> 'none' then assignment.generation + 1
        else assignment.generation
      end,
      status = case
        when assignment.applied_role = 'none'
          and assignment.applied_generation = assignment.generation
          and assignment.desired_role = 'none'
        then 'applied'
        else 'pending'
      end,
      last_error = null,
      updated_at = now()
    where assignment.user_id = p_user_id
    returning * into v_row;
    if not found then
      return jsonb_build_object('queued', false, 'reason', 'discord_not_linked');
    end if;
    return jsonb_build_object(
      'queued', true,
      'user_id', v_row.user_id,
      'discord_user_id', v_row.discord_user_id,
      'previous_discord_user_id', v_row.previous_discord_user_id,
      'guild_id', v_row.guild_id,
      'tourney_role', v_row.tourney_role,
      'desired_role', v_row.desired_role,
      'applied_role', v_row.applied_role,
      'generation', v_row.generation,
      'status', v_row.status
    );
  end if;

  select account.role, account.active
  into v_tourney_role, v_tourney_active
  from accounts.tourney_accounts account
  where account.user_id = p_user_id;

  v_desired_role := case
    when v_tourney_active is not true then 'none'
    when v_tourney_role = 'tourney_player' then 'participant'
    when v_tourney_role in ('tourney_owner', 'tourney_caster') then 'host'
    else 'none'
  end;

  insert into accounts.discord_role_assignments (
    user_id,
    discord_user_id,
    guild_id,
    tourney_role,
    desired_role,
    status
  ) values (
    p_user_id,
    v_discord_user_id,
    p_guild_id,
    v_tourney_role,
    v_desired_role,
    'pending'
  )
  on conflict (user_id) do update
  set
    discord_user_id = excluded.discord_user_id,
    previous_discord_user_id = case
      when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
      then accounts.discord_role_assignments.discord_user_id
      else accounts.discord_role_assignments.previous_discord_user_id
    end,
    guild_id = excluded.guild_id,
    tourney_role = excluded.tourney_role,
    desired_role = excluded.desired_role,
    generation = case
      when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        or accounts.discord_role_assignments.guild_id <> excluded.guild_id
        or accounts.discord_role_assignments.tourney_role is distinct from excluded.tourney_role
        or accounts.discord_role_assignments.desired_role <> excluded.desired_role
      then accounts.discord_role_assignments.generation + 1
      else accounts.discord_role_assignments.generation
    end,
    status = case
      when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
        and accounts.discord_role_assignments.guild_id = excluded.guild_id
        and accounts.discord_role_assignments.tourney_role is not distinct from excluded.tourney_role
        and accounts.discord_role_assignments.desired_role = excluded.desired_role
        and accounts.discord_role_assignments.applied_generation = accounts.discord_role_assignments.generation
        and accounts.discord_role_assignments.applied_role = excluded.desired_role
      then 'applied'
      else 'pending'
    end,
    last_error = null,
    updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'queued', true,
    'user_id', v_row.user_id,
    'discord_user_id', v_row.discord_user_id,
    'previous_discord_user_id', v_row.previous_discord_user_id,
    'guild_id', v_row.guild_id,
    'tourney_role', v_row.tourney_role,
    'desired_role', v_row.desired_role,
    'applied_role', v_row.applied_role,
    'generation', v_row.generation,
    'status', v_row.status
  );
end;
$$;

create or replace function public.roo_finalize_oauth_intent(
  p_token_hash text,
  p_user_id uuid,
  p_provider text,
  p_guild_id text default null
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
  v_result jsonb;
begin
  select *
  into v_intent
  from accounts.oauth_intents intent
  where intent.token_hash = lower(btrim(p_token_hash))
  limit 1
  for update;

  if not found then
    raise exception 'OAuth intent was not found' using errcode = 'P0002';
  end if;
  if v_intent.provider <> v_provider then
    raise exception 'OAuth provider changed' using errcode = '22023';
  end if;
  if v_intent.status = 'completed' then
    if v_intent.claimed_user_id <> p_user_id then
      raise exception 'OAuth intent belongs to another user' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'flow', v_intent.flow,
      'action', v_intent.action,
      'provider', v_intent.provider,
      'user_id', v_intent.claimed_user_id,
      'provider_subject', v_intent.provider_subject,
      'return_path', v_intent.return_path,
      'completed', true
    );
  end if;
  if v_intent.status <> 'pending' or v_intent.expires_at <= now() then
    update accounts.oauth_intents
    set status = case when status = 'pending' then 'expired' else status end,
        updated_at = now()
    where id = v_intent.id;
    raise exception 'OAuth intent is no longer active' using errcode = '22023';
  end if;
  if v_intent.action = 'link' and v_intent.target_user_id <> p_user_id then
    raise exception 'OAuth link user changed' using errcode = '42501';
  end if;

  select identity.provider_id
  into v_provider_subject
  from auth.identities identity
  where identity.user_id = p_user_id
    and identity.provider = v_provider
  order by
    identity.last_sign_in_at desc nulls last,
    identity.created_at desc nulls last,
    identity.id desc
  limit 1;

  if v_provider_subject is null then
    raise exception 'OAuth identity was not linked' using errcode = 'P0002';
  end if;
  if (
    select count(*)
    from auth.identities identity
    where identity.user_id = p_user_id and identity.provider = v_provider
  ) <> 1 then
    raise exception 'OAuth identity is ambiguous' using errcode = '23505';
  end if;

  perform public.roo_reconcile_auth_identity_links(p_user_id);

  update accounts.oauth_intents
  set
    claimed_user_id = p_user_id,
    provider_subject = v_provider_subject,
    status = 'completed',
    completed_at = now(),
    updated_at = now()
  where id = v_intent.id;

  if v_provider = 'discord'
     and v_intent.flow = 'tourney'
     and p_guild_id ~ '^[0-9]{5,30}$' then
    v_result := public.roo_refresh_discord_role_assignment(
      p_user_id,
      p_guild_id
    );
  else
    v_result := jsonb_build_object(
      'queued', false,
      'reason', case
        when v_provider = 'discord' and v_intent.flow = 'tourney'
          then 'guild_not_configured'
        else 'not_required'
      end
    );
  end if;

  return jsonb_build_object(
    'flow', v_intent.flow,
    'action', v_intent.action,
    'provider', v_intent.provider,
    'user_id', p_user_id,
    'provider_subject', v_provider_subject,
    'return_path', v_intent.return_path,
    'completed', true,
    'discord_role', v_result
  );
end;
$$;

create or replace function public.roo_get_discord_role_assignment(
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', assignment.user_id,
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
  where assignment.user_id = p_user_id;
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
declare
  v_row accounts.discord_role_assignments%rowtype;
begin
  if p_applied_role not in ('none', 'participant', 'host')
     or p_status not in ('applied', 'retry', 'blocked') then
    raise exception 'Discord role completion is invalid' using errcode = '22023';
  end if;

  update accounts.discord_role_assignments
  set
    applied_role = case when p_status = 'applied' then p_applied_role else applied_role end,
    applied_generation = case when p_status = 'applied' then p_generation else applied_generation end,
    status = p_status,
    attempt_count = attempt_count + 1,
    last_error = nullif(left(coalesce(p_error, ''), 120), ''),
    joined_at = case when p_joined then coalesce(joined_at, now()) else joined_at end,
    applied_at = case when p_status = 'applied' then now() else applied_at end,
    previous_discord_user_id = case
      when p_status = 'applied' then null
      else previous_discord_user_id
    end,
    updated_at = now()
  where user_id = p_user_id
    and generation = p_generation
  returning * into v_row;

  if not found then
    raise exception 'Discord role generation changed' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'user_id', v_row.user_id,
    'generation', v_row.generation,
    'status', v_row.status,
    'applied_role', v_row.applied_role
  );
end;
$$;

revoke all on function public.roo_reconcile_auth_identity_links(uuid)
  from public, anon, authenticated;
revoke all on function public.roo_create_oauth_intent(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_refresh_discord_role_assignment(uuid, text)
  from public, anon, authenticated;
revoke all on function public.roo_finalize_oauth_intent(text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_get_discord_role_assignment(uuid)
  from public, anon, authenticated;
revoke all on function public.roo_complete_discord_role_assignment(uuid, bigint, text, text, text, boolean)
  from public, anon, authenticated;

grant execute on function public.roo_reconcile_auth_identity_links(uuid)
  to service_role;
grant execute on function public.roo_create_oauth_intent(jsonb)
  to service_role;
grant execute on function public.roo_refresh_discord_role_assignment(uuid, text)
  to service_role;
grant execute on function public.roo_finalize_oauth_intent(text, uuid, text, text)
  to service_role;
grant execute on function public.roo_get_discord_role_assignment(uuid)
  to service_role;
grant execute on function public.roo_complete_discord_role_assignment(uuid, bigint, text, text, text, boolean)
  to service_role;

comment on table accounts.oauth_intents is
  'Short-lived, single-use server-bound intent for Roo Industries OAuth signup, signin, and linking.';
comment on table accounts.discord_role_assignments is
  'Desired-state ledger for idempotent Roo Industries Tourney managed Discord roles.';
