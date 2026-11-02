set lock_timeout = '5s';
set statement_timeout = '120s';

create table cms.public_content_generation (
  singleton boolean primary key default true check (singleton),
  generation bigint not null check (generation > 0)
);
insert into cms.public_content_generation values (true, 1);
revoke all on cms.public_content_generation from public, anon, authenticated;
alter table cms.public_content_generation enable row level security;

create table cms.public_content_publications (
  generation bigint primary key check (generation > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  object_path text not null unique,
  bound_at timestamptz not null default clock_timestamp()
);
revoke all on cms.public_content_publications from public, anon, authenticated;
alter table cms.public_content_publications enable row level security;

create function public.roo_bind_public_content_publication(p_generation text,p_sha256 text,p_object_path text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_generation bigint; v_existing cms.public_content_publications%rowtype;
begin
  if coalesce(p_generation,'') !~ '^[1-9][0-9]{0,18}$' or coalesce(p_sha256,'') !~ '^[a-f0-9]{64}$' or
     p_object_path is distinct from 'snapshots/' || lpad(p_generation,20,'0') || '-' || p_sha256 || '.json' then
    raise exception 'Invalid public content publication identity' using errcode = '22023';
  end if;
  select generation into strict v_generation from cms.public_content_generation where singleton for update;
  if p_generation::bigint > v_generation then
    raise exception 'Public content publication is ahead of its source' using errcode = '40001';
  end if;
  insert into cms.public_content_publications(generation,sha256,object_path)
  values(p_generation::bigint,p_sha256,p_object_path) on conflict(generation) do nothing;
  select * into strict v_existing from cms.public_content_publications where generation = p_generation::bigint;
  if v_existing.sha256 <> p_sha256 or v_existing.object_path <> p_object_path then
    raise exception 'Public content publication identity conflicts' using errcode = '40001';
  end if;
  select * into strict v_existing from cms.public_content_publications order by generation desc limit 1;
  return jsonb_build_object('generation',v_existing.generation::text,'sha256',v_existing.sha256,'path',v_existing.object_path);
end;
$$;
revoke all on function public.roo_bind_public_content_publication(text,text,text) from public,anon,authenticated;
grant execute on function public.roo_bind_public_content_publication(text,text,text) to service_role;

create function migration.advance_public_content_generation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old_type text;
  v_new_type text;
  v_types constant text[] := array[
    'proReviewsCarousel','about','services','package','packagesSettings','howItWorks',
    'supportedGames','faqSettings','faqSection','hero','meetTheTeam','contact','tool',
    'benchmark','discordBanner','terms','privacyPolicy','review','referralBox',
    'sanity.imageAsset','sanity.fileAsset'
  ];
begin
  if tg_table_name <> 'assets' then
    if tg_op <> 'INSERT' then v_old_type := old.document_type; end if;
    if tg_op <> 'DELETE' then v_new_type := new.document_type; end if;
    if not coalesce(v_old_type = any(v_types),false) and not coalesce(v_new_type = any(v_types),false) then
      return null;
    end if;
  end if;
  update cms.public_content_generation set generation = generation + 1 where singleton;
  return null;
end;
$$;
revoke all on function migration.advance_public_content_generation() from public,anon,authenticated;
create trigger public_content_generation after insert or update or delete on migration.source_documents
for each row execute function migration.advance_public_content_generation();
create trigger public_content_asset_generation after insert or update or delete on cms.assets
for each row execute function migration.advance_public_content_generation();

create function public.roo_fetch_public_documents_targeted(
  p_document_types text[], p_ids text[] default null,
  p_filters jsonb default '[]'::jsonb, p_limit integer default 500
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_generation bigint;
begin
  if p_document_types is null or cardinality(p_document_types) = 0 or not p_document_types <@ array[
    'proReviewsCarousel','about','services','package','packagesSettings','howItWorks',
    'supportedGames','faqSettings','faqSection','hero','meetTheTeam','contact','tool',
    'benchmark','discordBanner','terms','privacyPolicy','review','referralBox',
    'sanity.imageAsset','sanity.fileAsset'
  ]::text[] then
    raise exception 'Public content scope is required' using errcode = '22023';
  end if;
  select generation into strict v_generation from cms.public_content_generation where singleton for share;
  return jsonb_build_object('generation',v_generation::text,
    'publicationGeneration',(select max(generation)::text from cms.public_content_publications),
    'documents',
    public.roo_fetch_shadow_documents_targeted(p_document_types,p_ids,p_filters,p_limit));
end;
$$;
revoke all on function public.roo_fetch_public_documents_targeted(text[],text[],jsonb,integer) from public,anon,authenticated;
grant execute on function public.roo_fetch_public_documents_targeted(text[],text[],jsonb,integer) to service_role;

create function public.roo_capture_public_content_publication()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_generation bigint; v_documents jsonb; v_assets jsonb;
begin
  select generation into strict v_generation from cms.public_content_generation where singleton for share;
  select coalesce(jsonb_agg(payload order by legacy_sanity_id),'[]'::jsonb) into v_documents
  from migration.source_documents where not tombstoned and document_type = any(array[
    'proReviewsCarousel','about','services','package','packagesSettings','howItWorks',
    'supportedGames','faqSettings','faqSection','hero','meetTheTeam','contact','tool',
    'benchmark','discordBanner','terms','privacyPolicy','review','referralBox',
    'sanity.imageAsset','sanity.fileAsset'
  ]);
  select coalesce(jsonb_agg(to_jsonb(asset) order by legacy_sanity_asset_id),'[]'::jsonb) into v_assets
  from cms.assets asset where migration_status = 'verified';
  if jsonb_array_length(v_documents) > 10000 or octet_length(v_documents::text) + octet_length(v_assets::text) > 8388608 then
    raise exception 'Public content publication exceeds its size limit' using errcode = '54000';
  end if;
  return jsonb_build_object('generation',v_generation::text,'documents',v_documents,'assets',v_assets);
end;
$$;
revoke all on function public.roo_capture_public_content_publication() from public,anon,authenticated;
grant execute on function public.roo_capture_public_content_publication() to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('public-content-state','public-content-state',false,8388608,array['application/json']);
