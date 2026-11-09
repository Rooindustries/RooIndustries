set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  definition text;
  old_terminal text := $old$coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb$old$;
  new_terminal text := $new$(coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb or commerce.abandoned_paypal_watch_needs_resume(source.payload))$new$;
  old_due text := $old$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now)$old$;
  new_due text := $new$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now or commerce.abandoned_paypal_watch_needs_resume(source.payload))$new$;
  old_order text := $old$coalesce(payment.next_recovery_at, '-infinity'::timestamptz), payment.updated_at, payment.id$old$;
  new_order text := $new$case when commerce.abandoned_paypal_watch_needs_resume(source.payload) then '-infinity'::timestamptz else coalesce(payment.next_recovery_at, '-infinity'::timestamptz) end, payment.updated_at, payment.id$new$;
begin
  definition := pg_get_functiondef('public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'::regprocedure);
  if array_length(string_to_array(definition, new_terminal), 1) is distinct from 2
    or array_length(string_to_array(definition, new_due), 1) is distinct from 2
    or array_length(string_to_array(definition, new_order), 1) is distinct from 2 then
    raise exception 'unexpected payment recovery candidate filter';
  end if;
  execute replace(replace(replace(definition, new_terminal, old_terminal), new_due, old_due), new_order, old_order);
end;
$rollback$;

drop function commerce.abandoned_paypal_watch_needs_resume(jsonb);
