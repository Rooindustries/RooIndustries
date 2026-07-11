
create table commerce.booking_settings (
  id text primary key default 'default',
  payload jsonb not null default '{}'::jsonb,
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  source_updated_at timestamptz,
  imported_at timestamptz,
  updated_at timestamptz not null default now(),
  check (id = 'default')
);

create table commerce.bookings (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  source_revision text,
  source_hash text,
  status text not null
    check (status in ('pending', 'captured', 'completed', 'failed', 'refunded', 'cancelled')),
  customer_email text,
  payer_email text,
  customer_name text,
  package_legacy_id text,
  package_title text not null,
  start_time_utc timestamptz,
  customer_timezone text,
  amount_subunits bigint not null default 0 check (amount_subunits >= 0),
  currency text not null default 'USD'
    check (currency ~ '^[A-Z]{3}$'),
  payment_record_id uuid,
  referral_user_id uuid references auth.users(id) on delete set null,
  coupon_code text,
  requires_reschedule boolean not null default false,
  cancelled_at timestamptz,
  refunded_at timestamptz,
  completed_at timestamptz,
  booking_payload jsonb not null default '{}'::jsonb,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_email is null or customer_email = lower(btrim(customer_email))),
  check (payer_email is null or payer_email = lower(btrim(payer_email)))
);

create table commerce.slot_holds (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  source_revision text,
  source_hash text,
  start_time_utc timestamptz not null,
  package_legacy_id text,
  package_title text not null,
  phase text not null
    check (phase in ('active', 'payment', 'consumed', 'released', 'expired')),
  expires_at timestamptz not null,
  owner_token_hash text,
  payment_record_id uuid,
  released_at timestamptz,
  release_reason text,
  payload jsonb not null default '{}'::jsonb,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    phase not in ('released', 'expired')
    or released_at is not null
  )
);

create table commerce.booking_slots (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  booking_id uuid not null references commerce.bookings(id) on delete restrict,
  start_time_utc timestamptz not null,
  status text not null default 'active'
    check (status in ('active', 'released')),
  locked_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  source_revision text,
  source_hash text,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'active' and released_at is null)
    or (status = 'released' and released_at is not null)
  )
);

create table commerce.slot_claims (
  start_time_utc timestamptz primary key,
  claim_type text not null check (claim_type in ('hold', 'booking')),
  hold_id uuid references commerce.slot_holds(id) on delete restrict,
  booking_id uuid references commerce.bookings(id) on delete restrict,
  expires_at timestamptz,
  claimed_at timestamptz not null default now(),
  check (
    (claim_type = 'hold' and hold_id is not null and booking_id is null and expires_at is not null)
    or
    (claim_type = 'booking' and booking_id is not null and hold_id is null and expires_at is null)
  )
);

create table commerce.payment_records (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  source_revision text,
  source_hash text,
  provider text not null check (provider in ('paypal', 'razorpay', 'free')),
  status text not null
    check (status in (
      'started',
      'order_pending',
      'order_created',
      'captured',
      'finalizing',
      'booked',
      'needs_recovery',
      'email_partial',
      'abandoned',
      'failed',
      'refunded',
      'reversed'
    )),
  session_scope text not null,
  quote_fingerprint text not null,
  pricing_fingerprint text,
  provider_idempotency_key text not null,
  provider_order_id text,
  provider_payment_id text,
  amount_subunits bigint not null check (amount_subunits >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  booking_id uuid references commerce.bookings(id) on delete set null,
  slot_hold_id uuid references commerce.slot_holds(id) on delete set null,
  coupon_redemption_id uuid,
  provider_public_data jsonb not null default '{}'::jsonb,
  booking_payload jsonb not null default '{}'::jsonb,
  pricing_snapshot jsonb not null default '{}'::jsonb,
  immutable_snapshot_hash text,
  session_expires_at timestamptz not null,
  finalization_lease_id text,
  finalization_lease_expires_at timestamptz,
  recovery_attempt_count integer not null default 0 check (recovery_attempt_count >= 0),
  next_recovery_at timestamptz,
  requires_reschedule boolean not null default false,
  refund_state text,
  email_dispatch_required boolean not null default false,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_scope),
  unique (provider_idempotency_key)
);

