set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
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
  if array_length(string_to_array(definition, new_terminal), 1) is distinct from 2
    or array_length(string_to_array(definition, new_due), 1) is distinct from 2
    or array_length(string_to_array(definition, new_aggregation), 1) is distinct from 2 then
    raise exception 'unexpected payment recovery candidate filter';
  end if;
  execute replace(replace(replace(definition, new_terminal, old_terminal), new_due, old_due), new_aggregation, old_aggregation);
end;
$rollback$;

drop function commerce.exhausted_late_capture_watch_needs_resume(jsonb);
