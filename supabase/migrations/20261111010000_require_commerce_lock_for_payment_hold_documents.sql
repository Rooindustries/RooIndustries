set lock_timeout = '5s';
set statement_timeout = '120s';

create function migration.is_payment_hold_document(document_type text, tombstoned boolean, payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(document_type = 'slotHold' and not tombstoned
    and pg_catalog.lower(coalesce(payload->>'phase', 'active')) in ('payment', 'payment_pending'), false);
$$;

create function migration.require_commerce_lock_for_payment_hold_document()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key bigint := pg_catalog.hashtextextended('cms-reference-integrity', 0);
  v_was_payment_hold boolean := false;
  v_previous_expiry text;
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
  if tg_op = 'UPDATE' then
    v_was_payment_hold := migration.is_payment_hold_document(old.document_type, old.tombstoned, old.payload);
    v_previous_expiry := old.payload->>'expiresAt';
  else
    select migration.is_payment_hold_document(source.document_type, source.tombstoned, source.payload),
      source.payload->>'expiresAt'
    into v_was_payment_hold, v_previous_expiry
    from migration.source_documents source
    where source.legacy_sanity_id = new.legacy_sanity_id;
    v_was_payment_hold := coalesce(v_was_payment_hold, false);
  end if;
  if migration.is_payment_hold_document(new.document_type, new.tombstoned, new.payload)
    and (not v_was_payment_hold or v_previous_expiry is distinct from new.payload->>'expiresAt')
    and (migration.try_timestamptz(new.payload->>'expiresAt') >= pg_catalog.clock_timestamp() + interval '10 minutes') is not true then
    raise exception 'payment hold must start with a fresh expiry at least 10 minutes ahead'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger source_documents_require_commerce_lock_for_payment_hold_insert
before insert on migration.source_documents
for each row
when (migration.is_payment_hold_document(new.document_type, new.tombstoned, new.payload))
execute function migration.require_commerce_lock_for_payment_hold_document();

create trigger source_documents_require_commerce_lock_for_payment_hold_update
before update on migration.source_documents
for each row
when (migration.is_payment_hold_document(old.document_type, old.tombstoned, old.payload)
  or migration.is_payment_hold_document(new.document_type, new.tombstoned, new.payload))
execute function migration.require_commerce_lock_for_payment_hold_document();

create trigger source_documents_require_commerce_lock_for_payment_hold_delete
before delete on migration.source_documents
for each row
when (migration.is_payment_hold_document(old.document_type, old.tombstoned, old.payload))
execute function migration.require_commerce_lock_for_payment_hold_document();

revoke all on function migration.require_commerce_lock_for_payment_hold_document()
  from public, anon, authenticated, service_role;
