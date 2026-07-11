-- Commerce-only Supabase cutover foundation. All browser roles remain denied;
-- the website uses these functions through its server-side service-role client.

alter table migration.source_documents
  add column if not exists backend_owner text not null default 'sanity',
  add column if not exists cutover_generation integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'migration.source_documents'::regclass
      and conname = 'source_documents_backend_owner_check'
  ) then
    alter table migration.source_documents
      add constraint source_documents_backend_owner_check
      check (backend_owner in ('sanity', 'supabase'));
  end if;
end;
$$;

alter table commerce.email_dispatches
  add column if not exists dispatch_kind text not null default 'booking_confirmation',
  add column if not exists cutover_generation integer not null default 0;

alter table commerce.referral_ledger
  add column if not exists cutover_generation integer not null default 0;

alter table commerce.refunds
  add column if not exists cutover_generation integer not null default 0;

alter table commerce.bookings
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.slot_holds
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.booking_slots
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.payment_records
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.coupons
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.coupon_redemptions
  add column if not exists cutover_generation integer not null default 0;
alter table commerce.recovery_cases
  add column if not exists cutover_generation integer not null default 0;

alter table commerce.email_dispatches
  drop constraint if exists email_dispatches_status_check;
alter table commerce.email_dispatches
  add constraint email_dispatches_status_check
  check (status in (
    'pending', 'sending', 'sent', 'retry', 'failed', 'historical_unknown'
  ));

alter table commerce.email_dispatches
  drop constraint if exists email_dispatches_dispatch_kind_check;
alter table commerce.email_dispatches
  add constraint email_dispatches_dispatch_kind_check
  check (dispatch_kind in ('booking_confirmation', 'reschedule'));

create table if not exists migration.commerce_commands (
  command_id text primary key,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  cutover_generation integer not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  check (command_id ~ '^[A-Za-z0-9._:-]{8,160}$')
);

create table if not exists migration.commerce_mirror_outbox (
  id uuid primary key default gen_random_uuid(),
  command_id text not null references migration.commerce_commands(command_id) on delete restrict,
  event_key text not null unique,
  document_ids text[] not null,
  documents jsonb not null default '[]'::jsonb,
  deleted_ids text[] not null default '{}'::text[],
  canonical_hash text not null check (canonical_hash ~ '^[0-9a-f]{64}$'),
  cutover_generation integer not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'retry', 'mirrored', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  mirrored_at timestamptz
);

create index if not exists commerce_mirror_outbox_pending_idx
  on migration.commerce_mirror_outbox (status, next_attempt_at, created_at)
  where status in ('pending', 'retry', 'processing');

create table if not exists migration.commerce_mirror_checkpoints (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  canonical_hash text not null check (canonical_hash ~ '^[0-9a-f]{64}$'),
  cutover_generation integer not null,
  document_count integer not null check (document_count >= 0),
  mirrored_at timestamptz not null default now()
);

create table if not exists migration.commerce_request_metrics (
  id bigint generated always as identity primary key,
  route text not null check (route ~ '^[a-z0-9_:/-]{1,120}$'),
  backend text not null check (backend in ('sanity', 'supabase')),
  cutover_generation integer not null,
  duration_ms integer not null check (duration_ms >= 0),
  status_code integer not null check (status_code between 100 and 599),
  response_bytes integer not null default 0 check (response_bytes >= 0),
  recorded_at timestamptz not null default now()
);

create index if not exists commerce_request_metrics_recent_idx
  on migration.commerce_request_metrics (recorded_at desc);

alter table migration.commerce_commands enable row level security;
alter table migration.commerce_mirror_outbox enable row level security;
alter table migration.commerce_mirror_checkpoints enable row level security;
alter table migration.commerce_request_metrics enable row level security;

revoke all on migration.commerce_commands,
  migration.commerce_mirror_outbox,
  migration.commerce_mirror_checkpoints,
  migration.commerce_request_metrics
  from public, anon, authenticated;
grant all on migration.commerce_commands,
  migration.commerce_mirror_outbox,
  migration.commerce_mirror_checkpoints,
  migration.commerce_request_metrics
  to service_role;
grant usage, select on all sequences in schema migration to service_role;

create or replace function migration.canonical_business_document(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when p_payload->>'_type' = 'referral' then p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash',
      '_commerceCutoverGeneration', '_supabaseMirroredAt',
      'creatorPassword', 'resetToken', 'resetTokenHash',
      'resetTokenExpiresAt', 'passwordResetRequired', 'credentialVersion'
    ]
    else p_payload - array[
      '_rev', '_createdAt', '_updatedAt', '_system',
      '_supabaseRevision', '_supabaseCanonicalHash',
      '_commerceCutoverGeneration', '_supabaseMirroredAt'
    ]
  end;
$$;

create or replace function migration.referral_commerce_patch(p_payload jsonb)
returns jsonb
language sql
immutable
strict
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(field.key, field.value), '{}'::jsonb)
  from jsonb_each(p_payload) field
  where field.key = any(array[
    'successfulReferrals',
    'currentCommissionPercent',
    'currentDiscountPercent',
    'isFirstTime',
    'xocPayments',
    'vertexPayments',
    'earnedXoc',
    'earnedVertex',
    'earnedTotal',
    'paidXoc',
    'paidVertex',
    'paidTotal',
    'owedXoc',
    'owedVertex',
    'owedTotal',
    'notes'
  ]::text[]);
$$;

