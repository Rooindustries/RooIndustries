set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  definition text;
  anchor text := $anchor$    where not source.tombstoned
$anchor$;
  exclusion text := $exclusion$      and coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb
$exclusion$;
begin
  definition := pg_get_functiondef('public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'::regprocedure);
  if strpos(definition, exclusion) > 0 then
    return;
  end if;
  if array_length(string_to_array(definition, anchor), 1) is distinct from 2 then
    raise exception 'review-only recovery migration: unexpected recovery candidate filter';
  end if;
  execute replace(definition, anchor, anchor || exclusion);
end;
$migration$;
