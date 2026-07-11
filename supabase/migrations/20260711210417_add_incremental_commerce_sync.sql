alter table migration.sync_cursors
  add column if not exists lease_id text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_error_code text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'migration.sync_cursors'::regclass
      and conname = 'sync_cursors_lease_pair_check'
  ) then
    alter table migration.sync_cursors
      add constraint sync_cursors_lease_pair_check check (
        (lease_id is null and lease_expires_at is null)
        or (lease_id is not null and lease_expires_at is not null)
      );
  end if;
end;
$$;

create or replace function public.roo_import_and_project_commerce_shadow_batch(
  p_documents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
declare
  v_import jsonb;
  v_projection jsonb;
begin
  v_import := public.roo_import_commerce_shadow_batch(p_documents);
  v_projection := public.roo_refresh_operational_shadow();
  return jsonb_build_object(
    'import', v_import,
    'projection', v_projection
  );
end;
$$;

create or replace function public.roo_reconcile_and_project_commerce_shadow_sources_since(
  p_source_ids text[],
  p_document_types text[],
  p_snapshot_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
declare
  v_reconciliation jsonb;
  v_projection jsonb;
begin
  v_reconciliation := public.roo_reconcile_commerce_shadow_sources_since(
    p_source_ids,
    p_document_types,
    p_snapshot_started_at
  );
  v_projection := public.roo_refresh_operational_shadow();
  return jsonb_build_object(
    'reconciliation', v_reconciliation,
    'projection', v_projection
  );
end;
$$;

create or replace function public.roo_tombstone_and_project_commerce_shadow_ids(
  p_ids text[],
  p_deleted_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '20s'
as $$
declare
  v_tombstones jsonb;
  v_projection jsonb;
begin
  if p_ids is null
    or cardinality(p_ids) > 500
    or exists (
      select 1 from unnest(p_ids) id
      where nullif(btrim(coalesce(id, '')), '') is null
    )
    or exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = any(p_ids)
        and not (
          source.document_type = any(
            migration.commerce_reconcilable_document_types()
          )
        )
    ) then
    raise exception 'commerce tombstones contain an invalid source id or type'
      using errcode = '22023';
  end if;

  v_tombstones := public.roo_tombstone_shadow_ids(
    p_ids,
    coalesce(p_deleted_at, now())
  );
  v_projection := public.roo_refresh_operational_shadow();
  return jsonb_build_object(
    'tombstones', v_tombstones,
    'projection', v_projection
  );
end;
$$;

create or replace function public.roo_commerce_canonical_manifest_for_ids(
  p_ids text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_ids is null
    or cardinality(p_ids) > 500
    or exists (
      select 1 from unnest(p_ids) id
      where nullif(btrim(coalesce(id, '')), '') is null
    ) then
    raise exception 'a valid list of at most 500 source ids is required'
      using errcode = '22023';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', source.legacy_sanity_id,
      'type', source.document_type,
      'hash', migration.canonical_business_hash(source.payload),
      'tombstoned', source.tombstoned
    ) order by source.legacy_sanity_id), '[]'::jsonb)
    from migration.source_documents source
    where source.legacy_sanity_id = any(p_ids)
      and source.document_type = any(migration.commerce_shadow_document_types())
  );
end;
$$;

