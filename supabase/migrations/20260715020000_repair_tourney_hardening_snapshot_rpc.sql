set lock_timeout = '5s';
set statement_timeout = '120s';

drop function if exists public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb);

create or replace function public.roo_capture_tourney_hardening_snapshot(
  p_legacy_snapshot jsonb default null,
  p_sanity_account jsonb default null,
  p_legacy_snapshot_text text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract record;
  v_rows jsonb;
  v_payload jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_key text := encode(extensions.gen_random_bytes(32), 'hex');
  v_key_id uuid;
  v_snapshot_id uuid;
  v_hash text;
  v_relation text;
  v_roundtrip text;
  v_vault_key text;
  v_meta record;
  v_schema_version integer;
begin
  if nullif(p_legacy_snapshot_text,'') is null then
    raise exception 'Exact legacy Tourney snapshot text is required'
      using errcode='22023';
  end if;
  begin
    p_legacy_snapshot := p_legacy_snapshot_text::jsonb;
  exception when others then
    raise exception 'Exact legacy Tourney snapshot text is malformed'
      using errcode='22023';
  end;
  select metadata.id,metadata.primary_backend,metadata.generation,metadata.writes_paused,
    metadata.fallback_read_only
  into v_meta
  from tourney.cutover_metadata metadata
  where metadata.id='tourney'
  for share;
  select metadata.schema_version into v_schema_version
  from tourney.schema_metadata metadata
  where metadata.schema_name='tourney';
  if v_meta.id is null or v_meta.primary_backend <> 'supabase'
     or v_meta.generation <> 1 or not v_meta.writes_paused
     or v_meta.fallback_read_only or coalesce(v_schema_version,0) < 4 then
    raise exception 'Tourney snapshot controls are not in the paused schema-v4 pre-cutover state'
      using errcode='55000';
  end if;
  if coalesce(jsonb_typeof(p_legacy_snapshot),'') <> 'object' then
    raise exception 'Legacy Tourney snapshot is incomplete or malformed'
      using errcode='22023';
  end if;
  if not (p_legacy_snapshot ?& array[
       'tourney_players','tourney_player_tokens','tourney_registration_config',
       'tourney_bracket_teams','tourney_bracket_team_members','tourney_bracket_meta',
       'tourney_bracket_entities','tourney_bracket_counters','tourney_bracket_audit',
       'tourney_bracket_lock','tourney_appeals','tourney_payouts',
       'tourney_email_dispatches','tourney_command_receipts','tourney_mirror_outbox',
       'tourney_mirror_checkpoints','tourney_mirror_tombstones',
       'tourney_account_snapshots','tourney_external_operations',
       'tourney_discord_role_assignments','tourney_identity_conflicts',
       'tourney_parity_runs','tourney_cutover_metadata','tourney_schema_metadata',
       'tourney_mirror_contracts','tourney_cutover_gate_events',
       'tourney_import_quarantine','tourney_shadow_observations',
       'tourney_shadow_latency_baselines'
     ]) or exists(
       select 1 from jsonb_each(p_legacy_snapshot) entry
       where jsonb_typeof(entry.value) <> 'array'
     ) then
    raise exception 'Legacy Tourney snapshot is incomplete or malformed'
      using errcode='22023';
  end if;
  if coalesce(jsonb_typeof(p_sanity_account),'') <> 'object'
     or p_sanity_account->>'_id' is distinct from 'tourneyAuthStore' then
    raise exception 'Sanity Tourney account snapshot is missing or malformed'
      using errcode='22023';
  end if;
  if not exists(
    select 1
    from jsonb_array_elements(p_legacy_snapshot->'tourney_cutover_metadata') row_data
    where row_data->>'id'='tourney'
      and row_data->>'primary_backend'='supabase'
      and (row_data->>'generation')::bigint=1
      and (row_data->>'writes_paused')::boolean
      and not (row_data->>'fallback_read_only')::boolean
  ) then
    raise exception 'Legacy Tourney snapshot controls do not match the paused cutover'
      using errcode='55000';
  end if;
  for v_contract in
    select logical_table, supabase_relation
    from tourney.mirror_contracts where enabled order by logical_table
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(source_row) order by to_jsonb(source_row)::text), ''[]''::jsonb) from %s source_row',
      v_contract.supabase_relation::regclass
    ) into v_rows;
    v_payload := v_payload || jsonb_build_object(v_contract.logical_table, v_rows);
    v_counts := v_counts || jsonb_build_object(v_contract.logical_table, jsonb_array_length(v_rows));
  end loop;
  select coalesce(jsonb_agg(to_jsonb(account) order by account.principal_id), '[]'::jsonb)
  into v_rows from accounts.tourney_accounts account;
  v_payload := v_payload || jsonb_build_object('accounts.tourney_accounts', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.tourney_accounts', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(principal) order by principal.id), '[]'::jsonb)
  into v_rows from accounts.principals principal
  where principal.id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.principals', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.principals', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(alias) order by alias.id), '[]'::jsonb)
  into v_rows from accounts.login_aliases alias
  where alias.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.login_aliases', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.login_aliases', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(identity) order by identity.id), '[]'::jsonb)
  into v_rows from accounts.identity_links identity
  where identity.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.identity_links', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.identity_links', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(mapping) order by mapping.user_id), '[]'::jsonb)
  into v_rows from accounts.principal_auth_users mapping
  where mapping.principal_id in (select principal_id from accounts.tourney_accounts);
  v_payload := v_payload || jsonb_build_object('accounts.principal_auth_users', v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.principal_auth_users', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(auth_user) order by auth_user.id), '[]'::jsonb)
  into v_rows from auth.users auth_user
  where auth_user.id in (
    select user_id from accounts.principal_auth_users
    where principal_id in (select principal_id from accounts.tourney_accounts)
  );
  v_payload := v_payload || jsonb_build_object('auth.users', v_rows);
  v_counts := v_counts || jsonb_build_object('auth.users', jsonb_array_length(v_rows));
  select coalesce(jsonb_agg(to_jsonb(identity) order by identity.id), '[]'::jsonb)
  into v_rows from auth.identities identity
  where identity.user_id in (
    select user_id from accounts.principal_auth_users
    where principal_id in (select principal_id from accounts.tourney_accounts)
  );
  v_payload := v_payload || jsonb_build_object('auth.identities', v_rows);
  v_counts := v_counts || jsonb_build_object('auth.identities', jsonb_array_length(v_rows));
  foreach v_relation in array array[
    'tourney.mirror_outbox','tourney.mirror_checkpoints',
    'tourney.mirror_tombstones','tourney.schema_metadata',
    'tourney.tourney_player_auth_operations','tourney.external_operation_secrets',
    'tourney.mirror_contracts','tourney.parity_runs','tourney.cutover_metadata',
    'tourney.identity_conflicts','tourney.shadow_observations',
    'tourney.shadow_latency_baselines','tourney.cutover_gate_events',
    'migration.tourney_sync_runs','migration.tourney_import_quarantine',
    'migration.tourney_import_preflights'
  ] loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(snapshot_row) order by to_jsonb(snapshot_row)::text), ''[]''::jsonb) from %s snapshot_row',
      v_relation::regclass
    ) into v_rows;
    v_payload := v_payload || jsonb_build_object(v_relation,v_rows);
    v_counts := v_counts || jsonb_build_object(v_relation,jsonb_array_length(v_rows));
  end loop;
  select coalesce(jsonb_agg(to_jsonb(intent) order by intent.id),'[]'::jsonb)
  into v_rows
  from accounts.oauth_intents intent
  where intent.flow='tourney'
    or intent.principal_id in (select principal_id from accounts.tourney_accounts)
    or intent.target_user_id in (
      select user_id from accounts.principal_auth_users mapping
      where mapping.principal_id in (select principal_id from accounts.tourney_accounts)
    )
    or intent.claimed_user_id in (
      select user_id from accounts.principal_auth_users mapping
      where mapping.principal_id in (select principal_id from accounts.tourney_accounts)
    );
  v_payload := v_payload || jsonb_build_object('accounts.oauth_intents',v_rows);
  v_counts := v_counts || jsonb_build_object('accounts.oauth_intents',jsonb_array_length(v_rows));
  v_payload := v_payload || jsonb_build_object(
    'legacy',p_legacy_snapshot,'sanity_account',p_sanity_account
  );
  select vault.create_secret(
    v_key,
    'tourney-hardening-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
    'AES key for the Roo Industries Tourney hardening snapshot'
  ) into v_key_id;
  v_hash := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');
  insert into migration.tourney_pre_cutover_snapshots(
    key_secret_id,payload_sha256,ciphertext,table_counts
  ) values(
    v_key_id,v_hash,
    extensions.pgp_sym_encrypt(v_payload::text,v_key,'cipher-algo=aes256,compress-algo=1'),
    v_counts
  ) returning id into v_snapshot_id;
  select secret.decrypted_secret into v_vault_key
  from vault.decrypted_secrets secret
  where secret.id=v_key_id;
  if v_vault_key is distinct from v_key then
    raise exception 'Tourney hosted snapshot Vault key retrieval failed'
      using errcode='XX001';
  end if;
  select extensions.pgp_sym_decrypt(snapshot.ciphertext,v_vault_key)
  into v_roundtrip
  from migration.tourney_pre_cutover_snapshots snapshot
  where snapshot.id=v_snapshot_id;
  if v_roundtrip is distinct from v_payload::text then
    raise exception 'Tourney hosted snapshot round-trip verification failed'
      using errcode='XX001';
  end if;
  return jsonb_build_object(
    'snapshot_id',v_snapshot_id,'payload_sha256',v_hash,
    'table_counts',v_counts,'captured_at',now(),
    'payload',v_payload,'payload_text',v_payload::text,
    'hosted_roundtrip_verified',true
  );
end;
$$;

revoke all on function tourney.guard_email_dispatch_terminal_state()
  from public, anon, authenticated;
revoke all on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  to service_role;
