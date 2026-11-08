set lock_timeout = '5s';
set statement_timeout = '120s';

do $edit$
declare
  definition text;
  previous constant text := $old$payment_source.payload->>'providerPaymentState' = 'succeeded'$old$;
  replacement constant text :=
    $new$payment_source.payload->>'providerPaymentState' in ('succeeded', 'requires_merchant_action')$new$;
begin
  definition := pg_get_functiondef('public.roo_cleanup_expired_supabase_holds(integer,integer)'::regprocedure);
  if strpos(definition, replacement) > 0 then return; end if;
  if array_length(string_to_array(definition, previous), 1) is distinct from 2 then
    raise exception 'unexpected contract: public.roo_cleanup_expired_supabase_holds';
  end if;
  execute replace(definition, previous, replacement);
end;
$edit$;

create or replace function commerce.payment_recovery_can_resume(payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select payload->>'provider' in ('paypal', 'razorpay', 'dodo')
    and nullif(btrim(payload->>'bookingId'), '') is null
    and (payload->>'reconciliationRecoveryTerminal' = 'true'
      or payload->>'nextRecoveryAt' >= '9999-01-01')
    and coalesce(payload->>'providerRecoveryTerminal', 'false') != 'true'
    and coalesce(payload->>'providerPaymentState', '') not in ('refunded', 'disputed', 'failed', 'cancelled', 'abandoned');
$$;
revoke all on function commerce.payment_recovery_can_resume(jsonb) from public, anon, authenticated;
grant execute on function commerce.payment_recovery_can_resume(jsonb) to service_role;

create table if not exists migration.captured_payment_recovery_resumes (
  document_id text primary key,
  previous_state jsonb not null,
  resumed_revision text
);
alter table migration.captured_payment_recovery_resumes enable row level security;
revoke all on migration.captured_payment_recovery_resumes from public, anon, authenticated, service_role;

do $resume$
declare
  source record;
  previous_state jsonb;
begin
  for source in
    select * from migration.source_documents
    where document_type = 'paymentRecord' and not tombstoned
      and backend_owner = 'supabase'
      and cutover_generation = (select generation from migration.commerce_control where singleton)
      and commerce.payment_recovery_can_resume(payload)
      and payload->>'status' in ('started', 'needs_recovery', 'finalizing', 'captured_client', 'captured_webhook')
    for update
  loop
    select jsonb_object_agg(key, value) into previous_state
    from jsonb_each(source.payload)
    where key in ('reconciliationRecoveryTerminal', 'nextRecoveryAt', 'recoveryOwnerReviewRequired');
    insert into migration.captured_payment_recovery_resumes(document_id, previous_state)
    values (source.legacy_sanity_id, previous_state)
    on conflict (document_id) do update set previous_state = excluded.previous_state;
    perform public.roo_apply_commerce_document_mutations(
      'resume.captured-payment.' || source.legacy_sanity_id || ':' || source.source_revision,
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace', 'expected_revision', source.source_revision,
        'document', source.payload || jsonb_build_object(
          'reconciliationRecoveryTerminal', false,
          'recoveryOwnerReviewRequired', true,
          'nextRecoveryAt', clock_timestamp()
        )
      )), source.cutover_generation
    );
    update migration.captured_payment_recovery_resumes
    set resumed_revision = (select source_revision from migration.source_documents
      where legacy_sanity_id = source.legacy_sanity_id)
    where document_id = source.legacy_sanity_id;
  end loop;
end;
$resume$;

do $queue$
declare
  definition text;
  previous constant text := 'payment.updated_at, source.payload';
  replacement constant text := $projection$payment.updated_at, (select jsonb_object_agg(key, value) from jsonb_each(source.payload)
      where key in ('_id', '_type', 'status', 'provider', 'updatedAt', 'nextRecoveryAt',
        'reconciliationRecoveryTerminal', 'providerRecoveryTerminal', 'providerRecoveryTerminalReason',
        'refundRequiresBookingSync', 'resourceReleasePending', 'requiresReschedule',
        'emailDispatchRequired', 'lateCaptureWatchUntil', 'emailDispatch')) as payload$projection$;
begin
  definition := pg_get_functiondef('public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean)'::regprocedure);
  if strpos(definition, replacement) > 0 then return; end if;
  if array_length(string_to_array(definition, previous), 1) is distinct from 2 then
    raise exception 'unexpected contract: public.roo_fetch_recovery_payment_documents';
  end if;
  execute replace(definition, previous, replacement);
end;
$queue$;