create or replace function public.roo_claim_commerce_sync_cursor(
  p_stream_name text,
  p_lease_id text,
  p_lease_seconds integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stream_name text := btrim(coalesce(p_stream_name, ''));
  v_lease_id text := btrim(coalesce(p_lease_id, ''));
  v_result jsonb;
begin
  if v_stream_name !~ '^[a-z0-9._:-]{8,100}$'
    or v_lease_id !~ '^[A-Za-z0-9._:-]{8,160}$'
    or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid commerce sync lease'
      using errcode = '22023';
  end if;

  insert into migration.sync_cursors (stream_name)
  values (v_stream_name)
  on conflict (stream_name) do nothing;

  update migration.sync_cursors cursor
  set
    lease_id = v_lease_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    last_error_code = null,
    updated_at = now()
  where cursor.stream_name = v_stream_name
    and (
      cursor.lease_id is null
      or cursor.lease_expires_at <= now()
      or cursor.lease_id = v_lease_id
    )
  returning jsonb_build_object(
    'claimed', true,
    'cursor_value', cursor.cursor_value,
    'source_updated_at', cursor.source_updated_at,
    'lease_expires_at', cursor.lease_expires_at
  ) into v_result;

  return coalesce(v_result, jsonb_build_object('claimed', false));
end;
$$;

create or replace function public.roo_complete_incremental_commerce_sync(
  p_stream_name text,
  p_lease_id text,
  p_run_id uuid,
  p_cursor_value text,
  p_source_updated_at timestamptz,
  p_counters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stream_name text := btrim(coalesce(p_stream_name, ''));
  v_lease_id text := btrim(coalesce(p_lease_id, ''));
begin
  update migration.sync_runs
  set
    status = 'completed',
    completed_at = now(),
    counters = coalesce(p_counters, '{}'::jsonb),
    error_summary = null
  where id = p_run_id
    and status = 'running';
  if not found then
    raise exception 'active sync run not found'
      using errcode = 'P0002';
  end if;

  update migration.sync_cursors cursor
  set
    cursor_value = p_cursor_value,
    source_updated_at = p_source_updated_at,
    last_successful_run_id = p_run_id,
    lease_id = null,
    lease_expires_at = null,
    last_error_code = null,
    updated_at = now()
  where cursor.stream_name = v_stream_name
    and cursor.lease_id = v_lease_id;
  if not found then
    raise exception 'commerce sync lease conflict'
      using errcode = '40001';
  end if;

  return jsonb_build_object(
    'completed', true,
    'run_id', p_run_id,
    'cursor_value', p_cursor_value
  );
end;
$$;

create or replace function public.roo_release_commerce_sync_cursor(
  p_stream_name text,
  p_lease_id text,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  update migration.sync_cursors cursor
  set
    lease_id = null,
    lease_expires_at = null,
    last_error_code = left(
      coalesce(nullif(btrim(p_error_code), ''), 'COMMERCE_SYNC_FAILED'),
      128
    ),
    updated_at = now()
  where cursor.stream_name = btrim(coalesce(p_stream_name, ''))
    and cursor.lease_id = btrim(coalesce(p_lease_id, ''));
  get diagnostics v_released = row_count;
  return v_released = 1;
end;
$$;

revoke all on function public.roo_import_and_project_commerce_shadow_batch(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_reconcile_and_project_commerce_shadow_sources_since(text[], text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_tombstone_and_project_commerce_shadow_ids(text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_canonical_manifest_for_ids(text[])
  from public, anon, authenticated;
revoke all on function public.roo_claim_commerce_sync_cursor(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.roo_complete_incremental_commerce_sync(text, text, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_release_commerce_sync_cursor(text, text, text)
  from public, anon, authenticated;

grant execute on function public.roo_import_and_project_commerce_shadow_batch(jsonb)
  to service_role;
grant execute on function public.roo_reconcile_and_project_commerce_shadow_sources_since(text[], text[], timestamptz)
  to service_role;
grant execute on function public.roo_tombstone_and_project_commerce_shadow_ids(text[], timestamptz)
  to service_role;
grant execute on function public.roo_commerce_canonical_manifest_for_ids(text[])
  to service_role;
grant execute on function public.roo_claim_commerce_sync_cursor(text, text, integer)
  to service_role;
grant execute on function public.roo_complete_incremental_commerce_sync(text, text, uuid, text, timestamptz, jsonb)
  to service_role;
grant execute on function public.roo_release_commerce_sync_cursor(text, text, text)
  to service_role;
