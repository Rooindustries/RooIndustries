set lock_timeout = '5s';
set statement_timeout = '120s';

create table migration.cms_publish_commands (
  command_id text primary key
    check (command_id ~ '^cms:[0-9a-f]{64}$'),
  request_hash text not null
    check (request_hash ~ '^[0-9a-f]{64}$'),
  actor text not null
    check (actor ~ '^sanity:[A-Za-z0-9._@/-]{1,120}$'),
  operation text not null
    check (operation in ('create', 'replace', 'delete')),
  status text not null
    check (status in ('processing', 'committed')),
  result jsonb,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  check (
    (status = 'processing' and result is null and committed_at is null)
    or (status = 'committed' and result is not null and committed_at is not null)
  )
);

create index cms_publish_commands_actor_created_idx
  on migration.cms_publish_commands (actor, created_at desc);
create index cms_publish_commands_processing_idx
  on migration.cms_publish_commands (created_at)
  where status = 'processing';

alter table migration.cms_publish_commands enable row level security;

revoke all on migration.cms_publish_commands
  from public, anon, authenticated, service_role;

create policy "cms_publish_commands_deny_browser"
  on migration.cms_publish_commands
  for all to anon, authenticated using (false) with check (false);

create or replace function public.roo_cms_publish_command_result(
  p_command_id text,
  p_request_hash text,
  p_actor text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_command migration.cms_publish_commands%rowtype;
begin
  if coalesce(p_command_id, '') !~ '^cms:[0-9a-f]{64}$'
     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     or right(p_command_id, 64) <> p_request_hash
     or coalesce(p_actor, '') !~ '^sanity:[A-Za-z0-9._@/-]{1,120}$' then
    raise exception 'invalid CMS receipt lookup'
      using errcode = '22023';
  end if;

  select * into v_command
  from migration.cms_publish_commands
  where command_id = p_command_id;
  if not found then return null; end if;
  if v_command.request_hash is distinct from p_request_hash
     or v_command.actor is distinct from p_actor then
    raise exception 'CMS command identity conflict'
      using errcode = '40001';
  end if;
  if v_command.status <> 'committed' then return null; end if;
  return v_command.result || jsonb_build_object('replayed', true);
end;
$$;

create or replace function migration.apply_cms_commerce_mutation(
  p_command_id text,
  p_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation integer;
  v_starts_paused boolean;
  v_request_hash text;
  v_existing migration.commerce_commands%rowtype;
  v_operation text := coalesce(p_mutation->>'operation', '');
  v_id text := coalesce(p_mutation->>'id', p_mutation->'document'->>'_id', '');
  v_expected_revision text := nullif(p_mutation->>'expected_revision', '');
  v_current migration.source_documents%rowtype;
  v_current_exists boolean := false;
  v_type text := nullif(btrim(coalesce(p_mutation->'document'->>'_type', '')), '');
  v_payload jsonb;
  v_revision text;
  v_hash text;
  v_now timestamptz;
  v_documents jsonb := '[]'::jsonb;
  v_deleted_ids text[] := '{}'::text[];
  v_canonical_hash text;
  v_event_key text;
  v_result jsonb;
begin
  if coalesce(p_command_id, '') !~ '^[A-Za-z0-9._:-]{8,160}$'
     or v_operation not in ('create', 'replace', 'delete')
     or v_id = '' then
    raise exception 'invalid CMS commerce mutation'
      using errcode = '22023';
  end if;

  select generation, starts_paused into v_generation, v_starts_paused
  from migration.commerce_control
  where singleton
  for share;
  if not found then
    raise exception 'commerce control is unavailable'
      using errcode = '55000';
  end if;
  if v_starts_paused then
    raise exception 'CMS commerce writes are paused'
      using errcode = '55006';
  end if;
  perform migration.assert_commerce_write_fence(v_generation);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('cms-commerce-document:' || v_id, 0)
  );

  select * into v_current
  from migration.source_documents
  where legacy_sanity_id = v_id
  for update;
  v_current_exists := found;

  if v_operation = 'delete' then
    if not v_current_exists or v_current.tombstoned then
      raise exception 'document not found: %', v_id using errcode = 'P0002';
    end if;
    v_type := v_current.document_type;
  end if;
  if v_type not in ('bookingSettings', 'coupon', 'package', 'upgradeLink') then
    raise exception 'document type is outside the CMS commerce domain: %', coalesce(v_type, '')
      using errcode = '22023';
  end if;

  v_request_hash := migration.commerce_command_hash(
    'document_mutation',
    jsonb_build_array(p_mutation),
    v_generation
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_command_id, 0)
  );

  select * into v_existing
  from migration.commerce_commands
  where command_id = p_command_id
  for update;
  if found then
    if v_existing.request_hash is distinct from v_request_hash then
      raise exception 'commerce command id was reused with different input'
        using errcode = '23505';
    end if;
    return v_existing.result;
  end if;

  if v_operation = 'create' and v_current_exists and not v_current.tombstoned then
    raise exception 'document already exists: %', v_id using errcode = '23505';
  end if;
  if v_operation in ('replace', 'delete')
     and (not v_current_exists or v_current.tombstoned) then
    raise exception 'document not found: %', v_id using errcode = 'P0002';
  end if;
  if v_operation = 'replace' and v_current.document_type is distinct from v_type then
    raise exception 'document type cannot change during replacement'
      using errcode = '22023';
  end if;
  if v_expected_revision is not null
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
      cutover_generation = v_generation
    where legacy_sanity_id = v_id;
    delete from cms.documents where legacy_sanity_id = v_id;
    if v_type = 'bookingSettings' then
      delete from commerce.booking_settings where legacy_sanity_id = v_id;
    elsif v_type = 'coupon' then
      update commerce.coupons
      set active = false, updated_at = now(), backend_owner = 'supabase'
      where legacy_sanity_id = v_id;
    end if;
    v_deleted_ids := array[v_id];
  else
    if coalesce(p_mutation->'document'->>'_id', '') <> v_id then
      raise exception 'CMS commerce document identity mismatch'
        using errcode = '22023';
    end if;
    v_payload := p_mutation->'document';
    v_now := clock_timestamp();
    v_revision := replace(gen_random_uuid()::text, '-', '');
    v_payload := v_payload || jsonb_build_object(
      '_id', v_id,
      '_type', v_type,
      '_rev', v_revision,
      '_updatedAt', v_now,
      'backendOwner', 'supabase',
      'cutoverGeneration', v_generation
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
      false, false, false, null, 'supabase', v_generation
    )
    on conflict (legacy_sanity_id) do update set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_created_at = coalesce(
        migration.source_documents.source_created_at,
        excluded.source_created_at
      ),
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false,
      tombstoned_at = null,
      backend_owner = 'supabase',
      cutover_generation = excluded.cutover_generation;
    perform cms.sync_document_from_source(v_payload, v_hash);
    select jsonb_build_array(source.payload)
    into v_documents
    from migration.source_documents source
    where source.legacy_sanity_id = v_id and not source.tombstoned;
  end if;

  perform migration.project_commerce_document_ids(array[v_id]);
  perform migration.project_commerce_extensions(array[v_id]);
  perform migration.restore_commerce_owners(array[v_id]);
  perform migration.project_commerce_recovery_fields(array[v_id]);
  perform migration.cleanup_commerce_document_ids(array[v_id]);
  if v_type = 'bookingSettings' and v_operation <> 'delete' then
    update commerce.booking_settings
    set source_backend = 'supabase', updated_at = now()
    where legacy_sanity_id = v_id;
  end if;

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
        'generation', v_generation
      )::text,
      'sha256'
    ),
    'hex'
  );
  v_event_key := 'commerce-mirror:' || encode(
    extensions.digest(p_command_id || ':' || v_canonical_hash, 'sha256'),
    'hex'
  );
  v_result := jsonb_build_object(
    'command_id', p_command_id,
    'cutover_generation', v_generation,
    'event_key', v_event_key,
    'results', case
      when v_operation = 'delete'
        then jsonb_build_array(jsonb_build_object('_id', v_id, 'deleted', true))
      else v_documents
    end
  );

  insert into migration.commerce_commands (
    command_id, request_hash, cutover_generation, operation, result, completed_at
  ) values (
    p_command_id, v_request_hash, v_generation,
    'document_mutation', v_result, now()
  );
  insert into migration.commerce_mirror_outbox (
    command_id, event_key, document_ids, documents, deleted_ids,
    canonical_hash, cutover_generation
  ) values (
    p_command_id, v_event_key, array[v_id], v_documents, v_deleted_ids,
    v_canonical_hash, v_generation
  ) on conflict (event_key) do nothing;

  return v_result;
