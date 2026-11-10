set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function commerce.exhausted_late_capture_watch_needs_resume(payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select payload->>'provider' in ('paypal', 'razorpay', 'dodo')
    and lower(payload->>'status') = 'abandoned'
    and payload->'reconciliationRecoveryTerminal' = 'true'::jsonb
    and payload->>'recoveryReason' = any(array[
      'paypal_lookup_failed_401', 'paypal_lookup_failed_403', 'paypal_lookup_failed_404', 'paypal_lookup_failed_429',
      'paypal_lookup_failed_500', 'paypal_lookup_failed_502', 'paypal_lookup_failed_503', 'paypal_lookup_failed_504',
      'razorpay_lookup_failed_401', 'razorpay_lookup_failed_403', 'razorpay_lookup_failed_404', 'razorpay_lookup_failed_429',
      'razorpay_lookup_failed_500', 'razorpay_lookup_failed_502', 'razorpay_lookup_failed_503', 'razorpay_lookup_failed_504',
      'dodo_lookup_failed_401', 'dodo_lookup_failed_403', 'dodo_lookup_failed_404', 'dodo_lookup_failed_429',
      'dodo_lookup_failed_500', 'dodo_lookup_failed_502', 'dodo_lookup_failed_503', 'dodo_lookup_failed_504',
      'paypal_lookup_exception', 'razorpay_lookup_exception'
    ])
    and payload->'recoveryFailureCount' = '12'::jsonb
    and payload->>'nextRecoveryAt' = '9999-12-31T23:59:59.999Z'
    and nullif(payload->>'lateCaptureWatchUntil', '') is not null
    and coalesce(payload->>'providerRecoveryTerminal', 'false') = 'false'
    and coalesce(payload->>'recoveryOwnerReviewRequired', 'false') = 'false'
    and coalesce(payload->>'resourceReleasePending', 'false') = 'false'
    and coalesce(payload->>'refundRequiresBookingSync', 'false') = 'false'
    and coalesce(payload->>'providerRefundDetailsMissing', 'false') = 'false';
$$;
revoke all on function commerce.exhausted_late_capture_watch_needs_resume(jsonb) from public, anon, authenticated;
grant execute on function commerce.exhausted_late_capture_watch_needs_resume(jsonb) to service_role;

do $migration$
declare
  definition text;
  old_terminal text := $old$coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb$old$;
  new_terminal text := $new$(coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$new$;
  old_due text := $old$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now)$old$;
  new_due text := $new$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$new$;
  old_aggregation text := $old$jsonb_agg(payload order by updated_at, legacy_sanity_id)$old$;
  new_aggregation text := $new$jsonb_agg(payload order by coalesce(commerce.exhausted_late_capture_watch_needs_resume(payload), false), updated_at, legacy_sanity_id)$new$;
begin
  definition := pg_get_functiondef('public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'::regprocedure);
  if strpos(definition, new_terminal) > 0 and strpos(definition, new_due) > 0
    and strpos(definition, new_aggregation) > 0 then return; end if;
  if array_length(string_to_array(definition, old_terminal), 1) is distinct from 2
    or array_length(string_to_array(definition, old_due), 1) is distinct from 2
    or array_length(string_to_array(definition, old_aggregation), 1) is distinct from 2 then
    raise exception 'unexpected payment recovery candidate filter';
  end if;
  execute replace(replace(replace(definition, old_terminal, new_terminal), old_due, new_due), old_aggregation, new_aggregation);
end;
$migration$;
