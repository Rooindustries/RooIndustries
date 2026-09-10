drop function if exists public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer);

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
      and payment.backend_owner = case
        when lower(p_backend) = 'supabase' then 'supabase' else 'sanity' end
      and (
        payment.provider != 'dodo'
        or (p_dodo_enabled and coalesce(source.payload->>'providerRecoveryTerminal', 'false') != 'true')
        or (payment.status = lower(p_refunded_status) and payment.refund_requires_booking_sync)
        or payment.resource_release_pending
        or (payment.status = 'email_partial' and source.payload->>'requiresReschedule' = 'true')
        or (payment.status in ('email_partial', lower(p_booked_status)) and payment.email_dispatch_required)
      )
      and (
        payment.status = any(coalesce(p_statuses, '{}'::text[]))
        or (payment.status = lower(p_refunded_status) and payment.refund_requires_booking_sync)
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

revoke all on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean)
  to service_role;