create or replace function migration.canonical_business_hash(p_payload jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select encode(
    extensions.digest(migration.canonical_business_document(p_payload)::text, 'sha256'),
    'hex'
  );
$$;

create or replace function migration.money_subunits_exact(p_value jsonb)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
begin
  if p_value is null or p_value = 'null'::jsonb then
    return 0;
  end if;
  v_text := btrim(p_value #>> '{}');
  if v_text !~ '^-?[0-9]+([.][0-9]{1,2})?$' then
    raise exception 'ambiguous money value: %', left(v_text, 64)
      using errcode = '22023';
  end if;
  return round(v_text::numeric * 100)::bigint;
end;
$$;

create or replace function migration.shadow_filter_matches(
  p_payload jsonb,
  p_filter jsonb
)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_path text := btrim(coalesce(p_filter->>'path', ''));
  v_operator text := lower(btrim(coalesce(p_filter->>'op', 'eq')));
  v_actual jsonb;
  v_actual_text text;
  v_value jsonb := p_filter->'value';
begin
  if v_path !~ '^[A-Za-z_][A-Za-z0-9_.]*$' then
    return false;
  end if;
  v_actual := p_payload #> string_to_array(v_path, '.');
  v_actual_text := v_actual #>> '{}';

  if v_operator = 'eq' then
    return v_actual = v_value;
  elsif v_operator = 'ieq' then
    return lower(coalesce(v_actual_text, '')) = lower(coalesce(v_value #>> '{}', ''));
  elsif v_operator = 'in' then
    return jsonb_typeof(v_value) = 'array'
      and exists (
        select 1 from jsonb_array_elements(v_value) item
        where item = v_actual
           or lower(coalesce(item #>> '{}', '')) = lower(coalesce(v_actual_text, ''))
      );
  elsif v_operator = 'lt' then
    return migration.try_timestamptz(v_actual_text)
      < migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'lte' then
    return migration.try_timestamptz(v_actual_text)
      <= migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'gt' then
    return migration.try_timestamptz(v_actual_text)
      > migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'gte' then
    return migration.try_timestamptz(v_actual_text)
      >= migration.try_timestamptz(v_value #>> '{}');
  elsif v_operator = 'defined' then
    return v_actual is not null and v_actual <> 'null'::jsonb;
  end if;
  return false;
end;
$$;

create or replace function public.roo_fetch_shadow_documents_targeted(
  p_document_types text[] default null,
  p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb,
  p_limit integer default 500
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(selected.payload order by selected.legacy_sanity_id), '[]'::jsonb)
  from (
    select source.legacy_sanity_id, source.payload
    from migration.source_documents source
    where not source.tombstoned
      and (p_document_types is null or source.document_type = any(p_document_types))
      and (p_ids is null or source.legacy_sanity_id = any(p_ids))
      and jsonb_typeof(coalesce(p_filters, '[]'::jsonb)) = 'array'
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(p_filters, '[]'::jsonb)) filter
        where not migration.shadow_filter_matches(source.payload, filter)
      )
    order by source.legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 500), 1000))
  ) selected;
$$;

create or replace function public.roo_fetch_recovery_payment_documents(
  p_backend text,
  p_statuses text[],
  p_refunded_status text,
  p_booked_status text,
  p_abandoned_status text,
  p_now timestamptz,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(candidate.payload order by candidate.updated_at, candidate.id), '[]'::jsonb)
  from (
    select
      source.legacy_sanity_id as id,
      source.payload,
      coalesce(
        migration.try_timestamptz(source.payload->>'updatedAt'),
        source.source_updated_at,
        source.last_seen_at
      ) as updated_at
    from migration.source_documents source
    where source.document_type = 'paymentRecord'
      and not source.tombstoned
      and lower(coalesce(source.payload->>'backendOwner', 'sanity')) = lower(p_backend)
      and (
        lower(coalesce(source.payload->>'status', '')) = any(p_statuses)
        or (
          lower(coalesce(source.payload->>'status', '')) = lower(p_refunded_status)
          and coalesce(migration.try_boolean(source.payload->>'refundRequiresBookingSync'), false)
        )
        or (
          lower(coalesce(source.payload->>'status', '')) = lower(p_booked_status)
          and coalesce(migration.try_boolean(source.payload->>'emailDispatchRequired'), false)
        )
        or (
          lower(coalesce(source.payload->>'status', '')) = lower(p_abandoned_status)
          and (
            coalesce(migration.try_boolean(source.payload->>'resourceReleasePending'), false)
            or nullif(source.payload->>'lateCaptureWatchUntil', '') is not null
          )
        )
      )
      and (
        nullif(source.payload->>'nextRecoveryAt', '') is null
        or migration.try_timestamptz(source.payload->>'nextRecoveryAt') <= p_now
      )
    order by updated_at, source.legacy_sanity_id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  ) candidate;
$$;

-- Backfill the dispatch ledger without sending. Missing historical delivery
-- timestamps are deliberately unknown and are never selected for retries.
insert into commerce.email_dispatches (
  id, booking_id, recipient_type, recipient_email_hash, idempotency_key,
  status, sent_at, payload, legacy_sanity_id, source_revision, source_hash,
  backend_owner, dispatch_kind, cutover_generation, created_at, updated_at
)
select
  migration.document_uuid(
    'email_dispatch', source.legacy_sanity_id || ':' || recipient.kind || ':booking_confirmation'
  ),
  booking.id,
  recipient.kind,
  encode(extensions.digest(lower(coalesce(
    case when recipient.kind = 'customer'
      then coalesce(source.payload->>'email', source.payload->>'payerEmail')
      else coalesce(settings.payload->>'ownerEmail', '') end,
    ''
  )), 'sha256'), 'hex'),
  'booking-' || source.legacy_sanity_id || '-' ||
    case when recipient.kind = 'customer' then 'client' else 'owner' end,
  case
    when nullif(source.payload->>(case when recipient.kind = 'customer'
      then 'emailDispatchClientSentAt' else 'emailDispatchOwnerSentAt' end), '') is not null
      then 'sent'
    else 'historical_unknown'
  end,
  migration.try_timestamptz(source.payload->>(case when recipient.kind = 'customer'
    then 'emailDispatchClientSentAt' else 'emailDispatchOwnerSentAt' end)),
  jsonb_build_object('historical_backfill', true),
  source.legacy_sanity_id || ':' || recipient.kind || ':booking_confirmation',
  source.source_revision,
  source.source_hash,
  source.backend_owner,
  'booking_confirmation',
  source.cutover_generation,
  coalesce(source.source_created_at, now()),
  now()
from migration.source_documents source
join commerce.bookings booking on booking.legacy_sanity_id = source.legacy_sanity_id
cross join (values ('customer'), ('owner')) recipient(kind)
left join commerce.booking_settings settings on settings.id = 'default'
where source.document_type = 'booking' and not source.tombstoned
on conflict (idempotency_key) do nothing;

insert into commerce.email_dispatches (
  id, booking_id, recipient_type, recipient_email_hash, idempotency_key,
  status, sent_at, provider_message_id, payload, legacy_sanity_id,
  source_revision, source_hash, backend_owner, dispatch_kind,
  cutover_generation, created_at, updated_at
)
select
  migration.document_uuid(
    'email_dispatch', source.legacy_sanity_id || ':' || recipient.kind || ':reschedule'
  ),
  booking.id,
  recipient.kind,
  encode(extensions.digest(lower(coalesce(
    case when recipient.kind = 'customer'
      then coalesce(source.payload->>'email', source.payload->>'payerEmail')
      else coalesce(settings.payload->>'ownerEmail', '') end,
    ''
  )), 'sha256'), 'hex'),
  'booking-' || source.legacy_sanity_id || '-reschedule-' ||
    case when recipient.kind = 'customer' then 'client' else 'owner' end,
  case
    when nullif(source.payload->>(case when recipient.kind = 'customer'
      then 'recoveryClientNotifiedAt' else 'recoveryOwnerNotifiedAt' end), '') is not null
      then 'sent'
    else 'historical_unknown'
  end,
  migration.try_timestamptz(source.payload->>(case when recipient.kind = 'customer'
    then 'recoveryClientNotifiedAt' else 'recoveryOwnerNotifiedAt' end)),
  nullif(source.payload->>(case when recipient.kind = 'customer'
    then 'recoveryClientProviderId' else 'recoveryOwnerProviderId' end), ''),
  jsonb_build_object('historical_backfill', true, 'requires_reschedule', true),
  source.legacy_sanity_id || ':' || recipient.kind || ':reschedule',
  source.source_revision,
  source.source_hash,
  source.backend_owner,
  'reschedule',
  source.cutover_generation,
  coalesce(source.source_created_at, now()),
  now()
from migration.source_documents source
join commerce.bookings booking on booking.legacy_sanity_id = source.legacy_sanity_id
cross join (values ('customer'), ('owner')) recipient(kind)
left join commerce.booking_settings settings on settings.id = 'default'
where source.document_type = 'booking'
  and not source.tombstoned
  and coalesce(migration.try_boolean(source.payload->>'requiresReschedule'), false)
on conflict (idempotency_key) do nothing;

create or replace function migration.project_commerce_extensions(
  p_document_ids text[] default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_emails integer := 0;
  v_changed integer := 0;
  v_referrals integer := 0;
  v_refunds integer := 0;
begin
  -- New and changed booking delivery state. Historical-unknown rows stay inert
  -- unless an explicit sent timestamp is later observed.
  insert into commerce.email_dispatches (
    id, booking_id, recipient_type, recipient_email_hash, idempotency_key,
    status, lease_id, lease_expires_at, provider_message_id, attempt_count,
    next_attempt_at, sent_at, last_error_code, payload, legacy_sanity_id,
    source_revision, source_hash, backend_owner, dispatch_kind,
    cutover_generation, created_at, updated_at
  )
  select
    migration.document_uuid(
      'email_dispatch', source.legacy_sanity_id || ':' || recipient.kind || ':booking_confirmation'
    ),
    booking.id,
    recipient.kind,
    encode(extensions.digest(lower(coalesce(
      case when recipient.kind = 'customer'
        then coalesce(source.payload->>'email', source.payload->>'payerEmail')
        else coalesce(settings.payload->>'ownerEmail', '') end,
      ''
    )), 'sha256'), 'hex'),
    'booking-' || source.legacy_sanity_id || '-' ||
      case when recipient.kind = 'customer' then 'client' else 'owner' end,
    case
      when nullif(source.payload->>(case when recipient.kind = 'customer'
        then 'emailDispatchClientSentAt' else 'emailDispatchOwnerSentAt' end), '') is not null
        then 'sent'
      when lower(coalesce(source.payload->>'emailDispatchStatus', '')) in ('partial', 'failed')
        then 'retry'
      when lower(coalesce(source.payload->>'emailDispatchStatus', '')) = 'sent'
        then 'sent'
      else 'pending'
    end,
    nullif(source.payload->>'emailDispatchLeaseId', ''),
    migration.try_timestamptz(source.payload->>'emailDispatchLeaseExpiresAt'),
    nullif(source.payload->>(case when recipient.kind = 'customer'
      then 'emailDispatchClientProviderId' else 'emailDispatchOwnerProviderId' end), ''),
    greatest(0, coalesce(migration.try_numeric(source.payload->>'emailDispatchAttemptCount')::integer, 0)),
    migration.try_timestamptz(source.payload->>'emailDispatchNextAttemptAt'),
    migration.try_timestamptz(source.payload->>(case when recipient.kind = 'customer'
      then 'emailDispatchClientSentAt' else 'emailDispatchOwnerSentAt' end)),
    nullif(source.payload->>'emailDispatchLastError', ''),
    jsonb_build_object('booking_id', source.legacy_sanity_id),
    source.legacy_sanity_id || ':' || recipient.kind || ':booking_confirmation',
    source.source_revision,
    source.source_hash,
    source.backend_owner,
    'booking_confirmation',
    source.cutover_generation,
    coalesce(source.source_created_at, now()),
    now()
  from migration.source_documents source
  join commerce.bookings booking on booking.legacy_sanity_id = source.legacy_sanity_id
  cross join (values ('customer'), ('owner')) recipient(kind)
  left join commerce.booking_settings settings on settings.id = 'default'
  where source.document_type = 'booking'
    and not source.tombstoned
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids))
  on conflict (idempotency_key) do update
  set
    booking_id = excluded.booking_id,
    recipient_email_hash = excluded.recipient_email_hash,
    status = case
      when commerce.email_dispatches.status = 'historical_unknown'
        and excluded.status <> 'sent' then 'historical_unknown'
      else excluded.status
    end,
    lease_id = excluded.lease_id,
    lease_expires_at = excluded.lease_expires_at,
    provider_message_id = coalesce(excluded.provider_message_id, commerce.email_dispatches.provider_message_id),
    attempt_count = greatest(commerce.email_dispatches.attempt_count, excluded.attempt_count),
    next_attempt_at = excluded.next_attempt_at,
    sent_at = coalesce(commerce.email_dispatches.sent_at, excluded.sent_at),
    last_error_code = excluded.last_error_code,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = excluded.backend_owner,
    cutover_generation = excluded.cutover_generation,
    updated_at = now();
  get diagnostics v_emails = row_count;

  insert into commerce.email_dispatches (
    id, booking_id, recipient_type, recipient_email_hash, idempotency_key,
    status, lease_id, lease_expires_at, provider_message_id, attempt_count,
    next_attempt_at, sent_at, last_error_code, payload, legacy_sanity_id,
    source_revision, source_hash, backend_owner, dispatch_kind,
    cutover_generation, created_at, updated_at
  )
  select
    migration.document_uuid(
      'email_dispatch', source.legacy_sanity_id || ':' || recipient.kind || ':reschedule'
    ),
    booking.id,
    recipient.kind,
    encode(extensions.digest(lower(coalesce(
      case when recipient.kind = 'customer'
        then coalesce(source.payload->>'email', source.payload->>'payerEmail')
        else coalesce(settings.payload->>'ownerEmail', '') end,
      ''
    )), 'sha256'), 'hex'),
    'booking-' || source.legacy_sanity_id || '-reschedule-' ||
      case when recipient.kind = 'customer' then 'client' else 'owner' end,
    case
      when nullif(source.payload->>(case when recipient.kind = 'customer'
        then 'recoveryClientNotifiedAt' else 'recoveryOwnerNotifiedAt' end), '') is not null
        then 'sent'
      when lower(coalesce(source.payload->>'recoveryNotificationStatus', '')) = 'partial'
        then 'retry'
      else 'pending'
    end,
    nullif(source.payload->>'recoveryNotificationLeaseId', ''),
    migration.try_timestamptz(source.payload->>'recoveryNotificationLeaseExpiresAt'),
    nullif(source.payload->>(case when recipient.kind = 'customer'
      then 'recoveryClientProviderId' else 'recoveryOwnerProviderId' end), ''),
    greatest(0, coalesce(
      migration.try_numeric(source.payload->>'recoveryNotificationAttemptCount')::integer,
      0
    )),
    migration.try_timestamptz(source.payload->>'recoveryNotificationNextAttemptAt'),
    migration.try_timestamptz(source.payload->>(case when recipient.kind = 'customer'
      then 'recoveryClientNotifiedAt' else 'recoveryOwnerNotifiedAt' end)),
    nullif(source.payload->>'recoveryNotificationLastError', ''),
    jsonb_build_object('booking_id', source.legacy_sanity_id, 'requires_reschedule', true),
    source.legacy_sanity_id || ':' || recipient.kind || ':reschedule',
    source.source_revision,
    source.source_hash,
    source.backend_owner,
    'reschedule',
    source.cutover_generation,
    coalesce(source.source_created_at, now()),
    now()
  from migration.source_documents source
  join commerce.bookings booking on booking.legacy_sanity_id = source.legacy_sanity_id
  cross join (values ('customer'), ('owner')) recipient(kind)
  left join commerce.booking_settings settings on settings.id = 'default'
  where source.document_type = 'booking'
    and not source.tombstoned
    and coalesce(migration.try_boolean(source.payload->>'requiresReschedule'), false)
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids))
  on conflict (idempotency_key) do update
  set
    booking_id = excluded.booking_id,
    recipient_email_hash = excluded.recipient_email_hash,
    status = case
      when commerce.email_dispatches.status = 'historical_unknown'
        and excluded.status <> 'sent' then 'historical_unknown'
      else excluded.status
    end,
    lease_id = excluded.lease_id,
    lease_expires_at = excluded.lease_expires_at,
    provider_message_id = coalesce(
      excluded.provider_message_id,
      commerce.email_dispatches.provider_message_id
    ),
    attempt_count = greatest(commerce.email_dispatches.attempt_count, excluded.attempt_count),
    next_attempt_at = excluded.next_attempt_at,
    sent_at = coalesce(commerce.email_dispatches.sent_at, excluded.sent_at),
    last_error_code = excluded.last_error_code,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = excluded.backend_owner,
    cutover_generation = excluded.cutover_generation,
    updated_at = now();
  get diagnostics v_changed = row_count;
  v_emails := v_emails + v_changed;

  insert into commerce.referral_ledger (
    id, creator_user_id, entry_type, amount_subunits, currency,
    idempotency_key, legacy_sanity_id, payload, occurred_at,
    source_revision, source_hash, backend_owner, cutover_generation, created_at
  )
  select
    migration.document_uuid('referral_ledger', source.legacy_sanity_id),
    profile.user_id,
    case when source.document_type = 'creatorPayout' then 'payout' else 'adjustment' end,
    migration.money_subunits_exact(
      case when source.document_type = 'creatorPayout'
        then source.payload->'amount' else source.payload->'totalOwed' end
    ),
    'USD',
    source.legacy_sanity_id,
    source.legacy_sanity_id,
    source.payload,
    coalesce(
      migration.try_timestamptz(source.payload->>'paidAt'),
      source.source_created_at,
      source.source_updated_at,
      now()
    ),
    source.source_revision,
    source.source_hash,
    source.backend_owner,
    source.cutover_generation,
    coalesce(source.source_created_at, now())
  from migration.source_documents source
  left join public.profiles profile
    on profile.legacy_sanity_id = source.payload#>>'{creator,_ref}'
  where source.document_type in ('owedReferral', 'creatorPayout')
    and not source.tombstoned
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids))
  on conflict (idempotency_key) do update
  set
    creator_user_id = excluded.creator_user_id,
    entry_type = excluded.entry_type,
    amount_subunits = excluded.amount_subunits,
    payload = excluded.payload,
    occurred_at = excluded.occurred_at,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = excluded.backend_owner,
    cutover_generation = excluded.cutover_generation;
  get diagnostics v_referrals = row_count;

  insert into commerce.refunds (
    id, payment_record_id, booking_id, provider, provider_refund_id,
    event_type, status, amount_subunits, currency, full_refund,
    accounting_reversed, slot_released, payload, legacy_sanity_id,
    occurred_at, source_revision, source_hash, backend_owner,
    cutover_generation, created_at, updated_at
  )
  select
    migration.document_uuid(
      'refund', source.legacy_sanity_id || ':' || coalesce(
        nullif(refund.payload->>'providerRefundId', ''), refund.payload->>'_key'
      )
    ),
    payment.id,
    payment.booking_id,
    payment.provider,
    coalesce(nullif(refund.payload->>'providerRefundId', ''), refund.payload->>'_key'),
    coalesce(nullif(refund.payload->>'eventType', ''), 'unknown'),
    case
      when coalesce(migration.try_boolean(refund.payload->>'reversed'), false) then 'reversed'
      when lower(coalesce(refund.payload->>'status', 'pending')) = 'processed' then 'completed'
      when lower(coalesce(refund.payload->>'status', 'pending')) = 'failed' then 'failed'
      else 'pending'
    end,
    case
      when coalesce(migration.try_numeric(refund.payload->>'amountInSubunits'), 0) > 0
        then migration.try_numeric(refund.payload->>'amountInSubunits')::bigint
      else migration.money_subunits_exact(refund.payload->'amount')
    end,
    migration.currency_code(coalesce(refund.payload->>'currency', payment.currency)),
    lower(coalesce(source.payload->>'refundState', '')) = 'full'
      or coalesce(migration.try_boolean(refund.payload->>'reversed'), false),
    coalesce(migration.try_boolean(source.payload#>>'{refundBookingSync,referralReversed}'), false),
    coalesce(migration.try_boolean(source.payload#>>'{refundBookingSync,reopenedSlot}'), false),
    refund.payload,
    source.legacy_sanity_id || ':' || coalesce(
      nullif(refund.payload->>'providerRefundId', ''), refund.payload->>'_key'
    ),
    coalesce(
      migration.try_timestamptz(refund.payload->>'updatedAt'),
      source.source_updated_at,
      now()
    ),
    source.source_revision,
    source.source_hash,
    source.backend_owner,
    source.cutover_generation,
    coalesce(source.source_created_at, now()),
    now()
  from migration.source_documents source
  join commerce.payment_records payment
    on payment.legacy_sanity_id = source.legacy_sanity_id
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(source.payload->'refunds') = 'array'
      then source.payload->'refunds' else '[]'::jsonb end
  ) refund(payload)
  where source.document_type = 'paymentRecord'
    and not source.tombstoned
    and coalesce(nullif(refund.payload->>'providerRefundId', ''), refund.payload->>'_key') is not null
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids))
  on conflict (provider, provider_refund_id) do update
  set
    booking_id = excluded.booking_id,
    event_type = excluded.event_type,
    status = excluded.status,
    amount_subunits = excluded.amount_subunits,
    currency = excluded.currency,
    full_refund = excluded.full_refund,
    accounting_reversed = excluded.accounting_reversed,
    slot_released = excluded.slot_released,
    payload = excluded.payload,
    occurred_at = excluded.occurred_at,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = excluded.backend_owner,
    cutover_generation = excluded.cutover_generation,
    updated_at = now();
  get diagnostics v_refunds = row_count;

  update migration.source_documents
  set operational_imported = true
  where document_type in ('owedReferral', 'creatorPayout')
    and not tombstoned
    and (p_document_ids is null or legacy_sanity_id = any(p_document_ids));

  return jsonb_build_object(
    'email_dispatches', v_emails,
    'referral_ledger', v_referrals,
    'refunds', v_refunds
  );
end;
$$;

create or replace function migration.restore_commerce_owners(
  p_document_ids text[] default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update commerce.bookings target
  set
    backend_owner = source.backend_owner,
    source_backend = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'booking'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.slot_holds target
  set
    backend_owner = source.backend_owner,
    source_backend = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'slotHold'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.booking_slots target
  set
    backend_owner = source.backend_owner,
    source_backend = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'bookingSlot'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.payment_records target
  set
    backend_owner = source.backend_owner,
    source_backend = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'paymentRecord'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.coupons target
  set
    backend_owner = source.backend_owner,
    source_backend = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'coupon'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.coupon_redemptions target
  set
    backend_owner = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type = 'couponRedemption'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.recovery_cases target
  set
    backend_owner = source.backend_owner,
    cutover_generation = source.cutover_generation
  from migration.source_documents source
  where source.document_type in ('paymentRecoveryCase', 'bookingRecoveryCase')
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.payment_start_claims target
  set backend_owner = source.backend_owner
  from migration.source_documents source
  where source.document_type = 'paymentStartClaim'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.payment_proof_claims target
  set backend_owner = source.backend_owner
  from migration.source_documents source
  where source.document_type = 'paymentProofClaim'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.payment_upgrade_locks target
  set backend_owner = source.backend_owner
  from migration.source_documents source
  where source.document_type = 'paymentUpgradeLock'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));

  update commerce.webhook_receipts target
  set backend_owner = source.backend_owner
  from migration.source_documents source
  where source.document_type = 'paymentWebhookReceipt'
    and target.legacy_sanity_id = source.legacy_sanity_id
    and (p_document_ids is null or source.legacy_sanity_id = any(p_document_ids));
