set lock_timeout = '5s';
set statement_timeout = '120s';
create or replace function public.roo_find_verified_cms_asset(p_kind text,p_sha1 text,p_sha256 text)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) from (select * from cms.assets where p_kind in ('image','file') and p_sha1 ~ '^[0-9a-f]{40}$' and p_sha256 ~ '^[0-9a-f]{64}$' and legacy_sanity_asset_id like p_kind||'-'||p_sha1||'-%' and sha256=p_sha256 and migration_status='verified' and verified_at is not null order by legacy_sanity_asset_id limit 20) a;
$$;
revoke all on function public.roo_find_verified_cms_asset(text,text,text) from public,anon,authenticated;
grant execute on function public.roo_find_verified_cms_asset(text,text,text) to service_role;
create table cms.uploads (
 upload_id uuid primary key,
 actor text not null check(actor ~ '^admin:[A-Za-z0-9._@/-]{1,120}$'),
 kind text not null check(kind in ('image','file')),
 file_name text not null check(char_length(file_name) between 1 and 240),
 declared_byte_size bigint not null check(declared_byte_size>0 and declared_byte_size<=67108864),
 declared_sha1 text not null check(declared_sha1 ~ '^[0-9a-f]{40}$'),
 declared_sha256 text not null check(declared_sha256 ~ '^[0-9a-f]{64}$'),
 declared_mime_type text not null,
 declared_width integer check(declared_width is null or declared_width>0),
 declared_height integer check(declared_height is null or declared_height>0),
 attempt_count integer not null default 0 check(attempt_count between 0 and 6),
 last_error_code text,
 staging_bucket text not null default 'cms-upload-staging' check(staging_bucket='cms-upload-staging'),
 staging_path text not null unique,
 expires_at timestamptz not null,
 status text not null default 'issued' check(status in ('issued','completed','refused')),
 asset_id text,
 result jsonb,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 staging_cleaned_at timestamptz,
 check((status='completed')=(asset_id is not null and result is not null and completed_at is not null)),
 check(kind<>'image' or declared_byte_size<=20971520)
);
alter table cms.uploads enable row level security;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('cms-upload-staging','cms-upload-staging',false,67108864,array['image/png','image/jpeg','image/webp','image/avif','image/gif','image/svg+xml','application/zip','application/x-zip-compressed','application/octet-stream','application/vnd.microsoft.portable-executable','application/x-msdownload']);
create or replace function migration.cms_upload_json(p_upload cms.uploads)
returns jsonb language sql immutable set search_path='' as $$
 select to_jsonb(p_upload)||jsonb_build_object('uploadId',p_upload.upload_id,'kind',p_upload.kind,'fileName',p_upload.file_name,'mimeType',p_upload.declared_mime_type,'byteSize',p_upload.declared_byte_size,'sha1',p_upload.declared_sha1,'sha256',p_upload.declared_sha256,'width',p_upload.declared_width,'height',p_upload.declared_height,'bucket',p_upload.staging_bucket,'path',p_upload.staging_path,'expiresAt',p_upload.expires_at,'status',p_upload.status);
