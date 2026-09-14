set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
begin
  if to_regprocedure('public.roo_reclaim_referral_orphan_identity(text,uuid,text)') is null
     or to_regclass('accounts.orphan_identity_reclaim_audit') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema='accounts' and table_name='oauth_intents'
         and column_name='recovery_for_intent_id'
     ) then
    raise exception 'Apply the forward orphan-recovery prerequisite repair before tournament retirement.'
      using errcode='55000';
  end if;
end;
$$;

alter table accounts.account_roles drop constraint account_roles_role_check;
alter table accounts.account_roles add constraint account_roles_role_check check (
  role in ('customer', 'creator', 'tourney_player', 'tourney_viewer',
           'tourney_caster', 'tourney_owner', 'administrator', 'tourney_retired')
);

create or replace function accounts.principal_domain(p_principal_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (
      select 1 from accounts.creator_profiles creator
      where creator.principal_id = p_principal_id
    ) then 'referral'
    when exists (
      select 1 from accounts.tourney_accounts tourney
      where tourney.principal_id = p_principal_id
    ) or exists (
      select 1 from accounts.account_roles historical
      where historical.principal_id = p_principal_id
        and historical.role = 'tourney_retired'
    ) then 'tourney'
    else 'referral'
  end;
$$;

create or replace function public.roo_reclaim_referral_orphan_identity(
  p_token_hash text,
  p_orphan_user_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent accounts.oauth_intents%rowtype;
  v_grant accounts.reauth_grants%rowtype;
  v_identity auth.identities%rowtype;
  v_provider text := pg_catalog.lower(pg_catalog.btrim(p_provider));
  v_provider_subject text;
  v_source_principal_id uuid;
  v_source_mapping_count integer := 0;
  v_owner_identity_count integer := 0;
  v_target_principal_id uuid;
  v_target_status text;
  v_block_reason text;
  v_block_outcome text;
  v_public_reason text;
  v_target_providers jsonb;
  v_moved_count integer := 0;
begin
  if v_provider not in ('google', 'discord')
     or pg_catalog.lower(pg_catalog.btrim(p_token_hash)) !~ '^[0-9a-f]{64}$'
     or p_orphan_user_id is null then
    raise exception 'Identity recovery input is invalid' using errcode = '22023';
  end if;

  select * into v_intent
  from accounts.oauth_intents intent
  where intent.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
  for update;
  if not found
     or v_intent.action <> 'reclaim'
     or v_intent.flow <> 'referral'
     or v_intent.provider <> v_provider
     or v_intent.status <> 'pending'
     or v_intent.expires_at <= pg_catalog.now()
     or v_intent.target_user_id is null
     or v_intent.principal_id is null
     or v_intent.recovery_for_intent_id is null then
    raise exception 'Identity recovery intent is not active' using errcode = '42501';
  end if;

  select * into v_grant
  from accounts.reauth_grants grant_row
  where grant_row.id = v_intent.reauth_grant_id
    and grant_row.bound_intent_id = v_intent.id
    and grant_row.user_id = v_intent.target_user_id
    and grant_row.principal_id = v_intent.principal_id
    and grant_row.purpose = 'link_identity'
    and (grant_row.provider is null or grant_row.provider = v_provider)
    and grant_row.used_at is null
    and grant_row.expires_at > pg_catalog.now()
  for update;
  if not found then
    raise exception 'Recent authentication expired' using errcode = '42501';
  end if;

  select mapping.principal_id, principal.status
  into v_target_principal_id, v_target_status
  from accounts.principal_auth_users mapping
  join accounts.principals principal on principal.id = mapping.principal_id
  where mapping.user_id = v_intent.target_user_id
  for update of mapping, principal;

  perform 1
  from auth.users auth_user
  where auth_user.id = v_intent.target_user_id
  for update;
  perform 1
  from accounts.creator_profiles creator
  where creator.principal_id = v_target_principal_id
  for update;
  perform 1
  from accounts.account_roles role
  where role.principal_id = v_target_principal_id
    and role.role = 'creator'
  for update;

  if v_target_principal_id is null
     or v_target_principal_id <> v_intent.principal_id
     or v_target_status <> 'active'
     or not exists (
       select 1
       from accounts.creator_profiles creator
       where creator.principal_id = v_target_principal_id
         and creator.active
     )
     or not exists (
       select 1
       from accounts.account_roles role
       where role.principal_id = v_target_principal_id
         and role.role = 'creator'
     ) then
    raise exception 'Active creator target was not found' using errcode = '42501';
  end if;

  perform 1
  from auth.users auth_user
  where auth_user.id = p_orphan_user_id
  for update;

  select * into v_identity
  from auth.identities identity
  where identity.user_id = p_orphan_user_id
    and identity.provider = v_provider
  order by identity.last_sign_in_at desc nulls last,
    identity.created_at desc,
    identity.id desc
  limit 1
  for update;

  if found then
    v_provider_subject := v_identity.provider_id;
  end if;

  select pg_catalog.count(*)::integer into v_owner_identity_count
  from auth.identities identity
  where identity.user_id = p_orphan_user_id;

  select mapping.principal_id into v_source_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_orphan_user_id
  for update;

  if v_source_principal_id is not null then
    select pg_catalog.count(*)::integer into v_source_mapping_count
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_source_principal_id;

    perform 1
    from accounts.principals principal
    where principal.id = v_source_principal_id
    for update;
    perform 1
    from accounts.creator_profiles creator
    where creator.principal_id = v_source_principal_id
    for update;
    perform 1
    from accounts.tourney_accounts tourney_account
    where tourney_account.principal_id = v_source_principal_id
    for update;
  end if;

  if v_provider_subject is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'orphan-reclaim:' || v_provider || ':' || v_provider_subject,
        0
      )
    );
  end if;

  if p_orphan_user_id = v_intent.target_user_id
     and v_provider_subject is not null then
    perform public.roo_reconcile_auth_identity_links(v_intent.target_user_id);
    update accounts.reauth_grants
    set used_at = pg_catalog.now()
    where id = v_grant.id and used_at is null;
    update accounts.oauth_intents
    set
      claimed_user_id = v_intent.target_user_id,
      provider_subject = v_provider_subject,
      status = 'completed',
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where id = v_intent.id;
    insert into accounts.orphan_identity_reclaim_audit (
      oauth_intent_id,
      original_link_intent_id,
      provider,
      provider_subject,
      source_user_id,
      source_principal_id,
      target_user_id,
      target_principal_id,
      outcome,
      reason,
      details
    ) values (
      v_intent.id,
      v_intent.recovery_for_intent_id,
      v_provider,
      v_provider_subject,
      p_orphan_user_id,
      v_target_principal_id,
      v_intent.target_user_id,
      v_target_principal_id,
      'already_linked',
      'identity_already_reached_target',
      pg_catalog.jsonb_build_object('identity_id', v_identity.id)
    );
    return pg_catalog.jsonb_build_object(
      'reclaimed', false,
      'alreadyLinked', true,
      'reason', 'already_linked'
    );
  end if;

  if v_provider_subject is null then
    v_block_reason := 'provider_identity_missing';
    v_block_outcome := 'blocked_not_orphan';
    v_public_reason := 'not_orphan';
  elsif v_source_principal_id is null
     or v_owner_identity_count <> 1
     or v_source_mapping_count <> 1 then
    v_block_reason := 'provider_only_orphan_required';
    v_block_outcome := 'blocked_not_orphan';
    v_public_reason := 'not_orphan';
  elsif v_source_principal_id = v_target_principal_id
     or exists (
       select 1
       from accounts.creator_profiles creator
       where creator.principal_id = v_source_principal_id
         and creator.active
     )
     or exists (
       select 1
       from accounts.tourney_accounts tourney_account
       where tourney_account.principal_id = v_source_principal_id
         and tourney_account.active
     )
     or exists (
       select 1 from accounts.account_roles historical
       where historical.principal_id = v_source_principal_id
         and historical.role = 'tourney_retired'
     ) then
    v_block_reason := 'active_domain_account';
    v_block_outcome := 'blocked_active_account';
    v_public_reason := 'active_account';
  elsif exists (
    select 1
    from accounts.identity_links projected
    where projected.provider = v_provider
      and projected.provider_subject = v_provider_subject
      and (
        projected.user_id <> p_orphan_user_id
        or projected.principal_id <> v_source_principal_id
      )
  ) or exists (
    select 1
    from auth.identities target_identity
    where target_identity.user_id = v_intent.target_user_id
      and target_identity.provider = v_provider
  ) or exists (
    select 1
    from accounts.identity_links target_link
    where target_link.principal_id = v_target_principal_id
      and target_link.provider = v_provider
  ) then
    v_block_reason := 'identity_projection_conflict';
    v_block_outcome := 'blocked_conflict';
    v_public_reason := 'conflict';
  end if;

  if v_block_reason is not null then
    update accounts.reauth_grants
    set used_at = pg_catalog.now()
    where id = v_grant.id and used_at is null;
    update accounts.oauth_intents
    set
      claimed_user_id = p_orphan_user_id,
      provider_subject = v_provider_subject,
      status = 'failed',
      failure_code = v_block_reason,
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where id = v_intent.id;
    insert into accounts.orphan_identity_reclaim_audit (
      oauth_intent_id,
      original_link_intent_id,
      provider,
      provider_subject,
      source_user_id,
      source_principal_id,
      target_user_id,
      target_principal_id,
      outcome,
      reason,
      details
    ) values (
      v_intent.id,
      v_intent.recovery_for_intent_id,
      v_provider,
      v_provider_subject,
      p_orphan_user_id,
      v_source_principal_id,
      v_intent.target_user_id,
      v_target_principal_id,
      v_block_outcome,
      v_block_reason,
      pg_catalog.jsonb_build_object(
        'owner_identity_count', v_owner_identity_count,
        'source_mapping_count', v_source_mapping_count
      )
    );
    return pg_catalog.jsonb_build_object(
      'reclaimed', false,
      'reason', v_public_reason
    );
  end if;

  update auth.identities identity
  set
    user_id = v_intent.target_user_id,
    updated_at = pg_catalog.now()
  where identity.id = v_identity.id
    and identity.user_id = p_orphan_user_id
    and identity.provider = v_provider
    and identity.provider_id = v_provider_subject;
  get diagnostics v_moved_count = row_count;
  if v_moved_count <> 1 then
    raise exception 'Orphan identity move lost its row guard' using errcode = '40001';
  end if;

  update accounts.identity_links projected
  set
    user_id = v_intent.target_user_id,
    principal_id = v_target_principal_id,
    last_seen_at = pg_catalog.now(),
    metadata = projected.metadata || pg_catalog.jsonb_build_object(
      'orphan_reclaimed_at', pg_catalog.now(),
      'orphan_reclaim_audit_intent_id', v_intent.id
    )
  where projected.provider = v_provider
    and projected.provider_subject = v_provider_subject
    and projected.user_id = p_orphan_user_id
    and projected.principal_id = v_source_principal_id;

  perform public.roo_reconcile_auth_identity_links(v_intent.target_user_id);

  select coalesce(
    pg_catalog.jsonb_agg(provider_row.provider order by provider_row.provider),
    '[]'::jsonb
  ) into v_target_providers
  from (
    select distinct identity.provider
    from auth.identities identity
    where identity.user_id = v_intent.target_user_id
  ) provider_row;

  update auth.users auth_user
  set
    raw_app_meta_data = pg_catalog.jsonb_set(
      coalesce(auth_user.raw_app_meta_data, '{}'::jsonb),
      '{providers}',
      v_target_providers,
      true
    ),
    updated_at = pg_catalog.now()
  where auth_user.id = v_intent.target_user_id;

  update auth.users auth_user
  set
    raw_app_meta_data = pg_catalog.jsonb_set(
      coalesce(auth_user.raw_app_meta_data, '{}'::jsonb) - 'provider',
      '{providers}',
      '[]'::jsonb,
      true
    ),
    updated_at = pg_catalog.now()
  where auth_user.id = p_orphan_user_id;

  delete from auth.sessions session
  where session.user_id = p_orphan_user_id;

  update accounts.reauth_grants
  set used_at = pg_catalog.now()
  where id = v_grant.id and used_at is null;

  update accounts.oauth_intents
  set
    claimed_user_id = p_orphan_user_id,
    provider_subject = v_provider_subject,
    status = 'completed',
    completed_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  where id = v_intent.id;

  insert into accounts.orphan_identity_reclaim_audit (
    oauth_intent_id,
    original_link_intent_id,
    provider,
    provider_subject,
    source_user_id,
    source_principal_id,
    target_user_id,
    target_principal_id,
    outcome,
    reason,
    details
  ) values (
    v_intent.id,
    v_intent.recovery_for_intent_id,
    v_provider,
    v_provider_subject,
    p_orphan_user_id,
    v_source_principal_id,
    v_intent.target_user_id,
    v_target_principal_id,
    'reclaimed',
    'provider_only_orphan_released',
    pg_catalog.jsonb_build_object(
      'identity_id', v_identity.id,
      'owner_identity_count', v_owner_identity_count,
      'source_mapping_count', v_source_mapping_count
    )
  );

  return pg_catalog.jsonb_build_object(
    'reclaimed', true,
    'alreadyLinked', false,
    'reason', 'orphan_reclaimed',
    'account', accounts.principal_account_json(
      v_target_principal_id,
      v_intent.target_user_id
    )
  );
end;
$$;

revoke all on function public.roo_reclaim_referral_orphan_identity(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.roo_reclaim_referral_orphan_identity(text, uuid, text)
  to service_role;
