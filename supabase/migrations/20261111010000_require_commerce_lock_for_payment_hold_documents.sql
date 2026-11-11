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
  if tg_op = 'UPDATE' and old.payload is not distinct from new.payload
    and old.tombstoned is not distinct from new.tombstoned
    and old.document_type is not distinct from new.document_type then
    return new;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_locks held
    where held.pid = pg_catalog.pg_backend_pid()
      and held.locktype = 'advisory'
      and held.granted
      and held.classid::bigint = ((v_key >> 32) & 4294967295)
      and held.objid::bigint = (v_key & 4294967295)
      and held.objsubid = 1
  ) then
    raise exception 'payment hold document requires the cms-reference-integrity commerce lock'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger source_documents_require_commerce_lock_for_payment_hold
before insert or update on migration.source_documents
for each row
when (new.document_type = 'slotHold' and not new.tombstoned
  and lower(coalesce(new.payload->>'phase', 'active')) in ('payment', 'payment_pending'))
execute function migration.require_commerce_lock_for_payment_hold_document();

revoke all on function migration.require_commerce_lock_for_payment_hold_document()
  from public, anon, authenticated, service_role;