end;
$$;

create or replace function public.roo_refresh_operational_shadow()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_projection jsonb;
  v_extensions jsonb;
  v_cleanup jsonb;
begin
  v_projection := public.roo_project_operational_shadow();
  v_extensions := migration.project_commerce_extensions(null);
  perform migration.restore_commerce_owners(null);
  v_cleanup := public.roo_cleanup_operational_shadow();
  return jsonb_build_object(
    'projection', v_projection,
    'extensions', v_extensions,
    'cleanup', v_cleanup
  );
end;
$$;

create or replace function public.roo_apply_commerce_document_mutations(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command_id text := btrim(coalesce(p_command_id, ''));
  v_request_hash text;
  v_existing migration.commerce_commands%rowtype;
  v_mutation jsonb;
  v_operation text;
  v_id text;
  v_expected_revision text;
  v_current migration.source_documents%rowtype;
  v_payload jsonb;
  v_type text;
  v_revision text;
  v_hash text;
  v_now timestamptz;
  v_results jsonb := '[]'::jsonb;
  v_changed_ids text[] := '{}';
  v_deleted_ids text[] := '{}';
  v_documents jsonb;
  v_canonical_hash text;
  v_event_key text;
  v_result jsonb;
begin
  if v_command_id !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid commerce command id' using errcode = '22023';
  end if;
  if jsonb_typeof(p_mutations) <> 'array' or jsonb_array_length(p_mutations) < 1 then
    raise exception 'p_mutations must be a nonempty JSON array' using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, 0) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  v_request_hash := encode(
    extensions.digest(
      (p_mutations || jsonb_build_object('generation', p_cutover_generation))::text,
      'sha256'
    ),
    'hex'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_command_id, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('roo-commerce-mutations', 0)
  );

  select * into v_existing
  from migration.commerce_commands
  where command_id = v_command_id
  for update;
  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'commerce command id was reused with different input'
        using errcode = '23505';
    end if;
    return v_existing.result;
  end if;

  for v_mutation in select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_type := nullif(btrim(coalesce(v_mutation->'document'->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');
    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(v_id, '')), '') is null then
      raise exception 'document mutation is missing id' using errcode = '22023';
    end if;
    if v_operation <> 'delete' and (
      v_type is null or not (v_type = any(array[
        'booking', 'slotHold', 'bookingSlot',
        'paymentRecord', 'paymentStartClaim', 'paymentUpgradeLock',
        'paymentProofClaim', 'paymentWebhookReceipt', 'paymentRecoveryCase',
        'bookingRecoveryCase', 'coupon', 'couponRedemption', 'referral',
        'owedReferral', 'creatorPayout'
      ]::text[]))
    ) then
      raise exception 'document type is outside the commerce domain: %', coalesce(v_type, '')
        using errcode = '22023';
    end if;
    if v_type = 'referral' and v_operation <> 'replace' then
      raise exception 'referral commerce mutations must patch an existing record'
        using errcode = '22023';
    end if;

    select * into v_current
    from migration.source_documents
    where legacy_sanity_id = v_id
    for update;

    if v_operation = 'create' and found and not v_current.tombstoned then
      raise exception 'document already exists: %', v_id using errcode = '23505';
    end if;
    if v_operation = 'create_if_missing' and found and not v_current.tombstoned then
      v_results := v_results || jsonb_build_array(v_current.payload);
      continue;
    end if;
    if v_operation in ('replace', 'delete') and (not found or v_current.tombstoned) then
      raise exception 'document not found: %', v_id using errcode = 'P0002';
    end if;
    if v_operation = 'delete' and found and not (
      v_current.document_type = any(array[
        'booking', 'slotHold', 'bookingSlot',
        'paymentRecord', 'paymentStartClaim', 'paymentUpgradeLock',
        'paymentProofClaim', 'paymentWebhookReceipt', 'paymentRecoveryCase',
        'bookingRecoveryCase', 'coupon', 'couponRedemption',
        'owedReferral', 'creatorPayout'
      ]::text[])
    ) then
      raise exception 'document type is outside the commerce domain: %', v_current.document_type
        using errcode = '22023';
    end if;
    if v_operation = 'replace' and v_current.document_type is distinct from v_type then
      raise exception 'document type cannot change during replacement'
        using errcode = '22023';
    end if;
    if v_expected_revision is not null
      and found and not v_current.tombstoned
      and v_current.source_revision is distinct from v_expected_revision then
      raise exception 'document revision conflict: %', v_id using errcode = '40001';
    end if;

    if v_operation = 'delete' then
      update migration.source_documents
      set
        tombstoned = true,
        tombstoned_at = now(),
        last_seen_at = now(),
        backend_owner = 'supabase',
        cutover_generation = p_cutover_generation
      where legacy_sanity_id = v_id;
      delete from cms.documents where legacy_sanity_id = v_id;
      v_deleted_ids := array_append(v_deleted_ids, v_id);
      v_changed_ids := array_append(v_changed_ids, v_id);
      v_results := v_results || jsonb_build_array(jsonb_build_object('_id', v_id, 'deleted', true));
      continue;
    end if;

    v_payload := v_mutation->'document';
    if v_payload is null or nullif(btrim(coalesce(v_type, '')), '') is null then
      raise exception 'document mutation is missing document type' using errcode = '22023';
    end if;
    if v_type = 'referral' then
      v_payload := (
        v_current.payload - array[
          'successfulReferrals',
          'currentCommissionPercent',
          'currentDiscountPercent',
          'isFirstTime',
          'xocPayments',
          'vertexPayments',
          'earnedXoc',
          'earnedVertex',
          'earnedTotal',
          'paidXoc',
          'paidVertex',
          'paidTotal',
          'owedXoc',
          'owedVertex',
          'owedTotal',
          'notes'
        ]
      ) || migration.referral_commerce_patch(v_payload);
    end if;

    v_now := clock_timestamp();
    v_revision := replace(gen_random_uuid()::text, '-', '');
    v_payload := v_payload || jsonb_build_object(
      '_id', v_id,
      '_type', v_type,
      '_rev', v_revision,
      '_updatedAt', v_now,
      'backendOwner', 'supabase',
      'cutoverGeneration', p_cutover_generation
    );
    if not (v_payload ? '_createdAt') then
      v_payload := v_payload || jsonb_build_object(
        '_createdAt', coalesce(v_current.payload->'_createdAt', to_jsonb(v_now))
      );
    end if;
    v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

    insert into migration.source_documents (
      legacy_sanity_id, document_type, source_revision, source_hash, payload,
      source_created_at, source_updated_at, first_seen_at, last_seen_at,
      operational_imported, cms_imported, tombstoned, tombstoned_at,
      backend_owner, cutover_generation
    ) values (
      v_id, v_type, v_revision, v_hash, v_payload,
      nullif(v_payload->>'_createdAt', '')::timestamptz, v_now, now(), now(),
      false, false, false, null, 'supabase', p_cutover_generation
    )
    on conflict (legacy_sanity_id) do update set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_created_at = coalesce(migration.source_documents.source_created_at, excluded.source_created_at),
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false,
      tombstoned_at = null,
      backend_owner = 'supabase',
      cutover_generation = excluded.cutover_generation;
    perform cms.sync_document_from_source(v_payload, v_hash);
    v_changed_ids := array_append(v_changed_ids, v_id);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;

  -- The existing projector is intentionally called inside this transaction.
  -- A projection failure therefore rolls back the compatibility documents and
  -- the outbox record together.
  perform public.roo_refresh_operational_shadow();
  perform migration.project_commerce_extensions(v_changed_ids);
  perform migration.restore_commerce_owners(v_changed_ids);

  select coalesce(jsonb_agg(source.payload order by source.legacy_sanity_id), '[]'::jsonb)
  into v_documents
  from migration.source_documents source
  where source.legacy_sanity_id = any(v_changed_ids) and not source.tombstoned;
  select coalesce(array_agg(distinct deleted_id order by deleted_id), '{}'::text[])
  into v_deleted_ids
  from unnest(v_deleted_ids) deleted_id
  where not exists (
    select 1 from migration.source_documents source
    where source.legacy_sanity_id = deleted_id and not source.tombstoned
  );
  select coalesce(array_agg(distinct changed_id order by changed_id), '{}'::text[])
  into v_changed_ids
  from unnest(v_changed_ids) changed_id;
  v_canonical_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'documents', coalesce((
          select jsonb_agg(
            migration.canonical_business_document(item.value)
            order by item.value->>'_id'
          ) from jsonb_array_elements(v_documents) item(value)
        ), '[]'::jsonb),
        'deleted_ids', to_jsonb(v_deleted_ids),
        'generation', p_cutover_generation
      )::text,
      'sha256'
    ),
    'hex'
  );
  v_event_key := 'commerce-mirror:' || encode(
    extensions.digest(v_command_id || ':' || v_canonical_hash, 'sha256'),
    'hex'
  );
  v_result := jsonb_build_object(
    'results', v_results,
    'event_key', v_event_key,
    'command_id', v_command_id,
    'cutover_generation', p_cutover_generation
  );

  insert into migration.commerce_commands (
    command_id, request_hash, cutover_generation, result
  ) values (v_command_id, v_request_hash, p_cutover_generation, v_result);

  insert into migration.commerce_mirror_outbox (
    command_id, event_key, document_ids, documents, deleted_ids,
    canonical_hash, cutover_generation
  ) values (
    v_command_id, v_event_key, v_changed_ids, v_documents, v_deleted_ids,
    v_canonical_hash, p_cutover_generation
  ) on conflict (event_key) do nothing;

  return v_result;
