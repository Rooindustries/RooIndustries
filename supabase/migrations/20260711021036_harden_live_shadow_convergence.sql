alter table migration.source_documents
  add column if not exists tombstoned_at timestamptz;

update migration.source_documents
set tombstoned_at = coalesce(tombstoned_at, last_seen_at, now())
where tombstoned
  and tombstoned_at is null;

create or replace function public.roo_import_shadow_batch(
  p_documents jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
  v_payload jsonb;
  v_id text;
  v_type text;
  v_hash text;
  v_applied integer;
  v_imported integer := 0;
  v_skipped_stale integer := 0;
begin
  if jsonb_typeof(p_documents) <> 'array' then
    raise exception 'p_documents must be a JSON array'
      using errcode = '22023';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_documents)
  loop
    v_payload := v_item->'payload';
    v_id := coalesce(v_item->>'legacy_sanity_id', v_payload->>'_id');
    v_type := coalesce(v_item->>'document_type', v_payload->>'_type');
    v_hash := v_item->>'source_hash';

    if v_id is null or v_type is null or v_payload is null then
      raise exception 'shadow document is missing id, type, or payload'
        using errcode = '22023';
    end if;
    if v_payload->>'_id' <> v_id or v_payload->>'_type' <> v_type then
      raise exception 'shadow document identity mismatch for %', v_id
        using errcode = '22023';
    end if;
    if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'shadow document hash is invalid for %', v_id
        using errcode = '22023';
    end if;

    insert into migration.source_documents (
      legacy_sanity_id,
      document_type,
      source_revision,
      source_hash,
      payload,
      source_created_at,
      source_updated_at,
      first_seen_at,
      last_seen_at,
      operational_imported,
      cms_imported,
      tombstoned,
      tombstoned_at
    )
    values (
      v_id,
      v_type,
      coalesce(v_item->>'source_revision', v_payload->>'_rev'),
      v_hash,
      v_payload,
      nullif(
        coalesce(v_item->>'source_created_at', v_payload->>'_createdAt'),
        ''
      )::timestamptz,
      nullif(
        coalesce(v_item->>'source_updated_at', v_payload->>'_updatedAt'),
        ''
      )::timestamptz,
      now(),
      now(),
      coalesce((v_item->>'operational_imported')::boolean, false),
      coalesce((v_item->>'cms_imported')::boolean, false),
      false,
      null
    )
    on conflict (legacy_sanity_id) do update
    set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_created_at = excluded.source_created_at,
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      operational_imported = migration.source_documents.operational_imported
        or excluded.operational_imported,
      cms_imported = migration.source_documents.cms_imported
        or excluded.cms_imported,
      tombstoned = false,
      tombstoned_at = null
    where
      (
        excluded.source_updated_at is null
        and migration.source_documents.source_updated_at is null
        and migration.source_documents.tombstoned_at is null
      )
      or (
        excluded.source_updated_at is not null
        and (
          migration.source_documents.source_updated_at is null
          or excluded.source_updated_at >= migration.source_documents.source_updated_at
        )
        and (
          migration.source_documents.tombstoned_at is null
          or excluded.source_updated_at > migration.source_documents.tombstoned_at
        )
      );
    get diagnostics v_applied = row_count;

    if v_applied = 1 then
      perform cms.sync_document_from_source(v_payload, v_hash);
      v_imported := v_imported + 1;
    else
      v_skipped_stale := v_skipped_stale + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'imported', v_imported,
    'skipped_stale', v_skipped_stale
  );
end;
$$;

create or replace function public.roo_shadow_manifest()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', legacy_sanity_id,
        'type', document_type,
        'revision', coalesce(source_revision, ''),
        'updatedAt', coalesce(source_updated_at::text, ''),
        'hash', source_hash,
        'tombstoned', tombstoned,
        'tombstonedAt', coalesce(tombstoned_at::text, '')
      )
      order by legacy_sanity_id
    ),
    '[]'::jsonb
  )
  from migration.source_documents;
