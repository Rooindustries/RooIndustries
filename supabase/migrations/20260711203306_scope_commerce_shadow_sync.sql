create or replace function migration.commerce_shadow_document_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'bookingSettings',
    'booking',
    'slotHold',
    'bookingSlot',
    'paymentRecord',
    'paymentStartClaim',
    'paymentProofClaim',
    'paymentUpgradeLock',
    'paymentWebhookReceipt',
    'paymentRecoveryCase',
    'bookingRecoveryCase',
    'coupon',
    'couponRedemption',
    'referral',
    'owedReferral',
    'creatorPayout',
    'package',
    'upgradeLink'
  ]::text[];
$$;

create or replace function migration.commerce_reconcilable_document_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(migration.commerce_shadow_document_types(), 'referral');
$$;

create or replace function public.roo_import_commerce_shadow_batch(
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
  v_type text;
begin
  if jsonb_typeof(p_documents) <> 'array' then
    raise exception 'p_documents must be a JSON array'
      using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_documents)
  loop
    v_payload := v_item->'payload';
    v_type := coalesce(v_item->>'document_type', v_payload->>'_type');
    if v_type is null
      or not (v_type = any(migration.commerce_shadow_document_types())) then
      raise exception 'document type is outside the commerce shadow scope: %',
        coalesce(v_type, '') using errcode = '22023';
    end if;
  end loop;

  return public.roo_import_shadow_batch(p_documents);
end;
$$;

create or replace function public.roo_reconcile_commerce_shadow_sources_since(
  p_source_ids text[],
  p_document_types text[],
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
begin
  if p_source_ids is null
    or p_document_types is null
    or p_snapshot_started_at is null then
    raise exception 'source ids, document types, and snapshot start are required'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from unnest(p_document_types) document_type
    where not (
      document_type = any(migration.commerce_reconcilable_document_types())
    )
  ) then
    raise exception 'reconciliation requested a type outside the safe commerce scope'
      using errcode = '22023';
  end if;

  select count(*)
  into v_preserved_concurrent
  from migration.source_documents source
  where not source.tombstoned
    and source.document_type = any(p_document_types)
    and not (source.legacy_sanity_id = any(p_source_ids))
    and greatest(
      coalesce(source.source_updated_at, '-infinity'::timestamptz),
      source.last_seen_at
    ) > p_snapshot_started_at;

  update migration.source_documents source
  set
    tombstoned = true,
    tombstoned_at = coalesce(source.tombstoned_at, now()),
    last_seen_at = now()
  where not source.tombstoned
    and source.document_type = any(p_document_types)
    and not (source.legacy_sanity_id = any(p_source_ids))
    and greatest(
      coalesce(source.source_updated_at, '-infinity'::timestamptz),
      source.last_seen_at
    ) <= p_snapshot_started_at;
  get diagnostics v_tombstoned = row_count;

  delete from cms.documents document
  using migration.source_documents source
  where document.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = any(p_document_types)
    and source.tombstoned;
  get diagnostics v_removed_cms = row_count;

  return jsonb_build_object(
    'tombstoned', v_tombstoned,
    'preserved_concurrent', v_preserved_concurrent,
    'removed_cms_documents', v_removed_cms
  );
end;
$$;

create or replace function public.roo_commerce_canonical_manifest_for_types(
  p_document_types text[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_document_types is null or exists (
    select 1
    from unnest(p_document_types) document_type
    where not (document_type = any(migration.commerce_shadow_document_types()))
  ) then
    raise exception 'manifest requested a type outside the commerce shadow scope'
      using errcode = '22023';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', source.legacy_sanity_id,
      'type', source.document_type,
      'hash', migration.canonical_business_hash(source.payload),
      'tombstoned', source.tombstoned
    ) order by source.legacy_sanity_id), '[]'::jsonb)
    from migration.source_documents source
    where source.document_type = any(p_document_types)
  );
end;
$$;