create unique index payment_records_provider_order_key
  on commerce.payment_records (provider, provider_order_id)
  where provider_order_id is not null;

create unique index payment_records_provider_payment_key
  on commerce.payment_records (provider, provider_payment_id)
  where provider_payment_id is not null;

alter table commerce.bookings
  add constraint bookings_payment_record_fkey
  foreign key (payment_record_id)
  references commerce.payment_records(id)
  on delete set null;

alter table commerce.slot_holds
  add constraint slot_holds_payment_record_fkey
  foreign key (payment_record_id)
  references commerce.payment_records(id)
  on delete set null;

create table commerce.payment_events (
  id uuid primary key default gen_random_uuid(),
  payment_record_id uuid not null references commerce.payment_records(id) on delete cascade,
  event_key text not null,
  status text,
  source text,
  reason text,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  legacy_sanity_id text,
  created_at timestamptz not null default now(),
  unique (payment_record_id, event_key)
);

create table commerce.payment_start_claims (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  scope text not null unique,
  payment_record_id uuid not null unique references commerce.payment_records(id) on delete cascade,
  provider text not null check (provider in ('paypal', 'razorpay', 'free')),
  quote_fingerprint text not null,
  created_at timestamptz not null default now()
);

create table commerce.payment_proof_claims (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  payment_record_id uuid not null references commerce.payment_records(id) on delete cascade,
  provider text not null check (provider in ('paypal', 'razorpay', 'free')),
  provider_order_id text,
  provider_payment_id text,
  booking_id uuid references commerce.bookings(id) on delete set null,
  status text not null check (status in ('claimed', 'booked', 'released')),
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index payment_proof_claims_order_key
  on commerce.payment_proof_claims (provider, provider_order_id)
  where provider_order_id is not null;

create unique index payment_proof_claims_payment_key
  on commerce.payment_proof_claims (provider, provider_payment_id)
  where provider_payment_id is not null;

create table commerce.payment_upgrade_locks (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  scope text not null unique,
  payment_record_id uuid not null references commerce.payment_records(id) on delete cascade,
  provider text not null check (provider in ('paypal', 'razorpay', 'free')),
  quote_fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table commerce.webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  provider text not null check (provider in ('paypal', 'razorpay')),
  event_id text not null,
  event_type text not null,
  status text not null
    check (status in ('received', 'processing', 'processed', 'ignored', 'retry')),
  payment_record_id uuid references commerce.payment_records(id) on delete set null,
  lease_id text,
  lease_expires_at timestamptz,
  http_status integer,
  payload_hash text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (provider, event_id)
);

create table commerce.refunds (
  id uuid primary key default gen_random_uuid(),
  payment_record_id uuid not null references commerce.payment_records(id) on delete cascade,
  booking_id uuid references commerce.bookings(id) on delete set null,
  provider text not null check (provider in ('paypal', 'razorpay')),
  provider_refund_id text not null,
  event_type text not null,
  status text not null
    check (status in ('pending', 'completed', 'failed', 'reversed')),
  amount_subunits bigint not null check (amount_subunits >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  full_refund boolean not null default false,
  accounting_reversed boolean not null default false,
  slot_released boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  legacy_sanity_id text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_refund_id)
);

create table commerce.coupons (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  code text not null unique,
  active boolean not null default true,
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_basis_points integer
    check (discount_basis_points is null or discount_basis_points between 0 and 10000),
  discount_amount_subunits bigint
    check (discount_amount_subunits is null or discount_amount_subunits >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  maximum_uses integer check (maximum_uses is null or maximum_uses >= 0),
  consumed_uses integer not null default 0 check (consumed_uses >= 0),
  reserved_uses integer not null default 0 check (reserved_uses >= 0),
  expires_at timestamptz,
  source_revision text,
  source_hash text,
  source_backend text not null default 'sanity'
    check (source_backend in ('sanity', 'supabase')),
  payload jsonb not null default '{}'::jsonb,
  imported_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    code = lower(btrim(code))
    and char_length(code) between 1 and 80
  ),
  check (
    (discount_kind = 'percent' and discount_basis_points is not null)
    or
    (discount_kind = 'fixed' and discount_amount_subunits is not null and currency is not null)
  )
);

create table commerce.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  coupon_id uuid not null references commerce.coupons(id) on delete restrict,
  payment_record_id uuid references commerce.payment_records(id) on delete set null,
  booking_id uuid references commerce.bookings(id) on delete set null,
  redemption_key text not null unique,
  state text not null
    check (state in ('reserved', 'consumed', 'released', 'refunded')),
  reservation_expires_at timestamptz,
  consumed_at timestamptz,
  released_at timestamptz,
  restored_at timestamptz,
  source_revision text,
  source_hash text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table commerce.payment_records
  add constraint payment_records_coupon_redemption_fkey
  foreign key (coupon_redemption_id)
  references commerce.coupon_redemptions(id)
  on delete set null;

create table commerce.referral_ledger (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid references auth.users(id) on delete set null,
  booking_id uuid references commerce.bookings(id) on delete set null,
  payment_record_id uuid references commerce.payment_records(id) on delete set null,
  entry_type text not null
    check (entry_type in ('commission', 'reversal', 'restoration', 'payout', 'adjustment')),
  amount_subunits bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  idempotency_key text not null unique,
  legacy_sanity_id text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table commerce.recovery_cases (
  id uuid primary key default gen_random_uuid(),
  legacy_sanity_id text unique,
  case_type text not null check (case_type in ('payment', 'booking', 'email')),
  payment_record_id uuid references commerce.payment_records(id) on delete set null,
  booking_id uuid references commerce.bookings(id) on delete set null,
  status text not null check (status in ('open', 'retrying', 'resolved', 'abandoned')),
  reason text not null,
  requires_reschedule boolean not null default false,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  source_revision text,
  source_hash text,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create table commerce.email_dispatches (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references commerce.bookings(id) on delete cascade,
  recovery_case_id uuid references commerce.recovery_cases(id) on delete cascade,
  recipient_type text not null check (recipient_type in ('customer', 'owner')),
  recipient_email_hash text not null,
  idempotency_key text not null unique,
  status text not null
    check (status in ('pending', 'sending', 'sent', 'retry', 'failed')),
  lease_id text,
  lease_expires_at timestamptz,
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz,
  sent_at timestamptz,
  last_error_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (booking_id is not null or recovery_case_id is not null)
);

create table commerce.rate_limit_buckets (
  bucket_key_hmac text not null,
  window_started_at timestamptz not null,
  count integer not null default 0 check (count >= 0),
  reset_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bucket_key_hmac, window_started_at),
  check (bucket_key_hmac ~ '^[0-9a-f]{64}$'),
  check (reset_at > window_started_at)
);

alter table commerce.booking_settings enable row level security;
alter table commerce.bookings enable row level security;
alter table commerce.slot_holds enable row level security;
alter table commerce.booking_slots enable row level security;
alter table commerce.slot_claims enable row level security;
alter table commerce.payment_records enable row level security;
alter table commerce.payment_events enable row level security;
alter table commerce.payment_start_claims enable row level security;
alter table commerce.payment_proof_claims enable row level security;
alter table commerce.payment_upgrade_locks enable row level security;
alter table commerce.webhook_receipts enable row level security;
alter table commerce.refunds enable row level security;
alter table commerce.coupons enable row level security;
alter table commerce.coupon_redemptions enable row level security;
alter table commerce.referral_ledger enable row level security;
alter table commerce.recovery_cases enable row level security;
alter table commerce.email_dispatches enable row level security;
alter table commerce.rate_limit_buckets enable row level security;

revoke all on all tables in schema commerce from public, anon, authenticated;
grant all on all tables in schema commerce to service_role;
grant usage, select on all sequences in schema commerce to service_role;
