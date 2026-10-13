set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function commerce.normalize_booking_confirmation_source(p_previous jsonb, p_document jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_previous jsonb := coalesce(p_previous, '{}'::jsonb);
  v_document jsonb := p_document;
  v_inactive boolean := lower(btrim(coalesce(p_document->>'status', '')))
    in ('failed', 'refunded', 'cancelled', 'canceled');
  v_was_inactive boolean := lower(btrim(coalesce(p_previous->>'status', '')))
    in ('failed', 'refunded', 'cancelled', 'canceled');
  v_field text;
  v_receipt record;
  v_recipient text;
  v_unknown boolean;
  v_receipt_repair boolean := false;
begin
  if v_inactive then
    for v_receipt in
      select dispatch.recipient_type, dispatch.sent_at, dispatch.provider_message_id
      from commerce.email_dispatches dispatch
      join commerce.bookings booking on booking.id = dispatch.booking_id
      where booking.legacy_sanity_id = v_document->>'_id'
        and dispatch.dispatch_kind = 'booking_confirmation' and dispatch.status = 'sent'
    loop
      v_recipient := case when v_receipt.recipient_type = 'customer' then 'Client' else 'Owner' end;
      if nullif(v_document->>('emailDispatch' || v_recipient || 'SentAt'), '') is null
        and v_receipt.sent_at is not null then
        v_document := v_document || jsonb_build_object('emailDispatch' || v_recipient || 'SentAt', v_receipt.sent_at);
        v_receipt_repair := true;
      end if;
      if nullif(v_document->>('emailDispatch' || v_recipient || 'ProviderId'), '') is null
        and v_receipt.provider_message_id is not null then
        v_document := v_document || jsonb_build_object('emailDispatch' || v_recipient || 'ProviderId', v_receipt.provider_message_id);
      end if;
    end loop;
    if v_was_inactive and (
      (nullif(p_document->>'emailDispatchLeaseId', '') is not null
        and p_document->>'emailDispatchLeaseId' is distinct from p_previous->>'emailDispatchLeaseId')
      or p_document->>'emailDispatchClientFirstAttemptAt' is distinct from p_previous->>'emailDispatchClientFirstAttemptAt'
      or p_document->>'emailDispatchOwnerFirstAttemptAt' is distinct from p_previous->>'emailDispatchOwnerFirstAttemptAt'
    ) and not v_receipt_repair then
      raise exception 'inactive booking cannot acquire an email transport lease' using errcode = '40001';
    end if;
    if v_was_inactive then
      foreach v_field in array array['emailDispatchAttemptCount', 'emailDispatchLastAttemptAt',
        'emailDispatchClientFirstAttemptAt', 'emailDispatchOwnerFirstAttemptAt'] loop
        v_document := v_document - v_field;
        if v_previous ? v_field then
          v_document := v_document || jsonb_build_object(v_field, v_previous->v_field);
        end if;
      end loop;
    end if;
    v_unknown := lower(btrim(coalesce(v_document->>'emailDispatchStatus', '')))
      in ('delivery_unknown', 'historical_unknown')
      or lower(btrim(coalesce(v_previous->>'emailDispatchStatus', '')))
        in ('delivery_unknown', 'historical_unknown');
    v_document := v_document || jsonb_build_object(
      'emailDispatchStatus', case
        when nullif(v_document->>'emailDispatchClientSentAt', '') is not null
          and nullif(v_document->>'emailDispatchOwnerSentAt', '') is not null then 'sent'
        when v_unknown then 'delivery_unknown'
        when nullif(v_document->>'emailDispatchClientSentAt', '') is not null
          or nullif(v_document->>'emailDispatchOwnerSentAt', '') is not null then 'partial'
        else 'failed' end,
      'emailDispatchLastError', case when v_unknown then 'email_delivery_unknown' else 'booking_inactive' end,
      'emailDispatchLeaseId', '', 'emailDispatchLeaseExpiresAt', '',
      'emailDispatchNextAttemptAt', '', 'emailDispatchDeferred', false
    );
  elsif v_was_inactive then
    if lower(btrim(coalesce(v_document->>'emailDispatchStatus', '')))
        not in ('delivery_unknown', 'historical_unknown') then
      if (nullif(v_previous->>'emailDispatchClientSentAt', '') is null
          and nullif(v_previous->>'emailDispatchClientFirstAttemptAt', '') is null)
        or (nullif(v_previous->>'emailDispatchOwnerSentAt', '') is null
          and nullif(v_previous->>'emailDispatchOwnerFirstAttemptAt', '') is null) then
        v_document := v_document || '{"emailDispatchAttemptCount":0}'::jsonb;
      end if;
      if v_document->>'emailDispatchLastError' = 'booking_inactive' then
        v_document := v_document || '{"emailDispatchLastError":""}'::jsonb;
      end if;
    end if;
    v_document := v_document || '{"emailDispatchLeaseId":"","emailDispatchLeaseExpiresAt":"","emailDispatchNextAttemptAt":""}'::jsonb;
  end if;
  return v_document;
end;
$$;

create or replace function commerce.guard_booking_confirmation_source()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.document_type = 'booking' and not new.tombstoned then
    new.payload := commerce.normalize_booking_confirmation_source(
      case when tg_op = 'UPDATE' then old.payload else '{}'::jsonb end, new.payload);
    new.source_hash := encode(extensions.digest(new.payload::text, 'sha256'), 'hex');
  end if;
  return new;
end;
$$;

drop trigger if exists guard_booking_confirmation_source on migration.source_documents;
create trigger guard_booking_confirmation_source
before insert or update of payload on migration.source_documents
for each row execute function commerce.guard_booking_confirmation_source();

do $migration$
declare
  definition text := pg_get_functiondef('migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)'::regprocedure);
  anchor text := '    v_now := clock_timestamp();';
begin
  if position('commerce.normalize_booking_confirmation_source' in definition) = 0 then
    if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
      raise exception 'booking confirmation migration: expected document mutation anchor once';
    end if;
    execute replace(definition, anchor, $replacement$    if v_type = 'booking' then
      v_payload := commerce.normalize_booking_confirmation_source(v_current.payload, v_payload);
    end if;
$replacement$ || anchor);
  end if;
end;
$migration$;

revoke all on function commerce.normalize_booking_confirmation_source(jsonb, jsonb) from public, anon, authenticated;
grant execute on function commerce.normalize_booking_confirmation_source(jsonb, jsonb) to service_role;
revoke all on function commerce.guard_booking_confirmation_source() from public, anon, authenticated;

create or replace function commerce.booking_confirmation_is_inactive(p_booking_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select lower(btrim(coalesce(source.payload->>'status', '')))
      in ('failed', 'refunded', 'cancelled', 'canceled')
    from commerce.bookings booking
    join migration.source_documents source on source.legacy_sanity_id = booking.legacy_sanity_id
    where booking.id = p_booking_id and not source.tombstoned
  ), true);
