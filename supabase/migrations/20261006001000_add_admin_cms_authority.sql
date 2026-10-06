set lock_timeout = '5s';
set statement_timeout = '120s';
alter table migration.cms_publish_commands drop constraint cms_publish_commands_actor_check;
alter table migration.cms_publish_commands add constraint cms_publish_commands_actor_check check(actor ~ '^(sanity|admin):[A-Za-z0-9._@/-]{1,120}$');
create table cms.document_revisions (
 id uuid primary key default gen_random_uuid(), document_id text not null, document_type text not null, revision text, document jsonb not null, actor text not null, command_id text not null, operation text not null check(operation in ('replace','delete')),created_at timestamptz not null default now(),unique(command_id,document_id)
);
alter table cms.document_revisions enable row level security;
create index cms_document_revisions_document_created on cms.document_revisions(document_id,created_at desc);
create or replace function migration.cms_nested_refs(p_document jsonb)
returns table(ref text,field_path text)
language sql immutable set search_path='' as $$
 with recursive nodes(value,path) as (
 select p_document,''::text
 union all
 select child.value,case when nodes.path='' then child.key else nodes.path||'.'||child.key end
 from nodes cross join lateral (
 select key,value from jsonb_each(case when jsonb_typeof(nodes.value)='object' then nodes.value else '{}'::jsonb end)
 union all select (ordinality-1)::text,value from jsonb_array_elements(case when jsonb_typeof(nodes.value)='array' then nodes.value else '[]'::jsonb end) with ordinality
 ) child
 ) select value->>'_ref',path from nodes where jsonb_typeof(value)='object' and value ? '_ref';
$$;
create or replace function migration.cms_package_namespace(p_title text)
returns text language sql immutable set search_path='' as $$
 with whitespace as (select U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' chars), normalized as (select lower(btrim(regexp_replace(btrim(coalesce(p_title,''),chars),'[(]upgrade[)]$','','i'),chars) collate pg_catalog."und-x-icu") title,chars from whitespace)
 select case when title ~ ('^(performance vertex max|xoc(['||chars||']*/['||chars||']*extreme overclocking)?)$') then 'performance vertex max' else title end from normalized;
$$;
create or replace function migration.cms_usable_price(p_price text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v text:=btrim(regexp_replace(p_price,'[,$€£₹]','','g'),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'); n double precision;
begin
 if v is null or v !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then return false; end if;
 n:=v::double precision;
 return n>=0.005 and n<='1.7976931348623157e308'::double precision;
exception when numeric_value_out_of_range or invalid_text_representation then return false;
end;
$$;
create or replace function public.roo_cms_document_revisions(p_document_id text,p_limit integer default 50)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('revisionId',id,'createdAt',created_at,'actor',actor,'operation',operation) order by created_at desc,id),'[]'::jsonb) from (select * from cms.document_revisions where document_id=p_document_id order by created_at desc,id limit greatest(1,least(coalesce(p_limit,50),100))) r;
$$;
create or replace function public.roo_cms_document_revision(p_revision_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$ select document from cms.document_revisions where id=p_revision_id; $$;

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
     or coalesce(p_actor, '') !~ '^(sanity|admin):[A-Za-z0-9._@/-]{1,120}$' then
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

  v_singleton:=v_type=any(array['about','bookingSettings','contact','discordBanner','faqSettings','footer','hero','howItWorks','meetTheTeam','packagesSettings','privacyPolicy','proReviewsCarousel','referralBox','services','siteSettings','supportedGames','terms']);
  if v_type='bookingSettings' and v_id<>'6d8a3646-0ed2-44b5-ad45-c5c9d578126a' then raise exception 'CMS_SINGLETON_IDENTITY' using errcode='23514'; end if;
  if v_operation='create' and v_singleton and exists(select 1 from migration.source_documents where document_type=v_type and not tombstoned and legacy_sanity_id<>v_id) then raise exception 'CMS_SINGLETON_EXISTS' using errcode='23505'; end if;
  if p_actor like 'admin:%' then
    if v_operation='create' and exists(select 1 from migration.cms_publish_commands where command_id<>p_command_id and actor like 'admin:%' and operation='create' and status='committed' and result->'document_ids' ? v_id) then raise exception 'CMS_CREATE_INTENT_CONFLICT' using errcode='23505'; end if;
    if v_operation='delete' and v_singleton then raise exception 'CMS_SINGLETON_REQUIRED' using errcode='23514'; end if;
    if jsonb_array_length(p_assets)>0 then raise exception 'CMS assets must be registered through verification' using errcode='22023'; end if;
  end if;
  if v_operation='delete' then
    if exists(select 1 from migration.source_documents source cross join lateral migration.cms_nested_refs(source.payload) refs where not source.tombstoned and source.legacy_sanity_id<>v_id and refs.ref=v_id) then
      raise exception 'CMS_REFERENCED' using errcode='23503',detail=(select jsonb_build_object('referencedBy',jsonb_agg(jsonb_build_object('_id',legacy_sanity_id,'_type',document_type,'title',payload->>'title')))::text from migration.source_documents source where not tombstoned and legacy_sanity_id<>v_id and exists(select 1 from migration.cms_nested_refs(source.payload) refs where refs.ref=v_id));
    end if;
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
revoke all on cms.document_revisions from public,anon,authenticated,service_role;
revoke all on function migration.cms_nested_refs(jsonb),migration.cms_usable_price(text),migration.cms_package_namespace(text),public.roo_cms_document_revisions(text,integer),public.roo_cms_document_revision(uuid) from public,anon,authenticated;
grant execute on function public.roo_cms_document_revisions(text,integer),public.roo_cms_document_revision(uuid) to service_role;
