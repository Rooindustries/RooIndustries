set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_fetch_shadow_document_sizes(
  p_document_types text[],
  p_after_id text default null,
  p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    '_id', selected.legacy_sanity_id,
    'bytes', selected.bytes
  ) order by selected.legacy_sanity_id), '[]'::jsonb)
  from (
    select legacy_sanity_id,
      octet_length(convert_to(payload::text, 'UTF8')) as bytes
    from migration.source_documents
    where not tombstoned
      and document_type = any(p_document_types)
      and (p_after_id is null or legacy_sanity_id > p_after_id)
    order by legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 500), 500))
  ) selected;
$$;

revoke all on function public.roo_fetch_shadow_document_sizes(text[], text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_fetch_shadow_document_sizes(text[], text, integer)
  to service_role;
