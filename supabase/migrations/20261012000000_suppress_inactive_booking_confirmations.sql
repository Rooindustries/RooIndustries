set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function commerce.preserve_terminal_email_dispatch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_inactive boolean;
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
  elsif new.dispatch_kind = 'booking_confirmation' and new.status <> 'sent'
    and (new.last_error_code = 'booking_inactive'
      or (tg_op = 'UPDATE' and old.status = 'failed' and old.last_error_code = 'booking_inactive')) then
    select lower(btrim(coalesce(source.payload->>'status', '')))
      in ('failed', 'refunded', 'cancelled', 'canceled')
    into v_inactive
    from commerce.bookings booking
    join migration.source_documents source on source.legacy_sanity_id = booking.legacy_sanity_id
    where booking.id = new.booking_id and not source.tombstoned;

    if coalesce(v_inactive, true) then
      new.status := 'failed';
      new.last_error_code := 'booking_inactive';
      new.lease_id := null;
      new.lease_expires_at := null;
      new.next_attempt_at := null;
    else
      if new.status <> 'sending' then new.status := 'pending'; end if;
      new.last_error_code := null;
      new.next_attempt_at := null;
    end if;
  end if;
  return new;
end;
$$;

do $migration$
declare
  definition text;
  claim_anchor text := $anchor$  if v_dispatch.next_attempt_at is not null$anchor$;
  claim_guard text := $guard$  if v_kind = 'booking_confirmation' and exists (
    select 1 from migration.source_documents source
    where source.legacy_sanity_id = v_booking_id and not source.tombstoned
      and lower(btrim(coalesce(source.payload->>'status', '')))
        in ('failed', 'refunded', 'cancelled', 'canceled')
  ) then
    update commerce.email_dispatches
    set status = 'failed', last_error_code = 'booking_inactive',
      lease_id = null, lease_expires_at = null, next_attempt_at = null, updated_at = now()
    where id = v_dispatch.id;
    return jsonb_build_object(
      'claimed', false, 'sent', false, 'historical_unknown', false,
      'in_progress', false, 'booking_inactive', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;

$guard$;
  completion_anchor text := $anchor$    when v_dispatch.attempt_count >= 12 then 'failed'$anchor$;
  recovery_anchor text := $anchor$      and dispatch.status <> 'historical_unknown'$anchor$;
begin
  if to_regprocedure('public.roo_claim_booking_email_dispatch(text,text,text,text,integer)') is null
    or to_regprocedure('public.roo_complete_booking_email_dispatch(text,text,boolean,text,text,timestamptz,timestamptz)') is null
    or to_regprocedure('public.roo_list_email_dispatch_recovery_bookings(text,timestamptz,integer)') is null
    or not exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'commerce.email_dispatches'::regclass
        and tgname = 'preserve_terminal_email_dispatch' and not tgisinternal and tgenabled <> 'D'
    ) then
    raise exception 'inactive booking confirmation migration requires the authoritative email ledger';
  end if;

  definition := pg_get_functiondef('public.roo_claim_booking_email_dispatch(text,text,text,text,integer)'::regprocedure);
  if (length(definition) - length(replace(definition, claim_anchor, ''))) <> length(claim_anchor)
    or position('booking_inactive' in definition) <> 0 then
    raise exception 'inactive booking confirmation migration: unexpected claim contract';
  end if;
  execute replace(definition, claim_anchor, claim_guard || claim_anchor);

  definition := pg_get_functiondef('public.roo_complete_booking_email_dispatch(text,text,boolean,text,text,timestamptz,timestamptz)'::regprocedure);
  if (length(definition) - length(replace(definition, completion_anchor, ''))) <> length(completion_anchor)
    or position('email_delivery_unknown' in definition) = 0 then
    raise exception 'inactive booking confirmation migration: unexpected completion contract';
  end if;
  execute replace(definition, completion_anchor,
    E'    when v_dispatch.dispatch_kind = ''booking_confirmation'' and lower(btrim(coalesce(p_error_code, ''''))) = ''booking_inactive'' then ''failed''\n'
      || completion_anchor);

  definition := pg_get_functiondef('public.roo_list_email_dispatch_recovery_bookings(text,timestamptz,integer)'::regprocedure);
  if (length(definition) - length(replace(definition, recovery_anchor, ''))) <> length(recovery_anchor) then
    raise exception 'inactive booking confirmation migration: unexpected recovery contract';
  end if;
  execute replace(definition, recovery_anchor, recovery_anchor ||
    E'\n      and (dispatch.dispatch_kind <> ''booking_confirmation'' or coalesce(dispatch.last_error_code, '''') <> ''booking_inactive'')');
end;
$migration$;

revoke all on function commerce.preserve_terminal_email_dispatch() from public, anon, authenticated;
revoke all on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer) to service_role;
grant execute on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) to service_role;
grant execute on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer) to service_role;