create or replace function public.roo_export_commerce_trial_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'format', 'roo-supabase-commerce-export-v1',
    'exported_at', now(),
    'source_documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'legacy_sanity_id', source.legacy_sanity_id,
        'document_type', source.document_type,
        'source_revision', source.source_revision,
        'source_hash', source.source_hash,
        'payload', migration.canonical_business_document(source.payload),
        'source_created_at', source.source_created_at,
        'source_updated_at', source.source_updated_at,
        'last_seen_at', source.last_seen_at,
        'tombstoned', source.tombstoned,
        'tombstoned_at', source.tombstoned_at,
        'backend_owner', source.backend_owner,
        'cutover_generation', source.cutover_generation
      ) order by source.legacy_sanity_id)
      from migration.source_documents source
      where source.document_type = any(migration.commerce_shadow_document_types())
    ), '[]'::jsonb),
    'booking_settings', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.booking_settings record), '[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.bookings record), '[]'::jsonb),
    'slot_holds', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.slot_holds record), '[]'::jsonb),
    'slot_claims', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.slot_claims record), '[]'::jsonb),
    'booking_slots', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.booking_slots record), '[]'::jsonb),
    'payment_records', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.payment_records record), '[]'::jsonb),
    'payment_start_claims', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.payment_start_claims record), '[]'::jsonb),
    'payment_upgrade_locks', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.payment_upgrade_locks record), '[]'::jsonb),
    'payment_proof_claims', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.payment_proof_claims record), '[]'::jsonb),
    'payment_events', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.payment_events record), '[]'::jsonb),
    'webhook_receipts', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.webhook_receipts record), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.refunds record), '[]'::jsonb),
    'coupons', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.coupons record), '[]'::jsonb),
    'coupon_redemptions', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.coupon_redemptions record), '[]'::jsonb),
    'referral_ledger', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.referral_ledger record), '[]'::jsonb),
    'recovery_cases', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.recovery_cases record), '[]'::jsonb),
    'email_dispatches', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.email_dispatches record), '[]'::jsonb),
    'rate_limit_buckets', coalesce((select jsonb_agg(to_jsonb(record)) from commerce.rate_limit_buckets record), '[]'::jsonb),
    'commands', coalesce((select jsonb_agg(to_jsonb(record)) from migration.commerce_commands record), '[]'::jsonb),
    'mirror_outbox', coalesce((select jsonb_agg(to_jsonb(record)) from migration.commerce_mirror_outbox record), '[]'::jsonb),
    'mirror_checkpoints', coalesce((select jsonb_agg(to_jsonb(record)) from migration.commerce_mirror_checkpoints record), '[]'::jsonb),
    'sync_runs', coalesce((select jsonb_agg(to_jsonb(record)) from migration.sync_runs record), '[]'::jsonb),
    'sync_cursors', coalesce((select jsonb_agg(to_jsonb(record)) from migration.sync_cursors record), '[]'::jsonb),
    'drift_findings', coalesce((select jsonb_agg(to_jsonb(record)) from migration.drift_findings record), '[]'::jsonb),
    'dead_letters', coalesce((select jsonb_agg(to_jsonb(record)) from migration.dead_letters record), '[]'::jsonb)
  );
$$;

revoke all on function migration.commerce_shadow_document_types()
  from public, anon, authenticated;
revoke all on function migration.commerce_reconcilable_document_types()
  from public, anon, authenticated;
revoke all on function public.roo_import_commerce_shadow_batch(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_reconcile_commerce_shadow_sources_since(text[], text[], timestamptz)
  from public, anon, authenticated;
revoke all on function public.roo_commerce_canonical_manifest_for_types(text[])
  from public, anon, authenticated;
revoke all on function public.roo_export_commerce_trial_snapshot()
  from public, anon, authenticated;

grant execute on function public.roo_import_commerce_shadow_batch(jsonb)
  to service_role;
grant execute on function public.roo_reconcile_commerce_shadow_sources_since(text[], text[], timestamptz)
  to service_role;
grant execute on function public.roo_commerce_canonical_manifest_for_types(text[])
  to service_role;
grant execute on function public.roo_export_commerce_trial_snapshot()
  to service_role;
