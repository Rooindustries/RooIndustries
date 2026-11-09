set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_fetch_shadow_document_sizes(
  p_document_types text[],
  p_after_id text default null,
  p_limit integer default 500,
  p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb
)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('_id', selected.legacy_sanity_id,
    'bytes', selected.bytes) order by selected.legacy_sanity_id), '[]'::jsonb)
  from (
    select legacy_sanity_id,
      octet_length(regexp_replace(payload::text, '("(?:[^"\\]|\\.)*")|[[:space:]]+', '\1', 'g')) as bytes
    from migration.source_documents
    where not tombstoned
      and (p_document_types is null or document_type = any(p_document_types))
      and (p_after_id is null or legacy_sanity_id > p_after_id)
      and (p_ids is null or legacy_sanity_id = any(p_ids))
      and not exists (select 1 from jsonb_array_elements(p_filters) filter
        where not migration.shadow_filter_matches(payload, filter))
    order by legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 500), 500))
  ) selected;
$$;

revoke all on function public.roo_fetch_shadow_document_sizes(text[], text, integer, text[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_fetch_shadow_document_sizes(text[], text, integer, text[], jsonb)
  to service_role;

create or replace function public.roo_fetch_recovery_payment_document_ids(
  p_backend text,
  p_statuses text[],
  p_refunded_status text,
  p_booked_status text,
  p_abandoned_status text,
  p_now timestamptz,
  p_limit integer default 50,
  p_dodo_enabled boolean default true,
  p_excluded_ids text[] default '{}'::text[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at
    from commerce.payment_records payment
    join migration.source_documents source
      on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and payment.legacy_sanity_id <> all(coalesce(p_excluded_ids, '{}'::text[]))
      and coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb
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
  select coalesce(jsonb_agg(legacy_sanity_id order by updated_at, legacy_sanity_id), '[]'::jsonb)
  from candidates;
$$;

revoke all on function public.roo_fetch_recovery_payment_document_ids(text,text[],text,text,text,timestamptz,integer,boolean,text[])
  from public, anon, authenticated, service_role;
grant execute on function public.roo_fetch_recovery_payment_document_ids(text,text[],text,text,text,timestamptz,integer,boolean,text[])
  to service_role;

create or replace function public.roo_list_email_dispatch_recovery_booking_ids(
  p_dispatch_kind text,
  p_now timestamptz default now(),
  p_limit integer default 20,
  p_excluded_ids text[] default '{}'::text[]
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
    where booking.legacy_sanity_id <> all(coalesce(p_excluded_ids, '{}'::text[]))
      and dispatch.dispatch_kind = lower(btrim(p_dispatch_kind))
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

revoke all on function public.roo_list_email_dispatch_recovery_booking_ids(text,timestamptz,integer,text[])
  from public, anon, authenticated, service_role;
grant execute on function public.roo_list_email_dispatch_recovery_booking_ids(text,timestamptz,integer,text[])
  to service_role;

create table if not exists commerce.referral_sync_cursor (
  singleton boolean primary key default true check (singleton),
  after_id text not null
);
revoke all on commerce.referral_sync_cursor from public, anon, authenticated, service_role;
create or replace function public.roo_referral_sync_cursor(p_after_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if p_after_id is not null then
    insert into commerce.referral_sync_cursor values (true, p_after_id)
    on conflict (singleton) do update set after_id = excluded.after_id;
  end if;
  return coalesce((select after_id from commerce.referral_sync_cursor), '');
end;
$$;
revoke all on function public.roo_referral_sync_cursor(text) from public, anon, authenticated, service_role;
grant execute on function public.roo_referral_sync_cursor(text) to service_role;
