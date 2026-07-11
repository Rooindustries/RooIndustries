
update storage.buckets
set allowed_mime_types = array[
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
  'application/vnd.microsoft.portable-executable',
  'application/x-msdownload'
]::text[]
where id = 'optimization-builds-private';

create or replace function public.roo_upsert_asset(p_asset jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := btrim(p_asset->>'legacy_sanity_asset_id');
  v_source_url text := btrim(p_asset->>'source_url');
  v_storage_bucket text := lower(btrim(p_asset->>'storage_bucket'));
  v_storage_path text := btrim(p_asset->>'storage_path');
  v_mime_type text := lower(btrim(p_asset->>'mime_type'));
  v_sha256 text := lower(btrim(p_asset->>'sha256'));
  v_asset_id uuid;
begin
  if v_id = '' or v_source_url = '' or v_storage_path = '' then
    raise exception 'asset import is missing identity or path'
      using errcode = '22023';
  end if;
  if v_storage_bucket not in (
    'site-content-public',
    'optimization-builds-private'
  ) then
    raise exception 'asset storage bucket is invalid'
      using errcode = '22023';
  end if;
  if v_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'asset checksum is invalid'
      using errcode = '22023';
  end if;
  if coalesce((p_asset->>'byte_size')::bigint, -1) < 0 then
    raise exception 'asset size is invalid'
      using errcode = '22023';
  end if;

  insert into cms.assets (
    legacy_sanity_asset_id,
    source_url,
    storage_bucket,
    storage_path,
    mime_type,
    byte_size,
    sha256,
    width,
    height,
    hotspot,
    crop,
    metadata,
    migration_status,
    copied_at,
    verified_at,
    updated_at
  )
  values (
    v_id,
    v_source_url,
    v_storage_bucket,
    v_storage_path,
    v_mime_type,
    (p_asset->>'byte_size')::bigint,
    v_sha256,
    nullif(p_asset->>'width', '')::integer,
    nullif(p_asset->>'height', '')::integer,
    p_asset->'hotspot',
    p_asset->'crop',
    coalesce(p_asset->'metadata', '{}'::jsonb),
    'verified',
    now(),
    now(),
    now()
  )
  on conflict (legacy_sanity_asset_id) do update
  set
    source_url = excluded.source_url,
    storage_bucket = excluded.storage_bucket,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    byte_size = excluded.byte_size,
    sha256 = excluded.sha256,
    width = excluded.width,
    height = excluded.height,
    hotspot = excluded.hotspot,
    crop = excluded.crop,
    metadata = excluded.metadata,
    migration_status = 'verified',
    copied_at = coalesce(cms.assets.copied_at, now()),
    verified_at = now(),
    updated_at = now()
  returning id into v_asset_id;

  return jsonb_build_object(
    'asset_id', v_asset_id,
    'legacy_sanity_asset_id', v_id,
    'storage_bucket', v_storage_bucket,
    'verified', true
  );
end;
$$;

revoke all on function public.roo_upsert_asset(jsonb)
  from public, anon, authenticated;
grant execute on function public.roo_upsert_asset(jsonb)
  to service_role;
