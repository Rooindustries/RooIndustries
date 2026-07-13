-- Durable Tourney cutover control-plane. The tourney schema remains private;
-- only service_role can use these tables and functions.

create table if not exists tourney.command_receipts (
  command_id text primary key,
  purpose text not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  result_status integer,
  result_body jsonb,
  generation integer not null default 0 check (generation >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists tourney.mirror_outbox (
  sequence bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  command_id text,
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  generation integer not null default 0 check (generation >= 0),
  table_name text not null,
  operation text not null check (operation in ('upsert', 'delete')),
  record_key jsonb not null,
  record_data jsonb,
  occurred_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  applied_at timestamptz,
  last_error_code text,
  last_error_at timestamptz
);

create index if not exists tourney_mirror_outbox_pending_idx
  on tourney.mirror_outbox (available_at, sequence)
  where applied_at is null;

create table if not exists tourney.mirror_checkpoints (
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  table_name text not null,
  record_key_hash text not null check (record_key_hash ~ '^[0-9a-f]{64}$'),
  source_sequence bigint not null,
  event_id uuid not null,
  generation integer not null default 0,
  applied_at timestamptz not null default now(),
  primary key (target_backend, table_name, record_key_hash)
);

create table if not exists tourney.mirror_tombstones (
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  table_name text not null,
  record_key_hash text not null check (record_key_hash ~ '^[0-9a-f]{64}$'),
  record_key jsonb not null,
  source_sequence bigint not null,
  generation integer not null default 0,
  deleted_at timestamptz not null default now(),
  primary key (target_backend, table_name, record_key_hash)
);

create table if not exists tourney.parity_runs (
  id uuid primary key default gen_random_uuid(),
  source_backend text not null check (source_backend in ('legacy', 'supabase')),
  target_backend text not null check (target_backend in ('legacy', 'supabase')),
  generation integer not null default 0,
  status text not null check (status in ('clean', 'drift', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  drift jsonb not null default '{}'::jsonb,
  relationships jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tourney_parity_runs_created_idx
  on tourney.parity_runs (created_at desc);

create table if not exists tourney.cutover_metadata (
  id text primary key default 'tourney' check (id = 'tourney'),
  primary_backend text not null default 'legacy'
    check (primary_backend in ('legacy', 'supabase')),
  generation integer not null default 0 check (generation >= 0),
  writes_paused boolean not null default false,
  fallback_read_only boolean not null default false,
  clean_since timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);

insert into tourney.cutover_metadata (id)
values ('tourney')
on conflict (id) do nothing;

create table if not exists tourney.email_dispatches (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  command_id text,
  dispatch_kind text not null check (dispatch_kind in (
    'registration', 'approval', 'reset', 'discord_invite', 'appeal', 'payout'
  )),
  recipient text not null,
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'retry', 'sent', 'failed', 'historical_unknown')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tourney_email_dispatches_recovery_idx
  on tourney.email_dispatches (next_attempt_at, created_at)
  where status in ('pending', 'retry', 'sending');

create table if not exists tourney.identity_conflicts (
  id uuid primary key default gen_random_uuid(),
  legacy_player_id text,
  principal_id uuid,
  conflict_type text not null,
  details jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists tourney.shadow_observations (
  id bigint generated always as identity primary key,
  route text not null,
  shape_match boolean not null,
  value_match boolean not null,
  ordering_match boolean not null,
  error_match boolean not null,
  primary_latency_ms integer not null default 0,
  shadow_latency_ms integer not null default 0,
  observed_at timestamptz not null default now()
);

create table if not exists migration.tourney_pre_cutover_snapshots (
  id uuid primary key default gen_random_uuid(),
  key_secret_id uuid not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext bytea not null,
  table_counts jsonb not null,
  captured_at timestamptz not null default now()
);

create index if not exists tourney_shadow_observations_route_idx
  on tourney.shadow_observations (route, observed_at desc);

do $$
declare v_table regclass;
begin
  foreach v_table in array array[
    'tourney.command_receipts'::regclass,
    'tourney.mirror_outbox'::regclass,
    'tourney.mirror_checkpoints'::regclass,
    'tourney.mirror_tombstones'::regclass,
    'tourney.parity_runs'::regclass,
    'tourney.cutover_metadata'::regclass,
    'tourney.email_dispatches'::regclass,
    'tourney.identity_conflicts'::regclass,
    'tourney.shadow_observations'::regclass,
    'migration.tourney_pre_cutover_snapshots'::regclass
  ] loop
    execute format('alter table %s enable row level security', v_table);
    execute format('revoke all on table %s from public, anon, authenticated', v_table);
    execute format('grant all on table %s to service_role', v_table);
  end loop;
end;
$$;

create or replace function public.roo_capture_tourney_pre_cutover_snapshot(
  p_legacy_snapshot jsonb default null,
  p_sanity_account jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_name text;
  v_rows jsonb;
  v_payload jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_key text := encode(extensions.gen_random_bytes(32), 'hex');
  v_key_id uuid;
  v_snapshot_id uuid;
  v_hash text;
begin
  foreach v_table in array array[
    'tourney.tourney_players', 'tourney.tourney_player_tokens',
    'tourney.tourney_registration_config', 'tourney.tourney_bracket_teams',
    'tourney.tourney_bracket_team_members', 'tourney.tourney_bracket_meta',
    'tourney.tourney_bracket_entities', 'tourney.tourney_bracket_counters',
    'tourney.tourney_bracket_audit', 'tourney.tourney_bracket_lock',
    'tourney.tourney_appeals', 'tourney.tourney_payouts'
  ] loop
    v_name := split_part(v_table, '.', 2);
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(source_row)), ''[]''::jsonb) from %s source_row',
      v_table
    ) into v_rows;
    v_payload := v_payload || jsonb_build_object(v_name, v_rows);
    v_counts := v_counts || jsonb_build_object(v_name, jsonb_array_length(v_rows));
  end loop;

  select coalesce(jsonb_agg(to_jsonb(account)), '[]'::jsonb)
  into v_rows from accounts.tourney_accounts account;
  v_payload := v_payload || jsonb_build_object('accounts.tourney_accounts', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.tourney_accounts', jsonb_array_length(v_rows));

  select coalesce(jsonb_agg(to_jsonb(alias)), '[]'::jsonb)
  into v_rows
  from accounts.login_aliases alias
  where alias.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.login_aliases', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.login_aliases', jsonb_array_length(v_rows));

  select coalesce(jsonb_agg(to_jsonb(mapping)), '[]'::jsonb)
  into v_rows
  from accounts.principal_auth_users mapping
  where mapping.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.principal_auth_users', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.principal_auth_users', jsonb_array_length(v_rows));

  if p_legacy_snapshot is not null then
    v_payload := v_payload || jsonb_build_object('legacy', p_legacy_snapshot);
    v_counts := v_counts || jsonb_build_object(
      'legacy_tables', (
        select count(*) from jsonb_object_keys(p_legacy_snapshot - '_counts')
      )
    );
  end if;
  if p_sanity_account is not null then
    v_payload := v_payload || jsonb_build_object('sanity_account', p_sanity_account);
    v_counts := v_counts || jsonb_build_object('sanity_account', 1);
  end if;

  select vault.create_secret(
    v_key,
    'tourney-pre-cutover-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    'AES key for the Roo Industries Tourney pre-cutover snapshot'
  ) into v_key_id;
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'utf8'), 'sha256'), 'hex');
  insert into migration.tourney_pre_cutover_snapshots (
    key_secret_id, payload_sha256, ciphertext, table_counts
  ) values (
    v_key_id, v_hash,
    extensions.pgp_sym_encrypt(v_payload::text, v_key, 'cipher-algo=aes256,compress-algo=1'),
    v_counts
  ) returning id into v_snapshot_id;
  return jsonb_build_object(
    'snapshot_id', v_snapshot_id,
    'payload_sha256', v_hash,
    'table_counts', v_counts,
    'captured_at', now()
  );
