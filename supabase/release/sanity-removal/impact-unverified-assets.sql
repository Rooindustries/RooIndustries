begin transaction read only;
set local statement_timeout='30s';
with recursive nodes(document_type,value) as (
 select document_type,payload from migration.source_documents where not tombstoned
 union all select nodes.document_type,child.value from nodes cross join lateral (
 select value from jsonb_each(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
 union all select value from jsonb_array_elements(case when jsonb_typeof(nodes.value)='array' then nodes.value else '[]'::jsonb end)
 ) child
),refs as(select document_type,value->>'_ref' ref from nodes where jsonb_typeof(value)='object' and value ? '_ref')
select refs.document_type,count(*) unverified_reference_count from refs left join cms.assets a on a.legacy_sanity_asset_id=refs.ref and a.migration_status='verified' and a.verified_at is not null and a.sha256 ~ '^[0-9a-f]{64}$' and ((refs.ref like 'image-%' and a.storage_bucket='site-content-public' and a.storage_path like 'images/%') or (refs.ref like 'file-%' and a.storage_bucket='optimization-builds-private' and a.storage_path like 'builds/%')) where refs.ref ~ '^(image|file)-' and a.id is null group by refs.document_type order by refs.document_type;
rollback;
