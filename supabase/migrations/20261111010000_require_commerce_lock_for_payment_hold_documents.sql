set lock_timeout = '5s';
set statement_timeout = '120s';

create function migration.require_commerce_lock_for_payment_hold_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key bigint := pg_catalog.hashtextextended('cms-reference-integrity', 0);
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(old) - 'operational_imported') = (to_jsonb(new) - 'operational_imported') then
    return new;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_locks held
    where held.pid = pg_catalog.pg_backend_pid()
      and held.locktype = 'advisory'
      and held.mode = 'ExclusiveLock'
      and held.granted
      and held.classid::bigint = ((v_key >> 32) & 4294967295)
      and held.objid::bigint = (v_key & 4294967295)
      and held.objsubid = 1
  ) then
    raise exception 'payment hold document requires the cms-reference-integrity commerce lock'
      using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger source_documents_require_commerce_lock_for_payment_hold_insert
before insert on migration.source_documents
for each row
when (new.document_type = 'slotHold' and not new.tombstoned
  and lower(coalesce(new.payload->>'phase', 'active')) in ('payment', 'payment_pending'))
execute function migration.require_commerce_lock_for_payment_hold_document();

create trigger source_documents_require_commerce_lock_for_payment_hold_update
before update on migration.source_documents
for each row
when ((old.document_type = 'slotHold' and not old.tombstoned
    and lower(coalesce(old.payload->>'phase', 'active')) in ('payment', 'payment_pending'))
  or (new.document_type = 'slotHold' and not new.tombstoned
    and lower(coalesce(new.payload->>'phase', 'active')) in ('payment', 'payment_pending')))
execute function migration.require_commerce_lock_for_payment_hold_document();

create trigger source_documents_require_commerce_lock_for_payment_hold_delete
before delete on migration.source_documents
for each row
when (old.document_type = 'slotHold' and not old.tombstoned
  and lower(coalesce(old.payload->>'phase', 'active')) in ('payment', 'payment_pending'))
execute function migration.require_commerce_lock_for_payment_hold_document();

revoke all on function migration.require_commerce_lock_for_payment_hold_document()
  from public, anon, authenticated, service_role;
