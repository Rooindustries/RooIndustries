set lock_timeout = '5s';
set statement_timeout = '120s';

alter function public.roo_apply_commerce_document_mutations(text, jsonb, integer)
  rename to roo_apply_commerce_document_mutations_unbounded;
alter function public.roo_apply_commerce_document_mutations_unbounded(text, jsonb, integer)
  set schema migration;

create function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mutation jsonb;
  v_document jsonb;
  v_operation text;
  v_id text;
  v_type text;
  v_expected_revision text;
begin
  if btrim(coalesce(p_command_id, '')) !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid commerce command id' using errcode = '22023';
  end if;
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) < 1
     or jsonb_array_length(p_mutations) > 100 then
    raise exception 'p_mutations must contain between 1 and 100 mutations'
      using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_mutations::text) > 1048576 then
    raise exception 'commerce mutation payload exceeds 1 MiB'
      using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    if jsonb_typeof(v_mutation) <> 'object' then
      raise exception 'commerce mutations must be JSON objects'
        using errcode = '22023';
    end if;

    v_operation := v_mutation->>'operation';
    v_document := v_mutation->'document';
    v_id := coalesce(v_mutation->>'id', v_document->>'_id', '');
    v_type := nullif(btrim(coalesce(v_document->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;
    if v_id = ''
       or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in v_id) > 0 then
      raise exception 'document mutation is missing or has an invalid id'
        using errcode = '22023';
    end if;
    if v_expected_revision is not null
       and char_length(v_expected_revision) > 256 then
      raise exception 'document mutation revision is too long'
        using errcode = '22023';
    end if;

    if v_operation <> 'delete' then
      if jsonb_typeof(v_document) <> 'object'
         or pg_catalog.octet_length(v_document::text) > 262144
         or v_type is null
         or char_length(v_type) > 128
         or v_type !~ '^[A-Za-z][A-Za-z0-9_.-]*$' then
        raise exception 'document mutation has an invalid document'
          using errcode = '22023';
      end if;
      if v_document ? '_id' and v_document->>'_id' <> v_id then
        raise exception 'document mutation identity mismatch'
          using errcode = '22023';
      end if;
    end if;
  end loop;

  return migration.roo_apply_commerce_document_mutations_unbounded(
    p_command_id,
    p_mutations,
    p_cutover_generation
  );
end;
$$;

revoke all on function migration.roo_apply_commerce_document_mutations_unbounded(
  text,
  jsonb,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.roo_apply_commerce_document_mutations(
  text,
  jsonb,
  integer
) from public, anon, authenticated, service_role;
grant execute on function public.roo_apply_commerce_document_mutations(
  text,
  jsonb,
  integer
) to service_role;

notify pgrst, 'reload schema';
