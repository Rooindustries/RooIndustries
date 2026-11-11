set lock_timeout = '5s';
set statement_timeout = '120s';

do $edit$
declare
  v text;
  v_owner_pattern constant text :=
    $re$hold\.phase in \('active', 'payment'\)(\s+)and hold\.expires_at > now\(\)$re$;
  v_owner_replacement constant text :=
    $re$(hold.phase = 'payment' or (hold.phase = 'active'\1and hold.expires_at > now()))$re$;
  v_expiry_pattern constant text :=
    $re$hold\.phase in \('active', 'payment'\)(\s+)and hold\.expires_at <= now\(\)$re$;
  v_claim_expiry_pattern constant text :=
    $re$claim\.expires_at <= now\(\)\s+or $re$;
begin
  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_project_operational_shadow';
  if pg_catalog.regexp_count(v, v_owner_pattern) <> 1 then
    raise exception 'unexpected contract: public.roo_project_operational_shadow';
  end if;
  execute pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_replacement);

  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'migration' and p.proname = 'project_commerce_document_ids_unserialized';
  if pg_catalog.regexp_count(v, v_owner_pattern) <> 1 then
    raise exception 'unexpected contract: migration.project_commerce_document_ids_unserialized';
  end if;
  execute pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_replacement);

  select pg_get_functiondef(p.oid) into strict v
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'roo_cleanup_operational_shadow';
  if pg_catalog.regexp_count(v, v_owner_pattern) <> 1
     or pg_catalog.regexp_count(v, v_expiry_pattern) <> 1
     or pg_catalog.regexp_count(v, v_claim_expiry_pattern) <> 1 then
    raise exception 'unexpected contract: public.roo_cleanup_operational_shadow';
  end if;
  v := pg_catalog.regexp_replace(v, v_owner_pattern, v_owner_replacement);
  v := pg_catalog.regexp_replace(v, v_expiry_pattern, $re$hold.phase = 'active'\1and hold.expires_at <= now()$re$);
  v := pg_catalog.regexp_replace(v, v_claim_expiry_pattern, '');
  execute v;
end;
$edit$;
