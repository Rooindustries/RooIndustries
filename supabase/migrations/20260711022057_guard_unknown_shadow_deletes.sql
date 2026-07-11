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
  v_inserted integer := 0;
  v_tombstoned integer := 0;
  v_removed_cms integer := 0;
  v_disabled_profiles integer := 0;
  v_disabled_creators integer := 0;
begin
  if p_ids is null then
    raise exception 'p_ids is required'
      using errcode = '22023';
  end if;

  with normalized_ids as (
    select distinct btrim(value) as legacy_sanity_id
    from unnest(p_ids) as item(value)
    where nullif(btrim(value), '') is not null
  ), placeholders as (
    select
      legacy_sanity_id,
      jsonb_build_object(
        '_id', legacy_sanity_id,
        '_type', '__tombstone__'
      ) as payload
    from normalized_ids
  )
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
  select
    legacy_sanity_id,
    '__tombstone__',
    null,
    encode(extensions.digest(payload::text, 'sha256'), 'hex'),
    payload,
    null,
    null,
    now(),
    now(),
    false,
    false,
    true,
    v_deleted_at
  from placeholders
  on conflict (legacy_sanity_id) do nothing;
  get diagnostics v_inserted = row_count;

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
    'tombstoned', v_inserted + v_tombstoned,
    'inserted_tombstones', v_inserted,
    'removed_cms_documents', v_removed_cms,
    'disabled_profiles', v_disabled_profiles,
    'disabled_creator_profiles', v_disabled_creators
  );
end;
$$;

revoke all on function public.roo_tombstone_shadow_ids(text[], timestamptz)
  from public, anon, authenticated;

grant execute on function public.roo_tombstone_shadow_ids(text[], timestamptz)
  to service_role;
