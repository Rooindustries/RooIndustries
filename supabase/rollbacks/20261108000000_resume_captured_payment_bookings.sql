set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  source record;
begin
  for source in
    select document.*, backup.previous_state
    from migration.source_documents document
    join migration.captured_payment_recovery_resumes backup
      on backup.document_id = document.legacy_sanity_id
      and backup.resumed_revision = document.source_revision
    where document.document_type = 'paymentRecord' and not document.tombstoned
      and document.backend_owner = 'supabase'
      and document.cutover_generation = (select generation from migration.commerce_control where singleton)
    for update of document
  loop
    perform public.roo_apply_commerce_document_mutations(
      'rollback.captured-payment.' || source.legacy_sanity_id || ':' || source.source_revision,
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace', 'expected_revision', source.source_revision,
        'document', (source.payload - array[
          'reconciliationRecoveryTerminal', 'nextRecoveryAt', 'recoveryOwnerReviewRequired'
        ]) || source.previous_state
      )), source.cutover_generation
    );
  end loop;
end;
$rollback$;
