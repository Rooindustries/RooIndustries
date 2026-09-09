do $migration$
declare
  table_name text;
  definition text;
  patched text;
begin
  foreach table_name in array array['payment_records','payment_start_claims','payment_proof_claims','payment_upgrade_locks','webhook_receipts','refunds'] loop
    execute format('alter table commerce.%I drop constraint %I', table_name, table_name || '_provider_check');
    if table_name in ('webhook_receipts','refunds') then
      execute format('alter table commerce.%I add constraint %I check (provider in (%L,%L,%L))',
        table_name, table_name || '_provider_check', 'paypal','razorpay','dodo');
    else
      execute format('alter table commerce.%I add constraint %I check (provider in (%L,%L,%L,%L))',
        table_name, table_name || '_provider_check', 'paypal','razorpay','free','dodo');
    end if;
  end loop;
  definition := pg_get_functiondef('migration.project_commerce_document_ids_unserialized(text[])'::regprocedure);
  patched := replace(definition, 'when ''razorpay'' then ''razorpay''',
    E'when ''razorpay'' then ''razorpay''\n      when ''dodo'' then ''dodo''');
  if patched = definition then raise exception 'Dodo migration: expected provider mapping was not found'; end if;
  execute patched;
  definition := pg_get_functiondef('public.roo_referral_earnings_summary(text,text)'::regprocedure);
  patched := replace(definition,
    'and (booking.booking_payload->>''commissionAmount'')::numeric <> 0',
    'and ((booking.booking_payload->>''commissionAmount'')::numeric <> 0 or booking.booking_payload ? ''dodoOriginalCommissionAmount'')');
  if patched = definition then raise exception 'Dodo migration: expected commission calculation was not found'; end if;
  execute patched;
end;
$migration$;
