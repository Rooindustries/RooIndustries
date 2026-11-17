set lock_timeout = '5s';
set statement_timeout = '120s';

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
    'migration_status', asset.migration_status,
    'sizes', document.payload #> '{metadata,sizes}'
  ) order by asset.legacy_sanity_asset_id), '[]'::jsonb)
  from cms.assets asset
  left join migration.source_documents document
    on document.legacy_sanity_id = asset.legacy_sanity_asset_id
    and not document.tombstoned
  where (
    coalesce(cardinality(p_asset_ids), 0) > 0
    and asset.legacy_sanity_asset_id = any(p_asset_ids)
  ) or (
    coalesce(cardinality(p_source_urls), 0) > 0
    and asset.source_url = any(p_source_urls)
  );
$$;

notify pgrst, 'reload schema';
