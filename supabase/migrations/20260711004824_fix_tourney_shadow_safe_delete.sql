create or replace function public.roo_import_tourney_snapshot(
  p_snapshot jsonb,
  p_source_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_counts jsonb;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'tourney snapshot hash is invalid'
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'tourney snapshot must be an object'
      using errcode = '22023';
  end if;

  delete from tourney.tourney_bracket_team_members where id is not null;
  delete from tourney.tourney_bracket_teams where id is not null;
  delete from tourney.tourney_player_tokens where id is not null;
  delete from tourney.tourney_players where id is not null;
  delete from tourney.tourney_registration_config where id is not null;
  delete from tourney.tourney_bracket_meta where id is not null;
  delete from tourney.tourney_bracket_entities where entity_type is not null;
  delete from tourney.tourney_bracket_counters where entity_type is not null;
  delete from tourney.tourney_bracket_audit where id is not null;
  delete from tourney.tourney_bracket_lock where id is not null;
  delete from tourney.tourney_appeals where id is not null;
  delete from tourney.tourney_payouts where id is not null;

  insert into tourney.tourney_players
    select * from jsonb_populate_recordset(
      null::tourney.tourney_players,
      coalesce(p_snapshot->'tourney_players', '[]'::jsonb)
    );
  insert into tourney.tourney_player_tokens
    select * from jsonb_populate_recordset(
      null::tourney.tourney_player_tokens,
      coalesce(p_snapshot->'tourney_player_tokens', '[]'::jsonb)
    );
  insert into tourney.tourney_registration_config
    select * from jsonb_populate_recordset(
      null::tourney.tourney_registration_config,
      coalesce(p_snapshot->'tourney_registration_config', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_teams
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_teams,
      coalesce(p_snapshot->'tourney_bracket_teams', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_team_members
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_team_members,
      coalesce(p_snapshot->'tourney_bracket_team_members', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_meta
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_meta,
      coalesce(p_snapshot->'tourney_bracket_meta', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_entities
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_entities,
      coalesce(p_snapshot->'tourney_bracket_entities', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_counters
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_counters,
      coalesce(p_snapshot->'tourney_bracket_counters', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_audit
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_audit,
      coalesce(p_snapshot->'tourney_bracket_audit', '[]'::jsonb)
    );
  insert into tourney.tourney_bracket_lock
    select * from jsonb_populate_recordset(
      null::tourney.tourney_bracket_lock,
      coalesce(p_snapshot->'tourney_bracket_lock', '[]'::jsonb)
    );
  insert into tourney.tourney_appeals
    select * from jsonb_populate_recordset(
      null::tourney.tourney_appeals,
      coalesce(p_snapshot->'tourney_appeals', '[]'::jsonb)
    );
  insert into tourney.tourney_payouts
    select * from jsonb_populate_recordset(
      null::tourney.tourney_payouts,
      coalesce(p_snapshot->'tourney_payouts', '[]'::jsonb)
    );

  select jsonb_object_agg(table_name, count_value order by table_name)
  into v_counts
  from (
    values
      ('tourney_players', (select count(*) from tourney.tourney_players)),
      ('tourney_player_tokens', (select count(*) from tourney.tourney_player_tokens)),
      ('tourney_registration_config', (select count(*) from tourney.tourney_registration_config)),
      ('tourney_bracket_teams', (select count(*) from tourney.tourney_bracket_teams)),
      ('tourney_bracket_team_members', (select count(*) from tourney.tourney_bracket_team_members)),
      ('tourney_bracket_meta', (select count(*) from tourney.tourney_bracket_meta)),
      ('tourney_bracket_entities', (select count(*) from tourney.tourney_bracket_entities)),
      ('tourney_bracket_counters', (select count(*) from tourney.tourney_bracket_counters)),
      ('tourney_bracket_audit', (select count(*) from tourney.tourney_bracket_audit)),
      ('tourney_bracket_lock', (select count(*) from tourney.tourney_bracket_lock)),
      ('tourney_appeals', (select count(*) from tourney.tourney_appeals)),
      ('tourney_payouts', (select count(*) from tourney.tourney_payouts))
  ) counts(table_name, count_value);

  insert into migration.tourney_sync_runs (
    source_hash,
    source_counts,
    imported_counts,
    status
  )
  values (
    p_source_hash,
    coalesce(p_snapshot->'_counts', '{}'::jsonb),
    v_counts,
    'completed'
  );

  return jsonb_build_object(
    'source_hash', p_source_hash,
    'counts', v_counts
  );
end;
$$;

revoke all on function public.roo_import_tourney_snapshot(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.roo_import_tourney_snapshot(jsonb, text)
  to service_role;