end;
$$;

create or replace function public.roo_claim_commerce_mirror_events(
  p_lease_id text,
  p_limit integer default 25,
  p_force boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if nullif(btrim(coalesce(p_lease_id, '')), '') is null then
    raise exception 'mirror lease id is required' using errcode = '22023';
  end if;
  with candidates as (
    select id
    from migration.commerce_mirror_outbox
    where (
      status in ('pending', 'retry')
      and (
        coalesce(p_force, false)
        or coalesce(next_attempt_at, '-infinity'::timestamptz) <= now()
      )
    ) or (
      status = 'processing' and lease_expires_at <= now()
    )
    order by created_at, id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update migration.commerce_mirror_outbox outbox
    set
      status = 'processing',
      lease_id = p_lease_id,
      lease_expires_at = now() + interval '2 minutes',
      attempt_count = attempt_count + 1
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_key', event_key,
    'documents', documents,
    'deleted_ids', to_jsonb(deleted_ids),
    'canonical_hash', canonical_hash,
    'cutover_generation', cutover_generation,
    'attempt_count', attempt_count
  ) order by created_at, id), '[]'::jsonb)
  into v_result
  from claimed;
  return v_result;
end;
$$;

create or replace function public.roo_complete_commerce_mirror_event(
  p_event_key text,
  p_lease_id text,
  p_success boolean,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
begin
  select * into v_event
  from migration.commerce_mirror_outbox
  where event_key = p_event_key
  for update;
  if not found then
    raise exception 'mirror event not found' using errcode = 'P0002';
  end if;
  if v_event.status = 'mirrored' then
    return jsonb_build_object('event_key', p_event_key, 'mirrored', true, 'idempotent', true);
  end if;
  if v_event.lease_id is distinct from p_lease_id then
    raise exception 'mirror event lease conflict' using errcode = '40001';
  end if;

  if p_success then
    update migration.commerce_mirror_outbox
    set
      status = 'mirrored',
      mirrored_at = now(),
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = null
    where event_key = p_event_key;
    insert into migration.commerce_mirror_checkpoints (
      event_key, canonical_hash, cutover_generation, document_count
    ) values (
      p_event_key,
      v_event.canonical_hash,
      v_event.cutover_generation,
      cardinality(v_event.document_ids)
    ) on conflict (event_key) do nothing;
  else
    update migration.commerce_mirror_outbox
    set
      status = case when attempt_count >= 12 then 'dead_letter' else 'retry' end,
      next_attempt_at = case
        when attempt_count >= 12 then null
        else now() + least(interval '1 hour', interval '1 minute' * power(2, least(attempt_count, 6)))
      end,
      lease_id = null,
      lease_expires_at = null,
      last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED'), 128)
    where event_key = p_event_key;
  end if;
  return jsonb_build_object('event_key', p_event_key, 'mirrored', p_success);
end;
$$;

create or replace function public.roo_commerce_mirror_backlog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'pending', count(*),
    'oldest_created_at', min(created_at),
    'oldest_age_seconds', coalesce(
      extract(epoch from now() - min(created_at))::bigint,
      0
    )
  )
  from migration.commerce_mirror_outbox
  where status <> 'mirrored';
