set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_commerce_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'last_parity', (
      select jsonb_build_object(
        'direction', direction,
        'completed_at', completed_at,
        'status', status,
        'counters', counters
      )
      from migration.sync_runs
      where status in ('completed', 'failed', 'cancelled')
        and completed_at is not null
        and (
          direction = 'sanity_to_supabase'
          or (
            direction = 'compare'
            and counters->>'mode' = 'verify'
          )
        )
      order by completed_at desc
      limit 1
    ),
    'last_mirror_checkpoint', (
      select jsonb_build_object(
        'event_key', event_key,
        'generation', cutover_generation,
        'mirrored_at', mirrored_at
      )
      from migration.commerce_mirror_checkpoints
      order by id desc
      limit 1
    ),
    'mirror', jsonb_build_object(
      'pending', (
        select count(*)
        from migration.commerce_mirror_outbox
        where status in ('pending', 'retry', 'processing', 'dead_letter')
      ),
      'oldest_pending_at', (
        select min(created_at)
        from migration.commerce_mirror_outbox
        where status in ('pending', 'retry', 'processing', 'dead_letter')
      ),
      'dead_letters', (
        select count(*)
        from migration.commerce_mirror_outbox
        where status = 'dead_letter'
      )
    ),
    'captured_without_booking', (
      select count(*)
      from commerce.payment_records
      where booking_id is null
        and (
          status in ('captured', 'finalizing')
          or (
            status = 'needs_recovery'
            and provider_payment_id is not null
          )
        )
    ),
    'email_retries', (
      select count(*)
      from commerce.email_dispatches
      where status in ('retry', 'failed')
    ),
    'email_oldest_retry_at', (
      select min(coalesce(next_attempt_at, updated_at))
      from commerce.email_dispatches
      where status in ('retry', 'failed')
    ),
    'coupon_mismatches', (
      select count(*)
      from commerce.coupons
      where consumed_uses < 0
        or reserved_uses < 0
        or (
          maximum_uses is not null
          and consumed_uses + reserved_uses > maximum_uses
        )
    ),
    'referral_ambiguous', (
      select count(*)
      from migration.source_documents
      where document_type in ('owedReferral', 'creatorPayout')
        and not tombstoned
        and btrim(coalesce(
          case
            when document_type = 'creatorPayout' then payload->>'amount'
            else payload->>'totalOwed'
          end,
          ''
        )) !~ '^-?[0-9]+([.][0-9]{1,2})?$'
    ),
    'recent_metrics', (
      select jsonb_build_object(
        'sample_count', count(*),
        'p95_ms', coalesce(
          round(
            percentile_cont(0.95) within group (order by duration_ms)
          )::integer,
          0
        ),
        'error_rate', coalesce(
          round(
            10000 * avg(case when status_code >= 500 then 1 else 0 end)
          ) / 100,
          0
        ),
        'max_response_bytes', coalesce(max(response_bytes), 0)
      )
      from migration.commerce_request_metrics
      where recorded_at >= now() - interval '5 minutes'
    ),
    'duplicate_active_slots', (
      select count(*)
      from (
        select start_time_utc
        from commerce.booking_slots
        where status = 'active'
        group by start_time_utc
        having count(*) > 1
      ) duplicates
    )
  );
$$;

revoke all on function public.roo_commerce_readiness()
  from public, anon, authenticated;
grant execute on function public.roo_commerce_readiness()
  to service_role;
