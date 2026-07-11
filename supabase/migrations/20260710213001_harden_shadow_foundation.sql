
alter table accounts.account_roles
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table accounts.login_aliases
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table accounts.identity_links
  add column if not exists legacy_sanity_id text,
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table accounts.credential_migrations
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table accounts.creator_profiles
  add column if not exists backend_owner text not null default 'supabase';
alter table accounts.tourney_accounts
  add column if not exists backend_owner text not null default 'supabase';
alter table licensing.entitlements
  add column if not exists backend_owner text not null default 'supabase';

alter table commerce.bookings
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.slot_holds
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.booking_slots
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.slot_claims
  add column if not exists legacy_sanity_id text,
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.payment_records
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.payment_events
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.payment_start_claims
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.payment_proof_claims
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.payment_upgrade_locks
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.webhook_receipts
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.refunds
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.coupons
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.coupon_redemptions
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.referral_ledger
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.recovery_cases
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.email_dispatches
  add column if not exists legacy_sanity_id text,
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';
alter table commerce.rate_limit_buckets
  add column if not exists legacy_sanity_id text,
  add column if not exists source_revision text,
  add column if not exists source_hash text,
  add column if not exists backend_owner text not null default 'supabase';

do $$
declare
  v_table regclass;
begin
  foreach v_table in array array[
    'accounts.account_roles'::regclass,
    'accounts.login_aliases'::regclass,
    'accounts.identity_links'::regclass,
    'accounts.credential_migrations'::regclass,
    'accounts.creator_profiles'::regclass,
    'accounts.tourney_accounts'::regclass,
    'licensing.entitlements'::regclass,
    'commerce.bookings'::regclass,
    'commerce.slot_holds'::regclass,
    'commerce.booking_slots'::regclass,
    'commerce.slot_claims'::regclass,
    'commerce.payment_records'::regclass,
    'commerce.payment_events'::regclass,
    'commerce.payment_start_claims'::regclass,
    'commerce.payment_proof_claims'::regclass,
    'commerce.payment_upgrade_locks'::regclass,
    'commerce.webhook_receipts'::regclass,
    'commerce.refunds'::regclass,
    'commerce.coupons'::regclass,
    'commerce.coupon_redemptions'::regclass,
    'commerce.referral_ledger'::regclass,
    'commerce.recovery_cases'::regclass,
    'commerce.email_dispatches'::regclass,
    'commerce.rate_limit_buckets'::regclass
  ]
  loop
    if not exists (
      select 1
      from pg_constraint
      where conrelid = v_table
        and conname = replace(v_table::text, '.', '_') || '_backend_owner_check'
    ) then
      execute format(
        'alter table %s add constraint %I check (backend_owner in (''sanity'', ''supabase''))',
        v_table,
        replace(v_table::text, '.', '_') || '_backend_owner_check'
      );
    end if;
  end loop;
end;
$$;

