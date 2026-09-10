do $migration$
declare
  definition text;
  patched text;
begin
  definition := pg_get_functiondef('public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'::regprocedure);
  patched := replace(definition,
    'payment.status = lower(p_refunded_status) and payment.refund_requires_booking_sync',
    'payment.refund_requires_booking_sync');
  if patched = definition then raise exception 'Expected refund recovery predicates were not found'; end if;
  execute patched;
end;
$migration$;