$$;

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
    new.last_error_code := null;
  elsif tg_op = 'UPDATE' and old.status = 'historical_unknown'
    and new.status not in ('historical_unknown', 'sent') then
    new.status := 'historical_unknown';
    new.last_error_code := old.last_error_code;
  end if;
  if new.status in ('sent', 'historical_unknown') then
    new.lease_id := null;
    new.lease_expires_at := null;
    new.next_attempt_at := null;
  elsif new.dispatch_kind = 'booking_confirmation' then
    if commerce.booking_confirmation_is_inactive(new.booking_id) then
      new.status := 'failed';
      new.last_error_code := 'booking_inactive';
      new.payload := coalesce(new.payload, '{}'::jsonb) || '{"booking_inactive":true}'::jsonb;
      if tg_op = 'UPDATE' and old.lease_id is not null then
        new.payload := new.payload || jsonb_build_object('booking_inactive_lease_id', old.lease_id);
      end if;
      new.lease_id := null;
      new.lease_expires_at := null;
      new.next_attempt_at := null;
    elsif new.last_error_code = 'booking_inactive'
      or (tg_op = 'UPDATE' and old.status = 'failed' and old.last_error_code = 'booking_inactive') then
      if new.status <> 'sending' then new.status := 'pending'; end if;
      new.last_error_code := null;
      new.next_attempt_at := null;
    end if;
  end if;
  return new;