create or replace function cms.sync_document_from_source(
  p_payload jsonb,
  p_content_hash text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id text := p_payload->>'_id';
  v_type text := p_payload->>'_type';
  v_slug text := coalesce(
    p_payload->'slug'->>'current',
    case
      when jsonb_typeof(p_payload->'slug') = 'string' then p_payload->>'slug'
      else null
    end
  );
  v_title text := coalesce(
    p_payload->>'title',
    p_payload->>'heading',
    p_payload->>'name',
    p_payload->>'label'
  );
  v_status text := case
    when v_id like 'drafts.%' then 'draft'
    else 'published'
  end;
  v_cms_types constant text[] := array[
    'about',
    'benchmark',
    'contact',
    'discordBanner',
    'faqSection',
    'faqSettings',
    'footer',
    'hero',
    'howItWorks',
    'meetTheTeam',
    'package',
    'packageBullet',
    'packagesSettings',
    'privacyPolicy',
    'proReviewsCarousel',
    'referralBox',
    'review',
    'reviewsCarousel',
    'services',
    'siteSettings',
    'supportedGames',
    'terms',
    'tool',
    'upgradeLink'
  ];
begin
  if not (v_type = any(v_cms_types)) then
    return;
  end if;

  insert into cms.documents (
    legacy_sanity_id,
    document_type,
    slug,
    title,
    publication_status,
    payload,
    content_hash,
    source_revision,
    source_created_at,
    source_updated_at,
    imported_at,
    published_at,
    updated_at
  )
  values (
    v_id,
    v_type,
    nullif(v_slug, ''),
    nullif(v_title, ''),
    v_status,
    p_payload,
    p_content_hash,
    p_payload->>'_rev',
    nullif(p_payload->>'_createdAt', '')::timestamptz,
    nullif(p_payload->>'_updatedAt', '')::timestamptz,
    now(),
    case when v_status = 'published' then now() else null end,
    now()
  )
  on conflict (legacy_sanity_id) do update
  set
    document_type = excluded.document_type,
    slug = excluded.slug,
    title = excluded.title,
    publication_status = excluded.publication_status,
    payload = excluded.payload,
    content_hash = excluded.content_hash,
    source_revision = excluded.source_revision,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at,
    imported_at = excluded.imported_at,
    published_at = coalesce(cms.documents.published_at, excluded.published_at),
    updated_at = now();
end;
$$;

create or replace function public.roo_upsert_asset(p_asset jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := btrim(p_asset->>'legacy_sanity_asset_id');
  v_source_url text := btrim(p_asset->>'source_url');
  v_storage_path text := btrim(p_asset->>'storage_path');
  v_mime_type text := lower(btrim(p_asset->>'mime_type'));
  v_sha256 text := lower(btrim(p_asset->>'sha256'));
  v_asset_id uuid;
begin
  if v_id = '' or v_source_url = '' or v_storage_path = '' then
    raise exception 'asset import is missing identity or path'
      using errcode = '22023';
  end if;
  if v_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'asset checksum is invalid'
      using errcode = '22023';
  end if;
  if coalesce((p_asset->>'byte_size')::bigint, -1) < 0 then
    raise exception 'asset size is invalid'
      using errcode = '22023';
  end if;

  insert into cms.assets (
    legacy_sanity_asset_id,
    source_url,
    storage_bucket,
    storage_path,
    mime_type,
    byte_size,
    sha256,
    width,
    height,
    hotspot,
    crop,
    metadata,
    migration_status,
    copied_at,
    verified_at,
    updated_at
  )
  values (
    v_id,
    v_source_url,
    'site-content-public',
    v_storage_path,
    v_mime_type,
    (p_asset->>'byte_size')::bigint,
    v_sha256,
    nullif(p_asset->>'width', '')::integer,
    nullif(p_asset->>'height', '')::integer,
    p_asset->'hotspot',
    p_asset->'crop',
    coalesce(p_asset->'metadata', '{}'::jsonb),
    'verified',
    now(),
    now(),
    now()
  )
  on conflict (legacy_sanity_asset_id) do update
  set
    source_url = excluded.source_url,
    storage_bucket = excluded.storage_bucket,
    storage_path = excluded.storage_path,
    mime_type = excluded.mime_type,
    byte_size = excluded.byte_size,
    sha256 = excluded.sha256,
    width = excluded.width,
    height = excluded.height,
    hotspot = excluded.hotspot,
    crop = excluded.crop,
    metadata = excluded.metadata,
    migration_status = 'verified',
    copied_at = coalesce(cms.assets.copied_at, now()),
    verified_at = now(),
    updated_at = now()
  returning id into v_asset_id;

  return jsonb_build_object(
    'asset_id', v_asset_id,
    'legacy_sanity_asset_id', v_id,
    'verified', true
  );
end;
$$;

create or replace function public.roo_replace_document_asset_links(p_links jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link jsonb;
  v_document_id uuid;
  v_asset_id uuid;
  v_inserted integer := 0;
begin
  if jsonb_typeof(p_links) <> 'array' then
    raise exception 'p_links must be a JSON array'
      using errcode = '22023';
  end if;

  delete from cms.document_assets;

  for v_link in select value from jsonb_array_elements(p_links)
  loop
    select id into v_document_id
    from cms.documents
    where legacy_sanity_id = v_link->>'document_legacy_id';

    select id into v_asset_id
    from cms.assets
    where legacy_sanity_asset_id = v_link->>'asset_legacy_id';

    if v_document_id is null or v_asset_id is null then
      raise exception 'asset link references a missing document or asset'
        using errcode = '23503';
    end if;

    insert into cms.document_assets (document_id, asset_id, field_path)
    values (v_document_id, v_asset_id, v_link->>'field_path')
    on conflict do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('linked', v_inserted);
end;
$$;

create or replace function public.roo_start_sync_run(
  p_direction text,
  p_mode text,
  p_source_cursor text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  insert into migration.sync_runs (
    direction,
    mode,
    status,
    source_cursor
  ) values (
    p_direction,
    p_mode,
    'running',
    p_source_cursor
  ) returning id into v_run_id;
  return v_run_id;
end;
$$;

create or replace function public.roo_finish_sync_run(
  p_run_id uuid,
  p_status text,
  p_counters jsonb default '{}'::jsonb,
  p_error_summary text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('completed', 'failed', 'cancelled') then
    raise exception 'invalid terminal sync status'
      using errcode = '22023';
  end if;

  update migration.sync_runs
  set
    status = p_status,
    completed_at = now(),
    counters = coalesce(p_counters, '{}'::jsonb),
    error_summary = nullif(p_error_summary, '')
  where id = p_run_id
    and status = 'running';

  if not found then
    raise exception 'active sync run not found'
      using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.roo_shadow_asset_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'assets', (select count(*) from cms.assets),
    'verified_assets', (
      select count(*) from cms.assets where migration_status = 'verified'
    ),
    'asset_bytes', (select coalesce(sum(byte_size), 0) from cms.assets),
    'document_asset_links', (select count(*) from cms.document_assets),
    'storage_objects', (
      select count(*)
      from storage.objects
      where bucket_id = 'site-content-public'
    )
  );
$$;

revoke all on function public.roo_upsert_asset(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_replace_document_asset_links(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_start_sync_run(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_finish_sync_run(uuid, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.roo_shadow_asset_summary()
  from public, anon, authenticated;

grant execute on function public.roo_upsert_asset(jsonb)
  to service_role;
grant execute on function public.roo_replace_document_asset_links(jsonb)
  to service_role;
grant execute on function public.roo_start_sync_run(text, text, text)
  to service_role;
grant execute on function public.roo_finish_sync_run(uuid, text, jsonb, text)
  to service_role;
grant execute on function public.roo_shadow_asset_summary()
  to service_role;
