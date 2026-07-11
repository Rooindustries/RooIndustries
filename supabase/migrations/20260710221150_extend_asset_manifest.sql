
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
        'source_url', source_url,
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

revoke all on function public.roo_asset_manifest()
  from public, anon, authenticated;
grant execute on function public.roo_asset_manifest()
  to service_role;