end;
$$;

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
  if v_kind = 'booking_confirmation' and commerce.booking_confirmation_is_inactive(v_dispatch.booking_id) then
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
    'previously_suppressed', coalesce(v_dispatch.payload->>'booking_inactive', 'false') = 'true',
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
  if v_dispatch.status = 'historical_unknown' and not coalesce(p_success, false) then
    return jsonb_build_object(
      'completed', true, 'sent', false, 'historical_unknown', true,
      'idempotent', true, 'status', v_dispatch.status,
      'provider_message_id', v_dispatch.provider_message_id,
      'sent_at', v_dispatch.sent_at
    );
  end if;
  if v_dispatch.status = 'failed' and v_dispatch.last_error_code = 'booking_inactive'
    and not coalesce(p_success, false)
    and lower(btrim(coalesce(p_error_code, ''))) <> 'email_delivery_unknown' then
    return jsonb_build_object(
      'completed', true, 'sent', false, 'booking_inactive', true,
      'idempotent', true, 'status', v_dispatch.status,
      'provider_message_id', v_dispatch.provider_message_id,
      'sent_at', v_dispatch.sent_at
    );
  end if;
  if v_dispatch.lease_id is distinct from v_lease_id and not coalesce((
    v_dispatch.status = 'failed' and v_dispatch.last_error_code = 'booking_inactive'
    and (v_dispatch.payload->>'booking_inactive_lease_id' = v_lease_id or exists (
      select 1 from commerce.bookings booking
      join migration.source_documents source on source.legacy_sanity_id = booking.legacy_sanity_id
      where booking.id = v_dispatch.booking_id and not source.tombstoned
        and source.payload->>'emailDispatchLeaseId' = v_lease_id
        and migration.try_timestamptz(source.payload->>'emailDispatchLeaseExpiresAt') > now()
    ))
  ), false) then
    raise exception 'email dispatch lease conflict'
      using errcode = '40001';
  end if;

  v_status := case
    when coalesce(p_success, false) then 'sent'
    when lower(btrim(coalesce(p_error_code, ''))) = 'email_delivery_unknown' then 'historical_unknown'
    when v_dispatch.dispatch_kind = 'booking_confirmation' and lower(btrim(coalesce(p_error_code, ''))) = 'booking_inactive' then 'failed'
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
    'booking_inactive', v_dispatch.status = 'failed' and v_dispatch.last_error_code = 'booking_inactive',
    'idempotent', false,
    'status', v_dispatch.status,
    'provider_message_id', v_dispatch.provider_message_id,
    'sent_at', v_dispatch.sent_at
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
      and not source.tombstoned
      and dispatch.status <> 'historical_unknown'
      and (dispatch.dispatch_kind <> 'booking_confirmation'
        or not commerce.booking_confirmation_is_inactive(booking.id)
        or dispatch.status = 'sent')
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
          dispatch.dispatch_kind = 'booking_confirmation'
          and dispatch.status = 'failed' and dispatch.last_error_code = 'booking_inactive'
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