$$;

create or replace function public.roo_consume_rate_limit(
  p_bucket_key_hmac text,
  p_window_started_at timestamptz,
  p_reset_at timestamptz,
  p_max integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_bucket_key_hmac !~ '^[0-9a-f]{64}$'
    or p_window_started_at is null
    or p_reset_at <= p_window_started_at
    or p_max < 1 then
    raise exception 'invalid rate limit command' using errcode = '22023';
  end if;
  insert into commerce.rate_limit_buckets (
    bucket_key_hmac, window_started_at, count, reset_at, backend_owner
  ) values (
    p_bucket_key_hmac, p_window_started_at, 1, p_reset_at, 'supabase'
  )
  on conflict (bucket_key_hmac, window_started_at) do update
  set
    count = commerce.rate_limit_buckets.count + 1,
    reset_at = greatest(commerce.rate_limit_buckets.reset_at, excluded.reset_at),
    updated_at = now(),
    backend_owner = 'supabase'
  returning count into v_count;
  return jsonb_build_object(
    'allowed', v_count <= p_max,
    'count', v_count,
    'remaining', greatest(0, p_max - v_count),
    'reset_at', p_reset_at
  );
end;
$$;

create or replace function public.roo_cleanup_commerce_rate_limits(
  p_now timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  delete from commerce.rate_limit_buckets
  where backend_owner = 'supabase' and reset_at <= coalesce(p_now, now());
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

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
        'completed_at', completed_at,
        'status', status,
        'counters', counters
      )
      from migration.sync_runs
      where direction = 'sanity_to_supabase' and status = 'completed'
      order by completed_at desc limit 1
    ),
    'last_mirror_checkpoint', (
      select jsonb_build_object(
        'event_key', event_key,
        'generation', cutover_generation,
        'mirrored_at', mirrored_at
      )
      from migration.commerce_mirror_checkpoints
      order by id desc limit 1
    ),
    'mirror', jsonb_build_object(
      'pending', (select count(*) from migration.commerce_mirror_outbox where status <> 'mirrored'),
      'oldest_pending_at', (
        select min(created_at) from migration.commerce_mirror_outbox where status <> 'mirrored'
      ),
      'dead_letters', (
        select count(*) from migration.commerce_mirror_outbox where status = 'dead_letter'
      )
    ),
    'captured_without_booking', (
      select count(*) from commerce.payment_records
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
      select count(*) from commerce.email_dispatches where status in ('retry', 'failed')
    ),
    'email_oldest_retry_at', (
      select min(coalesce(next_attempt_at, updated_at))
      from commerce.email_dispatches where status in ('retry', 'failed')
    ),
    'coupon_mismatches', (
      select count(*) from commerce.coupons
      where consumed_uses < 0 or reserved_uses < 0
        or (maximum_uses is not null and consumed_uses + reserved_uses > maximum_uses)
    ),
    'referral_ambiguous', (
      select count(*)
      from migration.source_documents
      where document_type in ('owedReferral', 'creatorPayout') and not tombstoned
        and btrim(coalesce(
          case when document_type = 'creatorPayout'
            then payload->>'amount' else payload->>'totalOwed' end,
          ''
        )) !~ '^-?[0-9]+([.][0-9]{1,2})?$'
    ),
    'recent_metrics', (
      select jsonb_build_object(
        'sample_count', count(*),
        'p95_ms', coalesce(
          round(percentile_cont(0.95) within group (order by duration_ms))::integer,
          0
        ),
        'error_rate', coalesce(
          round(10000 * avg(case when status_code >= 500 then 1 else 0 end)) / 100,
          0
        ),
        'max_response_bytes', coalesce(max(response_bytes), 0)
      )
      from migration.commerce_request_metrics
      where recorded_at >= now() - interval '5 minutes'
    ),
    'duplicate_active_slots', (
      select count(*) from (
        select start_time_utc from commerce.booking_slots
        where status = 'active' group by start_time_utc having count(*) > 1
      ) duplicates
    )
  );
