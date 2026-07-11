
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  primary_email text,
  display_name text not null default '',
  avatar_url text,
  timezone text,
  status text not null default 'active'
    check (status in ('pending', 'active', 'disabled', 'deleted')),
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  source_backend text not null default 'supabase'
    check (source_backend in ('sanity', 'supabase')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    primary_email is null
    or (
      primary_email = lower(btrim(primary_email))
      and char_length(primary_email) between 3 and 254
    )
  )
);

create unique index profiles_primary_email_key
  on public.profiles (lower(primary_email))
  where primary_email is not null;

alter table public.profiles enable row level security;
revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name, avatar_url, timezone) on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create table accounts.account_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null
    check (role in (
      'customer',
      'creator',
      'tourney_player',
      'tourney_viewer',
      'tourney_caster',
      'tourney_owner',
      'administrator'
    )),
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id) on delete set null,
  source_backend text not null default 'supabase'
    check (source_backend in ('sanity', 'supabase')),
  legacy_sanity_id text,
  primary key (user_id, role)
);

create table accounts.login_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alias_type text not null
    check (alias_type in ('email', 'referral_code', 'tourney_username')),
  normalized_value text not null,
  verified boolean not null default false,
  legacy_sanity_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (alias_type, normalized_value),
  check (
    normalized_value = lower(btrim(normalized_value))
    and char_length(normalized_value) between 1 and 254
  )
);

create table accounts.identity_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null
    check (provider in ('email', 'google', 'apple', 'discord')),
  provider_subject text not null,
  provider_email text,
  email_verified boolean not null default false,
  linked_at timestamptz not null default now(),
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  unique (provider, provider_subject),
  check (
    provider_email is null
    or provider_email = lower(btrim(provider_email))
  )
);

create table accounts.credential_migrations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legacy_sanity_id text unique,
  legacy_source text not null
    check (legacy_source in ('referral', 'tourney', 'none')),
  credential_kind text not null
    check (credential_kind in ('bcrypt', 'legacy_plaintext', 'none')),
  status text not null
    check (status in ('pending', 'imported', 'upgraded', 'blocked')),
  source_revision text,
  imported_at timestamptz,
  upgraded_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts.creator_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  referral_code text not null unique,
  paypal_email text,
  contact_discord text,
  contact_telegram text,
  contact_phone text,
  commission_basis_points integer not null default 1000
    check (commission_basis_points between 0 and 10000),
  discount_basis_points integer not null default 0
    check (discount_basis_points between 0 and 10000),
  successful_referrals integer not null default 0
    check (successful_referrals >= 0),
  payout_details jsonb not null default '{}'::jsonb,
  accounting_totals jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    referral_code = lower(btrim(referral_code))
    and char_length(referral_code) between 2 and 50
  ),
  check (
    paypal_email is null
    or paypal_email = lower(btrim(paypal_email))
  )
);

create table accounts.tourney_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role text not null
    check (role in ('tourney_player', 'tourney_viewer', 'tourney_caster', 'tourney_owner')),
  active boolean not null default true,
  credential_version text not null default '1',
  legacy_sanity_id text,
  source_revision text,
  source_hash text,
  legacy_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    username = lower(btrim(username))
    and char_length(username) between 1 and 80
  )
);

create table licensing.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  status text not null default 'active'
    check (status in ('draft', 'active', 'retired')),
  default_max_devices smallint not null default 1
    check (default_max_devices between 1 and 10),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    sku = lower(btrim(sku))
    and sku ~ '^[a-z0-9][a-z0-9._-]{1,63}$'
  )
);

create table licensing.entitlements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references licensing.products(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  buyer_email text not null,
  purchase_backend text not null
    check (purchase_backend in ('sanity', 'supabase', 'manual')),
  purchase_reference text not null,
  status text not null default 'unclaimed'
    check (status in ('unclaimed', 'active', 'suspended', 'revoked', 'refunded')),
  max_devices smallint not null default 1
    check (max_devices between 1 and 10),
  claimed_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  legacy_sanity_id text unique,
  source_revision text,
  source_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, purchase_backend, purchase_reference),
  check (
    buyer_email = lower(btrim(buyer_email))
    and char_length(buyer_email) between 3 and 254
  )
);

create table licensing.device_activations (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references licensing.entitlements(id) on delete cascade,
  device_fingerprint_hmac text not null,
  device_label text,
  app_version text,
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revocation_reason text,
  metadata jsonb not null default '{}'::jsonb,
  unique (entitlement_id, device_fingerprint_hmac),
  check (device_fingerprint_hmac ~ '^[0-9a-f]{64}$'),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index device_activations_one_active_per_entitlement
  on licensing.device_activations (entitlement_id)
  where status = 'active';

create table licensing.activation_events (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references licensing.entitlements(id) on delete cascade,
  activation_id uuid references licensing.device_activations(id) on delete set null,
  action text not null
    check (action in (
      'claim',
      'activate',
      'heartbeat',
      'reject',
      'revoke',
      'reactivate'
    )),
  request_id text not null unique,
  actor_user_id uuid references auth.users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

alter table accounts.account_roles enable row level security;
alter table accounts.login_aliases enable row level security;
alter table accounts.identity_links enable row level security;
alter table accounts.credential_migrations enable row level security;
alter table accounts.creator_profiles enable row level security;
alter table accounts.tourney_accounts enable row level security;
alter table licensing.products enable row level security;
alter table licensing.entitlements enable row level security;
alter table licensing.device_activations enable row level security;
alter table licensing.activation_events enable row level security;

revoke all on all tables in schema accounts, licensing from public, anon, authenticated;
grant all on all tables in schema accounts, licensing to service_role;
grant usage, select on all sequences in schema accounts, licensing to service_role;
