set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function migration.shadow_filter_matches(
  p_payload jsonb,
  p_filter jsonb
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_path text := btrim(coalesce(p_filter->>'path', ''));
  v_operator text := lower(btrim(coalesce(p_filter->>'op', 'eq')));
  v_actual jsonb;
  v_actual_text text;
  v_value jsonb := p_filter->'value';
begin
  if v_path !~ '^[A-Za-z_][A-Za-z0-9_.]*$' then
    return false;
  end if;
  v_actual := p_payload #> string_to_array(v_path, '.');
  v_actual_text := v_actual #>> '{}';

  if v_operator = 'eq' then
    return v_actual = v_value;
  elsif v_operator = 'ieq' then
    return lower(coalesce(v_actual_text, '')) = lower(coalesce(v_value #>> '{}', ''));
  elsif v_operator = 'in' then
    return jsonb_typeof(v_value) = 'array'
      and exists (
        select 1 from jsonb_array_elements(v_value) item
        where item = v_actual
           or lower(coalesce(item #>> '{}', '')) = lower(coalesce(v_actual_text, ''))
      );
  elsif v_operator = 'lt' then
    return migration.try_timestamptz(v_actual_text)
      < migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'lte' then
    return migration.try_timestamptz(v_actual_text)
      <= migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'gt' then
    return migration.try_timestamptz(v_actual_text)
      > migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'gte' then
    return migration.try_timestamptz(v_actual_text)
      >= migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'defined' then
    return v_actual is not null and v_actual <> 'null'::jsonb;
  end if;
  return false;
end;
$$;

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
