do $migration$
declare
  definition text;
  patched text;
begin
  definition := pg_get_functiondef('public.roo_project_operational_shadow()'::regprocedure);
  patched := replace(definition, 'when ''razorpay'' then ''razorpay''',
    E'when ''razorpay'' then ''razorpay''\n      when ''dodo'' then ''dodo''');
  if patched = definition then raise exception 'Dodo migration: expected full provider mappings were not found'; end if;
  execute patched;
end;
$migration$;
