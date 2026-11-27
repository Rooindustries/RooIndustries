set lock_timeout = '5s';
set statement_timeout = '120s';

create sequence if not exists commerce.reconcile_fence_seq;
create table if not exists commerce.reconcile_cleanup_runs (
  run_id uuid primary key default gen_random_uuid(),
  state text not null check (state in ('running', 'completed', 'failed', 'timed_out')),
  lease_expires_at timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  fenced_seq bigint
);
create table if not exists commerce.reconcile_hold_cleanup_blocks (
  payment_record_id text not null,
  run_id uuid not null references commerce.reconcile_cleanup_runs(run_id) on delete cascade,
  blocked_at timestamptz not null default clock_timestamp(),
  inspection_started_seq bigint,
  primary key (payment_record_id, run_id)
);
create index if not exists idx_reconcile_hold_cleanup_blocks_run_id on commerce.reconcile_hold_cleanup_blocks (run_id);
create index if not exists idx_reconcile_cleanup_runs_running_lease on commerce.reconcile_cleanup_runs (lease_expires_at) where state = 'running';
revoke all on sequence commerce.reconcile_fence_seq from public, anon, authenticated;
grant usage, select on sequence commerce.reconcile_fence_seq to service_role;
revoke all on table commerce.reconcile_cleanup_runs, commerce.reconcile_hold_cleanup_blocks from public, anon, authenticated;
grant select, insert, update, delete on table commerce.reconcile_cleanup_runs, commerce.reconcile_hold_cleanup_blocks to service_role;

create or replace function commerce.is_pending_or_partial_dodo_state(p_state text)
returns boolean language sql immutable set search_path = '' as $$
  select lower(btrim(coalesce(p_state, ''))) in ('processing', 'requires_payment_method', 'requires_customer_action', 'requires_merchant_action', 'requires_confirmation', 'requires_capture', 'partially_captured', 'partially_captured_and_capturable');
$$;

