create or replace function public.roo_supabase_port_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
        where not exists (
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
        and (
          creator.user_id is null
          or source.source_hash is distinct from creator.source_hash
        )),
    'parityAgeSeconds', (
      select case when max(completed_at) is null then null
        else extract(epoch from now() - max(completed_at)) end
      from migration.sync_runs
      where direction = 'compare' and status = 'completed'
    ),
    'staleProviderRecovery', (select count(*)
      from commerce.payment_records payment
      where payment.status = 'needs_recovery'
        and payment.updated_at < now() - interval '15 minutes'),
    'capturedWithoutBooking', (select count(*)
      from commerce.payment_records payment
      where payment.status in ('captured', 'booked', 'email_partial')
        and payment.booking_id is null
        and not coalesce(payment.requires_reschedule, false)),
    'reciprocalLinkMismatches', (
      select count(*) from (
        select 'payment' source_kind, payment.id source_id
        from commerce.payment_records payment
        where payment.booking_id is not null
          and not exists (
            select 1 from commerce.bookings booking
            where booking.id = payment.booking_id
              and booking.payment_record_id = payment.id
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
    'rescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule and recovery.status <> 'resolved'),
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