$$;

create or replace function public.roo_record_commerce_metric(
  p_route text,
  p_backend text,
  p_cutover_generation integer,
  p_duration_ms integer,
  p_status_code integer,
  p_response_bytes integer default 0
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into migration.commerce_request_metrics (
    route, backend, cutover_generation, duration_ms, status_code, response_bytes
  ) values (
    lower(btrim(p_route)),
    lower(btrim(p_backend)),
    greatest(0, coalesce(p_cutover_generation, 0)),
    greatest(0, coalesce(p_duration_ms, 0)),
    p_status_code,
    greatest(0, coalesce(p_response_bytes, 0))
  );
end;
$$;

create or replace function public.roo_cleanup_commerce_metrics(
  p_before timestamptz default now() - interval '14 days'
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  delete from migration.commerce_request_metrics
  where recorded_at < coalesce(p_before, now() - interval '14 days');
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

create or replace function public.roo_commerce_canonical_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', legacy_sanity_id,
    'type', document_type,
    'hash', migration.canonical_business_hash(payload),
    'tombstoned', tombstoned
  ) order by legacy_sanity_id), '[]'::jsonb)
  from migration.source_documents;
$$;

create or replace function public.roo_hash_canonical_documents(
  p_documents jsonb
)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', document.value->>'_id',
    'hash', migration.canonical_business_hash(document.value)
  ) order by document.value->>'_id'), '[]'::jsonb)
  from jsonb_array_elements(p_documents) document(value)
  where nullif(document.value->>'_id', '') is not null;
