begin;
set local lock_timeout='5s';set local statement_timeout='120s';
create schema if not exists sanity_rollback_archive;
CREATE OR REPLACE FUNCTION accounts.refresh_creator_fallback_authority(p_principal_id uuid, p_legacy_creator_id text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_legacy_ids text[];
  v_legacy_id text;
  v_principal accounts.principals%rowtype;
  v_creator accounts.creator_profiles%rowtype;
  v_existing accounts.creator_fallback_authorities%rowtype;
  v_authority accounts.creator_fallback_authorities%rowtype;
  v_principal_found boolean;
  v_creator_found boolean;
  v_role_present boolean;
  v_session_version bigint;
  v_credential_changed_at timestamptz;
  v_source_revision text;
  v_document jsonb;
  v_mutation jsonb;
  v_changed integer := 0;
  v_authority_changed boolean;
begin
  if p_principal_id is null then
    raise exception 'Creator fallback authority principal is required'
      using errcode = '22023';
  end if;

  if p_legacy_creator_id is not null then
    if p_legacy_creator_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in p_legacy_creator_id) > 0 then
      raise exception 'Creator fallback authority legacy id is invalid'
        using errcode = '22023';
    end if;
    v_legacy_ids := array[p_legacy_creator_id];
  else
    select coalesce(array_agg(candidate.legacy_creator_id order by candidate.legacy_creator_id), '{}')
    into v_legacy_ids
    from (
      select creator.legacy_sanity_id legacy_creator_id
      from accounts.creator_profiles creator
      where creator.principal_id = p_principal_id
        and creator.legacy_sanity_id is not null
      union
      select authority.legacy_creator_id
      from accounts.creator_fallback_authorities authority
      where authority.principal_id = p_principal_id
    ) candidate;
  end if;

  select principal.* into v_principal
  from accounts.principals principal
  where principal.id = p_principal_id;
  v_principal_found := found;

  foreach v_legacy_id in array v_legacy_ids
  loop
    select creator.* into v_creator
    from accounts.creator_profiles creator
    where creator.principal_id = p_principal_id
      and creator.legacy_sanity_id = v_legacy_id;
    v_creator_found := found;

    select authority.* into v_existing
    from accounts.creator_fallback_authorities authority
    where authority.legacy_creator_id = v_legacy_id
    for update;

    if not v_creator_found and not found then
      continue;
    end if;

    v_role_present := exists (
      select 1
      from accounts.account_roles role
      where role.principal_id = p_principal_id
        and role.role = 'creator'
    );
    v_session_version := case
      when v_principal_found then v_principal.session_version
      else v_existing.principal_session_version
    end;
    v_credential_changed_at := case
      when v_existing.legacy_creator_id is not null
       and v_existing.principal_id = p_principal_id
       and v_existing.credential_version = v_session_version
        then v_existing.credential_changed_at
      when v_principal_found and v_principal.session_version > 1
        then v_principal.updated_at
      when v_principal_found then coalesce(
        (
          select coalesce(
            credential.upgraded_at,
            credential.imported_at,
            credential.created_at
          )
          from accounts.credential_migrations credential
          where credential.principal_id = p_principal_id
          order by credential.updated_at desc, credential.user_id
          limit 1
        ),
        v_principal.created_at
      )
      else v_existing.credential_changed_at
    end;

    insert into accounts.creator_fallback_authorities (
      legacy_creator_id,
      principal_id,
      referral_code,
      principal_session_version,
      principal_status,
      creator_active,
      creator_role_present,
      credential_version,
      credential_changed_at,
      current_record
    )
    values (
      v_legacy_id,
      p_principal_id,
      coalesce(v_creator.referral_code, v_existing.referral_code),
      v_session_version,
      case when v_principal_found then v_principal.status else 'deleted' end,
      v_creator_found and v_creator.active,
      v_role_present,
      v_session_version,
      v_credential_changed_at,
      v_creator_found
    )
    on conflict (legacy_creator_id) do update
    set
      principal_id = excluded.principal_id,
      referral_code = excluded.referral_code,
      principal_session_version = excluded.principal_session_version,
      principal_status = excluded.principal_status,
      creator_active = excluded.creator_active,
      creator_role_present = excluded.creator_role_present,
      credential_version = excluded.credential_version,
      credential_changed_at = excluded.credential_changed_at,
      current_record = excluded.current_record,
      authority_version = accounts.creator_fallback_authorities.authority_version + 1,
      updated_at = now()
    where (
      accounts.creator_fallback_authorities.principal_id,
      accounts.creator_fallback_authorities.referral_code,
      accounts.creator_fallback_authorities.principal_session_version,
      accounts.creator_fallback_authorities.principal_status,
      accounts.creator_fallback_authorities.creator_active,
      accounts.creator_fallback_authorities.creator_role_present,
      accounts.creator_fallback_authorities.credential_version,
      accounts.creator_fallback_authorities.credential_changed_at,
      accounts.creator_fallback_authorities.current_record
    ) is distinct from (
      excluded.principal_id,
      excluded.referral_code,
      excluded.principal_session_version,
      excluded.principal_status,
      excluded.creator_active,
      excluded.creator_role_present,
      excluded.credential_version,
      excluded.credential_changed_at,
      excluded.current_record
    )
    returning * into v_authority;

    v_authority_changed := found;
    if not v_authority_changed then
      select authority.* into v_authority
      from accounts.creator_fallback_authorities authority
      where authority.legacy_creator_id = v_legacy_id
      for update;
    end if;
    if not found then
      continue;
    end if;

    v_document := jsonb_build_object(
      '_id', v_authority.document_id,
      '_type', 'referralAuthAuthority',
      'authoritySchemaVersion', 1,
      'legacyCreatorId', v_authority.legacy_creator_id,
      'principalId', v_authority.principal_id::text,
      'referralCode', v_authority.referral_code,
      'principalSessionVersion', v_authority.principal_session_version,
      'principalStatus', v_authority.principal_status,
      'creatorActive', v_authority.creator_active,
      'creatorRolePresent', v_authority.creator_role_present,
      'credentialVersion', v_authority.credential_version,
      'credentialChangedAt', to_char(
        v_authority.credential_changed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'currentRecord', v_authority.current_record,
      'authorityVersion', v_authority.authority_version
    );

    if not v_authority_changed and exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = v_authority.document_id
        and source.document_type = 'referralAuthAuthority'
        and source.backend_owner = 'supabase'
        and not source.tombstoned
        and source.payload @> v_document
    ) then
      continue;
    end if;

    select source.source_revision into v_source_revision
    from migration.source_documents source
    where source.legacy_sanity_id = v_authority.document_id
    for update;

    v_mutation := case
      when found then jsonb_build_object(
        'operation', 'replace',
        'id', v_authority.document_id,
        'expected_revision', v_source_revision,
        'document', v_document
      )
      else jsonb_build_object(
        'operation', 'create_if_missing',
        'id', v_authority.document_id,
        'document', v_document
      )
    end;

    perform public.roo_apply_document_mutations(jsonb_build_array(v_mutation));

    if not exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = v_authority.document_id
        and source.document_type = 'referralAuthAuthority'
        and source.payload->>'legacyCreatorId' = v_authority.legacy_creator_id
        and source.payload->>'principalId' = v_authority.principal_id::text
        and (source.payload->>'principalSessionVersion')::bigint
          = v_authority.principal_session_version
        and (source.payload->>'authorityVersion')::bigint
          = v_authority.authority_version
        and source.backend_owner = 'supabase'
        and not source.tombstoned
    ) then
      raise exception 'Creator fallback authority mirror event was not recorded'
        using errcode = '55000';
    end if;

    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$function$;
