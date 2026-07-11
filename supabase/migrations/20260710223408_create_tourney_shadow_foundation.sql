create schema if not exists tourney;
revoke all on schema tourney from public, anon, authenticated;
grant usage on schema tourney to service_role;

create table tourney.tourney_players (
  id text primary key,
  username text not null unique,
  email text not null unique,
  password_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'withdrawn', 'removed')),
  discord text not null,
  display_name text,
  discord_key text not null unique,
  battlenet text not null,
  rank_name text not null,
  role_play text not null,
  secondary_role_play text not null default '',
  approved_role_play text not null default '',
  registration_pool text not null default 'main'
    check (registration_pool in ('main', 'substitute')),
  time_zone text not null default '',
  twitch_username text,
  team_name text,
  available_aug_1_2 boolean not null default false,
  accepted_rules boolean not null default false,
  accepted_roo_visibility boolean not null default false,
  notes text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by text,
  denied_at timestamptz,
  denied_by text,
  removed_at timestamptz,
  removed_by text,
  withdrawn_at timestamptz,
  withdrawn_by text,
  discord_invite_sent_at timestamptz,
  discord_invite_email_id text,
  discord_invite_last_error text,
  discord_user_id text,
  discord_oauth_username text,
  discord_oauth_global_name text,
  discord_linked_at timestamptz,
  discord_role_assigned_at timestamptz,
  discord_role_last_error text
);

create unique index tourney_players_discord_user_id_unique
  on tourney.tourney_players (discord_user_id)
  where discord_user_id is not null;

create table tourney.tourney_player_tokens (
  id text primary key,
  player_id text not null references tourney.tourney_players(id) on delete cascade,
  token_hash text not null unique,
  purpose text not null check (purpose in ('approve', 'deny', 'reset')),
  recipient_username text,
  recipient_email text,
  recipient_role text,
  recipient_version text,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text,
  created_at timestamptz not null default now()
);

