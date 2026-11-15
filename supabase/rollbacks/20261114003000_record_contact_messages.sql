set lock_timeout = '5s';
set statement_timeout = '120s';

do $rollback$
declare
  v_unsent integer := 0;
begin
  if to_regclass('ops.contact_messages') is not null then
    lock table ops.contact_messages in access exclusive mode;
    select count(*) into v_unsent
    from ops.contact_messages
    where status in ('pending', 'failed', 'dead');
  end if;
  if v_unsent > 0 then
    raise exception 'contact messages were never delivered: %', v_unsent
      using errcode = '55000',
        hint = 'Forward or export the unsent rows in ops.contact_messages before rolling back.';
  end if;

  drop function if exists public.roo_claim_contact_retries(integer);
  drop function if exists public.roo_complete_contact_message(uuid, boolean, text, text);
  drop function if exists public.roo_record_contact_message(text, text, text, text, text);
  drop table if exists ops.contact_messages;

  notify pgrst, 'reload schema';
end;
$rollback$;