create or replace function commerce.has_explicit_owner_review(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select ((p_payload->'recoveryOwnerReviewRequired' = 'true'::jsonb)
    or coalesce(p_payload->>'recoveryReason', '') in ('captured_payment_release_requires_review', 'late_capture_watch_unverified_owner_review', 'resource_release_exhausted_owner_review')
    or coalesce(p_payload->>'providerRecoveryTerminalReason', '') = 'dodo_refund_details_incomplete'
    or (lower(coalesce(p_status, '')) = 'needs_recovery' and (p_payload->'reconciliationRecoveryTerminal' = 'true'::jsonb)
      and coalesce(p_payload->>'recoveryReason', '') in ('upgrade_credit_changed_after_quote', 'upgrade_credit_unverified'))) is true;
$$;

create or replace function commerce.has_verified_reversal(p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (lower(coalesce(p_payload->>'providerPaymentState', '')) in ('refunded', 'disputed') and (p_payload->'providerReversalVerified' = 'true'::jsonb)) is true;
$$;

create or replace function commerce.has_preserved_owner_review(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (commerce.has_explicit_owner_review(p_status, p_payload)
    or (lower(coalesce(p_payload->>'provider', '')) = 'dodo' and (p_payload->'providerRecoveryTerminal' = 'true'::jsonb)
      and lower(coalesce(p_status, '')) = 'needs_recovery' and not commerce.has_verified_reversal(p_payload))) is true;
$$;

create or replace function commerce.safe_payload_timestamptz(p_payload jsonb, p_key text)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare v_raw text; v_ts timestamptz;
begin
  if p_payload is null or jsonb_typeof(p_payload->p_key) <> 'string' then return null; end if;
  v_raw := btrim(p_payload->>p_key, E' \t\r\n');
  if v_raw = '' or v_raw !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$' then return null; end if;
  v_ts := v_raw::timestamptz;
  if not pg_catalog.isfinite(v_ts) then return null; end if;
  return v_ts;
exception when others then return null;
end;
$$;

create or replace function commerce.has_active_late_capture_watch(p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select commerce.safe_payload_timestamptz(p_payload, 'lateCaptureWatchUntil') is not null;
$$;

create or replace function commerce.dodo_cleanup_allowed(p_payload jsonb, p_now timestamptz, p_dodo_enabled boolean)
returns boolean language sql immutable set search_path = '' as $$
  select (coalesce(p_dodo_enabled, false) or not commerce.is_pending_or_partial_dodo_state(p_payload->>'providerPaymentState')
    or (commerce.has_active_late_capture_watch(p_payload) and commerce.safe_payload_timestamptz(p_payload, 'lateCaptureWatchUntil') <= p_now)) is true;
$$;

create or replace function commerce.payment_protects_expired_hold(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (commerce.has_preserved_owner_review(p_status, p_payload)
    or (lower(coalesce(p_payload->>'providerPaymentState', '')) in ('refunded', 'disputed') and not commerce.has_verified_reversal(p_payload))
    or (lower(coalesce(p_payload->>'provider', '')) = 'dodo' and (p_payload->'resourceReleasePending' = 'true'::jsonb)
      and (coalesce(p_payload->>'recoveryReason', '') = 'resource_release_exhausted'
        or ((p_payload->'reconciliationRecoveryTerminal' = 'true'::jsonb) and jsonb_typeof(p_payload->'recoveryFailureCount') = 'number' and (p_payload->>'recoveryFailureCount')::numeric >= 12)))
    or (not commerce.has_verified_reversal(p_payload) and (
      lower(coalesce(p_status, '')) in ('captured', 'captured_client', 'captured_webhook', 'verified_server', 'finalizing', 'booked', 'email_partial')
      or lower(coalesce(p_payload->>'verificationState', '')) = 'server_verified'
      or lower(coalesce(p_payload->>'providerPaymentState', '')) in ('succeeded', 'processing', 'requires_merchant_action', 'requires_capture', 'partially_captured', 'partially_captured_and_capturable')
      or coalesce(p_payload->>'recoveryReason', '') = 'dodo_refund_requires_reconciliation'
      or nullif(btrim(coalesce(p_payload->>'captureClaimedAt', '')), '') is not null))) is true;
$$;

create or replace function commerce.is_cleanup_pending(p_status text, p_resource_release_pending boolean, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (case when p_payload ? 'resourceReleasePending' then (p_payload->'resourceReleasePending' = 'true'::jsonb) is true else coalesce(p_resource_release_pending, false) end
    and not commerce.has_preserved_owner_review(p_status, p_payload)) is true;
$$;

create or replace function commerce.exhausted_pending_cleanup_needs_resume(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (lower(coalesce(p_payload->>'provider', '')) = 'dodo' and (p_payload->'reconciliationRecoveryTerminal' = 'true'::jsonb)
    and (p_payload->'resourceReleasePending' = 'true'::jsonb) and not ((p_payload->'providerRecoveryTerminal' = 'true'::jsonb) is true)
    and not commerce.has_preserved_owner_review(p_status, p_payload)) is true;
$$;

create or replace function commerce.exhausted_live_dodo_state_needs_resume(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (lower(coalesce(p_payload->>'provider', '')) = 'dodo' and (p_payload->'reconciliationRecoveryTerminal' = 'true'::jsonb)
    and not ((p_payload->'resourceReleasePending' = 'true'::jsonb) is true) and not ((p_payload->'providerRecoveryTerminal' = 'true'::jsonb) is true)
    and not commerce.has_preserved_owner_review(p_status, p_payload) and commerce.is_pending_or_partial_dodo_state(p_payload->>'providerPaymentState')) is true;
$$;

create or replace function commerce.exhausted_cleanup_watch_active(p_status text, p_payload jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (lower(coalesce(p_payload->>'provider', '')) = 'dodo' and (p_payload->'reconciliationRecoveryTerminal' = 'true'::jsonb)
    and not ((p_payload->'providerRecoveryTerminal' = 'true'::jsonb) is true) and not commerce.has_preserved_owner_review(p_status, p_payload)
    and lower(coalesce(p_status, '')) in ('failed', 'abandoned') and commerce.has_active_late_capture_watch(p_payload)) is true;
$$;

create or replace function commerce.exhausted_resume_is_due(p_payload jsonb, p_next_recovery_at timestamptz, p_now timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select (coalesce(commerce.safe_payload_timestamptz(p_payload, 'nextRecoveryAt'), p_next_recovery_at) is null
    or coalesce(commerce.safe_payload_timestamptz(p_payload, 'nextRecoveryAt'), p_next_recovery_at) <= p_now
    or coalesce(commerce.safe_payload_timestamptz(p_payload, 'nextRecoveryAt'), p_next_recovery_at) >= '2090-01-01T00:00:00Z'::timestamptz) is true;
$$;

create or replace function commerce.expire_timed_out_reconcile_runs(p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0;
begin
  update commerce.reconcile_cleanup_runs
  set state = 'timed_out', finished_at = p_now, fenced_seq = nextval('commerce.reconcile_fence_seq')
  where state = 'running' and lease_expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.roo_start_reconcile_cleanup_run(p_lease_seconds integer default 180)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_lease timestamptz; v_run_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  v_lease := v_now + make_interval(secs => greatest(1, least(coalesce(p_lease_seconds, 180), 900)));
  insert into commerce.reconcile_cleanup_runs (state, lease_expires_at, started_at) values ('running', v_lease, v_now) returning run_id into v_run_id;
  return jsonb_build_object('run_id', v_run_id, 'lease_expires_at', v_lease);
end;
$$;

create or replace function public.roo_begin_reconcile_record_inspection(p_run_id uuid, p_payment_record_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_seq bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  if not exists (select 1 from commerce.reconcile_cleanup_runs where run_id = p_run_id and state = 'running' and lease_expires_at > v_now) then
    return jsonb_build_object('ok', false, 'reason', 'run_not_active');
  end if;
  v_seq := nextval('commerce.reconcile_fence_seq');
  insert into commerce.reconcile_hold_cleanup_blocks (payment_record_id, run_id, blocked_at, inspection_started_seq)
  values (p_payment_record_id, p_run_id, v_now, v_seq)
  on conflict (payment_record_id, run_id) do update set inspection_started_seq = excluded.inspection_started_seq;
  return jsonb_build_object('ok', true, 'inspection_started_seq', v_seq);
end;
$$;

create or replace function public.roo_clear_reconcile_cleanup_block(p_run_id uuid, p_payment_record_id text, p_conclusive_provider_evidence boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_started_seq bigint; v_fenced_cleared integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  if not exists (select 1 from commerce.reconcile_cleanup_runs where run_id = p_run_id and state = 'running' and lease_expires_at > v_now) then
    return jsonb_build_object('ok', false, 'reason', 'run_not_active');
  end if;
  select inspection_started_seq into v_started_seq from commerce.reconcile_hold_cleanup_blocks where payment_record_id = p_payment_record_id and run_id = p_run_id;
  delete from commerce.reconcile_hold_cleanup_blocks where payment_record_id = p_payment_record_id and run_id = p_run_id;
  if (p_conclusive_provider_evidence is true) and v_started_seq is not null then
    delete from commerce.reconcile_hold_cleanup_blocks b using commerce.reconcile_cleanup_runs r
    where b.run_id = r.run_id and b.payment_record_id = p_payment_record_id
      and r.state in ('failed', 'timed_out') and r.fenced_seq is not null and v_started_seq > r.fenced_seq;
    get diagnostics v_fenced_cleared = row_count;
  elsif v_started_seq is not null then
    update commerce.reconcile_hold_cleanup_blocks b set blocked_at = v_now
    from commerce.reconcile_cleanup_runs r
    where b.run_id = r.run_id and b.payment_record_id = p_payment_record_id
      and r.state in ('failed', 'timed_out');
  end if;
  return jsonb_build_object('ok', true, 'fenced_cleared', v_fenced_cleared);
end;
$$;

create or replace function public.roo_fail_reconcile_cleanup_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_fenced_seq bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  update commerce.reconcile_cleanup_runs
  set state = 'failed', finished_at = v_now, fenced_seq = coalesce(fenced_seq, nextval('commerce.reconcile_fence_seq'))
  where run_id = p_run_id and state = 'running' returning fenced_seq into v_fenced_seq;
  return jsonb_build_object('ok', true, 'fenced_seq', v_fenced_seq);
end;
$$;

create or replace function public.roo_complete_reconcile_cleanup_run(p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz; v_state text; v_lease timestamptz; v_remaining integer := 0; v_fenced_seq bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  select state, lease_expires_at into v_state, v_lease from commerce.reconcile_cleanup_runs where run_id = p_run_id;
  select count(*)::integer into v_remaining from commerce.reconcile_hold_cleanup_blocks where run_id = p_run_id;
  if v_state = 'running' and v_lease > v_now and v_remaining = 0 then
    update commerce.reconcile_cleanup_runs set state = 'completed', finished_at = v_now where run_id = p_run_id;
    delete from commerce.reconcile_cleanup_runs r
    where r.state <> 'running' and r.run_id <> p_run_id and r.finished_at <= v_now - interval '1 hour'
      and not exists (select 1 from commerce.reconcile_hold_cleanup_blocks b where b.run_id = r.run_id);
    return jsonb_build_object('ok', true, 'completed', true, 'remaining_blocks', 0);
  end if;
  if v_state = 'running' then
    update commerce.reconcile_cleanup_runs set state = 'failed', finished_at = v_now, fenced_seq = nextval('commerce.reconcile_fence_seq')
    where run_id = p_run_id returning fenced_seq into v_fenced_seq;
  end if;
  return jsonb_build_object('ok', false, 'completed', false, 'remaining_blocks', v_remaining, 'fenced_seq', v_fenced_seq);
end;
$$;

drop function if exists public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean);

do $migration$
declare
  has_watch_resume boolean := to_regprocedure('commerce.exhausted_late_capture_watch_needs_resume(jsonb)') is not null;
  v_terminal text := case when has_watch_resume then $t$(not ((source.payload->'reconciliationRecoveryTerminal' = 'true'::jsonb) is true) or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$t$ else $t$not ((source.payload->'reconciliationRecoveryTerminal' = 'true'::jsonb) is true)$t$ end;
  v_due text := case when has_watch_resume then $d$(coalesce(commerce.safe_payload_timestamptz(source.payload, 'nextRecoveryAt'), payment.next_recovery_at) is null or coalesce(commerce.safe_payload_timestamptz(source.payload, 'nextRecoveryAt'), payment.next_recovery_at) <= p_now or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$d$ else $d$(coalesce(commerce.safe_payload_timestamptz(source.payload, 'nextRecoveryAt'), payment.next_recovery_at) is null or coalesce(commerce.safe_payload_timestamptz(source.payload, 'nextRecoveryAt'), payment.next_recovery_at) <= p_now)$d$ end;
begin
  execute format($fn$
create or replace function public.roo_fetch_recovery_payment_documents(p_backend text, p_statuses text[], p_refunded_status text, p_booked_status text, p_abandoned_status text, p_now timestamptz, p_limit integer default 50, p_dodo_enabled boolean default true, p_run_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $body$
declare v_now timestamptz; v_result jsonb := '[]'::jsonb; v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  if p_run_id is not null and not exists (select 1 from commerce.reconcile_cleanup_runs where run_id = p_run_id and state = 'running' and lease_expires_at > v_now) then
    raise exception 'reconcile_run_not_active' using errcode = 'P0001';
  end if;
  with candidates as (
    select payment.legacy_sanity_id, source.payload,
      case when (commerce.exhausted_pending_cleanup_needs_resume(payment.status, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled))
        or (p_dodo_enabled and commerce.exhausted_live_dodo_state_needs_resume(payment.status, source.payload)) then 0 else 1 end as priority_rank,
      coalesce(nullif(source.payload->>'nextRecoveryAt', ''), '') collate "C" as sort_next_recovery_at,
      coalesce(nullif(source.payload->>'updatedAt', ''), '') collate "C" as sort_updated_at,
      coalesce(nullif(source.payload->>'_id', ''), payment.legacy_sanity_id) collate "C" as sort_id
    from commerce.payment_records payment join migration.source_documents source on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and (%s or (commerce.exhausted_pending_cleanup_needs_resume(payment.status, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled))
        or (p_dodo_enabled and commerce.exhausted_live_dodo_state_needs_resume(payment.status, source.payload))
        or (p_dodo_enabled and commerce.exhausted_cleanup_watch_active(payment.status, source.payload)))
      and not ((source.payload->'providerRecoveryTerminal' = 'true'::jsonb) is true and coalesce(source.payload->>'providerRecoveryTerminalReason', '') in ('payment_currency_mismatch', 'payment_currency_invalid'))
      and (lower(btrim(payment.status)) not in ('email_partial', lower(btrim(p_booked_status))) or payment.refund_requires_booking_sync
        or (commerce.is_cleanup_pending(payment.status, payment.resource_release_pending, source.payload) and (payment.provider != 'dodo' or commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled)))
        or (source.payload->'requiresReschedule' = 'true'::jsonb) is true
        or not exists (select 1 from commerce.bookings booking where (booking.id = payment.booking_id or booking.legacy_sanity_id = source.payload->>'bookingId') and commerce.booking_confirmation_is_inactive(booking.id)))
      and (payment.provider != 'dodo' or (p_dodo_enabled and not ((source.payload->'providerRecoveryTerminal' = 'true'::jsonb) is true))
        or payment.refund_requires_booking_sync
        or (commerce.is_cleanup_pending(payment.status, payment.resource_release_pending, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled))
        or (commerce.exhausted_pending_cleanup_needs_resume(payment.status, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled))
        or (p_dodo_enabled and commerce.exhausted_live_dodo_state_needs_resume(payment.status, source.payload))
        or (payment.status = 'email_partial' and (source.payload->'requiresReschedule' = 'true'::jsonb) is true)
        or (payment.status in ('email_partial', lower(p_booked_status)) and payment.email_dispatch_required))
      and (payment.status = any(coalesce(p_statuses, '{}'::text[])) or payment.refund_requires_booking_sync
        or (payment.status = lower(p_booked_status) and payment.email_dispatch_required)
        or (lower(payment.status) in (lower(p_abandoned_status), 'failed')
          and ((commerce.is_cleanup_pending(payment.status, payment.resource_release_pending, source.payload) and (payment.provider != 'dodo' or commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled)))
            or commerce.has_active_late_capture_watch(source.payload)))
        or (commerce.exhausted_pending_cleanup_needs_resume(payment.status, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled))
        or (p_dodo_enabled and commerce.exhausted_live_dodo_state_needs_resume(payment.status, source.payload)))
      and (%s or (commerce.exhausted_pending_cleanup_needs_resume(payment.status, source.payload) and commerce.dodo_cleanup_allowed(source.payload, p_now, p_dodo_enabled) and commerce.exhausted_resume_is_due(source.payload, payment.next_recovery_at, p_now))
        or (p_dodo_enabled and commerce.exhausted_live_dodo_state_needs_resume(payment.status, source.payload) and commerce.exhausted_resume_is_due(source.payload, payment.next_recovery_at, p_now)))
    order by priority_rank asc, sort_next_recovery_at asc, sort_updated_at asc, sort_id asc limit v_limit
  ),
  registered as (
    insert into commerce.reconcile_hold_cleanup_blocks (payment_record_id, run_id, blocked_at)
    select c.legacy_sanity_id, p_run_id, v_now from candidates c where p_run_id is not null on conflict (payment_record_id, run_id) do nothing returning payment_record_id
  )
  select coalesce(jsonb_agg(c.payload order by c.priority_rank asc, c.sort_next_recovery_at asc, c.sort_updated_at asc, c.sort_id asc), '[]'::jsonb) into v_result from candidates c;
  return v_result;
end;
$body$;
$fn$, v_terminal, v_due);
end;
$migration$;

create or replace function public.roo_fetch_owner_review_dodo_documents(p_run_id uuid, p_now timestamptz default null, p_limit integer default 20)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_now timestamptz; v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100)); v_due_cutoff timestamptz; v_result jsonb := '[]'::jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  v_due_cutoff := coalesce(p_now, v_now) - interval '1 hour';
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  if p_run_id is not null and not exists (select 1 from commerce.reconcile_cleanup_runs where run_id = p_run_id and state = 'running' and lease_expires_at > v_now) then
    raise exception 'reconcile_run_not_active' using errcode = 'P0001';
  end if;
  with base as (
    select payment.legacy_sanity_id, payment.legacy_sanity_id collate "C" as sort_id, source.payload,
      lower(btrim(coalesce(source.payload->>'providerPaymentState', ''))) as pstate,
      commerce.safe_payload_timestamptz(source.payload, 'providerStateCheckedAt') as checked_at,
      (select min(b.blocked_at) from commerce.reconcile_hold_cleanup_blocks b join commerce.reconcile_cleanup_runs r on r.run_id = b.run_id where b.payment_record_id = payment.legacy_sanity_id and r.state in ('failed', 'timed_out')) as fenced_blocked_at,
      exists (select 1 from commerce.slot_holds h where h.payment_record_id = payment.id and h.phase = 'payment') as has_payment_hold
    from commerce.payment_records payment join migration.source_documents source on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned and payment.provider = 'dodo'
      and nullif(btrim(coalesce(source.payload->>'bookingId', '')), '') is null
      and nullif(btrim(coalesce(source.payload->>'providerOrderId', '')), '') is not null
  ),
  eligible as (
    select legacy_sanity_id, sort_id, payload, tier, sort_ts from (
      select legacy_sanity_id, sort_id, payload,
        case when fenced_blocked_at is not null and has_payment_hold then 0
          when pstate in ('refunded', 'disputed') and not ((payload->'providerReversalVerified' = 'true'::jsonb) is true)
            and coalesce(payload->>'providerRecoveryTerminalReason', '') not in ('dodo_session_mismatch', 'dodo_payment_binding_mismatch')
            and (checked_at is null or checked_at <= v_due_cutoff or checked_at >= '2090-01-01T00:00:00Z'::timestamptz) then 1
          when (pstate = 'unknown' or commerce.is_pending_or_partial_dodo_state(pstate)) and checked_at is not null and checked_at <= v_due_cutoff then 2
          when pstate = 'succeeded' and checked_at is not null and checked_at <= v_due_cutoff then 3 else 9 end as tier,
        case when fenced_blocked_at is not null and has_payment_hold then fenced_blocked_at else coalesce(checked_at, '-infinity'::timestamptz) end as sort_ts
      from base
    ) ranked where tier < 9
  ),
  reserved_succeeded as (select * from eligible where tier = 3 order by sort_ts asc, sort_id asc limit least(4, v_limit)),
  top_priority as (select * from eligible where tier in (0, 1) order by tier asc, sort_ts asc, sort_id asc limit greatest(0, v_limit - (select count(*) from reserved_succeeded))),
  unconfirmed_fill as (select * from eligible where tier = 2 order by sort_ts asc, sort_id asc limit greatest(0, v_limit - (select count(*) from top_priority) - (select count(*) from reserved_succeeded))),
  extra_succeeded as (select * from eligible where tier = 3 and legacy_sanity_id not in (select legacy_sanity_id from reserved_succeeded) order by sort_ts asc, sort_id asc limit greatest(0, v_limit - (select count(*) from top_priority) - (select count(*) from reserved_succeeded) - (select count(*) from unconfirmed_fill))),
  picked as (select * from top_priority union all select * from unconfirmed_fill union all select * from reserved_succeeded union all select * from extra_succeeded),
  registered as (
    insert into commerce.reconcile_hold_cleanup_blocks (payment_record_id, run_id, blocked_at)
    select p.legacy_sanity_id, p_run_id, v_now from picked p where p_run_id is not null on conflict (payment_record_id, run_id) do nothing returning payment_record_id
  )
  select coalesce(jsonb_agg(p.payload order by p.tier asc, p.sort_ts asc, p.sort_id asc), '[]'::jsonb) into v_result from picked p;
  return v_result;
end;
$$;

drop function if exists public.roo_cleanup_expired_supabase_holds(integer, integer);
create or replace function public.roo_cleanup_expired_supabase_holds(p_cutover_generation integer, p_limit integer default 100, p_include_payment_holds boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate record; v_claim_existed boolean; v_expired_holds integer := 0; v_removed_slot_claims integer := 0;
  v_mutation_result jsonb; v_payment_legacy_id text; v_payment_status text; v_payment_payload jsonb;
  v_has_active_run boolean := false; v_now timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  if coalesce(p_cutover_generation, -1) < 0 then raise exception 'invalid cutover generation' using errcode = '22023'; end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 500 then raise exception 'cleanup limit must be between 1 and 500' using errcode = '22023'; end if;
  perform migration.assert_commerce_write_fence(p_cutover_generation);
  perform commerce.expire_timed_out_reconcile_runs(v_now);
  delete from commerce.reconcile_hold_cleanup_blocks b using commerce.reconcile_cleanup_runs r
  where b.run_id = r.run_id and r.state in ('failed', 'timed_out')
    and (not exists (select 1 from commerce.slot_holds h join commerce.payment_records p on p.id = h.payment_record_id where p.legacy_sanity_id = b.payment_record_id and h.phase = 'payment')
      or (b.blocked_at <= v_now - interval '24 hours'
        and not exists (select 1 from commerce.payment_records p join migration.source_documents s on s.legacy_sanity_id = p.legacy_sanity_id
          where p.legacy_sanity_id = b.payment_record_id and not s.tombstoned and p.provider = 'dodo'
            and nullif(btrim(coalesce(s.payload->>'bookingId', '')), '') is null
            and nullif(btrim(coalesce(s.payload->>'providerOrderId', '')), '') is not null)));
  delete from commerce.reconcile_cleanup_runs r
  where r.state <> 'running' and r.finished_at <= v_now - interval '1 hour'
    and not exists (select 1 from commerce.reconcile_hold_cleanup_blocks b where b.run_id = r.run_id);
  select exists (select 1 from commerce.reconcile_cleanup_runs where state = 'running' and lease_expires_at > v_now) into v_has_active_run;

  for v_candidate in
    select hold.id hold_id, hold.phase hold_phase, hold.payment_record_id, source.legacy_sanity_id document_id, source.source_revision, source.payload
    from commerce.slot_holds hold join migration.source_documents source on source.legacy_sanity_id = hold.legacy_sanity_id
    where hold.cutover_generation = p_cutover_generation
      and ((hold.phase = 'active' and hold.expires_at <= v_now)
        or (coalesce(p_include_payment_holds, true) and not v_has_active_run and hold.phase = 'payment' and hold.expires_at <= v_now - interval '24 hours'
          and not exists (
            select 1 from commerce.payment_records payment
            left join migration.source_documents payment_source on payment_source.legacy_sanity_id = payment.legacy_sanity_id and payment_source.document_type = 'paymentRecord' and not payment_source.tombstoned
            where payment.id = hold.payment_record_id
              and (commerce.payment_protects_expired_hold(payment.status, payment_source.payload)
                or exists (select 1 from commerce.reconcile_hold_cleanup_blocks b where b.payment_record_id = payment.legacy_sanity_id)))))
      and source.cutover_generation = p_cutover_generation and source.document_type = 'slotHold' and not source.tombstoned
      and lower(coalesce(source.payload->>'phase', 'active')) in ('active', 'holding', 'payment', 'payment_pending')
    order by hold.expires_at, source.legacy_sanity_id for update of source skip locked limit least(p_limit, 100)
  loop
    if v_candidate.hold_phase = 'payment' and v_candidate.payment_record_id is not null then
      begin
        select payment.legacy_sanity_id, payment.status into v_payment_legacy_id, v_payment_status
        from commerce.payment_records payment where payment.id = v_candidate.payment_record_id for update nowait;
      exception when lock_not_available then continue;
      end;
      if v_payment_legacy_id is not null then
        if exists (select 1 from commerce.reconcile_hold_cleanup_blocks b where b.payment_record_id = v_payment_legacy_id) then continue; end if;
        v_payment_payload := null;
        begin
          select ps.payload into v_payment_payload from migration.source_documents ps
          where ps.legacy_sanity_id = v_payment_legacy_id and ps.document_type = 'paymentRecord' and not ps.tombstoned for update nowait;
        exception when lock_not_available then continue;
        end;
        if found and commerce.payment_protects_expired_hold(v_payment_status, v_payment_payload) then continue; end if;
      end if;
    end if;
    select exists (select 1 from commerce.slot_claims claim where claim.hold_id = v_candidate.hold_id) into v_claim_existed;
    select public.roo_apply_commerce_document_mutations(
      'cleanup.expired-hold.' || encode(extensions.digest(v_candidate.document_id || ':' || v_candidate.source_revision, 'sha256'), 'hex'),
      jsonb_build_array(jsonb_build_object('operation', 'replace', 'expected_revision', v_candidate.source_revision,
        'document', v_candidate.payload || jsonb_build_object('phase', 'expired', 'releasedAt', v_now, 'releaseReason', 'expired_by_operational_cleanup', 'holdNonce', gen_random_uuid()::text))),
      p_cutover_generation
    ) into v_mutation_result;
    v_expired_holds := v_expired_holds + 1;
    if v_claim_existed and not exists (select 1 from commerce.slot_claims claim where claim.hold_id = v_candidate.hold_id) then
      v_removed_slot_claims := v_removed_slot_claims + 1;
    end if;
  end loop;
  return jsonb_build_object('expired_holds', v_expired_holds, 'removed_slot_claims', v_removed_slot_claims, 'mirror_events_enqueued', 0, 'cutover_generation', p_cutover_generation);
end;
$$;

create or replace function migration.sync_source_document_payload_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.source_revision, '') <> '' and coalesce(new.payload->>'_rev', '') is distinct from new.source_revision then
    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('_rev', new.source_revision);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sync_source_document_payload_revision on migration.source_documents;
create trigger trg_sync_source_document_payload_revision before insert or update on migration.source_documents for each row execute function migration.sync_source_document_payload_revision();
do $backfill_rev$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  update migration.source_documents set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('_rev', source_revision)
  where coalesce(source_revision, '') <> '' and coalesce(payload->>'_rev', '') is distinct from source_revision;
end;
$backfill_rev$;

do $grants$
declare fn text;
begin
  foreach fn in array array[
    'commerce.is_pending_or_partial_dodo_state(text)', 'commerce.has_explicit_owner_review(text,jsonb)', 'commerce.has_verified_reversal(jsonb)',
    'commerce.has_preserved_owner_review(text,jsonb)', 'commerce.has_active_late_capture_watch(jsonb)', 'commerce.safe_payload_timestamptz(jsonb,text)',
    'commerce.dodo_cleanup_allowed(jsonb,timestamptz,boolean)', 'commerce.payment_protects_expired_hold(text,jsonb)', 'commerce.is_cleanup_pending(text,boolean,jsonb)',
    'commerce.exhausted_pending_cleanup_needs_resume(text,jsonb)', 'commerce.exhausted_live_dodo_state_needs_resume(text,jsonb)', 'commerce.exhausted_cleanup_watch_active(text,jsonb)',
    'commerce.exhausted_resume_is_due(jsonb,timestamptz,timestamptz)', 'commerce.expire_timed_out_reconcile_runs(timestamptz)', 'public.roo_start_reconcile_cleanup_run(integer)',
    'public.roo_begin_reconcile_record_inspection(uuid,text)', 'public.roo_clear_reconcile_cleanup_block(uuid,text,boolean)', 'public.roo_fail_reconcile_cleanup_run(uuid)',
    'public.roo_complete_reconcile_cleanup_run(uuid)', 'public.roo_fetch_owner_review_dodo_documents(uuid,timestamptz,integer)',
    'public.roo_fetch_recovery_payment_documents(text,text[],text,text,text,timestamptz,integer,boolean,uuid)', 'public.roo_cleanup_expired_supabase_holds(integer,integer,boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
  revoke all on function migration.sync_source_document_payload_revision() from public, anon, authenticated;
end;
$grants$;

do $cleanup_locks$
declare v text;
begin
  if to_regprocedure('migration.cleanup_commerce_document_ids(text[])') is null then return; end if;
  v := pg_get_functiondef('migration.cleanup_commerce_document_ids(text[])'::regprocedure);
  if strpos(v, 'delete from commerce.payment_upgrade_locks') > 0 then return; end if;
  execute regexp_replace(v, '\n  return jsonb_build_object\(\n    ''released_holds'', v_holds',
    E'\n  delete from commerce.payment_upgrade_locks lock\n  using migration.source_documents source\n  where source.legacy_sanity_id = lock.legacy_sanity_id\n    and source.tombstoned\n    and source.legacy_sanity_id = any(p_document_ids);\n\n  return jsonb_build_object(\n    ''released_holds'', v_holds');
end;
$cleanup_locks$;

notify pgrst, 'reload schema';
