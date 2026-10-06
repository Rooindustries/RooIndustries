set lock_timeout = '5s';
set statement_timeout = '120s';
do $$
begin
  if to_regprocedure('public.roo_apply_cms_publish_command(text,text,text,jsonb,jsonb,jsonb)') is null or to_regprocedure('public.roo_bootstrap_native_account(uuid)') is null or to_regclass('accounts.principal_auth_users') is null or to_regclass('accounts.account_roles') is null then raise exception 'Admin login and CMS guard prerequisites are missing'; end if;
end;
$$;
create or replace function public.roo_grant_account_role(p_user_id uuid,p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_principal_id uuid;
begin
  select principal_id into v_principal_id from accounts.principal_auth_users where user_id=p_user_id;
  if v_principal_id is null then raise exception 'Account principal is missing' using errcode='22023'; end if;
  insert into accounts.account_roles(user_id,principal_id,role,source_backend) values(p_user_id,v_principal_id,p_role,'supabase') on conflict do nothing;
  return public.roo_account_by_user_id(p_user_id);
end;
$$;
revoke all on function public.roo_grant_account_role(uuid,text) from public,anon,authenticated;
grant execute on function public.roo_grant_account_role(uuid,text) to service_role;
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
  v_current migration.source_documents%rowtype;
  v_current_exists boolean;
  v_ref record;
  v_field text;
  v_document jsonb;
  v_singleton boolean;
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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity',0));
  if coalesce(p_command_id, '') !~ '^cms:[0-9a-f]{64}$'
     or coalesce(p_request_hash, '') !~ '^[0-9a-f]{64}$'
     or right(p_command_id, 64) <> p_request_hash
     or coalesce(p_actor, '') !~ '^(sanity|admin):[A-Za-z0-9._@/-]{1,120}$'
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

  select * into v_current from migration.source_documents where legacy_sanity_id=v_id for update;
  v_current_exists:=found;
  if p_actor like 'admin:%' and v_operation in ('replace','delete') and
     (nullif(v_mutation->>'expected_revision','') is null or v_mutation->>'expected_revision' is distinct from v_current.source_revision) then
    raise exception 'CMS_REVISION_CONFLICT' using errcode='40001',detail=jsonb_build_object('currentRevision',v_current.source_revision)::text;
  end if;
  if p_actor like 'admin:%' and v_operation='create' then
    select * into v_existing from migration.cms_publish_commands where command_id<>p_command_id and actor like 'admin:%' and operation='create' and status='committed' and result->'document_ids' ? v_id order by committed_at limit 1;
    if found then raise exception 'CMS_CREATE_INTENT_CONFLICT' using errcode='23505',detail=jsonb_build_object('documentId',v_existing.result->'document_ids'->>0)::text; end if;
  end if;
  if v_operation='create' and v_current_exists then raise exception 'CMS document identity exists' using errcode='23505'; end if;
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

  if v_type is null or v_type not in (
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

  if v_operation='replace' and v_current_exists and v_current.document_type<>v_type then raise exception 'CMS_TYPE_MISMATCH' using errcode='22023'; end if;

  v_singleton:=v_type=any(array['about','bookingSettings','contact','discordBanner','faqSettings','footer','hero','howItWorks','meetTheTeam','packagesSettings','privacyPolicy','proReviewsCarousel','referralBox','services','siteSettings','supportedGames','terms']);
  if v_type='bookingSettings' and v_id<>'6d8a3646-0ed2-44b5-ad45-c5c9d578126a' then raise exception 'CMS_SINGLETON_IDENTITY' using errcode='23514'; end if;
  if v_operation='create' and v_singleton and exists(select 1 from migration.source_documents where document_type=v_type and not tombstoned and legacy_sanity_id<>v_id) then raise exception 'CMS_SINGLETON_EXISTS' using errcode='23505'; end if;
  if p_actor like 'admin:%' then
    if v_operation='delete' and v_singleton then raise exception 'CMS_SINGLETON_REQUIRED' using errcode='23514'; end if;
    if jsonb_array_length(p_assets)>0 then raise exception 'CMS assets must be registered through verification' using errcode='22023'; end if;
  end if;
  if v_operation='delete' then
    if v_type='coupon' and (coalesce(migration.try_numeric(v_current.payload->>'timesUsed'),0)>0 or coalesce(migration.try_numeric(v_current.payload->>'activeReservations'),0)>0 or coalesce(migration.try_numeric(v_current.payload->>'redemptionCount'),0)>0 or exists(select 1 from migration.source_documents source where not source.tombstoned and source.document_type='couponRedemption' and (source.payload#>>'{coupon,_ref}'=v_id or source.payload->>'couponId'=v_id))) then
      raise exception 'CMS_REFERENCED' using errcode='23503',detail=jsonb_build_object('reason','This coupon has redemption or reservation history. Keep it for accounting.')::text;
    end if;
    -- CMS document types from the publish allowlist above, including legacy references.
    select jsonb_build_object('referencedBy',jsonb_agg(jsonb_build_object('_id',legacy_sanity_id,'_type',document_type,'title',payload->>'title'))) into v_result
    from (select source.legacy_sanity_id,source.document_type,source.payload from migration.source_documents source where not source.tombstoned and source.legacy_sanity_id<>v_id and source.document_type in ('about','benchmark','bookingSettings','contact','coupon','discordBanner','faqSection','faqSettings','footer','hero','howItWorks','meetTheTeam','package','packagesSettings','privacyPolicy','proReviewsCarousel','referralBox','review','services','siteSettings','supportedGames','terms','tool','upgradeLink') and exists(select 1 from migration.cms_nested_refs(source.payload) refs where refs.ref=v_id) order by source.legacy_sanity_id limit 20) referenced;
    if v_result->'referencedBy'<>'null'::jsonb then raise exception 'CMS_REFERENCED' using errcode='23503',detail=v_result::text; end if;
  else
    v_document:=v_mutation->'document';
    if v_current_exists and v_current.payload ? '_createdAt' then v_document:=v_document||jsonb_build_object('_createdAt',v_current.payload->'_createdAt'); end if;
    if v_type='upgradeLink' then
      if coalesce(v_document#>>'{slug,current}','') !~ '^[A-Za-z0-9-]{1,80}$' then raise exception 'CMS_SLUG_INVALID' using errcode='22023'; end if;
      if exists(select 1 from migration.source_documents where document_type='upgradeLink' and not tombstoned and legacy_sanity_id<>v_id and lower(payload#>>'{slug,current}')=lower(v_document#>>'{slug,current}')) then raise exception 'CMS_SLUG_CONFLICT' using errcode='23505'; end if;
    end if;
    if v_type='coupon' then
      foreach v_field in array array['timesUsed','activeReservations','redemptionCount','autoDeactivatedByRedemptionId','autoDeactivatedAt'] loop
        v_document:=v_document-v_field;
        if v_operation='replace' and v_current.payload ? v_field then v_document:=v_document||jsonb_build_object(v_field,v_current.payload->v_field); end if;
      end loop;
      if v_operation='create' then v_document:=v_document||jsonb_build_object('timesUsed',0,'activeReservations',0,'redemptionCount',0); end if;
      if nullif(v_current.payload->>'autoDeactivatedByRedemptionId','') is not null then
        v_document:=v_document-'isActive';
        if v_current.payload ? 'isActive' then v_document:=v_document||jsonb_build_object('isActive',v_current.payload->'isActive'); end if;
      end if;
      if exists(select 1 from migration.source_documents where not tombstoned and legacy_sanity_id<>v_id and document_type in ('coupon','referral') and lower(btrim(coalesce(case when document_type='referral' then payload#>>'{slug,current}' end,payload->>'code',payload->>'referralCode','')))=lower(btrim(v_document->>'code'))) then raise exception 'CMS_CODE_CONFLICT' using errcode='23505'; end if;
    end if;
    if v_type='package' then
      if jsonb_typeof(v_document->'price') is distinct from 'string' or not migration.cms_usable_price(v_document->>'price') then raise exception 'CMS_PRICE_INVALID' using errcode='22023'; end if;
      if exists(select 1 from migration.source_documents where document_type='package' and not tombstoned and legacy_sanity_id<>v_id and migration.cms_package_namespace(payload->>'title')=migration.cms_package_namespace(v_document->>'title')) then raise exception 'CMS_PACKAGE_TITLE_CONFLICT' using errcode='23505'; end if;
    end if;
    v_mutation:=jsonb_set(v_mutation,'{document}',v_document);
    p_mutations:=jsonb_build_array(v_mutation);
    for v_ref in select * from migration.cms_nested_refs(v_document) where ref is null or ref !~ '^(image|file)-' loop
      if v_ref.ref is null or not exists(select 1 from migration.source_documents where legacy_sanity_id=v_ref.ref and not tombstoned and document_type='package') then raise exception 'CMS_REFERENCE_INVALID' using errcode='23503',detail=jsonb_build_object('path',v_ref.field_path,'reference',v_ref.ref)::text; end if;
    end loop;
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

  if v_operation<>'delete' then
    for v_ref in select * from migration.cms_nested_refs(v_document) where ref ~ '^(image|file)-' loop
      if not exists(select 1 from cms.assets where legacy_sanity_asset_id=v_ref.ref and migration_status='verified' and verified_at is not null and sha256 ~ '^[0-9a-f]{64}$' and ((v_ref.ref like 'image-%' and storage_bucket='site-content-public' and storage_path like 'images/%') or (v_ref.ref like 'file-%' and storage_bucket='optimization-builds-private' and storage_path like 'builds/%'))) then raise exception 'CMS_ASSET_UNVERIFIED' using errcode='23503',detail=jsonb_build_object('path',v_ref.field_path,'reference',v_ref.ref)::text; end if;
    end loop;
  end if;
  if v_operation in ('replace','delete') and v_current_exists and not v_current.tombstoned then
    insert into cms.document_revisions(document_id,document_type,revision,document,actor,command_id,operation) values(v_id,v_current.document_type,v_current.source_revision,v_current.payload,p_actor,p_command_id,v_operation);
  end if;
  if v_type in ('bookingSettings', 'coupon', 'package', 'upgradeLink') then
    v_results := migration.apply_cms_commerce_mutation(
      p_command_id || ':commerce',
      v_mutation
    )->'results';
  else
    v_results := public.roo_apply_document_mutations(p_mutations);
  end if;
  v_mutated_ids := array[v_id];
  if p_actor like 'admin:%' and v_operation='delete' then v_results:=jsonb_build_array(jsonb_build_object('_id',v_id,'_rev',v_current.source_revision,'deleted',true)); end if;

  if v_operation <> 'delete' then
    delete from cms.document_assets target
    using cms.documents document
    where target.document_id = document.id
      and document.legacy_sanity_id = v_id;

    for v_link in
      select jsonb_build_object('document_legacy_id',v_id,'asset_legacy_id',ref,'field_path',field_path) from migration.cms_nested_refs(v_document) where ref ~ '^(image|file)-'
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
revoke all on function public.roo_apply_cms_publish_command(text,text,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.roo_apply_cms_publish_command(text,text,text,jsonb,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
