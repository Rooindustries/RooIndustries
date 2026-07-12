alter table commerce.payment_records
  add column if not exists duplicate_payment_record boolean not null default false,
  add column if not exists canonical_payment_record_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'payment_records_canonical_payment_record_fkey'
      and conrelid = 'commerce.payment_records'::regclass
  ) then
    alter table commerce.payment_records
      add constraint payment_records_canonical_payment_record_fkey
      foreign key (canonical_payment_record_id)
      references commerce.payment_records(id)
      on delete set null;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'payment_records_canonical_not_self_check'
      and conrelid = 'commerce.payment_records'::regclass
  ) then
    alter table commerce.payment_records
      add constraint payment_records_canonical_not_self_check
      check (canonical_payment_record_id is null or canonical_payment_record_id <> id);
  end if;
end;
$$;

create index if not exists payment_records_canonical_payment_record_id_idx
  on commerce.payment_records (canonical_payment_record_id)
  where canonical_payment_record_id is not null;

create or replace function migration.project_commerce_recovery_fields(
  p_document_ids text[] default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
begin
  update commerce.payment_records payment
  set
    refund_requires_booking_sync = coalesce(
      migration.try_boolean(source.payload->>'refundRequiresBookingSync'), false
    ),
    resource_release_pending = coalesce(
      migration.try_boolean(source.payload->>'resourceReleasePending'), false
    ),
    late_capture_watch_until = migration.try_timestamptz(
      source.payload->>'lateCaptureWatchUntil'
    ),
    duplicate_payment_record = coalesce(
      migration.try_boolean(source.payload->>'duplicatePaymentRecord'), false
    ),
    canonical_payment_record_id = canonical.id
  from migration.source_documents source
  left join commerce.payment_records canonical
    on canonical.legacy_sanity_id =
      nullif(source.payload->>'canonicalPaymentRecordId', '')
  where source.document_type = 'paymentRecord'
    and not source.tombstoned
    and payment.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

select migration.project_commerce_recovery_fields(null);

do $$
declare
  v_payment record;
  v_generation integer;
  v_case_id text;
  v_command_id text;
begin
  select generation into v_generation
  from migration.commerce_control
  where singleton;

  for v_payment in
    select
      payment.legacy_sanity_id,
      payment.source_revision,
      payment.recovery_attempt_count,
      payment.next_recovery_at
    from commerce.payment_records payment
    where payment.provider = 'paypal'
      and payment.status = 'needs_recovery'
      and payment.legacy_sanity_id is not null
      and not exists (
        select 1
        from commerce.recovery_cases recovery
        where recovery.payment_record_id = payment.id
          and recovery.status in ('open', 'retrying')
      )
    order by payment.legacy_sanity_id
  loop
    v_case_id :=
      'paymentRecoveryCase.providerUnavailable.'
      || substr(md5(v_payment.legacy_sanity_id), 1, 24);
    v_command_id :=
      'provider-unavailable-recovery:'
      || md5(v_payment.legacy_sanity_id || ':' || coalesce(v_payment.source_revision, ''));

    perform public.roo_apply_commerce_document_mutations(
      v_command_id,
      jsonb_build_array(
        jsonb_build_object(
          'operation', 'create_if_missing',
          'document', jsonb_build_object(
            '_id', v_case_id,
            '_type', 'paymentRecoveryCase',
            'paymentRecordId', v_payment.legacy_sanity_id,
            'status', 'open',
            'reason', 'paypal_lookup_failed_404',
            'requiresReschedule', false,
            'attemptCount', greatest(v_payment.recovery_attempt_count, 1),
            'nextAttemptAt', coalesce(
              v_payment.next_recovery_at,
              now() + interval '60 minutes'
            ),
            'createdAt', now()
          )
        )
      ),
      v_generation
    );
  end loop;
end;
$$;

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
            select 1
            from commerce.bookings booking
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
            select 1
            from commerce.payment_records payment
            where payment.id = booking.payment_record_id
              and payment.booking_id = booking.id
          )
      ) mismatch
    ),
    'duplicatePaymentAliases', (select count(*)
      from commerce.payment_records payment
      where payment.duplicate_payment_record
        and payment.canonical_payment_record_id is not null),
    'providerRecoveryCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.case_type = 'payment'
        and recovery.status in ('open', 'retrying')
        and not recovery.requires_reschedule),
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

revoke all on function migration.project_commerce_recovery_fields(text[])
  from public, anon, authenticated;
revoke all on function public.roo_supabase_port_readiness()
  from public, anon, authenticated;
grant execute on function migration.project_commerce_recovery_fields(text[])
  to service_role;
grant execute on function public.roo_supabase_port_readiness()
  to service_role;