end;
$$;

create or replace function public.roo_apply_cms_publish_command(
  p_command_id text,
  p_request_hash text,
  p_actor text,
  p_mutations jsonb,
  p_assets jsonb default '[]'::jsonb,
  p_asset_links jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing migration.cms_publish_commands%rowtype;
  v_inserted integer := 0;
  v_mutation jsonb;
  v_asset jsonb;
  v_link jsonb;
  v_id text;
  v_type text;
  v_operation text;
  v_mutated_ids text[] := '{}'::text[];
  v_results jsonb;
  v_result jsonb;
begin
  if coalesce(p_command_id, '') !~ '^cms:[0-9a-f]{64}$'
     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     or right(p_command_id, 64) <> p_request_hash
     or coalesce(p_actor, '') !~ '^sanity:[A-Za-z0-9._@/-]{1,120}$'
     or p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) <> 1
     or p_assets is null
     or jsonb_typeof(p_assets) <> 'array'
     or jsonb_array_length(p_assets) > 100
     or p_asset_links is null
     or jsonb_typeof(p_asset_links) <> 'array'
     or jsonb_array_length(p_asset_links) > 500 then
    raise exception 'invalid CMS publish command input'
      using errcode = '22023';
  end if;

  v_mutation := p_mutations->0;
  v_operation := coalesce(v_mutation->>'operation', '');
  v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id', '');
  if v_operation not in ('create', 'replace', 'delete')
     or v_id = ''
     or v_id like 'drafts.%'
     or v_id like 'versions.%'
     or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
     or position('..' in v_id) > 0 then
    raise exception 'invalid CMS document mutation'
      using errcode = '22023';
  end if;

  insert into migration.cms_publish_commands (
    command_id,
    request_hash,
    actor,
    operation,
    status
  ) values (
    p_command_id,
    p_request_hash,
    p_actor,
    v_operation,
    'processing'
  )
  on conflict (command_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_existing
    from migration.cms_publish_commands
    where command_id = p_command_id
    for update;

    if v_existing.request_hash is distinct from p_request_hash
       or v_existing.actor is distinct from p_actor
       or v_existing.operation is distinct from v_operation then
      raise exception 'CMS command identity conflict'
        using errcode = '40001';
    end if;
    if v_existing.status = 'committed' then
      return v_existing.result || jsonb_build_object('replayed', true);
    end if;
    raise exception 'CMS command is already processing'
      using errcode = '55006';
  end if;

  if v_operation = 'delete' then
    select document_type into v_type
    from migration.source_documents
    where legacy_sanity_id = v_id
      and not tombstoned;
  else
    v_type := coalesce(v_mutation->'document'->>'_type', '');
    if coalesce(v_mutation->'document'->>'_id', '') <> v_id then
      raise exception 'invalid CMS document identity'
        using errcode = '22023';
    end if;
  end if;

  if v_type not in (
    'about',
    'benchmark',
    'bookingSettings',
    'contact',
    'coupon',
    'discordBanner',
    'faqSection',
    'faqSettings',
    'footer',
    'hero',
    'howItWorks',
    'meetTheTeam',
    'package',
    'packagesSettings',
    'privacyPolicy',
    'proReviewsCarousel',
    'referralBox',
    'review',
    'services',
    'siteSettings',
    'supportedGames',
    'terms',
    'tool',
    'upgradeLink'
  ) then
    raise exception 'unsupported CMS document type'
      using errcode = '22023';
  end if;

  for v_asset in
    select value from jsonb_array_elements(p_assets)
  loop
    if coalesce(v_asset->>'legacy_sanity_asset_id', '')
         !~ '^(image|file)-[A-Za-z0-9_.-]{1,240}$'
       or coalesce(v_asset->>'storage_bucket', '') not in (
         'site-content-public',
         'optimization-builds-private'
       ) then
      raise exception 'invalid CMS asset input'
        using errcode = '22023';
    end if;
    perform public.roo_upsert_asset(v_asset);
  end loop;

  if v_type in ('bookingSettings', 'coupon', 'package', 'upgradeLink') then
    v_results := migration.apply_cms_commerce_mutation(
      p_command_id || ':commerce',
      v_mutation
    )->'results';
  else
    v_results := public.roo_apply_document_mutations(p_mutations);
  end if;
  v_mutated_ids := array[v_id];

  if v_operation <> 'delete' then
    delete from cms.document_assets target
    using cms.documents document
    where target.document_id = document.id
      and document.legacy_sanity_id = v_id;

    for v_link in
      select value from jsonb_array_elements(p_asset_links)
    loop
      if coalesce(v_link->>'document_legacy_id', '') <> v_id
         or coalesce(v_link->>'asset_legacy_id', '')
           !~ '^(image|file)-[A-Za-z0-9_.-]{1,240}$'
         or char_length(coalesce(v_link->>'field_path', '')) not between 1 and 500 then
        raise exception 'invalid CMS asset link input'
          using errcode = '22023';
      end if;

      insert into cms.document_assets (document_id, asset_id, field_path)
      select document.id, asset.id, v_link->>'field_path'
      from cms.documents document
      join cms.assets asset
        on asset.legacy_sanity_asset_id = v_link->>'asset_legacy_id'
       and asset.migration_status = 'verified'
      where document.legacy_sanity_id = v_id
      on conflict do nothing;

      if not exists (
        select 1
        from cms.documents document
        join cms.document_assets link on link.document_id = document.id
        join cms.assets asset on asset.id = link.asset_id
        where document.legacy_sanity_id = v_id
          and asset.legacy_sanity_asset_id = v_link->>'asset_legacy_id'
          and link.field_path = v_link->>'field_path'
      ) then
        raise exception 'CMS asset link is missing a verified document or asset'
          using errcode = '23503';
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object(
    'assets', jsonb_array_length(p_assets),
    'command_id', p_command_id,
    'document_ids', to_jsonb(v_mutated_ids),
    'operation', v_operation,
    'replayed', false,
    'results', v_results
  );

  update migration.cms_publish_commands
  set
    status = 'committed',
    result = v_result,
    committed_at = now()
  where command_id = p_command_id
    and status = 'processing';

  if not found then
    raise exception 'CMS command receipt could not be committed'
      using errcode = '55000';
  end if;

  return v_result;
end;
$$;

create or replace function public.roo_cms_publish_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with receipts as (
    select
      count(*) filter (where status = 'committed') committed,
      count(*) filter (where status = 'processing') processing,
      min(created_at) filter (where status = 'processing') oldest_processing_at
    from migration.cms_publish_commands
  ), content_mirror as (
    select public.roo_document_mutation_mirror_backlog() value
  ), commerce_mirror as (
    select jsonb_build_object(
      'pending', count(*) filter (
        where status in ('pending', 'processing', 'retry', 'dead_letter')
      ),
      'dead_letters', count(*) filter (where status = 'dead_letter'),
      'overdue', count(*) filter (
        where status in ('pending', 'processing', 'retry')
          and created_at < now() - interval '5 minutes'
      ),
      'ready',
        count(*) filter (where status = 'dead_letter') = 0
        and count(*) filter (
          where status in ('pending', 'processing', 'retry')
            and created_at < now() - interval '5 minutes'
        ) = 0
    ) value
    from migration.commerce_mirror_outbox
  ), assets as (
    select jsonb_build_object(
      'links', count(*),
      'unverified_links', count(*) filter (
        where asset.id is null or asset.migration_status <> 'verified'
      ),
      'ready', count(*) filter (
        where asset.id is null or asset.migration_status <> 'verified'
      ) = 0
    ) value
    from cms.document_assets link
    left join cms.assets asset on asset.id = link.asset_id
  )
  select jsonb_build_object(
    'receipts', jsonb_build_object(
      'committed', receipts.committed,
      'processing', receipts.processing,
      'oldest_processing_at', receipts.oldest_processing_at,
      'ready', receipts.processing = 0
    ),
    'content_mirror', content_mirror.value,
    'commerce_mirror', commerce_mirror.value,
    'assets', assets.value,
    'ready',
      receipts.processing = 0
      and coalesce((content_mirror.value->>'ready')::boolean, false)
      and coalesce((commerce_mirror.value->>'ready')::boolean, false)
      and coalesce((assets.value->>'ready')::boolean, false)
  )
  from receipts, content_mirror, commerce_mirror, assets;
$$;

revoke all on function public.roo_apply_cms_publish_command(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.roo_cms_publish_command_result(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function migration.apply_cms_commerce_mutation(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_cms_publish_readiness()
  from public, anon, authenticated, service_role;

grant execute on function public.roo_apply_cms_publish_command(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb
) to service_role;
grant execute on function public.roo_cms_publish_command_result(text, text, text)
  to service_role;
grant execute on function public.roo_cms_publish_readiness()
  to service_role;