CREATE OR REPLACE FUNCTION accounts.refresh_creator_fallback_authority_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_table_name = 'principals' then
    perform accounts.refresh_creator_fallback_authority(
      case when tg_op = 'DELETE' then old.id else new.id end,
      null
    );
  elsif tg_table_name = 'creator_profiles' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform accounts.refresh_creator_fallback_authority(
        old.principal_id,
        old.legacy_sanity_id
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and (
         tg_op = 'INSERT'
         or new.principal_id is distinct from old.principal_id
         or new.legacy_sanity_id is distinct from old.legacy_sanity_id
         or new.referral_code is distinct from old.referral_code
         or new.active is distinct from old.active
       ) then
      perform accounts.refresh_creator_fallback_authority(
        new.principal_id,
        new.legacy_sanity_id
      );
    end if;
  elsif tg_table_name = 'account_roles' then
    if tg_op in ('UPDATE', 'DELETE') and old.role = 'creator' then
      perform accounts.refresh_creator_fallback_authority(old.principal_id, null);
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and new.role = 'creator'
       and (
         tg_op = 'INSERT'
         or new.principal_id is distinct from old.principal_id
         or new.role is distinct from old.role
       ) then
      perform accounts.refresh_creator_fallback_authority(new.principal_id, null);
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION migration.apply_cms_commerce_mutation(p_command_id text, p_mutation jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION migration.roo_apply_commerce_document_mutations_unbounded(p_command_id text, p_mutations jsonb, p_cutover_generation integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command_id text := btrim(coalesce(p_command_id, ''));
  v_request_hash text;
  v_legacy_request_hash text;
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
  v_starts_new_commerce boolean := false;
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

  v_legacy_request_hash := encode(
    extensions.digest(
      (p_mutations || jsonb_build_object('generation', p_cutover_generation))::text,
      'sha256'
    ),
    'hex'
  );
  v_request_hash := migration.commerce_command_hash(
    'document_mutation',
    p_mutations,
    p_cutover_generation
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_command_id, 0)
  );

  select * into v_existing
  from migration.commerce_commands
  where command_id = v_command_id
  for update;
  if found then
    if v_existing.request_hash not in (v_request_hash, v_legacy_request_hash) then
      raise exception 'commerce command id was reused with different input'
        using errcode = '23505';
    end if;
    return v_existing.result;
  end if;

  select exists (
    select 1
    from jsonb_array_elements(p_mutations) item(value)
    where item.value->>'operation' in ('create', 'create_if_missing')
      and item.value->'document'->>'_type' in (
        'slotHold', 'paymentStartClaim', 'paymentUpgradeLock'
      )
  ) into v_starts_new_commerce;

  if v_starts_new_commerce then
    perform migration.assert_commerce_start_fence(p_cutover_generation);
  else
    perform migration.assert_commerce_write_fence(p_cutover_generation);
  end if;

  for v_mutation in
    select value
    from jsonb_array_elements(p_mutations)
    order by coalesce(value->>'id', value->'document'->>'_id')
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(v_mutation->>'id', v_mutation->'document'->>'_id');
    v_type := nullif(btrim(coalesce(v_mutation->'document'->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');
    if v_operation is null or v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
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
      v_payload := v_current.payload
        || migration.referral_commerce_patch(v_payload);
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

  select coalesce(array_agg(distinct changed_id order by changed_id), '{}'::text[])
  into v_changed_ids
  from unnest(v_changed_ids) changed_id;

  if cardinality(v_changed_ids) > 0 then
    perform migration.project_commerce_document_ids(v_changed_ids);
    perform migration.project_commerce_extensions(v_changed_ids);
    perform migration.restore_commerce_owners(v_changed_ids);
    perform migration.project_commerce_recovery_fields(v_changed_ids);
    perform migration.cleanup_commerce_document_ids(v_changed_ids);
  end if;

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
    command_id, request_hash, cutover_generation, operation, result, completed_at
  ) values (
    v_command_id, v_request_hash, p_cutover_generation,
    'document_mutation', v_result, now()
  );

  insert into migration.commerce_mirror_outbox (
    command_id, event_key, document_ids, documents, deleted_ids,
    canonical_hash, cutover_generation
  ) values (
    v_command_id, v_event_key, v_changed_ids, v_documents, v_deleted_ids,
    v_canonical_hash, p_cutover_generation
  ) on conflict (event_key) do nothing;

  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION migration.terminalize_stale_provider_recoveries(p_apply boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidate_count integer := 0;
  v_candidate_digest text := '';
  v_command_id text := '';
  v_generation integer := 0;
  v_mutations jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_primary_backend text := '';
  v_starts_paused boolean := false;
begin
  select primary_backend, generation, starts_paused
  into v_primary_backend, v_generation, v_starts_paused
  from migration.commerce_control
  where singleton
  for share;

  if p_apply and (
    v_primary_backend is distinct from 'supabase'
    or v_generation <> 1
    or not v_starts_paused
  ) then
    raise exception 'stale provider recovery repair requires paused Supabase generation 1'
      using errcode = '55000';
  end if;

  if exists (
    select 1
    from commerce.recovery_cases recovery
    join commerce.payment_records payment
      on payment.id = recovery.payment_record_id
    join migration.source_documents payment_source
      on payment_source.legacy_sanity_id = payment.legacy_sanity_id
      and payment_source.document_type = 'paymentRecord'
      and not payment_source.tombstoned
    join migration.source_documents recovery_source
      on recovery_source.legacy_sanity_id = recovery.legacy_sanity_id
      and recovery_source.document_type = 'paymentRecoveryCase'
      and not recovery_source.tombstoned
    where recovery.case_type = 'payment'
      and recovery.status in ('open', 'retrying')
      and not recovery.requires_reschedule
      and payment.provider in ('paypal', 'razorpay')
      and recovery.reason = payment.provider || '_lookup_failed_404'
      and payment.status = 'needs_recovery'
      and payment.booking_id is null
      and payment.provider_payment_id is null
      and not payment.requires_reschedule
      and not payment.resource_release_pending
      and payment.recovery_attempt_count >= 24
      and coalesce(payment.source_created_at, payment.created_at)
        < v_now - interval '24 hours'
      and not exists (
        select 1
        from commerce.slot_holds hold
        where hold.payment_record_id = payment.id
          and hold.phase in ('active', 'payment')
      )
      and not exists (
        select 1
        from commerce.coupon_redemptions redemption
        where redemption.payment_record_id = payment.id
          and redemption.state = 'reserved'
      )
    group by payment.id
    having count(*) <> 1
  ) then
    raise exception 'ambiguous stale provider recovery cases'
      using errcode = '21000';
  end if;

  with candidates as (
    select
      payment.id payment_id,
      payment_source.legacy_sanity_id payment_document_id,
      payment_source.source_revision payment_revision,
      payment_source.payload payment_payload,
      recovery_source.legacy_sanity_id recovery_document_id,
      recovery_source.source_revision recovery_revision,
      recovery_source.payload recovery_payload
    from commerce.recovery_cases recovery
    join commerce.payment_records payment
      on payment.id = recovery.payment_record_id
    join migration.source_documents payment_source
      on payment_source.legacy_sanity_id = payment.legacy_sanity_id
      and payment_source.document_type = 'paymentRecord'
      and not payment_source.tombstoned
    join migration.source_documents recovery_source
      on recovery_source.legacy_sanity_id = recovery.legacy_sanity_id
      and recovery_source.document_type = 'paymentRecoveryCase'
      and not recovery_source.tombstoned
    where recovery.case_type = 'payment'
      and recovery.status in ('open', 'retrying')
      and not recovery.requires_reschedule
      and payment.provider in ('paypal', 'razorpay')
      and recovery.reason = payment.provider || '_lookup_failed_404'
      and payment.status = 'needs_recovery'
      and payment.booking_id is null
      and payment.provider_payment_id is null
      and not payment.requires_reschedule
      and not payment.resource_release_pending
      and payment.recovery_attempt_count >= 24
      and coalesce(payment.source_created_at, payment.created_at)
        < v_now - interval '24 hours'
      and not exists (
        select 1
        from commerce.slot_holds hold
        where hold.payment_record_id = payment.id
          and hold.phase in ('active', 'payment')
      )
      and not exists (
        select 1
        from commerce.coupon_redemptions redemption
        where redemption.payment_record_id = payment.id
          and redemption.state = 'reserved'
      )
  ), mutation_rows as (
    select
      payment_document_id document_id,
      jsonb_build_object(
        'operation', 'replace',
        'expected_revision', payment_revision,
        'document', payment_payload || jsonb_build_object(
          'status', 'abandoned',
          'recoveryReason', 'provider_order_not_found_after_recovery_window',
          'nextRecoveryAt', '',
          'lateCaptureWatchUntil', '',
          'resourceReleasePending', false,
          'resourceReleaseTargetStatus', '',
          'resourceReleaseReason', '',
          'providerRecoveryTerminal', true,
          'providerRecoveryTerminalAt', v_now,
          'providerRecoveryTerminalReason',
            'provider_order_not_found_after_recovery_window',
          'events', (
            case
              when jsonb_typeof(payment_payload->'events') = 'array'
                then payment_payload->'events'
              else '[]'::jsonb
            end
          ) || jsonb_build_array(jsonb_build_object(
            'status', 'abandoned',
            'source', 'migration',
            'reason', 'provider_order_not_found_after_recovery_window',
            'occurredAt', v_now
          ))
        )
      ) mutation
    from candidates
    union all
    select
      recovery_document_id,
      jsonb_build_object(
        'operation', 'replace',
        'expected_revision', recovery_revision,
        'document', recovery_payload || jsonb_build_object(
          'status', 'abandoned',
          'reason', 'provider_order_not_found_after_recovery_window',
          'nextAttemptAt', '',
          'leaseId', '',
          'leaseExpiresAt', '',
          'abandonedAt', v_now,
          'resolution', 'provider_order_not_found_after_recovery_window'
        )
      )
    from candidates
  )
  select
    (select count(*) from candidates),
    encode(extensions.digest(coalesce(
      (select string_agg(
        payment_document_id || ':' || coalesce(payment_revision, '') || ':' ||
        recovery_document_id || ':' || coalesce(recovery_revision, ''),
        '|' order by payment_document_id
      ) from candidates),
      ''
    ), 'sha256'), 'hex'),
    coalesce(jsonb_agg(mutation order by document_id), '[]'::jsonb)
  into v_candidate_count, v_candidate_digest, v_mutations
  from mutation_rows;

  if v_candidate_count = 0 or not p_apply then
    return jsonb_build_object(
      'ok', true,
      'applied', false,
      'candidateCount', v_candidate_count,
      'candidateDigest', v_candidate_digest
    );
  end if;

  v_command_id := 'provider-recovery-terminal:' || v_candidate_digest;
  perform public.roo_apply_commerce_document_mutations(
    v_command_id,
    v_mutations,
    v_generation
  );

  return jsonb_build_object(
    'ok', true,
    'applied', true,
    'candidateCount', v_candidate_count,
    'candidateDigest', v_candidate_digest,
    'commandId', v_command_id
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_admin_update_creator_terms(p_command_id text, p_creator_id uuid, p_expected_version bigint, p_total_basis_points integer, p_commission_basis_points integer, p_discount_basis_points integer, p_bypass_referral_requirement boolean, p_reason text, p_cutover_generation integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command_id text := btrim(coalesce(p_command_id, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_request_hash text;
  v_existing accounts.creator_terms_audit%rowtype;
  v_creator accounts.creator_profiles%rowtype;
  v_updated accounts.creator_profiles%rowtype;
  v_source migration.source_documents%rowtype;
  v_starts_paused boolean;
  v_old_terms jsonb;
  v_new_terms jsonb;
  v_apply_result jsonb;
begin
  if v_command_id !~ '^[A-Za-z0-9._:-]{8,120}$' then
    raise exception 'invalid command id' using errcode = '22023';
  end if;
  if p_creator_id is null or coalesce(p_expected_version, 0) < 1 then
    raise exception 'creator id and expected version are required' using errcode = '22023';
  end if;
  if p_total_basis_points is null
    or p_commission_basis_points is null
    or p_discount_basis_points is null
    or p_bypass_referral_requirement is null
    or p_total_basis_points not between 0 and 10000
    or p_commission_basis_points not between 0 and 10000
    or p_discount_basis_points not between 0 and 10000
    or p_commission_basis_points + p_discount_basis_points > p_total_basis_points then
    raise exception 'invalid creator terms allocation' using errcode = '22023';
  end if;
  if char_length(v_reason) < 3 or char_length(v_reason) > 500 then
    raise exception 'reason must be between 3 and 500 characters' using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  v_request_hash := encode(extensions.digest(jsonb_build_object(
    'creator_id', p_creator_id,
    'expected_version', p_expected_version,
    'total_basis_points', p_total_basis_points,
    'commission_basis_points', p_commission_basis_points,
    'discount_basis_points', p_discount_basis_points,
    'bypass_referral_requirement', p_bypass_referral_requirement,
    'reason', v_reason,
    'cutover_generation', p_cutover_generation
  )::text, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-terms:' || v_command_id, 0)
  );

  select * into v_existing
  from accounts.creator_terms_audit
  where command_id = v_command_id;
  if found then
    if v_existing.request_hash <> v_request_hash then
      raise exception 'command id was reused with different input' using errcode = '23505';
    end if;
    return v_existing.new_terms || jsonb_build_object(
      'command_id', v_existing.command_id,
      'source_revision', v_existing.source_revision,
      'updated_at', v_existing.created_at,
      'replayed', true
    );
  end if;

  select starts_paused into v_starts_paused
  from migration.commerce_control
  where singleton
  for share;
  if not found then
    raise exception 'commerce control is unavailable' using errcode = '55000';
  end if;
  if v_starts_paused then
    raise exception 'creator terms writes are paused' using errcode = '55006';
  end if;

  select * into v_creator
  from accounts.creator_profiles
  where user_id = p_creator_id
  for update;
  if not found or not v_creator.active then
    raise exception 'creator not found' using errcode = 'P0002';
  end if;
  if v_creator.terms_version <> p_expected_version then
    raise exception 'creator terms version conflict' using errcode = '40001';
  end if;
  if nullif(btrim(coalesce(v_creator.legacy_sanity_id, '')), '') is null then
    raise exception 'creator fallback identity is missing' using errcode = '55000';
  end if;

  select * into v_source
  from migration.source_documents
  where legacy_sanity_id = v_creator.legacy_sanity_id
    and document_type = 'referral'
    and not tombstoned
  for update;
  if not found then
    raise exception 'creator fallback document is missing' using errcode = '55000';
  end if;

  v_old_terms := jsonb_build_object(
    'creator_id', v_creator.user_id,
    'total_basis_points', v_creator.total_basis_points,
    'commission_basis_points', v_creator.commission_basis_points,
    'discount_basis_points', v_creator.discount_basis_points,
    'bypass_referral_requirement', v_creator.bypass_referral_requirement,
    'terms_version', v_creator.terms_version
  );

  v_apply_result := public.roo_apply_commerce_document_mutations(
    'referral-terms:' || v_command_id,
    jsonb_build_array(jsonb_build_object(
      'operation', 'replace',
      'document', v_source.payload || jsonb_build_object(
        'maxCommissionPercent', p_total_basis_points::numeric / 100,
        'currentCommissionPercent', p_commission_basis_points::numeric / 100,
        'currentDiscountPercent', p_discount_basis_points::numeric / 100,
        'bypassUnlock', p_bypass_referral_requirement
      ),
      'expected_revision', v_source.source_revision
    )),
    p_cutover_generation
  );

  update accounts.creator_profiles
  set terms_version = v_creator.terms_version + 1,
      updated_at = now()
  where user_id = p_creator_id
  returning * into v_updated;

  select * into v_source
  from migration.source_documents
  where legacy_sanity_id = v_creator.legacy_sanity_id;

  v_new_terms := jsonb_build_object(
    'creator_id', v_updated.user_id,
    'legacy_sanity_id', v_updated.legacy_sanity_id,
    'total_basis_points', v_updated.total_basis_points,
    'commission_basis_points', v_updated.commission_basis_points,
    'discount_basis_points', v_updated.discount_basis_points,
    'bypass_referral_requirement', v_updated.bypass_referral_requirement,
    'terms_version', v_updated.terms_version,
    'mirror_event_key', v_apply_result->>'event_key'
  );

  insert into accounts.creator_terms_audit (
    command_id,
    creator_user_id,
    actor,
    reason,
    request_hash,
    old_terms,
    new_terms,
    source_revision
  ) values (
    v_command_id,
    p_creator_id,
    'ref_admin_key',
    v_reason,
    v_request_hash,
    v_old_terms,
    v_new_terms,
    v_source.source_revision
  );

  return v_new_terms || jsonb_build_object(
    'command_id', v_command_id,
    'source_revision', v_source.source_revision,
    'updated_at', now(),
    'replayed', false
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_apply_cms_publish_command(p_command_id text, p_request_hash text, p_actor text, p_mutations jsonb, p_assets jsonb DEFAULT '[]'::jsonb, p_asset_links jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.roo_apply_commerce_document_mutations(p_command_id text, p_mutations jsonb, p_cutover_generation integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_mutation jsonb;
  v_document jsonb;
  v_operation text;
  v_id text;
  v_type text;
  v_expected_revision text;
begin
  if btrim(coalesce(p_command_id, '')) !~ '^[A-Za-z0-9._:-]{8,160}$' then
    raise exception 'invalid commerce command id' using errcode = '22023';
  end if;
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) < 1
     or jsonb_array_length(p_mutations) > 100 then
    raise exception 'p_mutations must contain between 1 and 100 mutations'
      using errcode = '22023';
  end if;
  if pg_catalog.octet_length(p_mutations::text) > 1048576 then
    raise exception 'commerce mutation payload exceeds 1 MiB'
      using errcode = '22023';
  end if;
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    if jsonb_typeof(v_mutation) <> 'object' then
      raise exception 'commerce mutations must be JSON objects'
        using errcode = '22023';
    end if;

    v_operation := v_mutation->>'operation';
    v_document := v_mutation->'document';
    v_id := coalesce(v_mutation->>'id', v_document->>'_id', '');
    v_type := nullif(btrim(coalesce(v_document->>'_type', '')), '');
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation is null or v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;
    if v_id = ''
       or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in v_id) > 0 then
      raise exception 'document mutation is missing or has an invalid id'
        using errcode = '22023';
    end if;
    if v_expected_revision is not null
       and char_length(v_expected_revision) > 256 then
      raise exception 'document mutation revision is too long'
        using errcode = '22023';
    end if;

    if v_operation <> 'delete' then
      if jsonb_typeof(v_document) <> 'object'
         or pg_catalog.octet_length(v_document::text) > 262144
         or v_type is null
         or char_length(v_type) > 128
         or v_type !~ '^[A-Za-z][A-Za-z0-9_.-]*$' then
        raise exception 'document mutation has an invalid document'
          using errcode = '22023';
      end if;
      if v_document ? '_id' and v_document->>'_id' <> v_id then
        raise exception 'document mutation identity mismatch'
          using errcode = '22023';
      end if;
    end if;
  end loop;

  return migration.roo_apply_commerce_document_mutations_unbounded(
    p_command_id,
    p_mutations,
    p_cutover_generation
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_apply_credential_source_operation(p_operation_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operation accounts.credential_operations%rowtype;
  v_source migration.source_documents%rowtype;
  v_set jsonb;
  v_unset text[];
  v_document jsonb;
  v_results jsonb;
  v_applied_revision text;
begin
  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_backend <> 'supabase'
     or v_operation.source_recovery_blocked
     or v_operation.status not in ('auth_applied', 'mirrored') then
    raise exception 'Credential source operation is not ready'
      using errcode = '55000';
  end if;

  if v_operation.source_applied_at is not null then
    return jsonb_build_object(
      'status', 'source_applied',
      'source_document_id', v_operation.source_document_id,
      'source_revision', v_operation.source_applied_revision,
      'idempotent', true
    );
  end if;

  select *
  into v_source
  from migration.source_documents source
  where source.legacy_sanity_id = v_operation.source_document_id
    and not source.tombstoned
  for update;

  if not found then
    raise exception 'Credential source document was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_preconditions is null
     or v_operation.source_preconditions = '{}'::jsonb
     or not (v_source.payload @> v_operation.source_preconditions) then
    raise exception 'Credential source precondition changed'
      using errcode = '40001';
  end if;

  v_set := v_operation.source_mutation->'set';
  select coalesce(array_agg(field), '{}'::text[])
  into v_unset
  from jsonb_array_elements_text(v_operation.source_mutation->'unset') field;
  v_document := (v_source.payload || v_set) - v_unset;

  v_results := public.roo_apply_document_mutations(
    jsonb_build_array(
      jsonb_build_object(
        'operation', 'replace',
        'id', v_operation.source_document_id,
        'expected_revision', v_source.source_revision,
        'document', v_document
      )
    )
  );
  v_applied_revision := nullif(v_results->0->>'_rev', '');

  if v_applied_revision is null then
    raise exception 'Credential source mutation did not return a revision'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    source_applied_revision = v_applied_revision,
    source_applied_at = now(),
    last_error_code = null,
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'source_applied',
    'source_document_id', v_operation.source_document_id,
    'source_revision', v_applied_revision,
    'idempotent', false
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_apply_credential_source_operation_v2(p_operation_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_operation accounts.credential_operations%rowtype;
  v_source migration.source_documents%rowtype;
  v_set jsonb;
  v_unset text[];
  v_document jsonb;
  v_results jsonb;
  v_applied_revision text;
  v_retry jsonb;
begin
  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'parked_at', v_operation.source_recovery_blocked_at
    );
  end if;

  if v_operation.attempt_count >= 6 then
    update accounts.credential_operations operation
    set
      source_recovery_blocked = true,
      source_recovery_blocked_at = coalesce(
        operation.source_recovery_blocked_at,
        now()
      ),
      next_retry_at = null,
      last_error_code = coalesce(
        operation.last_error_code,
        'CREDENTIAL_RECOVERY_ATTEMPT_LIMIT'
      ),
      last_error = coalesce(
        operation.last_error,
        'Credential recovery reached the automatic attempt limit.'
      ),
      last_error_class = coalesce(operation.last_error_class, 'transient'),
      updated_at = now()
    where operation.id = v_operation.id
    returning * into v_operation;

    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', false,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'parked_at', v_operation.source_recovery_blocked_at
    );
  end if;

  if v_operation.next_retry_at is not null
     and v_operation.next_retry_at > now() then
    return jsonb_build_object(
      'status', 'backoff',
      'retry_status', 'backoff',
      'idempotent', true,
      'parked', false,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'next_retry_at', v_operation.next_retry_at
    );
  end if;

  if v_operation.source_backend <> 'supabase'
     or v_operation.status not in ('auth_applied', 'mirrored') then
    return jsonb_build_object(
      'status', 'not_ready',
      'retry_status', 'not_ready',
      'idempotent', true,
      'parked', false,
      'error_code', 'CREDENTIAL_SOURCE_NOT_READY'
    );
  end if;

  if v_operation.source_applied_at is not null then
    return jsonb_build_object(
      'status', 'source_applied',
      'source_document_id', v_operation.source_document_id,
      'source_revision', v_operation.source_applied_revision,
      'idempotent', true
    );
  end if;

  select *
  into v_source
  from migration.source_documents source
  where source.legacy_sanity_id = v_operation.source_document_id
    and not source.tombstoned
  for update;

  if not found then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE',
      'Credential source document is unavailable.',
      'transient'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end if;

  if v_operation.source_preconditions is null
     or v_operation.source_preconditions = '{}'::jsonb
     or not (v_source.payload @> v_operation.source_preconditions) then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_PRECONDITION_CHANGED',
      'Credential source precondition changed.',
      'deterministic'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end if;

  v_set := v_operation.source_mutation->'set';
  select coalesce(array_agg(field), '{}'::text[])
  into v_unset
  from jsonb_array_elements_text(v_operation.source_mutation->'unset') field;
  v_document := (v_source.payload || v_set) - v_unset;

  begin
    v_results := public.roo_apply_document_mutations(
      jsonb_build_array(
        jsonb_build_object(
          'operation', 'replace',
          'id', v_operation.source_document_id,
          'expected_revision', v_source.source_revision,
          'document', v_document
        )
      )
    );
  exception when sqlstate '40001' then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_WRITE_CONFLICT',
      'Credential source write conflicted with another transaction.',
      'transient'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end;

  v_applied_revision := nullif(v_results->0->>'_rev', '');

  if v_applied_revision is null then
    raise exception 'Credential source mutation did not return a revision'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    source_applied_revision = v_applied_revision,
    source_applied_at = now(),
    last_error_code = null,
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'source_applied',
    'source_document_id', v_operation.source_document_id,
    'source_revision', v_applied_revision,
    'idempotent', false
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_apply_document_mutations(p_mutations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_changed_ids text[] := '{}'::text[];
  v_deleted_by_id jsonb := '{}'::jsonb;
  v_documents jsonb := '[]'::jsonb;
  v_deleted_documents jsonb := '[]'::jsonb;
  v_canonical_hash text;
  v_applied integer;
begin
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) > 100 then
    raise exception 'p_mutations must be a JSON array'
      using errcode = '22023';
  end if;

  for v_mutation in
    select value from jsonb_array_elements(p_mutations)
  loop
    v_operation := v_mutation->>'operation';
    v_id := coalesce(
      v_mutation->>'id',
      v_mutation->'document'->>'_id',
      ''
    );
    v_expected_revision := nullif(v_mutation->>'expected_revision', '');

    if v_operation is null or v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
      raise exception 'unsupported document mutation operation'
        using errcode = '22023';
    end if;

    if v_id = ''
       or v_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in v_id) > 0 then
      raise exception 'document mutation is missing or has an invalid id'
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
      v_changed_ids := array_append(v_changed_ids, v_id);
      v_deleted_by_id := jsonb_set(
        v_deleted_by_id,
        array[v_id],
        v_current.payload || jsonb_build_object(
          '_supabaseCanonicalHash', v_current.source_hash,
          '_supabaseRevision', v_current.source_revision
        ),
        true
      );
      delete from cms.documents where legacy_sanity_id = v_id;
      delete from migration.source_documents where legacy_sanity_id = v_id;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('_id', v_id, 'deleted', true)
      );
      continue;
    end if;

    v_payload := v_mutation->'document';
    v_type := nullif(btrim(coalesce(v_payload->>'_type', '')), '');

    if v_payload is null
       or v_type is null
       or char_length(v_type) > 128
       or v_type !~ '^[A-Za-z][A-Za-z0-9_.-]*$' then
      raise exception 'document mutation is missing document type'
        using errcode = '22023';
    end if;

    if v_payload ? '_id'
       and coalesce(v_payload->>'_id', '') <> v_id then
      raise exception 'document mutation identity mismatch'
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
      tombstoned,
      backend_owner
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
      false,
      'supabase'
    )
    on conflict (legacy_sanity_id) do update
    set
      document_type = excluded.document_type,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      payload = excluded.payload,
      source_updated_at = excluded.source_updated_at,
      last_seen_at = now(),
      tombstoned = false,
      backend_owner = 'supabase'
    where v_operation = 'replace';
    get diagnostics v_applied = row_count;

    if v_applied = 0 then
      if v_operation = 'create' then
        raise exception 'document already exists: %', v_id
          using errcode = '23505';
      end if;
      select payload into v_payload
      from migration.source_documents
      where legacy_sanity_id = v_id;
      v_results := v_results || jsonb_build_array(v_payload);
      continue;
    end if;

    perform cms.sync_document_from_source(v_payload, v_hash);
    v_changed_ids := array_append(v_changed_ids, v_id);
    v_results := v_results || jsonb_build_array(v_payload);
  end loop;

  v_changed_ids := array(
    select distinct changed_id
    from unnest(v_changed_ids) changed_id
    where nullif(btrim(changed_id), '') is not null
    order by changed_id
  );

  if cardinality(v_changed_ids) > 0 then
    select coalesce(
      jsonb_agg(
        source.payload || jsonb_build_object(
          '_supabaseCanonicalHash', source.source_hash,
          '_supabaseRevision', source.source_revision
        )
        order by source.legacy_sanity_id
      ),
      '[]'::jsonb
    )
    into v_documents
    from migration.source_documents source
    where source.legacy_sanity_id = any(v_changed_ids)
      and not source.tombstoned;

    select coalesce(
      jsonb_agg(v_deleted_by_id->changed_id order by changed_id),
      '[]'::jsonb
    )
    into v_deleted_documents
    from unnest(v_changed_ids) changed_id
    where v_deleted_by_id ? changed_id
      and not exists (
        select 1
        from migration.source_documents source
        where source.legacy_sanity_id = changed_id
          and not source.tombstoned
      );

    v_canonical_hash := encode(
      extensions.digest(
        jsonb_build_object(
          'documents', v_documents,
          'deleted_documents', v_deleted_documents
        )::text,
        'sha256'
      ),
      'hex'
    );

    insert into migration.document_mutation_mirror_outbox (
      document_ids,
      documents,
      deleted_documents,
      canonical_hash
    )
    values (
      v_changed_ids,
      v_documents,
      v_deleted_documents,
      v_canonical_hash
    );
  end if;

  return v_results;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_claim_commerce_mirror_events(p_lease_id text, p_limit integer DEFAULT 25, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_result jsonb;
begin
  if nullif(btrim(coalesce(p_lease_id, '')), '') is null then
    raise exception 'mirror lease id is required' using errcode = '22023';
  end if;
  update migration.commerce_mirror_outbox
  set status = 'dead_letter',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = null,
      last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS'
  where status = 'processing'
    and lease_expires_at <= now()
    and attempt_count >= 12;

  with candidates as (
    select candidate.id
    from migration.commerce_mirror_outbox candidate
    where (
      (candidate.status in ('pending', 'retry') and (
        coalesce(p_force, false)
        or coalesce(candidate.next_attempt_at, '-infinity'::timestamptz) <= now()
      )) or (candidate.status = 'processing' and candidate.lease_expires_at <= now())
    ) and not exists (
      select 1 from migration.commerce_mirror_outbox earlier
      where earlier.sequence_no < candidate.sequence_no
        and earlier.status not in ('mirrored', 'superseded')
        and earlier.document_ids && candidate.document_ids
    )
    order by candidate.sequence_no
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update migration.commerce_mirror_outbox outbox set
      status = 'processing', lease_id = p_lease_id,
      lease_expires_at = now() + interval '2 minutes',
      attempt_count = attempt_count + 1
    from candidates where outbox.id = candidates.id returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'sequence_no', claimed.sequence_no,
    'event_key', claimed.event_key,
    'document_ids', to_jsonb(claimed.document_ids),
    'documents', coalesce((
      select jsonb_agg(document.value || jsonb_build_object(
        '_supabaseCanonicalHash', migration.canonical_business_hash(document.value),
        '_supabaseSequence', claimed.sequence_no
      ) order by document.value->>'_id')
      from jsonb_array_elements(claimed.documents) document(value)
    ), '[]'::jsonb),
    'deleted_ids', to_jsonb(claimed.deleted_ids),
    'delete_guards', claimed.delete_guards,
    'canonical_hash', claimed.canonical_hash,
    'cutover_generation', claimed.cutover_generation,
    'attempt_count', claimed.attempt_count
  ) order by claimed.sequence_no), '[]'::jsonb) into v_result
  from claimed;
  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_claim_document_mutation_mirror_events(p_lease_id uuid, p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120, p_preferred_document_ids text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_preferred_ids text[] := '{}'::text[];
begin
  if p_lease_id is null
     or coalesce(p_limit, 0) not between 1 and 100
     or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid document mirror claim input'
      using errcode = '22023';
  end if;

  if p_preferred_document_ids is not null then
    if cardinality(p_preferred_document_ids) not between 1 and 100 then
      raise exception 'invalid preferred document mirror input'
        using errcode = '22023';
    end if;
    select coalesce(
      array_agg(distinct id order by id),
      '{}'::text[]
    )
    into v_preferred_ids
    from unnest(p_preferred_document_ids) id
    where id is not null
      and id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
      and position('..' in id) = 0;
    if cardinality(v_preferred_ids) <> cardinality(array(
      select distinct id from unnest(p_preferred_document_ids) id
    )) then
      raise exception 'invalid preferred document mirror input'
        using errcode = '22023';
    end if;
  end if;

  update migration.document_mutation_mirror_outbox
  set
    status = 'dead_letter',
    lease_id = null,
    lease_expires_at = null,
    last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
    updated_at = now(),
    applied_at = null,
    dead_lettered_at = now()
  where status = 'processing'
    and lease_expires_at <= now()
    and attempt_count >= max_attempts;

  with candidates as (
    select candidate.sequence_no
    from migration.document_mutation_mirror_outbox candidate
    where (
      (
        candidate.status in ('pending', 'retry')
        and candidate.next_attempt_at <= now()
      ) or (
        candidate.status = 'processing'
        and candidate.lease_expires_at <= now()
        and candidate.attempt_count < candidate.max_attempts
      )
    )
    and not exists (
      select 1
      from migration.document_mutation_mirror_outbox prior
      where prior.sequence_no < candidate.sequence_no
        and prior.status in ('pending', 'processing', 'retry')
        and prior.document_ids && candidate.document_ids
    )
    order by (candidate.document_ids && v_preferred_ids) desc,
      candidate.sequence_no
    for update skip locked
    limit p_limit
  ), claimed as (
    update migration.document_mutation_mirror_outbox event
    set
      status = 'processing',
      attempt_count = event.attempt_count + 1,
      lease_id = p_lease_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now(),
      dead_lettered_at = null
    from candidates
    where event.sequence_no = candidates.sequence_no
    returning event.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sequence_no', claimed.sequence_no::text,
        'event_key', claimed.event_key,
        'document_ids', to_jsonb(claimed.document_ids),
        'documents', coalesce((
          select jsonb_agg(
            document.value || jsonb_build_object(
              '_supabaseSequence', claimed.sequence_no::text
            )
            order by document.value->>'_id'
          )
          from jsonb_array_elements(claimed.documents) document(value)
        ), '[]'::jsonb),
        'deleted_documents', coalesce((
          select jsonb_agg(
            document.value || jsonb_build_object(
              '_supabaseSequence', claimed.sequence_no::text
            )
            order by document.value->>'_id'
          )
          from jsonb_array_elements(claimed.deleted_documents) document(value)
        ), '[]'::jsonb),
        'canonical_hash', claimed.canonical_hash,
        'attempt_count', claimed.attempt_count,
        'max_attempts', claimed.max_attempts
      )
      order by claimed.sequence_no
    ),
    '[]'::jsonb
  )
  into v_result
  from claimed;

  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_cleanup_commerce_rate_limits(p_now timestamp with time zone DEFAULT now())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_removed integer;
begin
  delete from commerce.rate_limit_buckets
  where backend_owner = 'supabase' and reset_at <= coalesce(p_now, now());
  get diagnostics v_removed = row_count;
  return v_removed;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_cleanup_expired_supabase_holds(p_cutover_generation integer, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidate record;
  v_claim_existed boolean;
  v_expired_holds integer := 0;
  v_removed_slot_claims integer := 0;
  v_mirror_events_enqueued integer := 0;
  v_mutation_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if coalesce(p_cutover_generation, -1) < 0 then
    raise exception 'invalid cutover generation' using errcode = '22023';
  end if;
  if coalesce(p_limit, 0) < 1 or p_limit > 500 then
    raise exception 'cleanup limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  perform migration.assert_commerce_write_fence(p_cutover_generation);

  for v_candidate in
    select
      hold.id hold_id,
      source.legacy_sanity_id document_id,
      source.source_revision,
      source.payload
    from commerce.slot_holds hold
    join migration.source_documents source
      on source.legacy_sanity_id = hold.legacy_sanity_id
    where hold.backend_owner = 'supabase'
      and hold.cutover_generation = p_cutover_generation
      and hold.phase in ('active', 'payment')
      and hold.expires_at <= v_now
      and source.backend_owner = 'supabase'
      and source.cutover_generation = p_cutover_generation
      and source.document_type = 'slotHold'
      and not source.tombstoned
      and lower(coalesce(source.payload->>'phase', 'active'))
        in ('active', 'holding', 'payment', 'payment_pending')
    order by hold.expires_at, source.legacy_sanity_id
    for update of source skip locked
    limit p_limit
  loop
    select exists (
      select 1
      from commerce.slot_claims claim
      where claim.hold_id = v_candidate.hold_id
    ) into v_claim_existed;

    select public.roo_apply_commerce_document_mutations(
      'cleanup.expired-hold.' || encode(
        extensions.digest(
          v_candidate.document_id || ':' || v_candidate.source_revision,
          'sha256'
        ),
        'hex'
      ),
      jsonb_build_array(jsonb_build_object(
        'operation', 'replace',
        'expected_revision', v_candidate.source_revision,
        'document', v_candidate.payload || jsonb_build_object(
          'phase', 'expired',
          'releasedAt', v_now,
          'releaseReason', 'expired_by_operational_cleanup',
          'holdNonce', gen_random_uuid()::text
        )
      )),
      p_cutover_generation
    ) into v_mutation_result;

    v_expired_holds := v_expired_holds + 1;
    if nullif(v_mutation_result->>'event_key', '') is not null then
      v_mirror_events_enqueued := v_mirror_events_enqueued + 1;
    end if;
    if v_claim_existed and not exists (
      select 1
      from commerce.slot_claims claim
      where claim.hold_id = v_candidate.hold_id
    ) then
      v_removed_slot_claims := v_removed_slot_claims + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'expired_holds', v_expired_holds,
    'removed_slot_claims', v_removed_slot_claims,
    'mirror_events_enqueued', v_mirror_events_enqueued,
    'cutover_generation', p_cutover_generation
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_cms_publish_command_result(p_command_id text, p_request_hash text, p_actor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.roo_cms_publish_readiness()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;
CREATE OR REPLACE FUNCTION public.roo_commerce_integrity_readiness()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'control', public.roo_commerce_control(),
    'mirror', public.roo_commerce_mirror_backlog(),
    'orphan_claimed_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      left join commerce.bookings booking on booking.id = proof.booking_id
      where proof.status = 'claimed'
        and (proof.booking_id is null or booking.id is null)
    ),
    'orphan_free_proofs', (
      select count(*)
      from commerce.payment_proof_claims proof
      join commerce.payment_records payment on payment.id = proof.payment_record_id
      where proof.provider = 'free'
        and proof.status = 'claimed'
        and proof.booking_id is null
        and payment.booking_id is null
        and payment.status in ('failed', 'abandoned')
    ),
    'command_conflicts', 0,
    'full_projector_calls_in_commands', 0
  );
$function$;
CREATE OR REPLACE FUNCTION public.roo_commerce_mirror_backlog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'pending', count(*) filter (
      where status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'actionable', count(*) filter (where status in ('pending', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'dead_letters', count(*) filter (where status = 'dead_letter'),
    'superseded', count(*) filter (where status = 'superseded'),
    'oldest_created_at', min(created_at) filter (
      where status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'oldest_age_seconds', coalesce(extract(epoch from now() - min(created_at)
      filter (where status in ('pending', 'retry', 'processing', 'dead_letter')))::bigint, 0),
    'checkpoint', (
      select jsonb_build_object(
        'sequence_no', checkpoint_sequence_no,
        'event_key', checkpoint_event_key,
        'generation', checkpoint_generation,
        'mirrored_at', mirrored_at
      ) from migration.commerce_mirror_state where singleton
    )
  )
  from migration.commerce_mirror_outbox;
$function$;
CREATE OR REPLACE FUNCTION public.roo_commerce_mirror_status_for_ids(p_document_ids text[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with requested as (
    select coalesce(array_agg(distinct btrim(id) order by btrim(id)), '{}'::text[]) ids
    from unnest(coalesce(p_document_ids, '{}'::text[])) id
    where nullif(btrim(id), '') is not null
  )
  select jsonb_build_object(
    'pending', count(*) filter (
      where event.status in ('pending', 'retry', 'processing', 'dead_letter')
    ),
    'dead_letters', count(*) filter (where event.status = 'dead_letter'),
    'oldest_created_at', min(event.created_at) filter (
      where event.status in ('pending', 'retry', 'processing', 'dead_letter')
    )
  )
  from migration.commerce_mirror_outbox event
  cross join requested
  where cardinality(requested.ids) > 0
    and event.document_ids && requested.ids;
$function$;
CREATE OR REPLACE FUNCTION public.roo_commerce_readiness()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'last_parity', (
      select jsonb_build_object(
        'direction', direction,
        'completed_at', completed_at,
        'status', status,
        'counters', counters
      )
      from migration.sync_runs
      where status in ('completed', 'failed', 'cancelled')
        and completed_at is not null
        and (
          direction = 'sanity_to_supabase'
          or (
            direction = 'compare'
            and counters->>'mode' = 'verify'
          )
        )
      order by completed_at desc
      limit 1
    ),
    'last_mirror_checkpoint', (
      select jsonb_build_object(
        'event_key', event_key,
        'generation', cutover_generation,
        'mirrored_at', mirrored_at
      )
      from migration.commerce_mirror_checkpoints
      order by id desc
      limit 1
    ),
    'mirror', jsonb_build_object(
      'pending', (
        select count(*)
        from migration.commerce_mirror_outbox
        where status in ('pending', 'retry', 'processing', 'dead_letter')
      ),
      'oldest_pending_at', (
        select min(created_at)
        from migration.commerce_mirror_outbox
        where status in ('pending', 'retry', 'processing', 'dead_letter')
      ),
      'dead_letters', (
        select count(*)
        from migration.commerce_mirror_outbox
        where status = 'dead_letter'
      )
    ),
    'captured_without_booking', (
      select count(*)
      from commerce.payment_records
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
      select count(*)
      from commerce.email_dispatches
      where status in ('retry', 'failed')
    ),
    'email_oldest_retry_at', (
      select min(coalesce(next_attempt_at, updated_at))
      from commerce.email_dispatches
      where status in ('retry', 'failed')
    ),
    'coupon_mismatches', (
      select count(*)
      from commerce.coupons
      where consumed_uses < 0
        or reserved_uses < 0
        or (
          maximum_uses is not null
          and consumed_uses + reserved_uses > maximum_uses
        )
    ),
    'referral_ambiguous', (
      select count(*)
      from migration.source_documents
      where document_type in ('owedReferral', 'creatorPayout')
        and not tombstoned
        and btrim(coalesce(
          case
            when document_type = 'creatorPayout' then payload->>'amount'
            else payload->>'totalOwed'
          end,
          ''
        )) !~ '^-?[0-9]+([.][0-9]{1,2})?$'
    ),
    'recent_metrics', (
      select jsonb_build_object(
        'sample_count', count(*),
        'p95_ms', coalesce(
          round(
            percentile_cont(0.95) within group (order by duration_ms)
          )::integer,
          0
        ),
        'error_rate', coalesce(
          round(
            10000 * avg(case when status_code >= 500 then 1 else 0 end)
          ) / 100,
          0
        ),
        'max_response_bytes', coalesce(max(response_bytes), 0)
      )
      from migration.commerce_request_metrics
      where recorded_at >= now() - interval '5 minutes'
        and route not in ('payment/reconcile', 'ref/cronsyncall')
    ),
    'duplicate_active_slots', (
      select count(*)
      from (
        select start_time_utc
        from commerce.booking_slots
        where status = 'active'
        group by start_time_utc
        having count(*) > 1
      ) duplicates
    )
  );
$function$;
CREATE OR REPLACE FUNCTION public.roo_complete_commerce_mirror_event(p_event_key text, p_lease_id text, p_success boolean, p_error_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_event migration.commerce_mirror_outbox%rowtype; v_checkpoint jsonb; v_status text;
begin
  if nullif(btrim(coalesce(p_event_key, '')), '') is null
    or nullif(btrim(coalesce(p_lease_id, '')), '') is null
    or p_success is null then
    raise exception 'invalid commerce mirror completion' using errcode = '22023';
  end if;

  select * into v_event from migration.commerce_mirror_outbox
  where event_key = p_event_key for update;
  if not found then raise exception 'mirror event not found' using errcode = 'P0002'; end if;
  if v_event.status in ('mirrored', 'superseded') then
    return jsonb_build_object('event_key', p_event_key, 'status', v_event.status, 'idempotent', true);
  end if;
  if v_event.lease_id is distinct from p_lease_id then
    raise exception 'mirror event lease conflict' using errcode = '40001';
  end if;
  if p_success then
    v_status := case when p_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE'
      then 'superseded' else 'mirrored' end;
    update migration.commerce_mirror_outbox set
      status = v_status, mirrored_at = case when v_status = 'mirrored' then now() else mirrored_at end,
      resolved_at = case when v_status = 'superseded' then now() else resolved_at end,
      resolution_reason = case when v_status = 'superseded' then 'newer_sanity_sequence' else resolution_reason end,
      lease_id = null, lease_expires_at = null, next_attempt_at = null,
      last_error_code = null
    where event_key = p_event_key;
    if v_status = 'mirrored' then
      insert into migration.commerce_mirror_checkpoints (
        event_key, canonical_hash, cutover_generation, document_count, sequence_no
      ) values (
        p_event_key, v_event.canonical_hash, v_event.cutover_generation,
        cardinality(v_event.document_ids), v_event.sequence_no
      ) on conflict (event_key) do update set
        sequence_no = excluded.sequence_no, mirrored_at = now();
    end if;
    v_checkpoint := migration.recompute_commerce_mirror_checkpoint();
  else
    update migration.commerce_mirror_outbox set
      status = case when attempt_count >= 12 then 'dead_letter' else 'retry' end,
      next_attempt_at = case when attempt_count >= 12 then null else
        now() + least(interval '1 hour', interval '1 minute' * power(2, least(attempt_count, 6))) end,
      lease_id = null, lease_expires_at = null,
      last_error_code = left(coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED'), 128)
    where event_key = p_event_key;
    v_status := case when v_event.attempt_count >= 12 then 'dead_letter' else 'retry' end;
  end if;
  return jsonb_build_object(
    'event_key', p_event_key, 'status', v_status,
    'checkpoint', v_checkpoint
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_complete_credential_operation_v2(p_operation_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal_id uuid;
  v_operation accounts.credential_operations%rowtype;
  v_version bigint;
begin
  select operation.principal_id
  into v_principal_id
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  select principal.session_version
  into v_version
  from accounts.principals principal
  where principal.id = v_principal_id
  for update;

  if not found then
    raise exception 'Credential principal was not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if v_operation.principal_id is distinct from v_principal_id then
    raise exception 'Credential operation principal changed'
      using errcode = '55000';
  end if;

  if v_operation.status = 'mirrored' then
    return jsonb_build_object(
      'status', 'mirrored',
      'session_version', v_version,
      'idempotent', true
    );
  end if;

  if v_operation.status <> 'auth_applied' then
    raise exception 'Credential operation is not ready to complete'
      using errcode = '55000';
  end if;

  if v_operation.sessions_revoked_at is null then
    raise exception 'Credential sessions have not been revoked'
      using errcode = '55000';
  end if;

  if v_operation.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error
    );
  end if;

  if v_operation.source_backend is not null
     and v_operation.source_applied_at is null then
    raise exception 'Credential source operation is not complete'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    status = 'mirrored',
    last_error_code = null,
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    mirrored_at = coalesce(operation.mirrored_at, now()),
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'mirrored',
    'session_version', v_version,
    'idempotent', false
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_complete_document_mutation_mirror_event(p_event_key uuid, p_lease_id uuid, p_success boolean, p_error_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event migration.document_mutation_mirror_outbox%rowtype;
  v_status text;
  v_resolved integer := 0;
begin
  if p_event_key is null or p_lease_id is null or p_success is null then
    raise exception 'invalid document mirror completion input'
      using errcode = '22023';
  end if;

  select * into v_event
  from migration.document_mutation_mirror_outbox
  where event_key = p_event_key
  for update;

  if not found then
    raise exception 'document mirror event not found'
      using errcode = 'P0002';
  end if;

  if v_event.status = 'applied' then
    return jsonb_build_object(
      'event_key', p_event_key,
      'status', 'applied',
      'idempotent', true
    );
  end if;

  if v_event.status <> 'processing'
     or v_event.lease_id is distinct from p_lease_id then
    raise exception 'document mirror event lease conflict'
      using errcode = '40001';
  end if;

  if p_success then
    update migration.document_mutation_mirror_outbox
    set
      status = 'applied',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = null,
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where event_key = p_event_key;

    update migration.document_mutation_mirror_outbox older
    set
      status = 'applied',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE',
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where older.status = 'dead_letter'
      and older.sequence_no < v_event.sequence_no
      and not exists (
        select 1
        from unnest(older.document_ids) older_document_id
        where not exists (
          select 1
          from migration.document_mutation_mirror_outbox newer
          where newer.status = 'applied'
            and newer.sequence_no > older.sequence_no
            and newer.document_ids && array[older_document_id]::text[]
        )
      );
    get diagnostics v_resolved = row_count;
    v_status := 'applied';
  else
    v_status := case
      when v_event.attempt_count >= v_event.max_attempts then 'dead_letter'
      else 'retry'
    end;
    update migration.document_mutation_mirror_outbox
    set
      status = v_status,
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = case
        when v_status = 'dead_letter' then now()
        else now() + least(
          interval '5 minutes',
          interval '15 seconds' * power(2, least(v_event.attempt_count - 1, 5))
        )
      end,
      last_error_code = left(
        regexp_replace(
          upper(coalesce(nullif(btrim(p_error_code), ''), 'MIRROR_FAILED')),
          '[^A-Z0-9_:-]',
          '_',
          'g'
        ),
        128
      ),
      updated_at = now(),
      applied_at = null,
      dead_lettered_at = case when v_status = 'dead_letter' then now() else null end
    where event_key = p_event_key;
  end if;

  return jsonb_build_object(
    'event_key', p_event_key,
    'status', v_status,
    'resolved_older_dead_letters', v_resolved
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_document_mutation_mirror_backlog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'pending', count(*) filter (
      where status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'actionable', count(*) filter (where status in ('pending', 'retry')),
    'processing', count(*) filter (where status = 'processing'),
    'retry', count(*) filter (where status = 'retry'),
    'dead_letters', count(*) filter (where status = 'dead_letter'),
    'overdue', count(*) filter (
      where status in ('pending', 'processing', 'retry')
        and created_at < now() - interval '5 minutes'
    ),
    'expired_leases', count(*) filter (
      where status = 'processing' and lease_expires_at <= now()
    ),
    'oldest_created_at', min(created_at) filter (
      where status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'oldest_age_seconds', coalesce(
      extract(epoch from now() - min(created_at) filter (
        where status in ('pending', 'processing', 'retry', 'dead_letter')
      ))::bigint,
      0
    ),
    'ready',
      count(*) filter (where status = 'dead_letter') = 0
      and count(*) filter (
        where status in ('pending', 'processing', 'retry')
          and created_at < now() - interval '5 minutes'
      ) = 0
  )
  from migration.document_mutation_mirror_outbox;
$function$;
CREATE OR REPLACE FUNCTION public.roo_document_mutation_mirror_status_for_ids(p_document_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids text[];
  v_result jsonb;
begin
  if p_document_ids is null
     or cardinality(p_document_ids) not between 1 and 500 then
    raise exception 'invalid document mirror status input'
      using errcode = '22023';
  end if;

  select coalesce(
    array_agg(distinct id order by id),
    '{}'::text[]
  )
  into v_ids
  from unnest(p_document_ids) id
  where id is not null
    and id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
    and position('..' in id) = 0;

  if cardinality(v_ids) <> cardinality(array(
    select distinct id from unnest(p_document_ids) id
  )) then
    raise exception 'invalid document mirror status input'
      using errcode = '22023';
  end if;

  select jsonb_build_object(
    'pending', count(*) filter (
      where event.status in ('pending', 'processing', 'retry', 'dead_letter')
    ),
    'dead_letters', count(*) filter (where event.status = 'dead_letter'),
    'oldest_created_at', min(event.created_at) filter (
      where event.status in ('pending', 'processing', 'retry', 'dead_letter')
    )
  )
  into v_result
  from migration.document_mutation_mirror_outbox event
  where event.document_ids && v_ids;

  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_enqueue_referral_email_mutation(p_mutations jsonb, p_referral_id text, p_dispatch_kind text, p_recipient_email text, p_recipient_hash text, p_token_hash text, p_delivery_payload jsonb, p_expires_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_referral_id text := btrim(coalesce(p_referral_id, ''));
  v_kind text := lower(btrim(coalesce(p_dispatch_kind, '')));
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_recipient_hash text := lower(btrim(coalesce(p_recipient_hash, '')));
  v_token_hash text := lower(btrim(coalesce(p_token_hash, '')));
  v_idempotency_key text;
  v_dispatch accounts.referral_email_dispatches%rowtype;
  v_source_error text;
begin
  if v_referral_id = '' or char_length(v_referral_id) > 256
    or v_kind not in ('registration_verification', 'password_reset')
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_email) > 254
    or v_recipient_hash !~ '^[0-9a-f]{64}$'
    or v_token_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_delivery_payload) <> 'object'
    or nullif(p_delivery_payload->>'token', '') is null
    or char_length(p_delivery_payload->>'token') > 256
    or char_length(coalesce(p_delivery_payload->>'name', '')) > 200
    or octet_length(p_delivery_payload::text) > 8192
    or p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '24 hours'
    or jsonb_typeof(p_mutations) <> 'array'
    or jsonb_array_length(p_mutations) < 1 then
    raise exception 'invalid referral email enqueue request'
      using errcode = '22023';
  end if;
  if encode(extensions.digest(v_email, 'sha256'), 'hex') <> v_recipient_hash
    or encode(
      extensions.digest(p_delivery_payload->>'token', 'sha256'),
      'hex'
    ) <> v_token_hash then
    raise exception 'referral email digest mismatch'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(p_mutations) mutation
    where mutation->>'operation' in ('create', 'replace')
      and mutation->'document'->>'_id' = v_referral_id
      and mutation->'document'->>'_type' = 'referral'
      and lower(btrim(mutation->'document'->>'creatorEmail')) = v_email
      and case v_kind
        when 'registration_verification' then
          mutation->'document'->>'registrationStatus' = 'pending_email'
          and mutation->'document'->>'registrationVerificationTokenHash' = v_token_hash
          and (mutation->'document'->>'registrationVerificationExpiresAt')::timestamptz
            = p_expires_at
        when 'password_reset' then
          coalesce(mutation->'document'->>'registrationStatus', '') <> 'pending_email'
          and mutation->'document'->>'resetTokenHash' = v_token_hash
          and (mutation->'document'->>'resetTokenExpiresAt')::timestamptz
            = p_expires_at
        else false
      end
  ) then
    raise exception 'referral email mutation does not match its dispatch'
      using errcode = '22023';
  end if;

  v_idempotency_key := 'referral-email-' || encode(
    extensions.digest(
      v_kind || ':' || v_referral_id || ':' || v_token_hash || ':' || v_recipient_hash,
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-email:' || v_kind || ':' || v_referral_id, 0)
  );

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where idempotency_key = v_idempotency_key
  for update;
  if found then
    if v_dispatch.referral_id <> v_referral_id
      or v_dispatch.dispatch_kind <> v_kind
      or v_dispatch.recipient_hash <> v_recipient_hash
      or v_dispatch.token_hash <> v_token_hash then
      raise exception 'referral email idempotency conflict'
        using errcode = '23505';
    end if;
    v_source_error := accounts.referral_email_dispatch_source_error(
      v_dispatch.referral_id,
      v_dispatch.dispatch_kind,
      v_dispatch.recipient_hash,
      v_dispatch.token_hash,
      v_dispatch.expires_at
    );
    if v_source_error is not null then
      raise exception 'referral email source state changed'
        using errcode = '40001', detail = v_source_error;
    end if;
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'idempotency_key', v_dispatch.idempotency_key,
      'status', v_dispatch.status,
      'replayed', true,
      'token_hash', v_dispatch.token_hash
    );
  end if;

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where referral_id = v_referral_id
    and dispatch_kind = v_kind
    and status in ('pending', 'sending', 'retry')
    and expires_at > now()
  order by created_at desc, id
  limit 1
  for update;
  if found then
    v_source_error := accounts.referral_email_dispatch_source_error(
      v_dispatch.referral_id,
      v_dispatch.dispatch_kind,
      v_dispatch.recipient_hash,
      v_dispatch.token_hash,
      v_dispatch.expires_at
    );
    if v_source_error is null then
      if v_dispatch.recipient_hash <> v_recipient_hash then
        raise exception 'referral email recipient conflict'
          using errcode = '23505';
      end if;
      return jsonb_build_object(
        'dispatch_id', v_dispatch.id,
        'idempotency_key', v_dispatch.idempotency_key,
        'status', v_dispatch.status,
        'replayed', true,
        'token_hash', v_dispatch.token_hash
      );
    end if;
    if v_dispatch.status = 'sending' and v_dispatch.lease_expires_at > now() then
      raise exception 'referral email source state changed during delivery'
        using errcode = '40001', detail = v_source_error;
    end if;
    update accounts.referral_email_dispatches
    set status = 'dead_letter',
        lease_id = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        last_error_code = 'source_state_changed',
        dead_lettered_at = now(),
        delivery_payload = delivery_payload - 'token',
        updated_at = now()
    where id = v_dispatch.id;
  end if;

  perform public.roo_apply_document_mutations(p_mutations);
  v_source_error := accounts.referral_email_dispatch_source_error(
    v_referral_id,
    v_kind,
    v_recipient_hash,
    v_token_hash,
    p_expires_at
  );
  if v_source_error is not null then
    raise exception 'referral email mutation did not establish source state'
      using errcode = '40001', detail = v_source_error;
  end if;
  insert into accounts.referral_email_dispatches (
    command_id,
    idempotency_key,
    referral_id,
    dispatch_kind,
    recipient_email,
    recipient_hash,
    token_hash,
    delivery_payload,
    expires_at
  ) values (
    'dispatch:' || v_idempotency_key,
    v_idempotency_key,
    v_referral_id,
    v_kind,
    v_email,
    v_recipient_hash,
    v_token_hash,
    p_delivery_payload,
    p_expires_at
  )
  returning * into v_dispatch;

  return jsonb_build_object(
    'dispatch_id', v_dispatch.id,
    'idempotency_key', v_dispatch.idempotency_key,
    'status', v_dispatch.status,
    'replayed', false,
    'token_hash', v_dispatch.token_hash
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_fetch_recovery_payment_documents(p_backend text, p_statuses text[], p_refunded_status text, p_booked_status text, p_abandoned_status text, p_now timestamp with time zone, p_limit integer DEFAULT 50, p_dodo_enabled boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with candidates as (
    select payment.legacy_sanity_id, payment.updated_at, source.payload
    from commerce.payment_records payment
    join migration.source_documents source
      on source.legacy_sanity_id = payment.legacy_sanity_id
    where not source.tombstoned
      and not (coalesce(source.payload->'providerRecoveryTerminal', 'false'::jsonb) = 'true'::jsonb
        and coalesce(source.payload->>'providerRecoveryTerminalReason', '')
          in ('payment_currency_mismatch', 'payment_currency_invalid'))
      and payment.backend_owner = case
        when lower(p_backend) = 'supabase' then 'supabase' else 'sanity' end
      and (
        payment.provider != 'dodo'
        or (p_dodo_enabled and coalesce(source.payload->>'providerRecoveryTerminal', 'false') != 'true')
        or (payment.refund_requires_booking_sync)
        or payment.resource_release_pending
        or (payment.status = 'email_partial' and source.payload->>'requiresReschedule' = 'true')
        or (payment.status in ('email_partial', lower(p_booked_status)) and payment.email_dispatch_required)
      )
      and (
        payment.status = any(coalesce(p_statuses, '{}'::text[]))
        or (payment.refund_requires_booking_sync)
        or (payment.status = lower(p_booked_status) and payment.email_dispatch_required)
        or (payment.status = lower(p_abandoned_status)
          and (payment.resource_release_pending or payment.late_capture_watch_until is not null))
      )
      and (payment.next_recovery_at is null or payment.next_recovery_at <= p_now)
    order by coalesce(payment.next_recovery_at, '-infinity'::timestamptz), payment.updated_at, payment.id
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  select coalesce(jsonb_agg(payload order by updated_at, legacy_sanity_id), '[]'::jsonb)
  from candidates;
$function$;
CREATE OR REPLACE FUNCTION public.roo_get_credential_operation_v2(p_operation_key text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'operation_key', operation.operation_key,
    'user_id', operation.user_id,
    'principal_id', operation.principal_id,
    'password_hash', operation.password_hash,
    'status', operation.status,
    'source_revision', operation.source_revision,
    'source_backend', operation.source_backend,
    'source_document_id', operation.source_document_id,
    'source_expected_revision', operation.source_expected_revision,
    'source_preconditions', operation.source_preconditions,
    'source_mutation', operation.source_mutation,
    'source_applied_revision', operation.source_applied_revision,
    'source_applied_at', operation.source_applied_at,
    'sessions_revoked_at', operation.sessions_revoked_at,
    'source_recovery_blocked', operation.source_recovery_blocked,
    'source_recovery_blocked_at', operation.source_recovery_blocked_at,
    'creator_legacy_sanity_id', creator.legacy_sanity_id,
    'attempt_count', operation.attempt_count,
    'consecutive_error_count', operation.consecutive_error_count,
    'last_error_code', operation.last_error_code,
    'last_error', operation.last_error,
    'last_error_class', operation.last_error_class,
    'next_retry_at', operation.next_retry_at
  )
  from accounts.credential_operations operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id
  where operation.operation_key = p_operation_key;
$function$;
CREATE OR REPLACE FUNCTION public.roo_list_credential_recovery_v2(p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_operation_key text;
begin
  update accounts.credential_operations operation
  set
    source_recovery_blocked = true,
    source_recovery_blocked_at = coalesce(
      operation.source_recovery_blocked_at,
      now()
    ),
    next_retry_at = null,
    last_error_code = coalesce(
      operation.last_error_code,
      'CREDENTIAL_RECOVERY_ATTEMPT_LIMIT'
    ),
    last_error = coalesce(
      operation.last_error,
      'Credential recovery reached the automatic attempt limit.'
    ),
    last_error_class = coalesce(operation.last_error_class, 'transient'),
    updated_at = now()
  where operation.status in ('prepared', 'auth_applied')
    and not operation.source_recovery_blocked
    and operation.attempt_count >= 6;

  for v_operation_key in
    select operation.operation_key
    from accounts.principals principal
    join accounts.credential_operations operation
      on operation.principal_id = principal.id
    left join auth.users auth_user on auth_user.id = operation.user_id
    where not operation.source_recovery_blocked
      and operation.attempt_count < 6
      and (
        operation.next_retry_at is null
        or operation.next_retry_at <= now()
      )
      and (
        (
          operation.status = 'auth_applied'
          and operation.sessions_revoked_at is null
        ) or (
          operation.status = 'prepared'
          and auth_user.encrypted_password = operation.password_hash
        )
      )
    order by operation.created_at
    for update of principal skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  loop
    perform public.roo_mark_credential_operation_v2(
      v_operation_key,
      'auth_applied',
      null
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'operation_key', operation.operation_key,
        'user_id', operation.user_id,
        'principal_id', operation.principal_id,
        'password_hash', operation.password_hash,
        'status', operation.status,
        'source_revision', operation.source_revision,
        'source_backend', operation.source_backend,
        'source_document_id', operation.source_document_id,
        'source_expected_revision', operation.source_expected_revision,
        'source_preconditions', operation.source_preconditions,
        'source_mutation', operation.source_mutation,
        'source_applied_revision', operation.source_applied_revision,
        'source_applied_at', operation.source_applied_at,
        'sessions_revoked_at', operation.sessions_revoked_at,
        'source_recovery_blocked', operation.source_recovery_blocked,
        'source_recovery_blocked_at', operation.source_recovery_blocked_at,
        'creator_legacy_sanity_id', creator.legacy_sanity_id,
        'attempt_count', operation.attempt_count,
        'consecutive_error_count', operation.consecutive_error_count,
        'last_error_code', operation.last_error_code,
        'last_error', operation.last_error,
        'last_error_class', operation.last_error_class,
        'next_retry_at', operation.next_retry_at
      )
      order by operation.created_at
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select candidate.*
    from accounts.credential_operations candidate
    where candidate.status in ('prepared', 'auth_applied')
      and not candidate.source_recovery_blocked
      and candidate.attempt_count < 6
      and (
        candidate.next_retry_at is null
        or candidate.next_retry_at <= now()
      )
    order by candidate.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  ) operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id;

  return v_result;
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_prepare_credential_operation_v2(p_operation_key text, p_user_id uuid, p_password_hash text, p_source_backend text, p_source_document_id text, p_source_expected_revision text, p_source_preconditions jsonb, p_source_mutation jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal_id uuid;
  v_existing accounts.credential_operations%rowtype;
  v_row accounts.credential_operations%rowtype;
  v_set jsonb := p_source_mutation->'set';
  v_unset jsonb := p_source_mutation->'unset';
  v_allowed_preconditions constant text[] := array[
    'creatorPassword',
    'credentialVersion',
    'resetTokenHash',
    'resetTokenExpiresAt'
  ];
  v_allowed_set constant text[] := array[
    'creatorPassword',
    'credentialVersion',
    'passwordLoginEnabled',
    'passwordResetRequired',
    'passwordChangedAt'
  ];
  v_allowed_unset constant text[] := array[
    'resetToken',
    'resetTokenHash',
    'resetTokenExpiresAt',
    'resetDeliveryToken'
  ];
begin
  select mapping.principal_id
  into v_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;

  if v_principal_id is null
     or p_password_hash !~ '^[$]2[aby][$][0-9]{2}[$]'
     or nullif(btrim(p_operation_key), '') is null
     or p_source_backend not in ('sanity', 'supabase')
     or p_source_document_id is null
     or p_source_document_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
     or position('..' in p_source_document_id) > 0
     or nullif(btrim(p_source_expected_revision), '') is null
     or jsonb_typeof(p_source_preconditions) <> 'object'
     or coalesce(p_source_preconditions, '{}'::jsonb) = '{}'::jsonb
     or jsonb_typeof(p_source_mutation) <> 'object'
     or jsonb_typeof(v_set) <> 'object'
     or jsonb_typeof(v_unset) <> 'array'
     or v_set->>'creatorPassword' is distinct from p_password_hash
     or v_set->'credentialVersion' is distinct from '2'::jsonb
     or v_set->'passwordLoginEnabled' is distinct from 'true'::jsonb
     or v_set->'passwordResetRequired' is distinct from 'false'::jsonb
     or nullif(btrim(v_set->>'passwordChangedAt'), '') is null
     or exists (
       select 1
       from jsonb_object_keys(p_source_preconditions) field
       where not (field = any(v_allowed_preconditions))
     )
     or exists (
       select 1
       from jsonb_object_keys(v_set) field
       where not (field = any(v_allowed_set))
     )
     or exists (
       select 1
       from jsonb_array_elements_text(v_unset) field
       where not (field = any(v_allowed_unset))
     ) then
    raise exception 'Credential source operation is invalid'
      using errcode = '22023';
  end if;

  perform (v_set->>'passwordChangedAt')::timestamptz;

  perform 1
  from accounts.principals principal
  where principal.id = v_principal_id
    and principal.status = 'active'
  for update;
  if not found then
    raise exception 'Active principal was not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_existing
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if found then
    if v_existing.user_id is distinct from p_user_id
       or v_existing.principal_id is distinct from v_principal_id
       or v_existing.password_hash is distinct from p_password_hash
       or v_existing.source_backend is distinct from p_source_backend
       or v_existing.source_document_id is distinct from p_source_document_id
       or v_existing.source_expected_revision is distinct from p_source_expected_revision
       or v_existing.source_preconditions is distinct from p_source_preconditions
       or v_existing.source_mutation is distinct from p_source_mutation
       or v_existing.status = 'failed' then
      raise exception 'Credential operation conflicts'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'status', v_existing.status,
      'principal_id', v_existing.principal_id,
      'password_hash', v_existing.password_hash,
      'source_backend', v_existing.source_backend,
      'source_document_id', v_existing.source_document_id,
      'source_preconditions', v_existing.source_preconditions,
      'source_mutation', v_existing.source_mutation,
      'idempotent', true
    );
  end if;

  if exists (
    select 1
    from accounts.credential_operations operation
    where operation.principal_id = v_principal_id
      and operation.status in ('prepared', 'auth_applied')
  ) then
    raise exception 'Another credential operation is in progress'
      using errcode = '55006';
  end if;

  insert into accounts.credential_operations (
    operation_key,
    user_id,
    principal_id,
    password_hash,
    source_revision,
    source_backend,
    source_document_id,
    source_expected_revision,
    source_preconditions,
    source_mutation
  )
  values (
    p_operation_key,
    p_user_id,
    v_principal_id,
    p_password_hash,
    p_source_expected_revision,
    p_source_backend,
    p_source_document_id,
    p_source_expected_revision,
    p_source_preconditions,
    p_source_mutation
  )
  on conflict (operation_key) do update
  set updated_at = accounts.credential_operations.updated_at
  where accounts.credential_operations.user_id = excluded.user_id
    and accounts.credential_operations.principal_id = excluded.principal_id
    and accounts.credential_operations.password_hash = excluded.password_hash
    and accounts.credential_operations.source_backend = excluded.source_backend
    and accounts.credential_operations.source_document_id = excluded.source_document_id
    and accounts.credential_operations.source_expected_revision = excluded.source_expected_revision
    and accounts.credential_operations.source_preconditions = excluded.source_preconditions
    and accounts.credential_operations.source_mutation = excluded.source_mutation
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Credential operation conflicts'
      using errcode = '23505';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'principal_id', v_principal_id,
    'password_hash', v_row.password_hash,
    'source_backend', v_row.source_backend,
    'source_document_id', v_row.source_document_id,
    'source_preconditions', v_row.source_preconditions,
    'source_mutation', v_row.source_mutation,
    'idempotent', false
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_requeue_commerce_mirror_event(p_event_key text, p_expected_attempt_count integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A requeue reason is required' using errcode = '22023';
  end if;
  select * into v_event
  from migration.commerce_mirror_outbox
  where event_key = p_event_key
  for update;
  if not found then
    raise exception 'mirror event not found' using errcode = 'P0002';
  end if;
  if v_event.status <> 'dead_letter'
    or v_event.attempt_count <> p_expected_attempt_count then
    raise exception 'mirror event changed or is not dead-lettered'
      using errcode = '40001';
  end if;
  update migration.commerce_mirror_outbox
  set status = 'retry',
      next_attempt_at = now(),
      lease_id = null,
      lease_expires_at = null,
      requeue_count = requeue_count + 1,
      last_requeued_at = now(),
      resolution_reason = left(btrim(p_reason), 240)
  where event_key = p_event_key;
  insert into migration.commerce_mirror_actions (
    event_key, action, expected_attempt_count, reason
  ) values (
    p_event_key, 'requeue', p_expected_attempt_count, left(btrim(p_reason), 240)
  );
  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'retry',
    'requeue_count', v_event.requeue_count + 1
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_requeue_document_mutation_mirror_event(p_event_key uuid, p_expected_attempt_count integer, p_actor text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event migration.document_mutation_mirror_outbox%rowtype;
  v_actor text := btrim(coalesce(p_actor, ''));
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_event_key is null
     or coalesce(p_expected_attempt_count, -1) < 0
     or v_actor !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,79}$'
     or char_length(v_reason) not between 8 and 240 then
    raise exception 'invalid document mirror requeue input'
      using errcode = '22023';
  end if;

  select * into v_event
  from migration.document_mutation_mirror_outbox
  where event_key = p_event_key
  for update;

  if not found then
    raise exception 'document mirror event not found'
      using errcode = 'P0002';
  end if;

  if v_event.status <> 'dead_letter'
     or v_event.attempt_count <> p_expected_attempt_count then
    raise exception 'document mirror event changed or is not dead-lettered'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from unnest(v_event.document_ids) event_document_id
    where not exists (
      select 1
      from migration.document_mutation_mirror_outbox newer
      where newer.status = 'applied'
        and newer.sequence_no > v_event.sequence_no
        and newer.document_ids && array[event_document_id]::text[]
    )
  ) then
    update migration.document_mutation_mirror_outbox
    set
      status = 'applied',
      last_error_code = 'SUPERSEDED_BY_NEWER_SEQUENCE',
      updated_at = now(),
      applied_at = now(),
      dead_lettered_at = null
    where event_key = p_event_key;

    insert into migration.document_mutation_mirror_actions (
      event_key,
      action,
      previous_attempt_count,
      actor,
      reason
    ) values (
      p_event_key,
      'supersede',
      p_expected_attempt_count,
      v_actor,
      v_reason
    );

    return jsonb_build_object(
      'event_key', p_event_key,
      'status', 'applied',
      'actor', v_actor,
      'superseded', true
    );
  end if;

  if exists (
    select 1
    from migration.document_mutation_mirror_outbox newer
    where newer.status = 'applied'
      and newer.sequence_no > v_event.sequence_no
      and newer.document_ids && v_event.document_ids
  ) then
    raise exception 'document mirror event overlaps newer applied state; create an explicit repair event'
      using errcode = '40001';
  end if;

  update migration.document_mutation_mirror_outbox
  set
    status = 'retry',
    attempt_count = 0,
    requeue_count = requeue_count + 1,
    next_attempt_at = now(),
    last_error_code = null,
    updated_at = now(),
    dead_lettered_at = null
  where event_key = p_event_key;

  insert into migration.document_mutation_mirror_actions (
    event_key,
    action,
    previous_attempt_count,
    actor,
    reason
  )
  values (
    p_event_key,
    'requeue',
    p_expected_attempt_count,
    v_actor,
    v_reason
  );

  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'retry',
    'actor', v_actor,
    'requeue_count', v_event.requeue_count + 1
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.roo_supabase_port_readiness()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with payment_aliases as (
    select
      payment.id,
      (
        canonical.id is not null
        and not canonical.duplicate_payment_record
        and payment.booking_id is not null
        and payment.booking_id = canonical.booking_id
        and booking.payment_record_id = canonical.id
        and payment.provider = canonical.provider
        and payment.currency is not distinct from canonical.currency
        and payment.status in ('booked', 'email_partial')
        and canonical.status in ('booked', 'email_partial')
      ) valid
    from commerce.payment_records payment
    left join commerce.payment_records canonical
      on canonical.id = payment.canonical_payment_record_id
    left join commerce.bookings booking
      on booking.id = payment.booking_id
    where payment.duplicate_payment_record
  )
  select jsonb_build_object(
    'documentMutationMirror', public.roo_document_mutation_mirror_backlog(),
    'credentialRecovery', jsonb_build_object(
      'pending', (select count(*) from accounts.credential_operations
        where status in ('prepared', 'auth_applied')),
      'oldestAt', (select min(created_at) from accounts.credential_operations
        where status in ('prepared', 'auth_applied'))
    ),
    'identityDrift', jsonb_build_object(
      'missing', (select count(*)
        from auth.identities identity
        join accounts.principal_auth_users mapping
          on mapping.user_id = identity.user_id
        where identity.provider in ('email', 'google', 'apple', 'discord')
          and not exists (
            select 1 from accounts.identity_links projected
            where projected.provider = identity.provider
              and projected.provider_subject = identity.provider_id
              and projected.principal_id = mapping.principal_id
          )),
      'stale', (select count(*) from accounts.identity_links projected
        where projected.backend_owner = 'supabase'
          and not exists (
            select 1 from auth.identities identity
            where identity.user_id = projected.user_id
              and identity.provider = projected.provider
              and identity.provider_id = projected.provider_subject
          ))
    ),
    'creatorProjectionDrift', (select count(*)
      from migration.source_documents source
      left join accounts.creator_profiles creator
        on creator.legacy_sanity_id = source.legacy_sanity_id
      where source.document_type = 'referral'
        and not source.tombstoned
        and coalesce(source.payload->>'registrationStatus', 'active') <> 'pending_email'
        and (
          creator.user_id is null
          or source.source_hash is distinct from creator.source_hash
        )),
    'parityAgeSeconds', (
      select case when max(completed_at) is null then null
        else extract(epoch from now() - max(completed_at)) end
      from migration.sync_runs
      where direction = 'compare' and status = 'completed'
    ),
    'staleProviderRecovery', (select count(*)
      from commerce.payment_records payment
      where payment.status = 'needs_recovery'
        and (
          (payment.next_recovery_at is null
            and payment.updated_at < now() - interval '15 minutes')
          or payment.next_recovery_at < now() - interval '15 minutes'
        )),
    'capturedWithoutBooking', (select count(*)
      from commerce.payment_records payment
      where payment.status in ('captured', 'booked', 'email_partial')
        and payment.booking_id is null
        and not coalesce(payment.requires_reschedule, false)
        and not (
          payment.duplicate_payment_record
          and exists (
            select 1
            from commerce.payment_records canonical
            where canonical.id = payment.canonical_payment_record_id
              and canonical.booking_id is not null
          )
        )),
    'reciprocalLinkMismatches', (
      select count(*) from (
        select 'payment' source_kind, payment.id source_id
        from commerce.payment_records payment
        where payment.booking_id is not null
          and not exists (
            select 1 from commerce.bookings booking
            where booking.id = payment.booking_id
              and (
                booking.payment_record_id = payment.id
                or (
                  payment.duplicate_payment_record
                  and booking.payment_record_id =
                    payment.canonical_payment_record_id
                )
              )
          )
        union all
        select 'booking', booking.id
        from commerce.bookings booking
        where booking.payment_record_id is not null
          and not exists (
            select 1 from commerce.payment_records payment
            where payment.id = booking.payment_record_id
              and payment.booking_id = booking.id
          )
      ) mismatch
    ),
    'duplicatePaymentAliases', (select count(*) from payment_aliases where not valid),
    'validPaymentAliases', (select count(*) from payment_aliases where valid),
    'paymentAliasesTotal', (select count(*) from payment_aliases),
    'invalidPaymentAliases', (select count(*) from payment_aliases where not valid),
    'providerRecoveryCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.case_type = 'payment'
        and recovery.status in ('open', 'retrying')
        and not recovery.requires_reschedule),
    'rescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and not exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'openRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule and recovery.status <> 'resolved'),
    'notifiedRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'unnotifiedRescheduleCases', (select count(*)
      from commerce.recovery_cases recovery
      where recovery.requires_reschedule
        and recovery.status <> 'resolved'
        and not exists (
          select 1
          from commerce.email_dispatches dispatch
          where dispatch.dispatch_kind = 'reschedule'
            and dispatch.recipient_type = 'customer'
            and dispatch.status = 'sent'
            and (
              dispatch.recovery_case_id = recovery.id
              or dispatch.booking_id = recovery.booking_id
            )
        )),
    'discordRetry', jsonb_build_object(
      'pending', (select count(*) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing')),
      'oldestAt', (select min(updated_at) from accounts.discord_role_assignments
        where status in ('pending', 'retry', 'processing'))
    ),
    'oauthIntents', jsonb_build_object(
      'expiredPending', (select count(*) from accounts.oauth_intents
        where status = 'pending' and expires_at <= now()),
      'terminalOlderThanSevenDays', (select count(*) from accounts.oauth_intents
        where status in ('completed', 'failed', 'expired', 'replaced')
          and updated_at < now() - interval '7 days')
    )
  );
$function$;
CREATE OR REPLACE FUNCTION public.roo_supersede_commerce_mirror_event(p_event_key text, p_replacement_event_key text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_event migration.commerce_mirror_outbox%rowtype;
  v_replacement migration.commerce_mirror_outbox%rowtype;
  v_checkpoint jsonb;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null
    or p_event_key = p_replacement_event_key then
    raise exception 'Invalid mirror supersession' using errcode = '22023';
  end if;
  select * into v_event from migration.commerce_mirror_outbox
  where event_key = p_event_key for update;
  select * into v_replacement from migration.commerce_mirror_outbox
  where event_key = p_replacement_event_key for share;
  if v_event.status <> 'dead_letter'
    or v_replacement.status <> 'mirrored'
    or v_replacement.cutover_generation < v_event.cutover_generation
    or not (v_event.document_ids <@ v_replacement.document_ids) then
    raise exception 'Mirror supersession is not safe' using errcode = '40001';
  end if;
  update migration.commerce_mirror_outbox
  set status = 'superseded',
      resolved_by_event_key = p_replacement_event_key,
      resolved_at = now(),
      resolution_reason = left(btrim(p_reason), 240),
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = null
  where event_key = p_event_key;
  insert into migration.commerce_mirror_actions (
    event_key, action, replacement_event_key, reason
  ) values (
    p_event_key, 'supersede', p_replacement_event_key, left(btrim(p_reason), 240)
  );
  v_checkpoint := migration.recompute_commerce_mirror_checkpoint();
  return jsonb_build_object(
    'event_key', p_event_key,
    'status', 'superseded',
    'replacement_event_key', p_replacement_event_key,
    'checkpoint', v_checkpoint
  );
end;
$function$;
create table sanity_rollback_archive.retired_outbox_rows as select 'commerce_mirror_outbox' outbox,to_jsonb(o) document from migration.commerce_mirror_outbox o where retired_at is not null union all select 'document_mutation_mirror_outbox',to_jsonb(o) from migration.document_mutation_mirror_outbox o where retired_at is not null;
create table sanity_rollback_archive.admin_publish_commands as select * from migration.cms_publish_commands where actor like 'admin:%'; delete from migration.cms_publish_commands where actor like 'admin:%';
update migration.commerce_mirror_outbox current set status=original.status,next_attempt_at=original.next_attempt_at,lease_id=original.lease_id,lease_expires_at=original.lease_expires_at,last_error_code=original.last_error_code from migration.sanity_outbox_retirement archive cross join lateral jsonb_populate_record(null::migration.commerce_mirror_outbox,archive.previous_state) original where archive.outbox='commerce_mirror_outbox' and current.event_key::text=archive.event_key and current.status='retired';
update migration.document_mutation_mirror_outbox current set status=original.status,next_attempt_at=original.next_attempt_at,lease_id=original.lease_id,lease_expires_at=original.lease_expires_at,last_error_code=original.last_error_code,updated_at=original.updated_at from migration.sanity_outbox_retirement archive cross join lateral jsonb_populate_record(null::migration.document_mutation_mirror_outbox,archive.previous_state) original where archive.outbox='document_mutation_mirror_outbox' and current.event_key::text=archive.event_key and current.status='retired';
CREATE TRIGGER account_roles_refresh_creator_fallback_authority AFTER INSERT OR DELETE OR UPDATE OF principal_id, role ON accounts.account_roles FOR EACH ROW EXECUTE FUNCTION accounts.refresh_creator_fallback_authority_trigger();
CREATE TRIGGER creator_profiles_refresh_creator_fallback_authority AFTER INSERT OR DELETE OR UPDATE OF principal_id, legacy_sanity_id, referral_code, active ON accounts.creator_profiles FOR EACH ROW EXECUTE FUNCTION accounts.refresh_creator_fallback_authority_trigger();
CREATE TRIGGER principals_refresh_creator_fallback_authority AFTER INSERT OR DELETE OR UPDATE OF status, session_version ON accounts.principals FOR EACH ROW EXECUTE FUNCTION accounts.refresh_creator_fallback_authority_trigger();
alter table commerce.booking_settings alter column source_backend set default 'sanity'::text;
alter table commerce.booking_slots alter column source_backend set default 'sanity'::text;
alter table commerce.bookings alter column source_backend set default 'sanity'::text;
alter table commerce.coupons alter column source_backend set default 'sanity'::text;
alter table commerce.payment_records alter column source_backend set default 'sanity'::text;
alter table commerce.slot_holds alter column source_backend set default 'sanity'::text;
alter table migration.cms_publish_commands drop constraint cms_publish_commands_actor_check;
alter table migration.cms_publish_commands add constraint cms_publish_commands_actor_check CHECK ((actor ~ '^sanity:[A-Za-z0-9._@/-]{1,120}$'::text));
alter table migration.commerce_mirror_outbox drop constraint commerce_mirror_outbox_status_check;
alter table migration.commerce_mirror_outbox add constraint commerce_mirror_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retry'::text, 'mirrored'::text, 'dead_letter'::text, 'superseded'::text])));
alter table migration.commerce_mirror_outbox drop column retired_at;
alter table migration.commerce_mirror_outbox drop column retirement_reason;
drop trigger suppress_retired_sanity_outbox_insert on migration.commerce_mirror_outbox;
alter table migration.document_mutation_mirror_outbox drop constraint document_mutation_mirror_outbox_status_check;
alter table migration.document_mutation_mirror_outbox add constraint document_mutation_mirror_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retry'::text, 'applied'::text, 'dead_letter'::text])));
alter table migration.document_mutation_mirror_outbox alter column next_attempt_at set not null;
alter table migration.document_mutation_mirror_outbox drop column retired_at;
alter table migration.document_mutation_mirror_outbox drop column retirement_reason;
drop trigger suppress_retired_sanity_outbox_insert on migration.document_mutation_mirror_outbox;
alter table migration.source_documents alter column backend_owner set default 'sanity'::text;
drop function roo_apply_referral_registration_mutations(jsonb);
drop function roo_cms_document_revision(uuid);
drop function roo_cms_document_revisions(text,integer);
drop function roo_complete_cms_upload(uuid,jsonb);
drop function roo_create_cms_upload(jsonb);
drop function roo_expired_cms_uploads(integer);
drop function roo_find_verified_cms_asset(text,text,text);
drop function roo_get_cms_upload(uuid);
drop function roo_grant_account_role(uuid,text);
drop function roo_mark_cms_upload_staging_cleaned(uuid);
drop function roo_record_cms_upload_failure(uuid,text);
drop function roo_refuse_cms_upload(uuid,text);
drop function roo_register_verified_cms_asset(jsonb,jsonb);
drop function roo_resume_prepared_credential_operation(text);
drop function migration.assert_referral_coupon_namespace(jsonb);
drop function migration.cms_nested_refs(jsonb);
drop function migration.cms_package_namespace(text);
drop function migration.cms_upload_json(cms.uploads);
drop function migration.cms_usable_price(text);
drop function migration.release_credential_mirror_wait(text);
drop function migration.suppress_retired_sanity_outbox_insert();
alter table cms.document_revisions set schema sanity_rollback_archive;
alter table cms.uploads set schema sanity_rollback_archive;
alter table migration.sanity_outbox_retirement set schema sanity_rollback_archive;
commit;