$$;

create or replace function public.roo_commerce_typed_gap_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with active as (
    select * from migration.source_documents where not tombstoned
  ), refund_sources as (
    select count(*)::bigint as count
    from active source
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(source.payload->'refunds') = 'array'
        then source.payload->'refunds' else '[]'::jsonb end
    ) refund(payload)
    where source.document_type = 'paymentRecord'
      and coalesce(nullif(refund.payload->>'providerRefundId', ''), refund.payload->>'_key') is not null
  )
  select jsonb_build_object(
    'bookings', jsonb_build_object(
      'source', (select count(*) from migration.source_documents where document_type = 'booking'),
      'typed', (select count(*) from commerce.bookings),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.bookings target on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'booking' and target.source_hash <> source.source_hash
      )
    ),
    'payments', jsonb_build_object(
      'source', (select count(*) from migration.source_documents where document_type = 'paymentRecord'),
      'typed', (select count(*) from commerce.payment_records),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.payment_records target on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'paymentRecord' and target.source_hash <> source.source_hash
      )
    ),
    'coupons', jsonb_build_object(
      'source', (select count(*) from migration.source_documents where document_type = 'coupon'),
      'typed', (select count(*) from commerce.coupons),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.coupons target on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'coupon' and target.source_hash <> source.source_hash
      )
    ),
    'holds', jsonb_build_object(
      'source', (select count(*) from migration.source_documents where document_type = 'slotHold'),
      'typed', (select count(*) from commerce.slot_holds),
      'hash_mismatches', (
        select count(*) from active source
        join commerce.slot_holds target on target.legacy_sanity_id = source.legacy_sanity_id
        where source.document_type = 'slotHold' and target.source_hash <> source.source_hash
      )
    ),
    'email_dispatches', jsonb_build_object(
      'expected', (
        select count(*) * 2 + count(*) filter (
          where coalesce(migration.try_boolean(payload->>'requiresReschedule'), false)
        ) * 2
        from active where document_type = 'booking'
      ),
      'typed', (select count(*) from commerce.email_dispatches),
      'unsafe_historical_retries', (
        select count(*) from commerce.email_dispatches
        where payload->>'historical_backfill' = 'true'
          and sent_at is null and status <> 'historical_unknown'
      )
    ),
    'referral_ledger', jsonb_build_object(
      'expected', (
        select count(*) from active where document_type in ('owedReferral', 'creatorPayout')
      ),
      'typed', (select count(*) from commerce.referral_ledger),
      'missing_creator_links', (
        select count(*) from commerce.referral_ledger
        where creator_user_id is null
      )
    ),
    'refunds', jsonb_build_object(
      'expected', (select count from refund_sources),
      'typed', (select count(*) from commerce.refunds)
    ),
    'duplicate_provider_orders', (
      select count(*) from (
        select provider, provider_order_id from commerce.payment_records
        where provider_order_id is not null
        group by provider, provider_order_id having count(*) > 1
      ) duplicate
    ),
    'duplicate_provider_payments', (
      select count(*) from (
        select provider, provider_payment_id from commerce.payment_records
        where provider_payment_id is not null
        group by provider, provider_payment_id having count(*) > 1
      ) duplicate
    ),
    'duplicate_email_keys', (
      select count(*) from (
        select idempotency_key from commerce.email_dispatches
        group by idempotency_key having count(*) > 1
      ) duplicate
    )
  );
