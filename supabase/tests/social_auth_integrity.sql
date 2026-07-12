begin;

do $$
declare
  v_user_id constant uuid := '70000000-0000-4000-8000-000000000001';
  v_discord_identity_id constant uuid := '70000000-0000-4000-8000-000000000002';
  v_google_identity_id constant uuid := '70000000-0000-4000-8000-000000000003';
  v_secondary_user_id constant uuid := '70000000-0000-4000-8000-000000000004';
  v_intent jsonb;
  v_finalized jsonb;
  v_assignment jsonb;
  v_account jsonb;
  v_grant jsonb;
  v_merged jsonb;
begin
  if pg_catalog.has_function_privilege(
    'anon',
    'public.roo_create_oauth_intent(jsonb)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.roo_finalize_oauth_intent(text,uuid,text,text,text)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.roo_list_pending_discord_role_assignments(integer)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'anon',
    'public.roo_read_oauth_intent(uuid,text)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.roo_create_reauth_grant(uuid,text,text,text)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.roo_merge_account_principals(text,text)',
    'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated',
    'public.roo_complete_credential_operation(text)',
    'execute'
  ) then
    raise exception 'browser roles can execute privileged OAuth intent functions';
  end if;

  insert into auth.users (
    id,
    aud,
    role,
    email,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) values (
    v_user_id,
    'authenticated',
    'authenticated',
    'social-auth-fixture@example.invalid',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

  insert into auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    created_at,
    updated_at
  ) values (
    v_google_identity_id,
    v_user_id,
    'google-social-auth-fixture',
    jsonb_build_object(
      'sub', 'google-social-auth-fixture',
      'email', 'unverified-google@example.invalid',
      'email_verified', false
    ),
    'google',
    now(),
    now()
  );

  insert into auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    created_at,
    updated_at
  ) values (
    v_discord_identity_id,
    v_user_id,
    '700000000000000001',
    jsonb_build_object(
      'sub', '700000000000000001',
      'email', 'social-auth-fixture@example.invalid',
      'email_verified', true
    ),
    'discord',
    now(),
    now()
  );

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    source_backend
  ) values (
    v_user_id,
    'social-auth-fixture@example.invalid',
    'Social Auth Fixture',
    'active',
    'supabase'
  );

  insert into accounts.account_roles (user_id, role)
  values (v_user_id, 'tourney_player');

  insert into accounts.account_roles (user_id, role)
  values (v_user_id, 'creator');

  insert into accounts.creator_profiles (
    user_id,
    referral_code,
    active,
    legacy_sanity_id
  ) values (
    v_user_id,
    'social-auth-fixture',
    true,
    'creator.social-auth-fixture'
  );

  insert into accounts.tourney_accounts (
    user_id,
    username,
    role,
    active,
    lifecycle_status,
    legacy_sanity_id
  ) values (
    v_user_id,
    'social-auth-fixture',
    'tourney_player',
    true,
    'approved',
    'player.social-auth-fixture'
  );

  perform public.roo_reconcile_auth_identity_links(v_user_id);
  if not exists (
    select 1
    from accounts.identity_links link
    where link.user_id = v_user_id
      and link.provider = 'discord'
      and link.provider_subject = '700000000000000001'
      and link.email_verified
  ) then
    raise exception 'Discord Auth identity was not projected exactly';
  end if;
  if not exists (
    select 1
    from accounts.identity_links link
    where link.user_id = v_user_id
      and link.provider = 'google'
      and link.provider_subject = 'google-social-auth-fixture'
      and not link.email_verified
  ) then
    raise exception 'Google verification was incorrectly inherited from another provider';
  end if;

  v_account := public.roo_account_by_user_id(v_user_id);
  if nullif(v_account->>'principal_id', '') is null
     or v_account->>'creator_legacy_sanity_id' <> 'creator.social-auth-fixture'
     or v_account->>'tourney_legacy_player_id' <> 'player.social-auth-fixture'
     or v_account->>'creator_active' <> 'true'
     or v_account->>'tourney_status' <> 'approved' then
    raise exception 'one principal did not preserve independent creator and Tourney domains';
  end if;

  begin
    insert into accounts.identity_links (
      user_id,
      provider,
      provider_subject
    ) values (
      v_user_id,
      'discord',
      '700000000000000002'
    );
    raise exception 'a second Discord identity was accepted for one user';
  exception when unique_violation then null;
  end;

  v_intent := public.roo_create_oauth_intent(jsonb_build_object(
    'flow', 'tourney',
    'action', 'link',
    'provider', 'discord',
    'target_user_id', v_user_id,
    'domain_subject', 'social-auth-fixture',
    'return_path', '/tourney',
    'expires_at', now() + interval '10 minutes',
    'token_hash', repeat('c', 64)
  ));
  if nullif(v_intent->>'id', '') is null then
    raise exception 'OAuth intent id was not returned';
  end if;

  v_finalized := public.roo_finalize_oauth_intent(
    repeat('c', 64),
    v_user_id,
    'discord',
    '710000000000000001',
    null
  );
  if (v_finalized->>'completed')::boolean is not true then
    raise exception 'OAuth intent did not complete';
  end if;

  v_finalized := public.roo_finalize_oauth_intent(
    repeat('c', 64),
    v_user_id,
    'discord',
    '710000000000000001',
    null
  );
  if (v_finalized->>'completed')::boolean is not true then
    raise exception 'OAuth intent replay was not idempotent';
  end if;

  v_assignment := public.roo_refresh_discord_role_assignment(
    v_user_id,
    '710000000000000001'
  );
  if v_assignment->>'desired_role' <> 'participant' then
    raise exception 'approved player did not map to Participant';
  end if;

  update accounts.tourney_accounts
  set role = 'tourney_caster', active = true, lifecycle_status = 'approved'
  where user_id = v_user_id;
  v_assignment := public.roo_refresh_discord_role_assignment(
    v_user_id,
    '710000000000000001'
  );
  if v_assignment->>'desired_role' <> 'host' then
    raise exception 'caster did not map to Host';
  end if;

  update accounts.tourney_accounts
  set active = false, lifecycle_status = 'removed'
  where user_id = v_user_id;
  v_assignment := public.roo_refresh_discord_role_assignment(
    v_user_id,
    '710000000000000001'
  );
  if v_assignment->>'desired_role' <> 'none' then
    raise exception 'removed account retained a managed Discord role';
  end if;

  if not exists (
    select 1
    from public.roo_list_pending_discord_role_assignments(25) pending
    where pending.user_id = v_user_id
  ) then
    raise exception 'pending Discord role assignment was not listed';
  end if;

  v_grant := public.roo_create_reauth_grant(
    v_user_id,
    repeat('d', 64),
    'unlink_identity',
    'discord'
  );
  if nullif(v_grant->>'id', '') is null then
    raise exception 'reauthentication grant was not created';
  end if;
  perform public.roo_consume_reauth_grant(
    repeat('d', 64),
    v_user_id,
    'unlink_identity',
    'discord'
  );
  begin
    perform public.roo_consume_reauth_grant(
      repeat('d', 64),
      v_user_id,
      'unlink_identity',
      'discord'
    );
    raise exception 'reauthentication grant was reusable';
  exception when insufficient_privilege then null;
  end;

  insert into auth.users (
    id,
    aud,
    role,
    email,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  ) values (
    v_secondary_user_id,
    'authenticated',
    'authenticated',
    'secondary-social-auth-fixture@example.invalid',
    now(),
    '{}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );
  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    source_backend
  ) values (
    v_secondary_user_id,
    'secondary-social-auth-fixture@example.invalid',
    'Secondary Social Auth Fixture',
    'active',
    'supabase'
  );
  insert into accounts.account_roles (user_id, role)
  values (v_secondary_user_id, 'customer');

  perform public.roo_create_reauth_grant(
    v_user_id,
    repeat('e', 64),
    'merge_account',
    null
  );
  perform public.roo_create_reauth_grant(
    v_secondary_user_id,
    repeat('f', 64),
    'merge_account',
    null
  );
  v_merged := public.roo_merge_account_principals(
    repeat('e', 64),
    repeat('f', 64)
  );
  if v_merged->>'principal_id' <> v_user_id::text
     or (select count(*) from accounts.principal_auth_users mapping
         where mapping.principal_id = v_user_id) <> 2
     or not exists (
       select 1 from accounts.principals principal
       where principal.id = v_secondary_user_id and principal.status = 'deleted'
     ) then
    raise exception 'account merge did not preserve both authenticated users on one principal';
  end if;
end;
$$;

rollback;
