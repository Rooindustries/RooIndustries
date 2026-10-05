set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  signature text;
  definition text;
  anchor text := $anchor$if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then$anchor$;
  replacement text := $replacement$if v_operation is null or v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then$replacement$;
begin
  foreach signature in array array[
    'public.roo_apply_document_mutations(jsonb)',
    'public.roo_apply_commerce_document_mutations(text,jsonb,integer)',
    'migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)'
  ] loop
    if to_regprocedure(signature) is null then
      raise exception 'document operation migration requires the current mutation contract: %', signature;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure(signature) and prosecdef
        and proconfig @> array['search_path=""']::text[]
    ) then
      raise exception 'document operation migration requires the security-definer contract: %', signature;
    end if;
    definition := pg_get_functiondef(to_regprocedure(signature));
    if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
      raise exception 'document operation migration: unexpected mutation contract anchor: %', signature;
    end if;
  end loop;

  foreach signature in array array[
    'public.roo_apply_document_mutations(jsonb)',
    'public.roo_apply_commerce_document_mutations(text,jsonb,integer)',
    'migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)'
  ] loop
    definition := pg_get_functiondef(to_regprocedure(signature));
    execute replace(definition, anchor, replacement);
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
