set lock_timeout = '5s';
set statement_timeout = '120s';

drop trigger if exists trg_sync_source_document_payload_revision on migration.source_documents;
drop function if exists migration.sync_source_document_payload_revision();
drop function if exists public.roo_fetch_owner_review_dodo_documents(uuid, timestamptz, integer), public.roo_complete_reconcile_cleanup_run(uuid), public.roo_fail_reconcile_cleanup_run(uuid), public.roo_clear_reconcile_cleanup_block(uuid, text, boolean), public.roo_begin_reconcile_record_inspection(uuid, text), public.roo_start_reconcile_cleanup_run(integer), commerce.expire_timed_out_reconcile_runs(timestamptz), public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean, uuid), public.roo_cleanup_expired_supabase_holds(integer, integer, boolean);

do $rollback_fetch$
declare
  has_watch_resume boolean := to_regprocedure('commerce.exhausted_late_capture_watch_needs_resume(jsonb)') is not null;
  v_terminal text := case when has_watch_resume then $t$(coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$t$ else $t$coalesce(nullif(source.payload->'reconciliationRecoveryTerminal', 'null'::jsonb), 'false'::jsonb) = 'false'::jsonb$t$ end;
  v_due text := case when has_watch_resume then $d$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now or commerce.exhausted_late_capture_watch_needs_resume(source.payload))$d$ else $d$(payment.next_recovery_at is null or payment.next_recovery_at <= p_now)$d$ end;
  v_agg text := case when has_watch_resume then $a$jsonb_agg(payload order by coalesce(commerce.exhausted_late_capture_watch_needs_resume(payload), false), updated_at, legacy_sanity_id)$a$ else $a$jsonb_agg(payload order by updated_at, legacy_sanity_id)$a$ end;
begin
  execute format($fn$
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
as $body$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at, source.payload
    from commerce.payment_records payment
    join migration.source_documents source
      on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and %s
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
      and %s
    order by coalesce(payment.next_recovery_at, '-infinity'::timestamptz), payment.updated_at, payment.id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  select coalesce(%s, '[]'::jsonb)
  from candidates;
$body$;
$fn$, v_terminal, v_due, v_agg);
end;
$rollback_fetch$;
revoke all on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean) from public, anon, authenticated;
grant execute on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer, boolean) to service_role;

create or replace function public.roo_cleanup_expired_supabase_holds(p_cutover_generation integer, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_candidate record; v_claim_existed boolean; v_expired_holds integer := 0;
  v_removed_slot_claims integer := 0; v_mirror_events_enqueued integer := 0;
  v_mutation_result jsonb; v_now timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity', 0));
  v_now := clock_timestamp();
  if coalesce(p_cutover_generation, -1) < 0 then raise exception 'invalid cutover generation' using errcode = '22023'; end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 500 then raise exception 'cleanup limit must be between 1 and 500' using errcode = '22023'; end if;
  perform migration.assert_commerce_write_fence(p_cutover_generation);
  for v_candidate in
    select hold.id hold_id, source.legacy_sanity_id document_id, source.source_revision, source.payload
    from commerce.slot_holds hold join migration.source_documents source on source.legacy_sanity_id = hold.legacy_sanity_id
    where hold.cutover_generation = p_cutover_generation
      and ((hold.phase = 'active' and hold.expires_at <= v_now)
        or (hold.phase = 'payment' and hold.expires_at <= v_now - interval '24 hours'
          and not exists (
            select 1 from commerce.payment_records payment
            left join migration.source_documents payment_source on payment_source.legacy_sanity_id = payment.legacy_sanity_id and payment_source.document_type = 'paymentRecord' and not payment_source.tombstoned
            where payment.id = hold.payment_record_id and coalesce(payment_source.payload->>'providerPaymentState', '') not in ('refunded', 'disputed')
              and (payment.status in ('captured', 'finalizing', 'booked', 'email_partial') or payment_source.payload->>'providerPaymentState' = 'succeeded' or payment_source.payload->>'verificationState' = 'server_verified')
          )))
      and source.cutover_generation = p_cutover_generation and source.document_type = 'slotHold' and not source.tombstoned
      and lower(coalesce(source.payload->>'phase', 'active')) in ('active', 'holding', 'payment', 'payment_pending')
    order by hold.expires_at, source.legacy_sanity_id for update of source skip locked limit least(p_limit, 25)
  loop
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
  return jsonb_build_object('expired_holds', v_expired_holds, 'removed_slot_claims', v_removed_slot_claims, 'mirror_events_enqueued', v_mirror_events_enqueued, 'cutover_generation', p_cutover_generation);
end;
$$;
revoke all on function public.roo_cleanup_expired_supabase_holds(integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.roo_cleanup_expired_supabase_holds(integer, integer) to service_role;

drop function if exists commerce.exhausted_resume_is_due(jsonb, timestamptz, timestamptz), commerce.exhausted_cleanup_watch_active(text, jsonb), commerce.exhausted_live_dodo_state_needs_resume(text, jsonb), commerce.exhausted_pending_cleanup_needs_resume(text, jsonb), commerce.is_cleanup_pending(text, boolean, jsonb), commerce.payment_protects_expired_hold(text, jsonb), commerce.dodo_cleanup_allowed(jsonb, timestamptz, boolean), commerce.safe_payload_timestamptz(jsonb, text), commerce.has_active_late_capture_watch(jsonb), commerce.has_preserved_owner_review(text, jsonb), commerce.has_verified_reversal(jsonb), commerce.has_explicit_owner_review(text, jsonb), commerce.is_pending_or_partial_dodo_state(text);
drop table if exists commerce.reconcile_hold_cleanup_blocks, commerce.reconcile_cleanup_runs;
drop sequence if exists commerce.reconcile_fence_seq;

do $rollback_locks$
declare
  v text;
  v_block constant text := E'\n  delete from commerce.payment_upgrade_locks lock\n  using migration.source_documents source\n  where source.legacy_sanity_id = lock.legacy_sanity_id\n    and source.tombstoned\n    and source.legacy_sanity_id = any(p_document_ids);\n';
begin
  if to_regprocedure('migration.cleanup_commerce_document_ids(text[])') is null then return; end if;
  v := pg_get_functiondef('migration.cleanup_commerce_document_ids(text[])'::regprocedure);
  if strpos(v, v_block) > 0 then execute replace(v, v_block, ''); end if;
end;
$rollback_locks$;

notify pgrst, 'reload schema';
