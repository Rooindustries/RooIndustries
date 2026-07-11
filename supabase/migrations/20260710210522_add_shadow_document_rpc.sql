
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
    p_payload->>'name'
  );
  v_status text := case
    when v_id like 'drafts.%' then 'draft'
    else 'published'
  end;
  v_cms_types constant text[] := array[
    'benchmark',
    'package',
    'faqSection',
    'review',
    'about',
    'contact',
    'footer',
    'hero',
    'howItWorks',
    'privacyPolicy',
    'services',
    'terms',
    'proReviewsCarousel',
    'tool',
    'referralBox',
    'faqSettings',
    'packagesSettings',
    'supportedGames',
    'upgradeLink',
    'discordBanner',
    'meetTheTeam',
    'siteSettings'
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
  v_count integer := 0;
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
      tombstoned
    )
    values (
      v_id,
      v_type,
      coalesce(v_item->>'source_revision', v_payload->>'_rev'),
      v_hash,
      v_payload,
      nullif(coalesce(v_item->>'source_created_at', v_payload->>'_createdAt'), '')::timestamptz,
      nullif(coalesce(v_item->>'source_updated_at', v_payload->>'_updatedAt'), '')::timestamptz,
      now(),
      now(),
      coalesce((v_item->>'operational_imported')::boolean, false),
      coalesce((v_item->>'cms_imported')::boolean, false),
      false
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
      tombstoned = false;

    perform cms.sync_document_from_source(v_payload, v_hash);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('imported', v_count);
end;
$$;

create or replace function public.roo_fetch_shadow_documents(
  p_document_types text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(payload order by legacy_sanity_id), '[]'::jsonb)
  from migration.source_documents
  where not tombstoned
    and (
      p_document_types is null
      or document_type = any(p_document_types)
    );
$$;

create or replace function public.roo_apply_document_mutations(
  p_mutations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
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
begin
  if jsonb_typeof(p_mutations) <> 'array' then
    raise exception 'p_mutations must be a JSON array'
      using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;

    if v_id is null or v_id = '' then
      raise exception 'document mutation is missing id'
        using errcode = '22023';
    end if;

    select *
    into v_current
    from migration.source_documents
    where legacy_sanity_id = v_id
    for update;

    if v_operation = 'create' and found then
      raise exception 'document already exists: %', v_id
        using errcode = '23505';
    end if;

    if v_operation = 'create_if_missing' and found then
      v_results := v_results || jsonb_build_array(v_current.payload);
      continue;
    end if;

    if v_operation in ('replace', 'delete') and not found then
      raise exception 'document not found: %', v_id
        using errcode = 'P0002';
    end if;

    if v_expected_revision is not null
       and found
       and v_current.source_revision is distinct from v_expected_revision then
      raise exception 'document revision conflict: %', v_id
        using errcode = '40001';
    end if;

    if v_operation = 'delete' then
      delete from cms.documents where legacy_sanity_id = v_id;
      delete from migration.source_documents where legacy_sanity_id = v_id;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('_id', v_id, 'deleted', true)
      );
      continue;
    end if;

    v_payload := v_mutation->'document';
    v_type := v_payload->>'_type';

    if v_payload is null or v_type is null or v_type = '' then
      raise exception 'document mutation is missing document type'
        using errcode = '22023';
    end if;

    v_now := clock_timestamp();
    v_revision := replace(gen_random_uuid()::text, '-', '');
    v_payload := v_payload || jsonb_build_object(
      '_id', v_id,
      '_type', v_type,
      '_rev', v_revision,
      '_updatedAt', v_now
    );

    if not (v_payload ? '_createdAt') then
      v_payload := v_payload || jsonb_build_object(
        '_createdAt',
        coalesce(v_current.payload->'_createdAt', to_jsonb(v_now))
      );
    end if;

    v_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

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
      tombstoned
    )
    values (
      v_id,
      v_type,
      v_revision,
      v_hash,
      v_payload,
      nullif(v_payload->>'_createdAt', '')::timestamptz,
      v_now,
      now(),
      now(),
      false,
      false,
      false
    )
    on conflict (legacy_sanity_id) do update
    set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false;

    perform cms.sync_document_from_source(v_payload, v_hash);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;

  return v_results;
end;
$$;

create or replace function public.roo_shadow_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'source_documents', (select count(*) from migration.source_documents where not tombstoned),
    'cms_documents', (select count(*) from cms.documents),
    'cms_assets', (select count(*) from cms.assets),
    'auth_users', (select count(*) from auth.users),
    'open_drift_findings', (
      select count(*) from migration.drift_findings where status = 'open'
    ),
    'dead_letters', (
      select count(*) from migration.dead_letters where resolved_at is null
    )
  );
$$;

revoke all on function public.roo_import_shadow_batch(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_fetch_shadow_documents(text[])
  from public, anon, authenticated;
revoke all on function public.roo_apply_document_mutations(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_shadow_summary()
  from public, anon, authenticated;

grant execute on function public.roo_import_shadow_batch(jsonb)
  to service_role;
grant execute on function public.roo_fetch_shadow_documents(text[])
  to service_role;
grant execute on function public.roo_apply_document_mutations(jsonb)
  to service_role;
grant execute on function public.roo_shadow_summary()
  to service_role;
