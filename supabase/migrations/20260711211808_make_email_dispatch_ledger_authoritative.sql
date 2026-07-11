create index if not exists email_dispatches_booking_kind_recipient_idx
  on commerce.email_dispatches (booking_id, dispatch_kind, recipient_type);

create or replace function commerce.preserve_terminal_email_dispatch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then
    new.status := 'sent';
    new.sent_at := old.sent_at;
    new.provider_message_id := old.provider_message_id;
    new.lease_id := null;
    new.lease_expires_at := null;
    new.next_attempt_at := null;
    new.last_error_code := null;
  elsif old.status = 'historical_unknown'
    and new.status not in ('historical_unknown', 'sent') then
    new.status := 'historical_unknown';
    new.lease_id := null;
    new.lease_expires_at := null;
    new.next_attempt_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_terminal_email_dispatch
  on commerce.email_dispatches;
create trigger preserve_terminal_email_dispatch
before update on commerce.email_dispatches
for each row execute function commerce.preserve_terminal_email_dispatch();

create or replace function public.roo_claim_booking_email_dispatch(
  p_booking_legacy_id text,
  p_dispatch_kind text,
  p_recipient_type text,
  p_lease_id text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking_id text := btrim(coalesce(p_booking_legacy_id, ''));
  v_kind text := lower(btrim(coalesce(p_dispatch_kind, '')));
  v_recipient text := lower(btrim(coalesce(p_recipient_type, '')));
  v_lease_id text := btrim(coalesce(p_lease_id, ''));
  v_dispatch commerce.email_dispatches%rowtype;
begin
  if v_booking_id = ''
    or v_kind not in ('booking_confirmation', 'reschedule')
    or v_recipient not in ('customer', 'owner')
    or v_lease_id !~ '^[A-Za-z0-9._:-]{8,160}$'
    or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid email dispatch lease request'
      using errcode = '22023';
  end if;

  select dispatch.* into v_dispatch
  from commerce.email_dispatches dispatch
  join commerce.bookings booking on booking.id = dispatch.booking_id
  where booking.legacy_sanity_id = v_booking_id
    and dispatch.dispatch_kind = v_kind
    and dispatch.recipient_type = v_recipient
  for update of dispatch;

  if not found then
    raise exception 'email dispatch ledger row not found'
      using errcode = 'P0002';
  end if;
  if v_dispatch.status = 'sent' then
    return jsonb_build_object(
      'claimed', false,
      'sent', true,
      'historical_unknown', false,
      'in_progress', false,
      'idempotency_key', v_dispatch.idempotency_key,
      'provider_message_id', v_dispatch.provider_message_id,
      'sent_at', v_dispatch.sent_at
    );
  end if;
  if v_dispatch.status = 'historical_unknown' then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'historical_unknown', true,
      'in_progress', false,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;
  if v_dispatch.lease_id is not null
    and v_dispatch.lease_id <> v_lease_id
    and v_dispatch.lease_expires_at > now() then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'historical_unknown', false,
      'in_progress', true,
      'idempotency_key', v_dispatch.idempotency_key,
      'lease_expires_at', v_dispatch.lease_expires_at
    );
  end if;
  if v_dispatch.next_attempt_at is not null
    and v_dispatch.next_attempt_at > now()
    and v_dispatch.lease_id is distinct from v_lease_id then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'historical_unknown', false,
      'in_progress', true,
      'idempotency_key', v_dispatch.idempotency_key,
      'next_attempt_at', v_dispatch.next_attempt_at
    );
  end if;

  update commerce.email_dispatches
  set
    status = 'sending',
    lease_id = v_lease_id,
    lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt_count = attempt_count + 1,
    last_error_code = null,
    updated_at = now()
  where id = v_dispatch.id;

  return jsonb_build_object(
    'claimed', true,
    'sent', false,
    'historical_unknown', false,
    'in_progress', false,
    'idempotency_key', v_dispatch.idempotency_key
  );
end;
$$;

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
  if v_dispatch.lease_id is distinct from v_lease_id then
    raise exception 'email dispatch lease conflict'
      using errcode = '40001';
  end if;

  v_status := case
    when coalesce(p_success, false) then 'sent'
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
      when coalesce(p_success, false) or v_status = 'failed' then null
      else coalesce(p_next_attempt_at, now() + interval '5 minutes')
    end,
    lease_id = null,
    lease_expires_at = null,
    updated_at = now()
  where id = v_dispatch.id;

  return jsonb_build_object(
    'completed', true,
    'sent', coalesce(p_success, false),
    'idempotent', false,
    'status', v_status,
    'provider_message_id', coalesce(
      nullif(btrim(p_provider_message_id), ''),
      v_dispatch.provider_message_id
    ),
    'sent_at', case
      when coalesce(p_success, false) then coalesce(p_sent_at, now())
      else v_dispatch.sent_at
    end
  );
end;
$$;

create or replace function public.roo_list_email_dispatch_recovery_bookings(
  p_dispatch_kind text,
  p_now timestamptz default now(),
  p_limit integer default 20
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(candidate.legacy_sanity_id order by candidate.updated_at), '[]'::jsonb)
  from (
    select distinct on (booking.legacy_sanity_id)
      booking.legacy_sanity_id,
      dispatch.updated_at
    from commerce.email_dispatches dispatch
    join commerce.bookings booking on booking.id = dispatch.booking_id
    join migration.source_documents source
      on source.legacy_sanity_id = booking.legacy_sanity_id
    where dispatch.dispatch_kind = lower(btrim(p_dispatch_kind))
      and dispatch.status <> 'historical_unknown'
      and (
        (
          dispatch.status in ('pending', 'retry')
          and coalesce(dispatch.next_attempt_at, '-infinity'::timestamptz)
            <= coalesce(p_now, now())
        )
        or (
          dispatch.status = 'sending'
          and dispatch.lease_expires_at <= coalesce(p_now, now())
        )
        or (
          dispatch.status = 'sent'
          and (
            case dispatch.dispatch_kind
              when 'booking_confirmation' then
                case dispatch.recipient_type
                  when 'customer' then nullif(source.payload->>'emailDispatchClientSentAt', '')
                  else nullif(source.payload->>'emailDispatchOwnerSentAt', '')
                end
              else
                case dispatch.recipient_type
                  when 'customer' then nullif(source.payload->>'recoveryClientNotifiedAt', '')
                  else nullif(source.payload->>'recoveryOwnerNotifiedAt', '')
                end
            end
          ) is null
        )
      )
    order by booking.legacy_sanity_id, dispatch.updated_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) candidate;
$$;

revoke all on function commerce.preserve_terminal_email_dispatch()
  from public, anon, authenticated;
revoke all on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer)
  from public, anon, authenticated;

grant execute on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer)
  to service_role;
grant execute on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz)
  to service_role;
grant execute on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer)
  to service_role;