$$;
create or replace function public.roo_create_cms_upload(p_upload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v cms.uploads%rowtype; v_id uuid:=(p_upload->>'uploadId')::uuid;v_actor text:=coalesce(p_upload->>'actor','admin:key');v_kind text:=p_upload->>'kind';v_mime text:=p_upload->>'mimeType';v_expiry timestamptz:=(p_upload->>'expiresAt')::timestamptz;
begin
 if p_upload is null or jsonb_typeof(p_upload)<>'object' or v_id is null or v_kind is null or p_upload->>'fileName' is null or p_upload->>'byteSize' is null or p_upload->>'sha1' is null or p_upload->>'sha256' is null or v_mime is null or v_expiry is null or v_expiry<=now() or v_expiry>now()+interval '24 hours' or not ((v_kind='image' and v_mime=any(array['image/png','image/jpeg','image/webp','image/avif','image/gif','image/svg+xml'])) or (v_kind='file' and v_mime=any(array['application/zip','application/x-zip-compressed','application/octet-stream','application/vnd.microsoft.portable-executable','application/x-msdownload']))) then raise exception 'CMS_UPLOAD_INVALID' using errcode='22023'; end if;
 if (p_upload ? 'bucket' and p_upload->>'bucket' is distinct from 'cms-upload-staging') or (p_upload ? 'path' and p_upload->>'path' is distinct from 'uploads/'||v_id::text) then raise exception 'CMS_UPLOAD_PATH_INVALID' using errcode='22023'; end if;
 insert into cms.uploads(upload_id,actor,kind,file_name,declared_byte_size,declared_sha1,declared_sha256,declared_mime_type,declared_width,declared_height,staging_path,expires_at) values(v_id,v_actor,v_kind,p_upload->>'fileName',(p_upload->>'byteSize')::bigint,p_upload->>'sha1',p_upload->>'sha256',v_mime,nullif(p_upload->>'width','')::integer,nullif(p_upload->>'height','')::integer,'uploads/'||v_id::text,v_expiry) on conflict(upload_id) do nothing;
 select * into v from cms.uploads where upload_id=v_id for update;
 if (v.actor,v.kind,v.file_name,v.declared_byte_size,v.declared_sha1,v.declared_sha256,v.declared_mime_type,v.declared_width,v.declared_height) is distinct from (v_actor,v_kind,p_upload->>'fileName',(p_upload->>'byteSize')::bigint,p_upload->>'sha1',p_upload->>'sha256',v_mime,nullif(p_upload->>'width','')::integer,nullif(p_upload->>'height','')::integer) then raise exception 'CMS_UPLOAD_IDENTITY_CONFLICT' using errcode='23505'; end if;
 return migration.cms_upload_json(v);
end;
$$;
create or replace function public.roo_get_cms_upload(p_upload_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$ select migration.cms_upload_json(u) from cms.uploads u where upload_id=p_upload_id; $$;
create or replace function public.roo_complete_cms_upload(p_upload_id uuid,p_result jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v cms.uploads%rowtype;a cms.assets%rowtype;v_asset_id text:=coalesce(p_result#>>'{asset,_ref}',p_result->>'assetId',p_result->>'asset_id');
begin
 select * into v from cms.uploads where upload_id=p_upload_id for update;
 if not found then raise exception 'CMS_UPLOAD_NOT_FOUND' using errcode='P0002'; end if;
 if v.status='completed' then
  if v.asset_id is distinct from v_asset_id or v.result is distinct from p_result then raise exception 'CMS_UPLOAD_IDENTITY_CONFLICT' using errcode='23505'; end if;
  return migration.cms_upload_json(v);
 end if;
 if v.status<>'issued' or v.expires_at<=now() or p_result is null then raise exception 'CMS_UPLOAD_NOT_READY' using errcode='55000'; end if;
 select * into a from cms.assets where legacy_sanity_asset_id=v_asset_id and migration_status='verified';
 if not found or a.verified_at is null or a.sha256 is distinct from v.declared_sha256 or a.byte_size is distinct from v.declared_byte_size or v_asset_id not like (case when v.kind='image' then 'image-' else 'file-' end)||v.declared_sha1||'-%' or (v.declared_width is not null and a.width is distinct from v.declared_width) or (v.declared_height is not null and a.height is distinct from v.declared_height) or not (a.mime_type=v.declared_mime_type or (v.declared_mime_type='application/x-zip-compressed' and a.mime_type='application/zip' and v_asset_id like 'file-%-zip') or (v_asset_id like 'file-%-exe' and a.mime_type='application/vnd.microsoft.portable-executable' and v.declared_mime_type in ('application/octet-stream','application/vnd.microsoft.portable-executable','application/x-msdownload'))) then raise exception 'CMS_UPLOAD_ASSET_MISMATCH' using errcode='23514'; end if;
 update cms.uploads set status='completed',asset_id=v_asset_id,result=p_result,completed_at=now() where upload_id=p_upload_id returning * into v;
 return migration.cms_upload_json(v);
end;
$$;
create or replace function public.roo_refuse_cms_upload(p_upload_id uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v cms.uploads%rowtype;
begin
 if coalesce(p_error_code,'') !~ '^[A-Z][A-Z0-9_]{1,127}$' then raise exception 'CMS_UPLOAD_ERROR_INVALID' using errcode='22023'; end if;
 select * into v from cms.uploads where upload_id=p_upload_id for update;
 if not found then raise exception 'CMS_UPLOAD_NOT_FOUND' using errcode='P0002'; end if;
 if v.status='issued' then update cms.uploads set status='refused',last_error_code=p_error_code where upload_id=p_upload_id returning * into v; end if;
 return migration.cms_upload_json(v);
end;
$$;
create or replace function public.roo_record_cms_upload_failure(p_upload_id uuid,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v cms.uploads%rowtype;
begin
 if coalesce(p_error_code,'') !~ '^[A-Z][A-Z0-9_]{1,127}$' then raise exception 'CMS_UPLOAD_ERROR_INVALID' using errcode='22023'; end if;
 select * into v from cms.uploads where upload_id=p_upload_id for update;
 if not found then raise exception 'CMS_UPLOAD_NOT_FOUND' using errcode='P0002'; end if;
 if v.status='issued' then update cms.uploads set attempt_count=least(attempt_count+1,6),last_error_code=p_error_code,status=case when attempt_count+1>=6 then 'refused' else 'issued' end where upload_id=p_upload_id returning * into v; end if;
 return migration.cms_upload_json(v);
end;
$$;
create or replace function public.roo_register_verified_cms_asset(p_asset jsonb,p_asset_document jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a cms.assets%rowtype; v_id text:=p_asset->>'legacy_sanity_asset_id';v_sha1 text:=p_asset_document->>'sha1hash';v_kind text; v_extension text:=p_asset_document->>'extension';v_result jsonb;
begin
 if p_asset is null or p_asset_document is null or jsonb_typeof(p_asset)<>'object' or jsonb_typeof(p_asset_document)<>'object' or v_id is null or v_sha1 is null or v_extension is null or v_sha1 !~ '^[0-9a-f]{40}$' or v_extension !~ '^(png|jpg|jpeg|gif|webp|avif|svg|zip|exe)$' or (p_asset->>'sha256') is null or p_asset->>'sha256' !~ '^[0-9a-f]{64}$' or p_asset->>'byte_size' is null or (p_asset->>'byte_size')::bigint<=0 or p_asset_document->>'_id' is distinct from v_id or (p_asset_document->>'size')::bigint is distinct from (p_asset->>'byte_size')::bigint or p_asset_document->>'mimeType' is distinct from p_asset->>'mime_type' then raise exception 'CMS_ASSET_INVALID' using errcode='22023'; end if;
 v_kind:=case when v_id like 'image-%' then 'image' when v_id like 'file-%' then 'file' else null end;
 if v_kind is null or p_asset_document->>'_type' is distinct from 'sanity.'||v_kind||'Asset' or p_asset->>'storage_bucket' is distinct from (case when v_kind='image' then 'site-content-public' else 'optimization-builds-private' end) or p_asset->>'storage_path' is distinct from (case when v_kind='image' then 'images/' else 'builds/' end)||v_sha1||'.'||v_extension then raise exception 'CMS_ASSET_IDENTITY_INVALID' using errcode='22023'; end if;
 if (v_kind='image' and (v_extension not in ('png','jpg','jpeg','gif','webp','avif','svg') or p_asset->>'mime_type' is distinct from (case v_extension when 'png' then 'image/png' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg' when 'gif' then 'image/gif' when 'webp' then 'image/webp' when 'avif' then 'image/avif' when 'svg' then 'image/svg+xml' end))) or (v_kind='file' and v_extension not in ('zip','exe')) then raise exception 'CMS_ASSET_TYPE_INVALID' using errcode='22023'; end if;
 if v_kind='image' then
  if (p_asset->>'byte_size')::bigint>20971520 or coalesce((p_asset->>'width')::integer,0)<=0 or coalesce((p_asset->>'height')::integer,0)<=0 or v_id is distinct from 'image-'||v_sha1||'-'||(p_asset->>'width')||'x'||(p_asset->>'height')||'-'||v_extension or p_asset_document#>>'{metadata,dimensions,width}' is distinct from p_asset->>'width' or p_asset_document#>>'{metadata,dimensions,height}' is distinct from p_asset->>'height' or coalesce(p_asset_document->>'url','') !~ '^https?://' or p_asset_document->>'url' is distinct from p_asset->>'source_url' then raise exception 'CMS_IMAGE_INVALID' using errcode='22023'; end if;
 else
  if (p_asset->>'byte_size')::bigint>67108864 or v_id is distinct from 'file-'||v_sha1||'-'||v_extension or (p_asset_document ? 'url' and p_asset_document->'url' <> 'null'::jsonb) or p_asset->>'mime_type' not in ('application/zip','application/x-zip-compressed','application/octet-stream','application/vnd.microsoft.portable-executable','application/x-msdownload') then raise exception 'CMS_FILE_INVALID' using errcode='22023'; end if;
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity',0));
 select * into a from cms.assets where legacy_sanity_asset_id=v_id for update;
 if found then
  if (a.storage_bucket,a.storage_path,a.sha256,a.byte_size,a.mime_type,a.width,a.height) is distinct from (p_asset->>'storage_bucket',p_asset->>'storage_path',p_asset->>'sha256',(p_asset->>'byte_size')::bigint,p_asset->>'mime_type',nullif(p_asset->>'width','')::integer,nullif(p_asset->>'height','')::integer) then raise exception 'CMS_ASSET_COLLISION' using errcode='23505'; end if;
  if not exists(select 1 from migration.source_documents where legacy_sanity_id=v_id) then
    perform public.roo_apply_document_mutations(jsonb_build_array(jsonb_build_object('operation','create','document',p_asset_document)));
  elsif not exists(select 1 from migration.source_documents where legacy_sanity_id=v_id and not tombstoned and document_type=p_asset_document->>'_type' and payload->>'sha1hash'=v_sha1 and payload->>'size'=p_asset_document->>'size' and payload->>'mimeType'=p_asset_document->>'mimeType' and payload->>'extension'=v_extension and (v_kind<>'image' or payload#>>'{metadata,dimensions,width}'=p_asset_document#>>'{metadata,dimensions,width}' and payload#>>'{metadata,dimensions,height}'=p_asset_document#>>'{metadata,dimensions,height}')) then
    raise exception 'CMS_ASSET_SOURCE_COLLISION' using errcode='23505';
  end if;
  if a.migration_status<>'verified' or a.verified_at is null then update cms.assets set migration_status='verified',verified_at=now() where id=a.id; end if;
  return jsonb_build_object('asset_id',a.id,'legacy_sanity_asset_id',v_id,'storage_bucket',a.storage_bucket,'verified',true,'replayed',true);
 end if;
 v_result:=public.roo_upsert_asset(p_asset);
 if not exists(select 1 from migration.source_documents where legacy_sanity_id=v_id) then
  perform public.roo_apply_document_mutations(jsonb_build_array(jsonb_build_object('operation','create','document',p_asset_document)));
 elsif not exists(select 1 from migration.source_documents where legacy_sanity_id=v_id and not tombstoned and document_type=p_asset_document->>'_type' and payload->>'sha1hash'=v_sha1 and payload->>'size'=p_asset_document->>'size' and payload->>'mimeType'=p_asset_document->>'mimeType' and payload->>'extension'=v_extension and (v_kind<>'image' or (payload#>>'{metadata,dimensions,width}'=p_asset_document#>>'{metadata,dimensions,width}' and payload#>>'{metadata,dimensions,height}'=p_asset_document#>>'{metadata,dimensions,height}'))) then
  raise exception 'CMS_ASSET_SOURCE_COLLISION' using errcode='23505';
 end if;
 return v_result||jsonb_build_object('replayed',false);
end;
$$;
revoke all on cms.uploads from public,anon,authenticated,service_role;
revoke all on function public.roo_create_cms_upload(jsonb),public.roo_get_cms_upload(uuid),public.roo_complete_cms_upload(uuid,jsonb),public.roo_register_verified_cms_asset(jsonb,jsonb),public.roo_refuse_cms_upload(uuid,text),public.roo_record_cms_upload_failure(uuid,text) from public,anon,authenticated;
grant execute on function public.roo_create_cms_upload(jsonb),public.roo_get_cms_upload(uuid),public.roo_complete_cms_upload(uuid,jsonb),public.roo_register_verified_cms_asset(jsonb,jsonb),public.roo_refuse_cms_upload(uuid,text),public.roo_record_cms_upload_failure(uuid,text) to service_role;

revoke all on function migration.cms_upload_json(cms.uploads) from public,anon,authenticated,service_role;
create or replace function public.roo_expired_cms_uploads(p_limit integer default 20)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(migration.cms_upload_json(u) order by expires_at,upload_id),'[]'::jsonb) from (
 select * from cms.uploads where staging_cleaned_at is null and expires_at<now()-interval '1 day' and staging_bucket='cms-upload-staging' and staging_path='uploads/'||upload_id::text order by expires_at,upload_id limit greatest(1,least(coalesce(p_limit,20),20))
 ) u;
$$;
revoke all on function public.roo_expired_cms_uploads(integer) from public,anon,authenticated;
grant execute on function public.roo_expired_cms_uploads(integer) to service_role;
create or replace function public.roo_mark_cms_upload_staging_cleaned(p_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v cms.uploads%rowtype;
begin
 update cms.uploads set staging_cleaned_at=coalesce(staging_cleaned_at,now()) where upload_id=p_upload_id and expires_at<now()-interval '1 day' and staging_bucket='cms-upload-staging' and staging_path='uploads/'||upload_id::text returning * into v;
 if not found then raise exception 'CMS_UPLOAD_CLEANUP_NOT_ELIGIBLE' using errcode='55000'; end if;
 return migration.cms_upload_json(v);
end;
$$;
revoke all on function public.roo_mark_cms_upload_staging_cleaned(uuid) from public,anon,authenticated;
grant execute on function public.roo_mark_cms_upload_staging_cleaned(uuid) to service_role;