end;
$$;

create or replace function tourney.mirror_record_key(
  p_table_name text,
  p_row jsonb
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_table_name
    when 'tourney_bracket_entities' then jsonb_build_object(
      'entity_type', p_row->>'entity_type', 'entity_id', p_row->>'entity_id'
    )
    else jsonb_build_object('id', p_row->>'id')
  end
$$;

create or replace function tourney.capture_mirror_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_enabled boolean := coalesce(nullif(current_setting('roo.tourney_mirror_enabled', true), ''), '0') in ('1', 'true', 'on');
  v_origin text := coalesce(nullif(current_setting('roo.tourney_backend', true), ''), 'supabase');
  v_generation integer := coalesce(nullif(current_setting('roo.tourney_generation', true), ''), '0')::integer;
  v_command_id text := nullif(current_setting('roo.tourney_command_id', true), '');
begin
  if not v_enabled or current_setting('roo.tourney_mirror_apply', true) = '1' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  insert into tourney.mirror_outbox (
    command_id, source_backend, generation, table_name, operation,
    record_key, record_data
  ) values (
    v_command_id, v_origin, v_generation, tg_table_name,
    case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
    tourney.mirror_record_key(tg_table_name, v_row),
    case when tg_op = 'DELETE' then null else v_row end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare v_name text;
begin
  foreach v_name in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts',
    'email_dispatches'
  ] loop
    execute format('drop trigger if exists capture_tourney_mirror_event on tourney.%I', v_name);
    execute format(
      'create trigger capture_tourney_mirror_event after insert or update or delete on tourney.%I for each row execute function tourney.capture_mirror_event()',
      v_name
    );
  end loop;
end;
$$;

create or replace function tourney.upsert_snapshot_rows(
  p_table_name text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table regclass;
  v_conflict text;
  v_updates text;
  v_count integer := 0;
begin
  if p_table_name not in (
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ) then
    raise exception 'unsupported Tourney snapshot table' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Tourney snapshot rows must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) = 0 then return 0; end if;

  v_table := format('tourney.%I', p_table_name)::regclass;
  select
    string_agg(format('%I', attribute.attname), ', ' order by key_column.ordinality),
    string_agg(format('%I = excluded.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
  into v_conflict, v_updates
  from pg_catalog.pg_index index_definition
  join lateral unnest(index_definition.indkey) with ordinality key_column(attnum, ordinality)
    on true
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = index_definition.indrelid
   and attribute.attnum = key_column.attnum
  where index_definition.indrelid = v_table and index_definition.indisprimary;

  select string_agg(format('%I = excluded.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
  into v_updates
  from pg_catalog.pg_attribute attribute
  where attribute.attrelid = v_table
    and attribute.attnum > 0
    and not attribute.attisdropped
    and attribute.attname not in (
      select primary_attribute.attname
      from pg_catalog.pg_index primary_index
      join lateral unnest(primary_index.indkey) key_attribute(attnum) on true
      join pg_catalog.pg_attribute primary_attribute
        on primary_attribute.attrelid = primary_index.indrelid
       and primary_attribute.attnum = key_attribute.attnum
      where primary_index.indrelid = v_table and primary_index.indisprimary
    );

  execute format(
    'insert into %s select * from jsonb_populate_recordset(null::%s, $1) on conflict (%s) do update set %s',
    v_table, v_table, v_conflict, v_updates
  ) using p_rows;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.roo_import_tourney_snapshot_incremental(
  p_snapshot jsonb,
  p_source_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_counts jsonb := '{}'::jsonb;
  v_count integer;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'tourney snapshot hash is invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'tourney snapshot must be an object' using errcode = '22023';
  end if;

  perform set_config('roo.tourney_mirror_apply', '1', true);
  foreach v_table in array array[
    'tourney_players', 'tourney_player_tokens', 'tourney_registration_config',
    'tourney_bracket_teams', 'tourney_bracket_team_members',
    'tourney_bracket_meta', 'tourney_bracket_entities',
    'tourney_bracket_counters', 'tourney_bracket_audit',
    'tourney_bracket_lock', 'tourney_appeals', 'tourney_payouts'
  ] loop
    v_count := tourney.upsert_snapshot_rows(v_table, coalesce(p_snapshot->v_table, '[]'::jsonb));
    v_counts := v_counts || jsonb_build_object(v_table, v_count);
  end loop;

  insert into migration.tourney_sync_runs (
    source_hash, source_counts, imported_counts, status
  ) values (
    p_source_hash, coalesce(p_snapshot->'_counts', '{}'::jsonb),
    coalesce(p_snapshot->'_counts', v_counts), 'completed'
  );
  return jsonb_build_object('source_hash', p_source_hash, 'counts', coalesce(p_snapshot->'_counts', v_counts));
end;
$$;

create or replace function public.roo_resolve_tourney_import_principal(
  p_legacy_player_id text,
  p_username text,
  p_login_email text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principals uuid[];
  v_principal uuid;
  v_conflict_id uuid;
begin
  select array_agg(distinct candidate.principal_id)
  into v_principals
  from (
    select account.principal_id
    from accounts.tourney_accounts account
    where account.legacy_sanity_id = btrim(p_legacy_player_id)
       or account.username = lower(btrim(p_username))
    union
    select account.principal_id
    from accounts.login_aliases alias
    join accounts.tourney_accounts account on account.principal_id = alias.principal_id
    where alias.alias_type in ('tourney_email', 'email')
      and alias.normalized_value = lower(btrim(p_login_email))
      and account.legacy_sanity_id = btrim(p_legacy_player_id)
  ) candidate;

  if coalesce(array_length(v_principals, 1), 0) > 1 then
    insert into tourney.identity_conflicts (
      legacy_player_id, conflict_type, details
    ) values (
      btrim(p_legacy_player_id), 'principal_collision',
      jsonb_build_object('candidate_count', array_length(v_principals, 1))
    ) returning id into v_conflict_id;
    return jsonb_build_object('conflict', true, 'conflict_id', v_conflict_id);
  end if;

  v_principal := v_principals[1];
  return jsonb_build_object(
    'conflict', false,
    'principal_id', v_principal,
    'matched', v_principal is not null
  );
end;
$$;

create or replace function public.roo_tourney_readiness()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with player_counts as (
    select status, count(*)::integer as count
    from tourney.tourney_players group by status
  ), shadow as (
    select route,
      count(*) filter (where shape_match and value_match and ordering_match and error_match)::integer as matching,
      count(*)::integer as sampled,
      percentile_cont(0.95) within group (order by primary_latency_ms)::integer as primary_p95_ms,
      percentile_cont(0.95) within group (order by shadow_latency_ms)::integer as shadow_p95_ms
    from tourney.shadow_observations
    where observed_at >= now() - interval '24 hours'
    group by route
  )
  select jsonb_build_object(
    'control', (select to_jsonb(metadata) - 'updated_by' from tourney.cutover_metadata metadata where id = 'tourney'),
    'player_counts', coalesce((select jsonb_object_agg(status, count) from player_counts), '{}'::jsonb),
    'table_counts', jsonb_build_object(
      'players', (select count(*) from tourney.tourney_players),
      'tokens', (select count(*) from tourney.tourney_player_tokens),
      'teams', (select count(*) from tourney.tourney_bracket_teams),
      'team_members', (select count(*) from tourney.tourney_bracket_team_members),
      'appeals', (select count(*) from tourney.tourney_appeals),
      'payouts', (select count(*) from tourney.tourney_payouts)
    ),
    'mirror', jsonb_build_object(
      'pending', (select count(*) from tourney.mirror_outbox where applied_at is null),
      'oldest_pending_at', (select min(occurred_at) from tourney.mirror_outbox where applied_at is null),
      'failed', (select count(*) from tourney.mirror_outbox where applied_at is null and last_error_at is not null)
    ),
    'identity_conflicts', (select count(*) from tourney.identity_conflicts where resolved_at is null),
    'email_retries', (select count(*) from tourney.email_dispatches where status in ('pending', 'retry', 'sending', 'failed')),
    'discord_retries', (select count(*) from accounts.discord_role_assignments where desired_role <> applied_role or last_error is not null),
    'last_parity', (select to_jsonb(run) from tourney.parity_runs run order by created_at desc limit 1),
    'shadow_reads', coalesce((select jsonb_object_agg(route, to_jsonb(shadow) - 'route') from shadow), '{}'::jsonb)
  )
$$;

insert into tourney.schema_metadata (schema_name, schema_version, updated_at)
values ('tourney', 3, now())
on conflict (schema_name) do update
set schema_version = greatest(tourney.schema_metadata.schema_version, excluded.schema_version),
    updated_at = now();

revoke all on function tourney.mirror_record_key(text, jsonb) from public, anon, authenticated;
revoke all on function tourney.capture_mirror_event() from public, anon, authenticated;
revoke all on function tourney.upsert_snapshot_rows(text, jsonb) from public, anon, authenticated;
revoke all on function public.roo_import_tourney_snapshot_incremental(jsonb, text) from public, anon, authenticated;
revoke all on function public.roo_resolve_tourney_import_principal(text, text, text) from public, anon, authenticated;
revoke all on function public.roo_tourney_readiness() from public, anon, authenticated;
revoke all on function public.roo_capture_tourney_pre_cutover_snapshot(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.roo_import_tourney_snapshot_incremental(jsonb, text) to service_role;
grant execute on function public.roo_resolve_tourney_import_principal(text, text, text) to service_role;
grant execute on function public.roo_tourney_readiness() to service_role;
grant execute on function public.roo_capture_tourney_pre_cutover_snapshot(jsonb, jsonb) to service_role;
