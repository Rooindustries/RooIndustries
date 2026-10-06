begin transaction read only;
set local statement_timeout='30s';
with recursive nodes(document_type,value) as (
 select document_type,payload from migration.source_documents where not tombstoned
 union all select nodes.document_type,child.value from nodes cross join lateral (
 select value from jsonb_each(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
 union all select value from jsonb_array_elements(case when jsonb_typeof(nodes.value)='array' then nodes.value else '[]'::jsonb end)
 ) child
),refs as(select document_type,value->>'_ref' ref from nodes where jsonb_typeof(value)='object' and value ? '_ref')
select refs.document_type,count(*) dangling_reference_count from refs left join migration.source_documents target on target.legacy_sanity_id=refs.ref and not target.tombstoned where (refs.ref is null or refs.ref !~ '^(image|file)-') and target.legacy_sanity_id is null group by refs.document_type order by refs.document_type;
rollback;
