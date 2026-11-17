set lock_timeout = '5s';
set statement_timeout = '120s';

revoke execute on function public.roo_upsert_asset(jsonb)
  from service_role;

create function migration.require_asset_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from cms.assets asset
    where asset.id = new.id
      and asset.migration_status = 'verified'
      and not exists (
        select 1
        from migration.source_documents document
        where document.legacy_sanity_id = asset.legacy_sanity_asset_id
          and document.document_type = case
            when asset.legacy_sanity_asset_id like 'image-%' then 'sanity.imageAsset'
            when asset.legacy_sanity_asset_id like 'file-%' then 'sanity.fileAsset'
          end
          and not document.tombstoned
      )
  ) then
    raise exception 'CMS_ASSET_RECORD_MISSING'
      using errcode = '23503';
  end if;
  return null;
end;
$$;

create constraint trigger assets_require_record
after insert or update on cms.assets
deferrable initially deferred
for each row
when (new.migration_status = 'verified')
execute function migration.require_asset_record();

revoke all on function migration.require_asset_record()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