$$;

revoke all on function public.roo_fetch_shadow_documents_targeted(text[], text[], jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.roo_apply_commerce_document_mutations(text, jsonb, integer)
  from public, anon, authenticated;
revoke all on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  from public, anon, authenticated;
revoke all on function public.roo_complete_commerce_mirror_event(text, text, boolean, text)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_mirror_backlog()
  from public, anon, authenticated;
revoke all on function public.roo_consume_rate_limit(text, timestamptz, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.roo_cleanup_commerce_rate_limits(timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_commerce_canonical_manifest()
  from public, anon, authenticated;
revoke all on function public.roo_hash_canonical_documents(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_typed_gap_summary()
  from public, anon, authenticated;
revoke all on function public.roo_record_commerce_metric(text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.roo_cleanup_commerce_metrics(timestamptz)
  from public, anon, authenticated;

grant execute on function public.roo_fetch_shadow_documents_targeted(text[], text[], jsonb, integer)
  to service_role;
grant execute on function public.roo_fetch_recovery_payment_documents(text, text[], text, text, text, timestamptz, integer)
  to service_role;
grant execute on function public.roo_apply_commerce_document_mutations(text, jsonb, integer)
  to service_role;
grant execute on function public.roo_claim_commerce_mirror_events(text, integer, boolean)
  to service_role;
grant execute on function public.roo_complete_commerce_mirror_event(text, text, boolean, text)
  to service_role;
grant execute on function public.roo_commerce_mirror_backlog()
  to service_role;
grant execute on function public.roo_consume_rate_limit(text, timestamptz, timestamptz, integer)
  to service_role;
grant execute on function public.roo_cleanup_commerce_rate_limits(timestamptz)
  to service_role;
grant execute on function public.roo_commerce_readiness()
  to service_role;
grant execute on function public.roo_commerce_canonical_manifest()
  to service_role;
grant execute on function public.roo_hash_canonical_documents(jsonb)
  to service_role;
grant execute on function public.roo_commerce_typed_gap_summary()
  to service_role;
grant execute on function public.roo_record_commerce_metric(text, text, integer, integer, integer, integer)
  to service_role;
grant execute on function public.roo_cleanup_commerce_metrics(timestamptz)
  to service_role;

-- Validate and project accounting before the migration can succeed. Any
-- ambiguous decimal aborts the migration and therefore blocks cutover.
select migration.project_commerce_extensions(null);
