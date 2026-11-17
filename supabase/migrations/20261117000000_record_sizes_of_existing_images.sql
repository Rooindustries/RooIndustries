set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_cms_image_size_records(
  p_after text default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(image) order by image.id), '[]'::jsonb)
  from (
    select
      asset.legacy_sanity_asset_id as id,
      asset.storage_bucket,
      asset.storage_path,
      asset.byte_size,
      asset.sha256,
      asset.width,
      asset.height,
      case
        when document.legacy_sanity_id is null then 'missing'
        when document.tombstoned then 'tombstoned'
        else 'present'
      end as document,
      case
        when not document.tombstoned
          and jsonb_typeof(document.payload #> '{metadata,sizes}') = 'array'
        then document.payload #> '{metadata,sizes}'
      end as sizes
    from cms.assets asset
    left join migration.source_documents document
      on document.legacy_sanity_id = asset.legacy_sanity_asset_id
    where asset.legacy_sanity_asset_id like 'image-%'
      and asset.migration_status = 'verified'
      and asset.verified_at is not null
      and asset.legacy_sanity_asset_id > coalesce(p_after, '')
    order by asset.legacy_sanity_asset_id
    limit greatest(1, least(coalesce(p_limit, 100), 100))
  ) image;
$$;

create or replace function public.roo_record_cms_image_sizes(
  p_asset_id text,
  p_sizes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_width integer;
  v_sizes integer[];
  v_document migration.source_documents%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));

  select asset.width
  into v_width
  from cms.assets asset
  where asset.legacy_sanity_asset_id = p_asset_id
    and asset.legacy_sanity_asset_id like 'image-%'
    and asset.migration_status = 'verified'
    and asset.verified_at is not null;
  if not found then
    raise exception 'CMS_IMAGE_SIZES_ASSET_NOT_VERIFIED' using errcode = '22023';
  end if;

  if p_sizes is null
     or jsonb_typeof(p_sizes) <> 'array'
     or jsonb_array_length(p_sizes) > 5
     or exists (
       select 1 from jsonb_array_elements(p_sizes) size
       where size.value::text !~ '^[1-9][0-9]{0,3}$'
     ) then
    raise exception 'CMS_IMAGE_SIZES_INVALID' using errcode = '22023';
  end if;
  select coalesce(array_agg((size.value::text)::integer order by size.position), '{}'::integer[])
  into v_sizes
  from jsonb_array_elements(p_sizes) with ordinality as size(value, position);
  if v_sizes is distinct from array(select distinct width from unnest(v_sizes) width order by width)
     or v_sizes[cardinality(v_sizes)] > least(coalesce(v_width, 0), 1280) then
    raise exception 'CMS_IMAGE_SIZES_INVALID' using errcode = '22023';
  end if;

  select *
  into v_document
  from migration.source_documents
  where legacy_sanity_id = p_asset_id
  for update;
  if not found or v_document.tombstoned or v_document.document_type <> 'sanity.imageAsset' then
    raise exception 'CMS_IMAGE_SIZES_DOCUMENT_MISSING' using errcode = '22023';
  end if;
  if jsonb_typeof(v_document.payload -> 'metadata') is distinct from 'object' then
    raise exception 'CMS_IMAGE_SIZES_METADATA_INVALID' using errcode = '22023';
  end if;
  if jsonb_typeof(v_document.payload #> '{metadata,sizes}') = 'array' then
    return jsonb_build_object('recorded', false, 'sizes', v_document.payload #> '{metadata,sizes}');
  end if;

  perform public.roo_apply_document_mutations(jsonb_build_array(jsonb_build_object(
    'operation', 'replace',
    'id', p_asset_id,
    'expected_revision', v_document.source_revision,
    'document', jsonb_set(v_document.payload, '{metadata,sizes}', p_sizes)
  )));
  return jsonb_build_object('recorded', true, 'sizes', p_sizes);
end;
$$;

revoke all on function public.roo_cms_image_size_records(text, integer)
  from public, anon, authenticated;
grant execute on function public.roo_cms_image_size_records(text, integer)
  to service_role;

revoke all on function public.roo_record_cms_image_sizes(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.roo_record_cms_image_sizes(text, jsonb)
  to service_role;

notify pgrst, 'reload schema';
