set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_read_public_content_revision()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)
  from migration.cms_publish_commands
  where status = 'committed';
$$;

create or replace function public.roo_fetch_public_content_documents(
  p_document_types text[] default null,
  p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb,
  p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'revision', public.roo_read_public_content_revision(),
    'documents', public.roo_fetch_shadow_documents_targeted(p_document_types, p_ids, p_filters, p_limit)
  );
$$;

revoke all on function public.roo_read_public_content_revision() from public, anon, authenticated;
grant execute on function public.roo_read_public_content_revision() to service_role;
revoke all on function public.roo_fetch_public_content_documents(text[], text[], jsonb, integer) from public, anon, authenticated;
grant execute on function public.roo_fetch_public_content_documents(text[], text[], jsonb, integer) to service_role;