create table tourney.tourney_registration_config (
  id text primary key,
  team_count integer not null default 8,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table tourney.tourney_bracket_teams (
  id text primary key,
  name text not null unique,
  seed_order integer,
  status text not null default 'active'
    check (status in ('active', 'disqualified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table tourney.tourney_bracket_team_members (
  id text primary key,
  team_id text not null references tourney.tourney_bracket_teams(id) on delete cascade,
  player_id text,
  display_name text not null,
  role_play text,
  created_at timestamptz not null default now()
);

create table tourney.tourney_bracket_meta (
  id text primary key,
  stage_id integer,
  status text not null default 'draft',
  published boolean not null default false,
  generated_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table tourney.tourney_bracket_entities (
  entity_type text not null,
  entity_id integer not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (entity_type, entity_id)
);

create table tourney.tourney_bracket_counters (
  entity_type text primary key,
  next_id integer not null default 0
);

create table tourney.tourney_bracket_audit (
  id text primary key,
  action text not null,
  actor_username text not null,
  match_id integer,
  team_id text,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table tourney.tourney_bracket_lock (
  id text primary key,
  locked_until timestamptz not null,
  locked_by text
);

create table tourney.tourney_appeals (
  id text primary key,
  type text not null,
  status text not null default 'open',
  team_name text,
  captain_name text,
  submitter_player_id text,
  submitter_username text not null,
  subject_player_id text,
  subject_name text,
  title text not null,
  details text not null,
  evidence_url text,
  ruling text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table tourney.tourney_payouts (
  id text primary key,
  player_id text not null,
  display_name text not null,
  team_name text,
  payout_type text not null,
  amount_usd numeric(10,2) not null default 0,
  status text not null default 'pending',
  payout_email text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

create table migration.tourney_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_counts jsonb not null,
  imported_counts jsonb not null,
  status text not null check (status in ('completed', 'failed')),
  created_at timestamptz not null default now()
);

do $$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'tourney.tourney_players'::regclass,
    'tourney.tourney_player_tokens'::regclass,
    'tourney.tourney_registration_config'::regclass,
    'tourney.tourney_bracket_teams'::regclass,
    'tourney.tourney_bracket_team_members'::regclass,
    'tourney.tourney_bracket_meta'::regclass,
    'tourney.tourney_bracket_entities'::regclass,
    'tourney.tourney_bracket_counters'::regclass,
    'tourney.tourney_bracket_audit'::regclass,
    'tourney.tourney_bracket_lock'::regclass,
    'tourney.tourney_appeals'::regclass,
    'tourney.tourney_payouts'::regclass,
    'migration.tourney_sync_runs'::regclass
  ]
  loop
    execute format('alter table %s enable row level security', v_table);
    execute format('revoke all on table %s from public, anon, authenticated', v_table);
    execute format('grant all on table %s to service_role', v_table);
    execute format(
      'create policy deny_browser_access on %s for all to anon, authenticated using (false) with check (false)',
      v_table
    );
  end loop;
end;
$$;

grant all on all tables in schema tourney to service_role;
grant usage, select on all sequences in schema tourney to service_role;

alter table accounts.login_aliases
  drop constraint login_aliases_alias_type_check;
alter table accounts.login_aliases
  add constraint login_aliases_alias_type_check
  check (alias_type in ('email', 'referral_code', 'tourney_username', 'tourney_email'));

create or replace function public.roo_import_tourney_snapshot(
  p_snapshot jsonb,
  p_source_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'tourney snapshot hash is invalid'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'tourney snapshot must be an object'
      using errcode = '22023';
  end if;

  delete from tourney.tourney_bracket_team_members;
  delete from tourney.tourney_bracket_teams;
  delete from tourney.tourney_player_tokens;
  delete from tourney.tourney_players;
  delete from tourney.tourney_registration_config;
  delete from tourney.tourney_bracket_meta;
  delete from tourney.tourney_bracket_entities;
  delete from tourney.tourney_bracket_counters;
  delete from tourney.tourney_bracket_audit;
  delete from tourney.tourney_bracket_lock;
  delete from tourney.tourney_appeals;
  delete from tourney.tourney_payouts;

  insert into tourney.tourney_players
    select * from jsonb_populate_recordset(
      null::tourney.tourney_players,
      coalesce(p_snapshot->'tourney_players', '[]'::jsonb)
    );
  insert into tourney.tourney_player_tokens
    select * from jsonb_populate_recordset(
      null::tourney.tourney_player_tokens,
      coalesce(p_snapshot->'tourney_player_tokens', '[]'::jsonb)
    );
  insert into tourney.tourney_registration_config
    select * from jsonb_populate_recordset(
      null::tourney.tourney_registration_config,
      coalesce(p_snapshot->'tourney_registration_config', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_teams
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_teams,
      coalesce(p_snapshot->'tourney_bracket_teams', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_team_members
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_team_members,
      coalesce(p_snapshot->'tourney_bracket_team_members', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_meta
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_meta,
      coalesce(p_snapshot->'tourney_bracket_meta', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_entities
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_entities,
      coalesce(p_snapshot->'tourney_bracket_entities', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_counters
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_counters,
      coalesce(p_snapshot->'tourney_bracket_counters', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_audit
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_audit,
      coalesce(p_snapshot->'tourney_bracket_audit', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_lock
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_lock,
      coalesce(p_snapshot->'tourney_bracket_lock', '[]'::jsonb)
    );
  insert into tourney.tourney_appeals
    select * from jsonb_populate_recordset(
      null::tourney.tourney_appeals,
      coalesce(p_snapshot->'tourney_appeals', '[]'::jsonb)
    );
  insert into tourney.tourney_payouts
    select * from jsonb_populate_recordset(
      null::tourney.tourney_payouts,
      coalesce(p_snapshot->'tourney_payouts', '[]'::jsonb)
    );

  select jsonb_object_agg(table_name, count_value order by table_name)
  into v_counts
  from (
    values
      ('tourney_players', (select count(*) from tourney.tourney_players)),
      ('tourney_player_tokens', (select count(*) from tourney.tourney_player_tokens)),
      ('tourney_registration_config', (select count(*) from tourney.tourney_registration_config)),
      ('tourney_bracket_teams', (select count(*) from tourney.tourney_bracket_teams)),
      ('tourney_bracket_team_members', (select count(*) from tourney.tourney_bracket_team_members)),
      ('tourney_bracket_meta', (select count(*) from tourney.tourney_bracket_meta)),
      ('tourney_bracket_entities', (select count(*) from tourney.tourney_bracket_entities)),
      ('tourney_bracket_counters', (select count(*) from tourney.tourney_bracket_counters)),
      ('tourney_bracket_audit', (select count(*) from tourney.tourney_bracket_audit)),
      ('tourney_bracket_lock', (select count(*) from tourney.tourney_bracket_lock)),
      ('tourney_appeals', (select count(*) from tourney.tourney_appeals)),
      ('tourney_payouts', (select count(*) from tourney.tourney_payouts))
  ) counts(table_name, count_value);

  insert into migration.tourney_sync_runs (
    source_hash,
    source_counts,
    imported_counts,
    status
  )
  values (
    p_source_hash,
    coalesce(p_snapshot->'_counts', '{}'::jsonb),
    v_counts,
    'completed'
  );

  return jsonb_build_object(
    'source_hash', p_source_hash,
    'counts', v_counts
  );
end;
$$;

create or replace function public.roo_import_tourney_player_account(
  p_account jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_auth_email text := lower(btrim(p_account->>'auth_email'));
  v_login_email text := lower(btrim(p_account->>'login_email'));
  v_username text := lower(btrim(p_account->>'username'));
  v_player_id text := btrim(p_account->>'player_id');
  v_version text := coalesce(nullif(p_account->>'credential_version', ''), '1');
  v_source_hash text := lower(btrim(p_account->>'source_hash'));
begin
  if v_user_id is null
     or v_auth_email = ''
     or v_login_email = ''
     or v_username = ''
     or v_player_id = ''
     or v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'tourney player account is invalid'
      using errcode = '22023';
  end if;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_auth_email,
    coalesce(nullif(p_account->>'display_name', ''), v_username),
    case when coalesce(p_account->>'status', 'pending') in ('approved', 'pending')
      then 'active' else 'disabled' end,
    v_player_id,
    v_source_hash,
    'sanity',
    now()
  )
  on conflict (user_id) do update
  set
    display_name = excluded.display_name,
    status = excluded.status,
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_hash = excluded.source_hash,
    updated_at = now();

  insert into accounts.account_roles (
    user_id, role, source_backend, legacy_sanity_id, source_hash, backend_owner
  )
  values (v_user_id, 'tourney_player', 'sanity', v_player_id, v_source_hash, 'sanity')
  on conflict (user_id, role) do update
  set source_hash = excluded.source_hash, backend_owner = 'sanity';

  insert into accounts.login_aliases (
    user_id,
    alias_type,
    normalized_value,
    verified,
    legacy_sanity_id,
    source_hash,
    backend_owner,
    updated_at
  )
  values
    (v_user_id, 'tourney_username', v_username, true, v_player_id, v_source_hash, 'sanity', now()),
    (v_user_id, 'tourney_email', v_login_email, true, v_player_id, v_source_hash, 'sanity', now())
  on conflict (alias_type, normalized_value) do update
  set
    verified = true,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity',
    updated_at = now()
  where accounts.login_aliases.user_id = excluded.user_id;

  insert into accounts.credential_migrations (
    user_id,
    legacy_sanity_id,
    legacy_source,
    credential_kind,
    status,
    source_hash,
    backend_owner,
    imported_at,
    updated_at
  )
  values (
    v_user_id,
    v_player_id,
    'tourney',
    'bcrypt',
    'imported',
    v_source_hash,
    'sanity',
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    credential_kind = 'bcrypt',
    status = 'imported',
    source_hash = excluded.source_hash,
    backend_owner = 'sanity',
    imported_at = coalesce(accounts.credential_migrations.imported_at, now()),
    updated_at = now();

  insert into accounts.tourney_accounts (
    user_id,
    username,
    role,
    active,
    credential_version,
    legacy_sanity_id,
    source_hash,
    legacy_payload,
    backend_owner,
    updated_at
  )
  values (
    v_user_id,
    v_username,
    'tourney_player',
    coalesce(p_account->>'status', 'pending') = 'approved',
    v_version,
    v_player_id,
    v_source_hash,
    coalesce(p_account->'legacy_payload', '{}'::jsonb),
    'sanity',
    now()
  )
  on conflict (user_id) do update
  set
    username = excluded.username,
    active = excluded.active,
    credential_version = excluded.credential_version,
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_hash = excluded.source_hash,
    legacy_payload = excluded.legacy_payload,
    backend_owner = 'sanity',
    updated_at = now();

  return jsonb_build_object('user_id', v_user_id, 'imported', true);
end;
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

revoke all on function public.roo_import_tourney_snapshot(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.roo_import_tourney_player_account(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_resolve_tourney_account_alias(text)
  from public, anon, authenticated;
grant execute on function public.roo_import_tourney_snapshot(jsonb, text)
  to service_role;
grant execute on function public.roo_import_tourney_player_account(jsonb)
  to service_role;
grant execute on function public.roo_resolve_tourney_account_alias(text)
  to service_role;
