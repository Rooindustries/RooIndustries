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
    and not (source.legacy_sanity_id = any(p_source_ids))
    and greatest(
      coalesce(source.source_updated_at, '-infinity'::timestamptz),
      source.last_seen_at
    ) <= p_snapshot_started_at;
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

revoke all on function public.roo_reconcile_shadow_sources_since(text[], timestamptz)
  from public, anon, authenticated;

grant execute on function public.roo_reconcile_shadow_sources_since(text[], timestamptz)
  to service_role;
