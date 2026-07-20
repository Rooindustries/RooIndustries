set lock_timeout = '5s';
set statement_timeout = '120s';

-- Preserve omitted referral commerce fields and make creator activation follow
-- the authoritative registration lifecycle without changing public signatures.

create or replace function migration.roo_apply_commerce_document_mutations_unbounded(
  p_command_id text,
  p_mutations jsonb,
  p_cutover_generation integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
    if v_operation not in ('create', 'create_if_missing', 'replace', 'delete') then
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
$$;

create or replace function public.roo_upsert_native_creator_account(
  p_account jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_email text := lower(btrim(p_account->>'primary_email'));
  v_code text := lower(btrim(p_account->>'referral_code'));
  v_legacy_id text := nullif(p_account->>'legacy_sanity_id', '');
  v_source_hash text := nullif(lower(p_account->>'source_hash'), '');
  v_source_revision text := nullif(p_account->>'source_revision', '');
  v_registration_status text := coalesce(
    nullif(lower(btrim(p_account->>'registration_status')), ''),
    'active'
  );
  v_account_active boolean := false;
  v_email_verified boolean := false;
  v_source migration.source_documents%rowtype;
begin
  if v_user_id is null
     or v_email is null
     or v_email = ''
     or v_code is null
     or v_code = '' then
    raise exception 'native creator account is incomplete'
      using errcode = '22023';
  end if;
  if v_source_hash is not null and v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'native creator source hash is invalid'
      using errcode = '22023';
  end if;
  if v_registration_status not in ('active', 'pending_email') then
    raise exception 'native creator registration status is invalid'
      using errcode = '22023';
  end if;
  if v_legacy_id is not null and v_source_revision is not null then
    select * into v_source
    from migration.source_documents source
    where source.legacy_sanity_id = v_legacy_id
      and source.document_type = 'referral'
      and not source.tombstoned
    for share;
    if found and (
      v_source.source_revision is distinct from v_source_revision
      or coalesce(v_source.payload->>'registrationStatus', 'active')
        is distinct from v_registration_status
    ) then
      raise exception 'native creator source state changed'
        using errcode = '40001';
    end if;
  end if;
  v_account_active := v_registration_status = 'active';
  v_email_verified := v_account_active;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_revision,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_email,
    coalesce(p_account->>'display_name', v_code),
    case when v_account_active then 'active' else 'pending' end,
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    primary_email = excluded.primary_email,
    display_name = excluded.display_name,
    status = case
      when public.profiles.status in ('disabled', 'deleted')
        then public.profiles.status
      else excluded.status
    end,
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, public.profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    source_backend = 'supabase',
    updated_at = now();

  insert into accounts.account_roles (
    user_id,
    role,
    source_backend,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    v_user_id,
    role,
    'supabase',
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase'
  from unnest(array['customer', 'creator']) role
  on conflict (user_id, role) do update
  set
    source_backend = 'supabase',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  insert into accounts.login_aliases (
    user_id,
    alias_type,
    normalized_value,
    verified,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values
    (
      v_user_id,
      'email',
      v_email,
      v_email_verified,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    ),
    (
      v_user_id,
      'referral_code',
      v_code,
      v_email_verified,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    )
  on conflict (alias_type, normalized_value) do update
  set
    verified = accounts.login_aliases.verified or excluded.verified,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now()
  where accounts.login_aliases.user_id = excluded.user_id;

  insert into accounts.credential_migrations (
    user_id,
    legacy_sanity_id,
    legacy_source,
    credential_kind,
    status,
    source_revision,
    source_hash,
    backend_owner,
    imported_at,
    upgraded_at,
    updated_at
  )
  values (
    v_user_id,
    v_legacy_id,
    'none',
    'bcrypt',
    'upgraded',
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now(),
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.credential_migrations.legacy_sanity_id),
    legacy_source = 'none',
    credential_kind = 'bcrypt',
    status = 'upgraded',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    imported_at = coalesce(accounts.credential_migrations.imported_at, now()),
    upgraded_at = coalesce(accounts.credential_migrations.upgraded_at, now()),
    failure_reason = null,
    updated_at = now();

  insert into accounts.creator_profiles (
    user_id,
    referral_code,
    paypal_email,
    contact_discord,
    active,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values (
    v_user_id,
    v_code,
    nullif(lower(btrim(p_account->>'paypal_email')), ''),
    nullif(p_account->>'contact_discord', ''),
    v_account_active,
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    referral_code = excluded.referral_code,
    paypal_email = excluded.paypal_email,
    contact_discord = excluded.contact_discord,
    active = excluded.active and not exists (
      select 1
      from public.profiles profile
      where profile.user_id = excluded.user_id
        and profile.status in ('disabled', 'deleted')
    ),
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.creator_profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now();

  insert into accounts.identity_links (
    user_id,
    provider,
    provider_subject,
    provider_email,
    email_verified,
    linked_at,
    last_seen_at,
    metadata,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  values (
    v_user_id,
    'email',
    'email:' || v_user_id::text,
    v_email,
    v_email_verified,
    now(),
    now(),
    jsonb_build_object('native', true),
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase'
  )
  on conflict (provider, provider_subject) do update
  set
    provider_email = excluded.provider_email,
    email_verified = accounts.identity_links.email_verified
      or excluded.email_verified,
    last_seen_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  return jsonb_build_object('user_id', v_user_id, 'upserted', true);
end;
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
  v_aliases integer := 0;
  v_identities integer := 0;
begin
  update public.profiles profile
  set
    status = case
      when coalesce(source.payload->>'registrationStatus', 'active') = 'pending_email'
        then 'pending'
      else 'active'
    end,
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    source_backend = source.backend_owner,
    updated_at = now()
  from migration.source_documents source
  where profile.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and not source.tombstoned
    and profile.status not in ('disabled', 'deleted')
    and (
      coalesce(source.payload->>'registrationStatus', 'active') = 'pending_email'
      or (
        profile.status = 'pending'
        and lower(coalesce(source.payload->>'active', 'true')) <> 'false'
      )
    )
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_profiles = row_count;

  update accounts.creator_profiles creator set
    referral_code = coalesce(
      nullif(lower(btrim(source.payload#>>'{slug,current}')), ''), creator.referral_code
    ),
    paypal_email = nullif(lower(btrim(source.payload->>'paypalEmail')), ''),
    contact_discord = nullif(source.payload->>'contactDiscord', ''),
    commission_basis_points = case
      when btrim(coalesce(source.payload->>'currentCommissionPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0,
        round((source.payload->>'currentCommissionPercent')::numeric * 100)::integer
      ))
      else creator.commission_basis_points
    end,
    discount_basis_points = case
      when btrim(coalesce(source.payload->>'currentDiscountPercent', ''))
        ~ '^[0-9]+([.][0-9]+)?$'
      then least(10000, greatest(0,
        round((source.payload->>'currentDiscountPercent')::numeric * 100)::integer
      ))
      else creator.discount_basis_points
    end,
    total_basis_points = greatest(
      case
        when btrim(coalesce(source.payload->>'maxCommissionPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'maxCommissionPercent')::numeric * 100)::integer
        ))
        else creator.total_basis_points
      end,
      case
        when btrim(coalesce(source.payload->>'currentCommissionPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'currentCommissionPercent')::numeric * 100)::integer
        ))
        else creator.commission_basis_points
      end +
      case
        when btrim(coalesce(source.payload->>'currentDiscountPercent', ''))
          ~ '^[0-9]+([.][0-9]+)?$'
        then least(10000, greatest(0,
          round((source.payload->>'currentDiscountPercent')::numeric * 100)::integer
        ))
        else creator.discount_basis_points
      end
    ),
    bypass_referral_requirement = case
      when lower(btrim(coalesce(source.payload->>'bypassUnlock', '')))
        in ('true', 'false')
      then lower(btrim(source.payload->>'bypassUnlock')) = 'true'
      else creator.bypass_referral_requirement
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
    accounting_totals = coalesce(creator.accounting_totals, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'earned_total', source.payload->'earnedTotal',
        'owed_total', source.payload->'owedTotal',
        'paid_total', source.payload->'paidTotal',
        'earned_vertex', source.payload->'earnedVertex',
        'earned_xoc', source.payload->'earnedXoc',
        'owed_vertex', source.payload->'owedVertex',
        'owed_xoc', source.payload->'owedXoc',
        'paid_vertex', source.payload->'paidVertex',
        'paid_xoc', source.payload->'paidXoc'
      )),
    active = not source.tombstoned
      and coalesce(source.payload->>'registrationStatus', 'active') <> 'pending_email'
      and lower(coalesce(source.payload->>'active', 'true')) <> 'false'
      and coalesce((
        select profile.status = 'active'
        from public.profiles profile
        where profile.user_id = creator.user_id
      ), true),
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = source.backend_owner,
    updated_at = now()
  from migration.source_documents source
  where creator.legacy_sanity_id = source.legacy_sanity_id
    and source.document_type = 'referral'
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_creators = row_count;

  update accounts.login_aliases alias set
    verified = true,
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = source.backend_owner,
    updated_at = now()
  from accounts.creator_profiles creator,
       public.profiles profile,
       migration.source_documents source
  where alias.user_id = creator.user_id
    and profile.user_id = creator.user_id
    and source.legacy_sanity_id = creator.legacy_sanity_id
    and source.document_type = 'referral'
    and not source.tombstoned
    and profile.status = 'active'
    and creator.active
    and coalesce(source.payload->>'registrationStatus', 'active') <> 'pending_email'
    and nullif(btrim(source.payload->>'emailVerifiedAt'), '') is not null
    and (
      (
        alias.alias_type = 'email'
        and alias.normalized_value = lower(btrim(source.payload->>'creatorEmail'))
      )
      or (
        alias.alias_type = 'referral_code'
        and alias.normalized_value = lower(btrim(source.payload#>>'{slug,current}'))
      )
    )
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_aliases = row_count;

  update accounts.identity_links identity set
    email_verified = true,
    last_seen_at = now(),
    source_revision = source.source_revision,
    source_hash = source.source_hash,
    backend_owner = source.backend_owner
  from accounts.creator_profiles creator,
       public.profiles profile,
       migration.source_documents source
  where identity.user_id = creator.user_id
    and profile.user_id = creator.user_id
    and source.legacy_sanity_id = creator.legacy_sanity_id
    and source.document_type = 'referral'
    and not source.tombstoned
    and profile.status = 'active'
    and creator.active
    and identity.provider = 'email'
    and lower(btrim(coalesce(identity.provider_email, ''))) =
      lower(btrim(source.payload->>'creatorEmail'))
    and coalesce(source.payload->>'registrationStatus', 'active') <> 'pending_email'
    and nullif(btrim(source.payload->>'emailVerifiedAt'), '') is not null
    and (
      p_legacy_sanity_ids is null
      or source.legacy_sanity_id = any(p_legacy_sanity_ids)
    );
  get diagnostics v_identities = row_count;

  return jsonb_build_object(
    'profiles', v_profiles,
    'creator_profiles', v_creators,
    'login_aliases', v_aliases,
    'identity_links', v_identities
  );
end;
$$;

revoke all on function migration.roo_apply_commerce_document_mutations_unbounded(
  text, jsonb, integer
) from public, anon, authenticated, service_role;
revoke all on function public.roo_upsert_native_creator_account(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_project_referral_account_shadow(text[])
  from public, anon, authenticated;

grant execute on function public.roo_upsert_native_creator_account(jsonb)
  to service_role;
grant execute on function public.roo_project_referral_account_shadow(text[])
  to service_role;

notify pgrst, 'reload schema';