$$;

create or replace function public.roo_project_referral_account_shadow(
  p_legacy_sanity_ids text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profiles integer := 0;
  v_creators integer := 0;
begin
  update public.profiles profile
  set
    display_name = coalesce(
      nullif(btrim(source.payload->>'name'), ''),
      nullif(lower(btrim(source.payload#>>'{slug,current}')), ''),
      profile.display_name
    ),
    status = case
      when lower(coalesce(source.payload->>'active', 'true')) = 'false'
        then 'disabled'
      else 'active'
    end,
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    source_backend = 'sanity',
    updated_at = now()
  from migration.source_documents source
  where profile.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and not source.tombstoned
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_profiles = row_count;

  update accounts.creator_profiles creator
  set
    referral_code = coalesce(
      nullif(lower(btrim(source.payload#>>'{slug,current}')), ''),
      creator.referral_code
    ),
    paypal_email = nullif(lower(btrim(source.payload->>'paypalEmail')), ''),
    contact_discord = nullif(source.payload->>'contactDiscord', ''),
    commission_basis_points = case
      when btrim(coalesce(source.payload->>'currentCommissionPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(
        10000::numeric,
        greatest(
          0::numeric,
          round((source.payload->>'currentCommissionPercent')::numeric * 100)
        )
      )::integer
      else creator.commission_basis_points
    end,
    discount_basis_points = case
      when btrim(coalesce(source.payload->>'currentDiscountPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(
        10000::numeric,
        greatest(
          0::numeric,
          round((source.payload->>'currentDiscountPercent')::numeric * 100)
        )
      )::integer
      else creator.discount_basis_points
    end,
    successful_referrals = case
      when btrim(coalesce(source.payload->>'successfulReferrals', '')) ~ '^[0-9]+$'
      then least(
        2147483647::numeric,
        (source.payload->>'successfulReferrals')::numeric
      )::integer
      else creator.successful_referrals
    end,
    payout_details = jsonb_build_object(
      'paypal_email', nullif(lower(btrim(source.payload->>'paypalEmail')), '')
    ),
    accounting_totals = jsonb_build_object(
      'earned_total', coalesce(source.payload->'earnedTotal', '0'::jsonb),
      'owed_total', coalesce(source.payload->'owedTotal', '0'::jsonb),
      'paid_total', coalesce(source.payload->'paidTotal', '0'::jsonb),
      'earned_vertex', coalesce(source.payload->'earnedVertex', '0'::jsonb),
      'earned_xoc', coalesce(source.payload->'earnedXoc', '0'::jsonb),
      'owed_vertex', coalesce(source.payload->'owedVertex', '0'::jsonb),
      'owed_xoc', coalesce(source.payload->'owedXoc', '0'::jsonb),
      'paid_vertex', coalesce(source.payload->'paidVertex', '0'::jsonb),
      'paid_xoc', coalesce(source.payload->'paidXoc', '0'::jsonb)
    ),
    active = lower(coalesce(source.payload->>'active', 'true')) <> 'false',
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = 'sanity',
    updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and not source.tombstoned
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_creators = row_count;

  return jsonb_build_object(
    'profiles', v_profiles,
    'creator_profiles', v_creators
  );
end;
$$;

create or replace function public.roo_tombstone_shadow_ids(
  p_ids text[],
  p_deleted_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_at timestamptz := coalesce(p_deleted_at, now());
  v_tombstoned integer := 0;
  v_removed_cms integer := 0;
  v_disabled_profiles integer := 0;
  v_disabled_creators integer := 0;
begin
  if p_ids is null then
    raise exception 'p_ids is required'
      using errcode = '22023';
  end if;

  update migration.source_documents source
  set
    tombstoned = true,
    tombstoned_at = greatest(
      coalesce(source.tombstoned_at, '-infinity'::timestamptz),
      v_deleted_at
    ),
    last_seen_at = now()
  where source.legacy_sanity_id = any(p_ids)
    and (
      not source.tombstoned
      or source.tombstoned_at is null
      or source.tombstoned_at < v_deleted_at
    );
  get diagnostics v_tombstoned = row_count;

  delete from cms.documents document
  using migration.source_documents source
  where document.legacy_sanity_id = source.legacy_sanity_id
    and source.tombstoned
    and source.legacy_sanity_id = any(p_ids);
  get diagnostics v_removed_cms = row_count;

  update public.profiles profile
  set status = 'disabled', updated_at = now()
  from migration.source_documents source
  where profile.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and source.tombstoned
    and source.legacy_sanity_id = any(p_ids);
  get diagnostics v_disabled_profiles = row_count;

  update accounts.creator_profiles creator
  set active = false, backend_owner = 'sanity', updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and source.tombstoned
    and source.legacy_sanity_id = any(p_ids);
  get diagnostics v_disabled_creators = row_count;

  return jsonb_build_object(
    'tombstoned', v_tombstoned,
    'removed_cms_documents', v_removed_cms,
    'disabled_profiles', v_disabled_profiles,
    'disabled_creator_profiles', v_disabled_creators
  );
end;
$$;

create or replace function public.roo_reconcile_shadow_sources_since(
  p_source_ids text[],
  p_snapshot_started_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tombstoned integer := 0;
  v_removed_cms integer := 0;
  v_preserved_concurrent integer := 0;
  v_disabled_profiles integer := 0;
  v_disabled_creators integer := 0;
begin
  if p_source_ids is null or p_snapshot_started_at is null then
    raise exception 'source ids and snapshot start are required'
      using errcode = '22023';
  end if;

  select count(*)
  into v_preserved_concurrent
  from migration.source_documents source
  where not source.tombstoned
    and not (source.legacy_sanity_id = any(p_source_ids))
    and source.source_updated_at > p_snapshot_started_at;

  update migration.source_documents source
  set
    tombstoned = true,
    tombstoned_at = coalesce(source.tombstoned_at, now()),
    last_seen_at = now()
  where not source.tombstoned
    and not (source.legacy_sanity_id = any(p_source_ids))
    and (
      source.source_updated_at is null
      or source.source_updated_at <= p_snapshot_started_at
    );
  get diagnostics v_tombstoned = row_count;

  delete from cms.documents document
  using migration.source_documents source
  where document.legacy_sanity_id = source.legacy_sanity_id
    and source.tombstoned;
  get diagnostics v_removed_cms = row_count;

  update public.profiles profile
  set status = 'disabled', updated_at = now()
  from migration.source_documents source
  where profile.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and source.tombstoned;
  get diagnostics v_disabled_profiles = row_count;

  update accounts.creator_profiles creator
  set active = false, backend_owner = 'sanity', updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and source.tombstoned;
  get diagnostics v_disabled_creators = row_count;

  return jsonb_build_object(
    'tombstoned', v_tombstoned,
    'preserved_concurrent', v_preserved_concurrent,
    'removed_cms_documents', v_removed_cms,
    'disabled_profiles', v_disabled_profiles,
    'disabled_creator_profiles', v_disabled_creators
  );
end;
$$;

revoke all on function public.roo_import_shadow_batch(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_shadow_manifest()
  from public, anon, authenticated;
revoke all on function public.roo_project_referral_account_shadow(text[])
  from public, anon, authenticated;
revoke all on function public.roo_tombstone_shadow_ids(text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_reconcile_shadow_sources_since(text[], timestamptz)
  from public, anon, authenticated;

grant execute on function public.roo_import_shadow_batch(jsonb)
  to service_role;
grant execute on function public.roo_shadow_manifest()
  to service_role;
grant execute on function public.roo_project_referral_account_shadow(text[])
  to service_role;
grant execute on function public.roo_tombstone_shadow_ids(text[], timestamptz)
  to service_role;
grant execute on function public.roo_reconcile_shadow_sources_since(text[], timestamptz)
  to service_role;
