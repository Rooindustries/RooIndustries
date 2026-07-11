
create or replace function public.roo_replace_document_asset_links(p_links jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link jsonb;
  v_document_id uuid;
  v_asset_id uuid;
  v_inserted integer := 0;
begin
  if jsonb_typeof(p_links) <> 'array' then
    raise exception 'p_links must be a JSON array'
      using errcode = '22023';
  end if;

  delete from cms.document_assets where true;

  for v_link in select value from jsonb_array_elements(p_links)
  loop
    select id into v_document_id
    from cms.documents
    where legacy_sanity_id = v_link->>'document_legacy_id';

    select id into v_asset_id
    from cms.assets
    where legacy_sanity_asset_id = v_link->>'asset_legacy_id';

    if v_document_id is null or v_asset_id is null then
      raise exception 'asset link references a missing document or asset'
        using errcode = '23503';
    end if;

    insert into cms.document_assets (document_id, asset_id, field_path)
    values (v_document_id, v_asset_id, v_link->>'field_path')
    on conflict do nothing;

    if found then
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  return jsonb_build_object('linked', v_inserted);
end;
$$;

revoke all on function public.roo_replace_document_asset_links(jsonb)
  from public, anon, authenticated;
grant execute on function public.roo_replace_document_asset_links(jsonb)
  to service_role;
