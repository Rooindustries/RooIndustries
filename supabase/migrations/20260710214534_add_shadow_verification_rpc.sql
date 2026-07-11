
create or replace function public.roo_shadow_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', legacy_sanity_id,
        'type', document_type,
        'revision', coalesce(source_revision, ''),
        'hash', source_hash
      )
      order by legacy_sanity_id
    ),
    '[]'::jsonb
  )
  from migration.source_documents
  where not tombstoned;
$$;

create or replace function public.roo_asset_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'legacy_sanity_asset_id', legacy_sanity_asset_id,
        'storage_bucket', storage_bucket,
        'storage_path', storage_path,
        'mime_type', mime_type,
        'byte_size', byte_size,
        'sha256', sha256,
        'migration_status', migration_status
      )
      order by legacy_sanity_asset_id
    ),
    '[]'::jsonb
  )
  from cms.assets;
$$;

create or replace function public.roo_account_shadow_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'auth_users', (select count(*) from auth.users),
    'profiles', (select count(*) from public.profiles),
    'roles', (select count(*) from accounts.account_roles),
    'login_aliases', (select count(*) from accounts.login_aliases),
    'identity_links', (select count(*) from accounts.identity_links),
    'credential_migrations', (
      select count(*) from accounts.credential_migrations
    ),
    'creator_profiles', (select count(*) from accounts.creator_profiles),
    'tourney_accounts', (select count(*) from accounts.tourney_accounts),
    'pending_credentials', (
      select count(*)
      from accounts.credential_migrations
      where status = 'pending'
    )
  );
$$;

create or replace function public.roo_record_drift_findings(
  p_run_id uuid,
  p_findings jsonb
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finding jsonb;
  v_count integer := 0;
begin
  if jsonb_typeof(p_findings) <> 'array' then
    raise exception 'p_findings must be a JSON array'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from migration.sync_runs where id = p_run_id
  ) then
    raise exception 'sync run not found'
      using errcode = 'P0002';
  end if;

  for v_finding in select value from jsonb_array_elements(p_findings)
  loop
    insert into migration.drift_findings (
      sync_run_id,
      category,
      severity,
      legacy_sanity_id,
      document_type,
      field_path,
      source_value_hash,
      target_value_hash,
      details,
      status
    ) values (
      p_run_id,
      v_finding->>'category',
      coalesce(nullif(v_finding->>'severity', ''), 'error'),
      nullif(v_finding->>'legacy_sanity_id', ''),
      nullif(v_finding->>'document_type', ''),
      nullif(v_finding->>'field_path', ''),
      nullif(v_finding->>'source_value_hash', ''),
      nullif(v_finding->>'target_value_hash', ''),
      coalesce(v_finding->'details', '{}'::jsonb),
      'open'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.roo_shadow_manifest()
  from public, anon, authenticated;
revoke all on function public.roo_asset_manifest()
  from public, anon, authenticated;
revoke all on function public.roo_account_shadow_summary()
  from public, anon, authenticated;
revoke all on function public.roo_record_drift_findings(uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.roo_shadow_manifest()
  to service_role;
grant execute on function public.roo_asset_manifest()
  to service_role;
grant execute on function public.roo_account_shadow_summary()
  to service_role;
grant execute on function public.roo_record_drift_findings(uuid, jsonb)
  to service_role;
