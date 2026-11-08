set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_fetch_shadow_document_sizes(
  p_document_types text[],
  p_after_id text default null,
  p_limit integer default 500,
  p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('_id', selected.legacy_sanity_id,
    'bytes', selected.bytes) order by selected.legacy_sanity_id), '[]'::jsonb)
  from (
    select legacy_sanity_id,
      octet_length(regexp_replace(payload::text, '("(?:[^"\\]|\\.)*")|[[:space:]]+', '\1', 'g')) as bytes
    from migration.source_documents
    where not tombstoned
      and (p_document_types is null or document_type = any(p_document_types))
      and (p_after_id is null or legacy_sanity_id > p_after_id)
      and (p_ids is null or legacy_sanity_id = any(p_ids))
      and not exists (select 1 from jsonb_array_elements(p_filters) filter
        where not migration.shadow_filter_matches(payload, filter))
    order by legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 500), 500))
  ) selected;
$$;

revoke all on function public.roo_fetch_shadow_document_sizes(text[], text, integer, text[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_fetch_shadow_document_sizes(text[], text, integer, text[], jsonb)
  to service_role;

create or replace function public.roo_fetch_recovery_payment_document_ids(
  p_backend text, p_statuses text[], p_refunded_status text, p_booked_status text,
  p_abandoned_status text, p_now timestamptz, p_limit integer default 50,
  p_dodo_enabled boolean default true
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(document->>'_id' order by position), '[]'::jsonb)
  from jsonb_array_elements(public.roo_fetch_recovery_payment_documents(
    p_backend, p_statuses, p_refunded_status, p_booked_status, p_abandoned_status,
    p_now, p_limit, p_dodo_enabled)) with ordinality as selected(document, position);
$$;
revoke all on function public.roo_fetch_recovery_payment_document_ids(text,text[],text,text,text,timestamptz,integer,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_fetch_recovery_payment_document_ids(text,text[],text,text,text,timestamptz,integer,boolean)
  to service_role;

create table if not exists commerce.referral_sync_cursor (
  singleton boolean primary key default true check (singleton),
  after_id text not null
);
revoke all on commerce.referral_sync_cursor from public, anon, authenticated, service_role;
create or replace function public.roo_referral_sync_cursor(p_after_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if p_after_id is not null then
    insert into commerce.referral_sync_cursor values (true, p_after_id)
    on conflict (singleton) do update set after_id = excluded.after_id;
  end if;
  return coalesce((select after_id from commerce.referral_sync_cursor), '');
end;
$$;
revoke all on function public.roo_referral_sync_cursor(text) from public, anon, authenticated, service_role;
grant execute on function public.roo_referral_sync_cursor(text) to service_role;