create or replace function public.roo_fetch_recovery_payment_documents(
  p_backend text,
  p_statuses text[],
  p_refunded_status text,
  p_booked_status text,
  p_abandoned_status text,
  p_now timestamptz,
  p_limit integer default 50,
  p_dodo_enabled boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at, source.payload
    from commerce.payment_records payment
    join migration.source_documents source
      on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and not (coalesce(source.payload->'providerRecoveryTerminal', 'false'::jsonb) = 'true'::jsonb
        and coalesce(source.payload->>'providerRecoveryTerminalReason', '')
          in ('payment_currency_mismatch', 'payment_currency_invalid'))
      and (
        lower(btrim(payment.status)) not in ('email_partial', lower(btrim(p_booked_status)))
        or payment.refund_requires_booking_sync
        or payment.resource_release_pending
        or coalesce(source.payload->>'requiresReschedule', 'false') = 'true'
        or not exists (
          select 1 from commerce.bookings booking
          where (booking.id = payment.booking_id
            or booking.legacy_sanity_id = source.payload->>'bookingId')
            and commerce.booking_confirmation_is_inactive(booking.id)
        )
      )
      and (
        payment.provider != 'dodo'
        or (p_dodo_enabled and coalesce(source.payload->>'providerRecoveryTerminal', 'false') != 'true')
        or (payment.refund_requires_booking_sync)
        or payment.resource_release_pending
        or (payment.status = 'email_partial' and source.payload->>'requiresReschedule' = 'true')
        or (payment.status in ('email_partial', lower(p_booked_status)) and payment.email_dispatch_required)
      )
      and (
        payment.status = any(coalesce(p_statuses, '{}'::text[]))
        or (payment.refund_requires_booking_sync)
        or (payment.status = lower(p_booked_status) and payment.email_dispatch_required)
        or (payment.status = lower(p_abandoned_status)
          and (payment.resource_release_pending or payment.late_capture_watch_until is not null))
      )
      and (payment.next_recovery_at is null or payment.next_recovery_at <= p_now)
    order by coalesce(payment.next_recovery_at, '-infinity'::timestamptz), payment.updated_at, payment.id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  select coalesce(jsonb_agg(payload order by updated_at, legacy_sanity_id), '[]'::jsonb)
  from candidates;
$$;

do $migration$
declare
  definition text;
  confirmation text;
  patched text;
  start_at integer;
  end_at integer;
  status_anchor text := $anchor$      when lower(btrim(coalesce(source.payload->>'emailDispatchStatus', ''))) in ('partial', 'failed')$anchor$;
  error_anchor text := $anchor$    nullif(source.payload->>'emailDispatchLastError', ''),$anchor$;
  update_anchor text := $anchor$    status = case
      when commerce.email_dispatches.status = 'historical_unknown'
        and excluded.status <> 'sent' then 'historical_unknown'
      else excluded.status
    end,$anchor$;
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'commerce.email_dispatches'::regclass
      and tgname = 'preserve_terminal_email_dispatch' and not tgisinternal and tgenabled <> 'D'
  ) then
    raise exception 'inactive booking confirmation migration requires the terminal-state trigger';
  end if;
  definition := pg_get_functiondef('migration.project_commerce_extensions(text[])'::regprocedure);
  start_at := strpos(definition, '  insert into commerce.email_dispatches (');
  end_at := start_at + strpos(substring(definition from start_at + 1), '  insert into commerce.email_dispatches (');
  if start_at = 0 or end_at <= start_at then
    raise exception 'inactive booking confirmation migration: missing confirmation projection';
  end if;
  confirmation := substring(definition from start_at for end_at - start_at);
  if strpos(confirmation, 'commerce.booking_confirmation_is_inactive') > 0 then
    return;
  end if;
  patched := replace(confirmation, 'lower(coalesce(source.payload->>''emailDispatchStatus'', ''''))',
    'lower(btrim(coalesce(source.payload->>''emailDispatchStatus'', '''')))');
  if strpos(patched, status_anchor) = 0 or strpos(patched, error_anchor) = 0
    or strpos(patched, update_anchor) = 0 then
    raise exception 'inactive booking confirmation migration: unexpected projection contract';
  end if;
  patched := replace(patched, status_anchor, $replacement$      when commerce.booking_confirmation_is_inactive(booking.id)
        and lower(btrim(coalesce(source.payload->>'emailDispatchStatus', ''))) <> 'sent' then 'failed'
$replacement$ || status_anchor);
  patched := replace(patched, error_anchor, $replacement$    case
      when nullif(source.payload->>(case when recipient.kind = 'customer'
        then 'emailDispatchClientSentAt' else 'emailDispatchOwnerSentAt' end), '') is not null
        or lower(btrim(coalesce(source.payload->>'emailDispatchStatus', ''))) = 'sent' then null
      when lower(btrim(coalesce(source.payload->>'emailDispatchStatus', ''))) = 'delivery_unknown'
        then coalesce(nullif(source.payload->>'emailDispatchLastError', ''), 'email_delivery_unknown')
      when commerce.booking_confirmation_is_inactive(booking.id) then 'booking_inactive'
      when lower(btrim(coalesce(source.payload->>'emailDispatchLastError', ''))) = 'booking_inactive' then null
      else nullif(source.payload->>'emailDispatchLastError', '')
    end,$replacement$);
  patched := replace(patched, update_anchor, $replacement$    status = case
      when commerce.email_dispatches.status = 'sent' then 'sent'
      when commerce.email_dispatches.status = 'historical_unknown'
        and excluded.status <> 'sent' then 'historical_unknown'
      when commerce.email_dispatches.status = 'failed'
        and commerce.email_dispatches.last_error_code = 'booking_inactive'
        and excluded.status not in ('sent', 'historical_unknown')
        and not commerce.booking_confirmation_is_inactive(excluded.booking_id) then 'pending'
      else excluded.status
    end,$replacement$);
  patched := replace(patched, '    last_error_code = excluded.last_error_code,', $replacement$    last_error_code = case
      when commerce.email_dispatches.status = 'sent' or excluded.status = 'sent' then null
      when commerce.email_dispatches.status = 'historical_unknown' then commerce.email_dispatches.last_error_code
      when not commerce.booking_confirmation_is_inactive(excluded.booking_id)
        and commerce.email_dispatches.last_error_code = 'booking_inactive' then null
      else excluded.last_error_code
    end,$replacement$);
  execute substring(definition from 1 for start_at - 1) || patched || substring(definition from end_at);
end;
$migration$;

revoke all on function commerce.booking_confirmation_is_inactive(uuid) from public, anon, authenticated;
grant execute on function commerce.booking_confirmation_is_inactive(uuid) to service_role;
revoke all on function commerce.preserve_terminal_email_dispatch() from public, anon, authenticated;
revoke all on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.roo_claim_booking_email_dispatch(text, text, text, text, integer) to service_role;
revoke all on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.roo_complete_booking_email_dispatch(text, text, boolean, text, text, timestamptz, timestamptz) to service_role;
revoke all on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.roo_list_email_dispatch_recovery_bookings(text, timestamptz, integer) to service_role;
revoke all on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean) to service_role;
