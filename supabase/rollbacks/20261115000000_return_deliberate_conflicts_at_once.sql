set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  v_known text[];
  v_found text[];
  v_signature text;
begin
  v_known := array[
    'commerce.normalize_booking_confirmation_source(jsonb,jsonb)',
    'migration.apply_cms_commerce_mutation(text,jsonb)',
    'migration.block_legacy_discord_reauth(boolean)',
    'migration.finalize_inactive_noop_discord_assignments(boolean)',
    'migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)',
    'public.roo_admin_update_creator_terms(text,uuid,bigint,integer,integer,integer,boolean,text,integer)',
    'public.roo_advance_commerce_generation(integer,text,boolean,text)',
    'public.roo_apply_cms_publish_command(text,text,text,jsonb,jsonb,jsonb)',
    'public.roo_apply_credential_source_operation_v2(text)',
    'public.roo_apply_document_mutations(jsonb)',
    'public.roo_cms_publish_command_result(text,text,text)',
    'public.roo_complete_booking_email_dispatch(text,text,boolean,text,text,timestamp with time zone,timestamp with time zone)',
    'public.roo_complete_discord_role_assignment(uuid,bigint,text,text,text,boolean)',
    'public.roo_complete_incremental_commerce_sync(text,text,uuid,text,timestamp with time zone,jsonb)',
    'public.roo_complete_referral_email_dispatch(text,uuid,boolean,text,text,integer)',
    'public.roo_enqueue_referral_email_mutation(jsonb,text,text,text,text,text,jsonb,timestamp with time zone)',
    'public.roo_reclaim_referral_orphan_identity(text,uuid,text)',
    'public.roo_record_credential_recovery_failure(text,text,text,text,text)',
    'public.roo_resolve_referral_email_dispatch(text,text)',
    'public.roo_set_commerce_starts_paused(integer,boolean,text)',
    'public.roo_upsert_native_creator_account(jsonb)',
    'public.roo_apply_credential_source_operation(text)',
    'public.roo_complete_credential_operation(text)',
    'public.roo_mark_credential_operation(text,text,text)',
    'public.roo_mark_credential_source_applied(text,text)',
    'public.roo_record_credential_recovery_error(text,text,text)'
  ];
  select coalesce(array_agg(format('%s.%s(%s)', n.nspname, p.proname,
           pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ','))), '{}')
  into v_found
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and p.prosrc like '%''PT409''%'
    and format('%s.%s(%s)', n.nspname, p.proname,
      pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',')) = any(v_known);

  foreach v_signature in array v_found loop
    execute pg_catalog.replace(
      pg_catalog.pg_get_functiondef(v_signature::pg_catalog.regprocedure),
      '''PT409''', '''40001''');
  end loop;
end;
$rollback$;
