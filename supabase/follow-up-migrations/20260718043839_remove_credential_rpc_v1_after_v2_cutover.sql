set lock_timeout = '5s';
set statement_timeout = '120s';

-- Deferred migration. Move this file into supabase/migrations only after all
-- application traffic is confirmed on the credential v2 RPCs.

do $$
declare
  v_missing_v2 text;
  v_missing_v1 text;
begin
  select string_agg(signature, ', ' order by signature)
  into v_missing_v2
  from unnest(array[
    'public.roo_get_credential_operation_v2(text)',
    'public.roo_mark_credential_operation_v2(text,text,text)',
    'public.roo_apply_credential_source_operation_v2(text)',
    'public.roo_mark_credential_source_applied_v2(text,text)',
    'public.roo_complete_credential_operation_v2(text)',
    'public.roo_list_credential_recovery_v2(integer)',
    'public.roo_record_credential_recovery_failure(text,text,text,text,text)'
  ]) signature
  where to_regprocedure(signature) is null;

  if v_missing_v2 is not null then
    raise exception 'Credential v2 RPC cutover is incomplete: %', v_missing_v2
      using errcode = '55000';
  end if;

  select string_agg(signature, ', ' order by signature)
  into v_missing_v1
  from unnest(array[
    'public.roo_get_credential_operation(text)',
    'public.roo_mark_credential_operation(text,text,text)',
    'public.roo_apply_credential_source_operation(text)',
    'public.roo_mark_credential_source_applied(text,text)',
    'public.roo_complete_credential_operation(text)',
    'public.roo_list_credential_recovery(integer)',
    'public.roo_record_credential_recovery_error(text,text,text)'
  ]) signature
  where to_regprocedure(signature) is null;

  if v_missing_v1 is not null then
    raise exception 'Credential v1 RPC removal precondition failed: %', v_missing_v1
      using errcode = '55000';
  end if;
end;
$$;

drop function public.roo_list_credential_recovery(integer);
drop function public.roo_apply_credential_source_operation(text);
drop function public.roo_mark_credential_source_applied(text, text);
drop function public.roo_complete_credential_operation(text);
drop function public.roo_get_credential_operation(text);
drop function public.roo_mark_credential_operation(text, text, text);
drop function public.roo_record_credential_recovery_error(text, text, text);
