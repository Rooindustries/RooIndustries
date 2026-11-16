set lock_timeout = '5s';
set statement_timeout = '120s';

do $precondition$
begin
  if not exists (select 1 from pg_catalog.pg_collation where collname = 'und-x-icu') then
    raise exception 'lookup filter migration needs the und-x-icu collation';
  end if;
end;
$precondition$;

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
  v_actual_type text;
  v_value jsonb := coalesce(p_filter->'value', 'null'::jsonb);
  v_value_type text;
  v_order integer;
begin
  if v_path !~ '^[A-Za-z_][A-Za-z0-9_.]*$' then
    return false;
  end if;
  v_actual := coalesce(p_payload #> string_to_array(v_path, '.'), 'null'::jsonb);
  v_actual_type := jsonb_typeof(v_actual);
  v_value_type := jsonb_typeof(v_value);

  if v_operator = 'eq' then
    return v_actual_type in ('null', 'string', 'number', 'boolean')
      and v_actual_type = v_value_type
      and v_actual = v_value;
  elsif v_operator = 'ieq' then
    if v_actual_type <> 'string' then
      return v_value_type = 'null';
    end if;
    return v_value_type = 'string'
      and lower((v_actual #>> '{}') collate "und-x-icu") = (v_value #>> '{}') collate "und-x-icu";
  elsif v_operator = 'in' then
    return v_value_type = 'array'
      and v_actual_type in ('null', 'string', 'number', 'boolean')
      and exists (
        select 1 from jsonb_array_elements(v_value) item
        where jsonb_typeof(item) = v_actual_type and item = v_actual
      );
  elsif v_operator in ('lt', 'lte', 'gt', 'gte') then
    if v_actual_type = 'number' and v_value_type = 'number' then
      v_order := sign((v_actual #>> '{}')::numeric - (v_value #>> '{}')::numeric)::integer;
    elsif v_actual_type = 'string' and v_value_type = 'string' then
      v_order := case
        when (v_actual #>> '{}') collate "C" < (v_value #>> '{}') collate "C" then -1
        when (v_actual #>> '{}') collate "C" > (v_value #>> '{}') collate "C" then 1
        else 0
      end;
    elsif v_actual_type = 'boolean' and v_value_type = 'boolean' then
      v_order := (v_actual #>> '{}')::boolean::integer - (v_value #>> '{}')::boolean::integer;
    else
      return false;
    end if;
    return case v_operator
      when 'lt' then v_order < 0
      when 'lte' then v_order <= 0
      when 'gt' then v_order > 0
      else v_order >= 0
    end;
  elsif v_operator = 'defined' then
    return v_actual_type <> 'null';
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
            where migration.shadow_filter_matches(source.payload, filter) is not true
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
          where migration.shadow_filter_matches(source.payload, filter) is not true
        )
      order by source.legacy_sanity_id
      limit greatest(1, least(coalesce(p_limit, 500), 1000))
    ) selected
  );
end;
$$;
