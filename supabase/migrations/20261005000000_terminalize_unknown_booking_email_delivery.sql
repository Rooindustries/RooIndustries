set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  definition text;
  patched text;
  confirmation_anchor text := 'when lower(coalesce(source.payload->>''emailDispatchStatus'', '''')) in (''partial'', ''failed'')';
  reschedule_anchor text := 'when lower(coalesce(source.payload->>''recoveryNotificationStatus'', '''')) = ''partial''';
begin
  if to_regclass('commerce.email_dispatches') is null
    or to_regclass('migration.source_documents') is null
    or to_regprocedure('migration.project_commerce_extensions(text[])') is null
    or to_regprocedure('public.roo_complete_booking_email_dispatch(text,text,boolean,text,text,timestamptz,timestamptz)') is null
    or to_regprocedure('commerce.preserve_terminal_email_dispatch()') is null then
    raise exception 'terminal email migration requires the authoritative booking email ledger';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'commerce.email_dispatches'::regclass
      and tgname = 'preserve_terminal_email_dispatch' and not tgisinternal and tgenabled <> 'D'
  ) then
    raise exception 'terminal email migration requires the terminal-state trigger';
  end if;
  definition := pg_get_functiondef('migration.project_commerce_extensions(text[])'::regprocedure);
  if position('= ''delivery_unknown''' in definition) > 0 then
    raise exception 'terminal email migration: projection already has delivery_unknown handling';
  end if;
  if (length(definition) - length(replace(definition, confirmation_anchor, ''))) / length(confirmation_anchor) <> 1
    or (length(definition) - length(replace(definition, reschedule_anchor, ''))) / length(reschedule_anchor) <> 1 then
    raise exception 'terminal email migration: expected projection anchors were not found exactly once';
  end if;
  patched := replace(definition, confirmation_anchor,
    E'when lower(coalesce(source.payload->>''emailDispatchStatus'', '''')) = ''delivery_unknown''\n        then ''historical_unknown''\n      ' || confirmation_anchor);
  patched := replace(patched, reschedule_anchor,
    E'when lower(coalesce(source.payload->>''recoveryNotificationStatus'', '''')) = ''delivery_unknown''\n        then ''historical_unknown''\n      ' || reschedule_anchor);
  execute patched;
end;
$migration$;

create or replace function commerce.preserve_terminal_email_dispatch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'sent' and new.status <> 'sent' then
    new.status := 'sent';
    new.sent_at := old.sent_at;
    new.provider_message_id := old.provider_message_id;
    new.lease_id := null;
    new.lease_expires_at := null;
    new.next_attempt_at := null;
    new.last_error_code := null;
  elsif tg_op = 'UPDATE' and old.status = 'historical_unknown'
    and new.status not in ('historical_unknown', 'sent') then
    new.status := 'historical_unknown';
  end if;
  if new.status = 'historical_unknown' then
    new.lease_id := null;
    new.lease_expires_at := null;
    new.next_attempt_at := null;
  end if;
  return new;
end;
$$;

drop trigger preserve_terminal_email_dispatch on commerce.email_dispatches;
create trigger preserve_terminal_email_dispatch
before insert or update on commerce.email_dispatches
for each row execute function commerce.preserve_terminal_email_dispatch();

create or replace function public.roo_complete_booking_email_dispatch(
  p_idempotency_key text,
  p_lease_id text,
  p_success boolean,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_sent_at timestamptz default now(),
  p_next_attempt_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_lease_id text := btrim(coalesce(p_lease_id, ''));
  v_dispatch commerce.email_dispatches%rowtype;
  v_status text;
begin
  if v_key = '' or v_lease_id !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid email dispatch completion'
      using errcode = '22023';
  end if;

  select * into v_dispatch
  from commerce.email_dispatches
  where idempotency_key = v_key
  for update;
  if not found then
    raise exception 'email dispatch ledger row not found'
      using errcode = 'P0002';
  end if;
  if v_dispatch.status = 'sent' and coalesce(p_success, false) then
    return jsonb_build_object(
      'completed', true,
      'sent', true,
      'idempotent', true,
      'provider_message_id', v_dispatch.provider_message_id,
      'sent_at', v_dispatch.sent_at
    );
  end if;
  if v_dispatch.status = 'historical_unknown' and not coalesce(p_success, false) then
    return jsonb_build_object(
      'completed', true, 'sent', false, 'historical_unknown', true,
      'idempotent', true, 'status', v_dispatch.status,
      'provider_message_id', v_dispatch.provider_message_id,
      'sent_at', v_dispatch.sent_at
    );
  end if;
  if v_dispatch.lease_id is distinct from v_lease_id then
    raise exception 'email dispatch lease conflict'
      using errcode = '40001';
  end if;

  v_status := case
    when coalesce(p_success, false) then 'sent'
    when lower(btrim(coalesce(p_error_code, ''))) = 'email_delivery_unknown' then 'historical_unknown'
    when v_dispatch.attempt_count >= 12 then 'failed'
    else 'retry'
  end;
  update commerce.email_dispatches
  set
    status = v_status,
    provider_message_id = case
      when coalesce(p_success, false)
        then coalesce(nullif(btrim(p_provider_message_id), ''), provider_message_id)
      else provider_message_id
    end,
    sent_at = case
      when coalesce(p_success, false) then coalesce(p_sent_at, now())
      else sent_at
    end,
    last_error_code = case
      when coalesce(p_success, false) then null
      else left(coalesce(nullif(btrim(p_error_code), ''), 'EMAIL_SEND_FAILED'), 128)
    end,
    next_attempt_at = case
      when coalesce(p_success, false) or v_status in ('failed', 'historical_unknown') then null
      else coalesce(p_next_attempt_at, now() + interval '5 minutes')
    end,
    lease_id = null,
    lease_expires_at = null,
    updated_at = now()
  where id = v_dispatch.id
  returning * into v_dispatch;

  return jsonb_build_object(
    'completed', true,
    'sent', v_dispatch.status = 'sent',
    'historical_unknown', v_dispatch.status = 'historical_unknown',
    'idempotent', false,
    'status', v_dispatch.status,
    'provider_message_id', v_dispatch.provider_message_id,
    'sent_at', v_dispatch.sent_at
  );
end;
$$;

revoke all on function commerce.preserve_terminal_email_dispatch() from public, anon, authenticated;
revoke all on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) to service_role;

select migration.project_commerce_extensions(array(
  select source.legacy_sanity_id
  from migration.source_documents source
  where source.document_type = 'booking' and not source.tombstoned
    and (lower(coalesce(source.payload->>'emailDispatchStatus', '')) = 'delivery_unknown'
      or lower(coalesce(source.payload->>'recoveryNotificationStatus', '')) = 'delivery_unknown')
));
