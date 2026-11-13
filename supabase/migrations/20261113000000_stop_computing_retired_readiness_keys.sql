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
        and route not in ('payment/reconcile', 'ref/cronsyncall')
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

create or replace function public.roo_commerce_integrity_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'control', public.roo_commerce_control(),
    'orphan_claimed_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      left join commerce.bookings booking on booking.id = proof.booking_id
      where proof.status = 'claimed'
        and (proof.booking_id is null or booking.id is null)
    ),
    'orphan_free_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      join commerce.payment_records payment on payment.id = proof.payment_record_id
      where proof.provider = 'free'
        and proof.status = 'claimed'
        and proof.booking_id is null
        and payment.booking_id is null
        and payment.status in ('failed', 'abandoned')
    ),
    'command_conflicts', 0,
    'full_projector_calls_in_commands', 0
  );
$$;

revoke all on function public.roo_commerce_integrity_readiness()
  from public, anon, authenticated;
grant execute on function public.roo_commerce_integrity_readiness()
  to service_role;

create or replace function public.roo_supabase_port_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with payment_aliases as (
    select
      payment.id,
      (
        canonical.id is not null
        and not canonical.duplicate_payment_record
        and payment.booking_id is not null
        and payment.booking_id = canonical.booking_id
        and booking.payment_record_id = canonical.id
        and payment.provider = canonical.provider
        and payment.currency is not distinct from canonical.currency
        and payment.status in ('booked', 'email_partial')
        and canonical.status in ('booked', 'email_partial')
      ) valid
    from commerce.payment_records payment
    left join commerce.payment_records canonical
      on canonical.id = payment.canonical_payment_record_id
    left join commerce.bookings booking
      on booking.id = payment.booking_id
    where payment.duplicate_payment_record
  )
  select jsonb_build_object(
    'credentialRecovery', jsonb_build_object(
      'pending', (select count(*) from accounts.credential_operations
        where status in ('prepared', 'auth_applied')),
      'oldestAt', (select min(created_at) from accounts.credential_operations
        where status in ('prepared', 'auth_applied'))
    ),
    'identityDrift', jsonb_build_object(
      'missing', (select count(*)
        from auth.identities identity
        join accounts.principal_auth_users mapping
          on mapping.user_id = identity.user_id
        where identity.provider in ('email', 'google', 'apple', 'discord')
          and not exists (
            select 1 from accounts.identity_links projected
            where projected.provider = identity.provider
              and projected.provider_subject = identity.provider_id
              and projected.principal_id = mapping.principal_id
          )),
      'stale', (select count(*) from accounts.identity_links projected
        where projected.backend_owner = 'supabase'
          and not exists (
            select 1 from auth.identities identity
            where identity.user_id = projected.user_id
              and identity.provider = projected.provider
              and identity.provider_id = projected.provider_subject
          ))
    ),
    'creatorProjectionDrift', (select count(*)
      from migration.source_documents source
      left join accounts.creator_profiles creator
        on creator.legacy_sanity_id = source.legacy_sanity_id
      where source.document_type = 'referral'
        and not source.tombstoned
        and coalesce(source.payload->>'registrationStatus', 'active') <> 'pending_email'
        and (
          creator.user_id is null
          or source.source_hash is distinct from creator.source_hash
        )),
    'staleProviderRecovery', (select count(*)
      from commerce.payment_records payment
      where payment.status = 'needs_recovery'
        and (
          (payment.next_recovery_at is null
            and payment.updated_at < now() - interval '15 minutes')
          or payment.next_recovery_at < now() - interval '15 minutes'
        )),
    'capturedWithoutBooking', (select count(*)
      from commerce.payment_records payment
      where payment.status in ('captured', 'booked', 'email_partial')
        and payment.booking_id is null
        and not coalesce(payment.requires_reschedule, false)
        and not (
          payment.duplicate_payment_record
          and exists (
            select 1
            from commerce.payment_records canonical
            where canonical.id = payment.canonical_payment_record_id
              and canonical.booking_id is not null
          )
        )),
    'reciprocalLinkMismatches', (
      select count(*) from (
        select 'payment' source_kind, payment.id source_id
        from commerce.payment_records payment
        where payment.booking_id is not null
          and not exists (
            select 1 from commerce.bookings booking
            where booking.id = payment.booking_id
              and (
                booking.payment_record_id = payment.id
                or (
                  payment.duplicate_payment_record
                  and booking.payment_record_id =
                    payment.canonical_payment_record_id
                )
              )
          )
        union all
        select 'booking', booking.id
        from commerce.bookings booking
        where booking.payment_record_id is not null
          and not exists (
            select 1 from commerce.payment_records payment
            where payment.id = booking.payment_record_id
              and payment.booking_id = booking.id
          )
      ) mismatch
    ),
    'duplicatePaymentAliases', (select count(*) from payment_aliases where not valid),
    'validPaymentAliases', (select count(*) from payment_aliases where valid),
    'paymentAliasesTotal', (select count(*) from payment_aliases),
    'invalidPaymentAliases', (select count(*) from payment_aliases where not valid),
    'providerRecoveryCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.case_type = 'payment'
        and recovery.status in ('open', 'retrying')
        and not recovery.requires_reschedule),
    'rescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and not exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'openRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule and recovery.status <> 'resolved'),
    'notifiedRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'unnotifiedRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and not exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'discordRetry', jsonb_build_object(
      'pending', (select count(*) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing')),
      'oldestAt', (select min(updated_at) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing'))
    ),
    'oauthIntents', jsonb_build_object(
      'expiredPending', (select count(*) from accounts.oauth_intents
        where status = 'pending' and expires_at <= now()),
      'terminalOlderThanSevenDays', (select count(*) from accounts.oauth_intents
        where status in ('completed', 'failed', 'expired', 'replaced')
          and updated_at < now() - interval '7 days')
    )
  );
$$;

revoke all on function public.roo_supabase_port_readiness()
  from public, anon, authenticated;
grant execute on function public.roo_supabase_port_readiness()
  to service_role;

