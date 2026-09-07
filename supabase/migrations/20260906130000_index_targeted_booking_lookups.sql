set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists source_documents_booking_paypal_order_idx
  on migration.source_documents ((payload->'paypalOrderId'), legacy_sanity_id)
  where document_type = 'booking' and not tombstoned;

create or replace function public.roo_fetch_shadow_documents_targeted(
  p_document_types text[] default null,
  p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb,
  p_limit integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Expose the existing primary-key restriction to the cached query plan.
  if p_ids is not null then
    return (
      select coalesce(jsonb_agg(selected.payload order by selected.legacy_sanity_id), '[]'::jsonb)
      from (
        select source.legacy_sanity_id, source.payload
        from migration.source_documents source
        where source.legacy_sanity_id = any(p_ids)
          and not source.tombstoned
          and (p_document_types is null or source.document_type = any(p_document_types))
          and jsonb_typeof(coalesce(p_filters, '[]'::jsonb)) = 'array'
          and not exists (
            select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) filter
            where not migration.shadow_filter_matches(source.payload, filter)
          )
        order by source.legacy_sanity_id
        limit greatest(1, least(coalesce(p_limit, 500), 1000))
      ) selected
    );
  end if;

  if p_document_types = array['booking']::text[]
    and jsonb_typeof(p_filters) = 'array'
    and jsonb_array_length(p_filters) = 1
    and p_filters #>> '{0,path}' = 'paypalOrderId'
    and p_filters #>> '{0,op}' = 'eq'
    and jsonb_typeof(p_filters #> '{0,value}') = 'string' then
    -- Missing/null order IDs cannot satisfy GROQ string equality. Do not let
    -- them consume the result limit before the client evaluates its selector.
    return (
      select coalesce(jsonb_agg(selected.payload order by selected.legacy_sanity_id), '[]'::jsonb)
      from (
        select source.legacy_sanity_id, source.payload
        from migration.source_documents source
        where source.document_type = 'booking'
          and not source.tombstoned
          and source.payload->'paypalOrderId' = p_filters #> '{0,value}'
        order by source.legacy_sanity_id
        limit greatest(1, least(coalesce(p_limit, 500), 1000))
      ) selected
    );
  end if;

  -- Other selector shapes retain the existing conservative candidate filter.
  return (
    select coalesce(jsonb_agg(selected.payload order by selected.legacy_sanity_id), '[]'::jsonb)
    from (
      select source.legacy_sanity_id, source.payload
      from migration.source_documents source
      where not source.tombstoned
        and (p_document_types is null or source.document_type = any(p_document_types))
        and jsonb_typeof(coalesce(p_filters, '[]'::jsonb)) = 'array'
        and not exists (
          select 1 from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) filter
          where not migration.shadow_filter_matches(source.payload, filter)
        )
      order by source.legacy_sanity_id
      limit greatest(1, least(coalesce(p_limit, 500), 1000))
    ) selected
  );
end;
$$;
