set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
begin
  if to_regclass('commerce.refunds') is null
    or to_regclass('commerce.payment_records') is null
    or to_regprocedure('migration.project_commerce_extensions(text[])') is null
    or (
      select count(*) from pg_catalog.pg_attribute
      where attrelid = to_regclass('commerce.refunds')
        and not attisdropped and attnotnull
        and ((attname in ('provider', 'provider_refund_id') and atttypid = 'text'::regtype)
          or (attname = 'payment_record_id' and atttypid = 'uuid'::regtype))
    ) <> 3
    or not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = to_regclass('commerce.refunds')
        and contype = 'u'
        and pg_get_constraintdef(oid) = 'UNIQUE (provider, provider_refund_id)'
    ) then
    raise exception 'refund binding migration requires the authoritative provider refund ledger';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = to_regclass('commerce.refunds') and contype = 'f'
      and confrelid = to_regclass('commerce.payment_records')
      and conkey = array[(select attnum from pg_catalog.pg_attribute
        where attrelid = to_regclass('commerce.refunds') and attname = 'payment_record_id')]::smallint[]
      and confkey = array[(select attnum from pg_catalog.pg_attribute
        where attrelid = to_regclass('commerce.payment_records') and attname = 'id')]::smallint[]
  ) then
    raise exception 'refund binding migration requires the payment ownership foreign key';
  end if;
  if exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = to_regclass('commerce.refunds')
      and tgname = 'preserve_refund_payment_binding' and not tgisinternal
  ) or to_regprocedure('commerce.preserve_refund_payment_binding()') is not null then
    raise exception 'refund binding migration: unexpected existing binding guard';
  end if;
end;
$migration$;

create function commerce.preserve_refund_payment_binding()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_payment_id uuid;
begin
  if tg_op = 'UPDATE' and (
    new.provider is distinct from old.provider
    or new.provider_refund_id is distinct from old.provider_refund_id
    or new.payment_record_id is distinct from old.payment_record_id
  ) then
    raise exception 'refund payment binding conflict'
      using errcode = '23505';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('commerce-refund:' || new.provider || ':' || new.provider_refund_id, 0)
  );
  select refund.payment_record_id into existing_payment_id
  from commerce.refunds refund
  where refund.provider = new.provider
    and refund.provider_refund_id = new.provider_refund_id
  for update;
  if found and existing_payment_id is distinct from new.payment_record_id then
    raise exception 'refund payment binding conflict'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke all on function commerce.preserve_refund_payment_binding() from public, anon, authenticated, service_role;

create trigger preserve_refund_payment_binding
before insert or update on commerce.refunds
for each row execute function commerce.preserve_refund_payment_binding();
