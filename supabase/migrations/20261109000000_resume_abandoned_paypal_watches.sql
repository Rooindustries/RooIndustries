set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function commerce.abandoned_paypal_watch_needs_resume(payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select payload->>'provider' = 'paypal'
    and lower(payload->>'status') = 'abandoned'
    and payload->>'reconciliationRecoveryTerminal' = 'true'
    and payload->>'recoveryReason' = 'paypal_lookup_failed_404'
    and payload->>'recoveryFailureCount' = '12'
    and payload->>'nextRecoveryAt' = '9999-12-31T23:59:59.999Z'
    and nullif(payload->>'lateCaptureWatchUntil', '') is not null
    and coalesce(payload->>'providerRecoveryTerminal', 'false') = 'false'
    and coalesce(payload->>'recoveryOwnerReviewRequired', 'false') = 'false'
    and coalesce(payload->>'resourceReleasePending', 'false') = 'false'
    and coalesce(payload->>'refundRequiresBookingSync', 'false') = 'false'
    and coalesce(payload->>'providerRefundDetailsMissing', 'false') = 'false';
$$;
revoke all on function commerce.abandoned_paypal_watch_needs_resume(jsonb) from public, anon, authenticated;
grant execute on function commerce.abandoned_paypal_watch_needs_resume(jsonb) to service_role;

do $migration$
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
  if strpos(definition, new_terminal) > 0 and strpos(definition, new_due) > 0
    and strpos(definition, new_order) > 0 then return; end if;
  if array_length(string_to_array(definition, old_terminal), 1) is distinct from 2
    or array_length(string_to_array(definition, old_due), 1) is distinct from 2
    or array_length(string_to_array(definition, old_order), 1) is distinct from 2 then
    raise exception 'unexpected payment recovery candidate filter';
  end if;
  execute replace(replace(replace(definition, old_terminal, new_terminal), old_due, new_due), old_order, new_order);
end;
$migration$;
