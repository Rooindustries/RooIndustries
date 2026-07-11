
create or replace function public.roo_import_account(
  p_account jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_email text := lower(btrim(p_account->>'primary_email'));
  v_role jsonb;
  v_alias jsonb;
  v_existing_user_id uuid;
  v_credential jsonb := p_account->'credential_migration';
  v_creator jsonb := p_account->'creator_profile';
  v_tourney jsonb := p_account->'tourney_account';
begin
  if v_user_id is null or v_email is null or v_email = '' then
    raise exception 'account import requires user_id and primary_email'
      using errcode = '22023';
  end if;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_revision,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_email,
    coalesce(p_account->>'display_name', ''),
    coalesce(nullif(p_account->>'status', ''), 'active'),
    nullif(p_account->>'legacy_sanity_id', ''),
    nullif(p_account->>'source_revision', ''),
    nullif(p_account->>'source_hash', ''),
    'sanity',
    now()
  )
  on conflict (user_id) do update
  set
    primary_email = excluded.primary_email,
    display_name = excluded.display_name,
    status = excluded.status,
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, public.profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    source_backend = 'sanity',
    updated_at = now();

  for v_role in
    select value from jsonb_array_elements(coalesce(p_account->'roles', '[]'::jsonb))
  loop
    insert into accounts.account_roles (
      user_id,
      role,
      source_backend,
      legacy_sanity_id
    )
    values (
      v_user_id,
      trim(both '"' from v_role::text),
      'sanity',
      nullif(p_account->>'legacy_sanity_id', '')
    )
    on conflict (user_id, role) do nothing;
  end loop;

  for v_alias in
    select value from jsonb_array_elements(coalesce(p_account->'aliases', '[]'::jsonb))
  loop
    select user_id
    into v_existing_user_id
    from accounts.login_aliases
    where alias_type = v_alias->>'type'
      and normalized_value = lower(btrim(v_alias->>'value'));

    if v_existing_user_id is not null and v_existing_user_id <> v_user_id then
      raise exception 'account alias is already assigned'
        using errcode = '23505';
    end if;

    insert into accounts.login_aliases (
      user_id,
      alias_type,
      normalized_value,
      verified,
      legacy_sanity_id,
      updated_at
    )
    values (
      v_user_id,
      v_alias->>'type',
      lower(btrim(v_alias->>'value')),
      coalesce((v_alias->>'verified')::boolean, false),
      nullif(p_account->>'legacy_sanity_id', ''),
      now()
    )
    on conflict (alias_type, normalized_value) do update
    set
      verified = accounts.login_aliases.verified or excluded.verified,
      legacy_sanity_id = coalesce(
        accounts.login_aliases.legacy_sanity_id,
        excluded.legacy_sanity_id
      ),
      updated_at = now();
  end loop;

  if v_credential is not null and jsonb_typeof(v_credential) = 'object' then
    insert into accounts.credential_migrations (
      user_id,
      legacy_sanity_id,
      legacy_source,
      credential_kind,
      status,
      source_revision,
      imported_at,
      upgraded_at,
      updated_at
    )
    values (
      v_user_id,
      nullif(v_credential->>'legacy_sanity_id', ''),
      v_credential->>'legacy_source',
      v_credential->>'credential_kind',
      v_credential->>'status',
      nullif(v_credential->>'source_revision', ''),
      case when v_credential->>'status' = 'imported' then now() else null end,
      case when v_credential->>'status' = 'upgraded' then now() else null end,
      now()
    )
    on conflict (user_id) do update
    set
      legacy_sanity_id = coalesce(
        excluded.legacy_sanity_id,
        accounts.credential_migrations.legacy_sanity_id
      ),
      legacy_source = excluded.legacy_source,
      credential_kind = excluded.credential_kind,
      status = excluded.status,
      source_revision = excluded.source_revision,
      imported_at = coalesce(
        accounts.credential_migrations.imported_at,
        excluded.imported_at
      ),
      upgraded_at = coalesce(
        accounts.credential_migrations.upgraded_at,
        excluded.upgraded_at
      ),
      updated_at = now();
  end if;

  if v_creator is not null and jsonb_typeof(v_creator) = 'object' then
    insert into accounts.creator_profiles (
      user_id,
      referral_code,
      paypal_email,
      contact_discord,
      contact_telegram,
      contact_phone,
      commission_basis_points,
      discount_basis_points,
      successful_referrals,
      payout_details,
      accounting_totals,
      active,
      legacy_sanity_id,
      source_revision,
      source_hash,
      updated_at
    )
    values (
      v_user_id,
      lower(btrim(v_creator->>'referral_code')),
      nullif(lower(btrim(v_creator->>'paypal_email')), ''),
      nullif(v_creator->>'contact_discord', ''),
      nullif(v_creator->>'contact_telegram', ''),
      nullif(v_creator->>'contact_phone', ''),
      coalesce((v_creator->>'commission_basis_points')::integer, 1000),
      coalesce((v_creator->>'discount_basis_points')::integer, 0),
      coalesce((v_creator->>'successful_referrals')::integer, 0),
      coalesce(v_creator->'payout_details', '{}'::jsonb),
      coalesce(v_creator->'accounting_totals', '{}'::jsonb),
      coalesce((v_creator->>'active')::boolean, true),
      nullif(v_creator->>'legacy_sanity_id', ''),
      nullif(v_creator->>'source_revision', ''),
      nullif(v_creator->>'source_hash', ''),
      now()
    )
    on conflict (user_id) do update
    set
      referral_code = excluded.referral_code,
      paypal_email = excluded.paypal_email,
      contact_discord = excluded.contact_discord,
      contact_telegram = excluded.contact_telegram,
      contact_phone = excluded.contact_phone,
      commission_basis_points = excluded.commission_basis_points,
      discount_basis_points = excluded.discount_basis_points,
      successful_referrals = excluded.successful_referrals,
      payout_details = excluded.payout_details,
      accounting_totals = excluded.accounting_totals,
      active = excluded.active,
      legacy_sanity_id = excluded.legacy_sanity_id,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      updated_at = now();
  end if;

  if v_tourney is not null and jsonb_typeof(v_tourney) = 'object' then
    insert into accounts.tourney_accounts (
      user_id,
      username,
      role,
      active,
      credential_version,
      legacy_sanity_id,
      source_revision,
      source_hash,
      legacy_payload,
      updated_at
    )
    values (
      v_user_id,
      lower(btrim(v_tourney->>'username')),
      v_tourney->>'role',
      coalesce((v_tourney->>'active')::boolean, true),
      coalesce(nullif(v_tourney->>'credential_version', ''), '1'),
      nullif(v_tourney->>'legacy_sanity_id', ''),
      nullif(v_tourney->>'source_revision', ''),
      nullif(v_tourney->>'source_hash', ''),
      coalesce(v_tourney->'legacy_payload', '{}'::jsonb),
      now()
    )
    on conflict (user_id) do update
    set
      username = excluded.username,
      role = excluded.role,
      active = excluded.active,
      credential_version = excluded.credential_version,
      legacy_sanity_id = excluded.legacy_sanity_id,
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      legacy_payload = excluded.legacy_payload,
      updated_at = now();
  end if;

  return jsonb_build_object('user_id', v_user_id, 'imported', true);
end;
$$;

create or replace function public.roo_resolve_account_alias(
  p_identifier text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.user_id,
    'primary_email', p.primary_email,
    'display_name', p.display_name,
    'status', p.status,
    'legacy_sanity_id', p.legacy_sanity_id,
    'credential_status', cm.status,
    'credential_kind', cm.credential_kind,
    'legacy_source', cm.legacy_source,
    'roles', coalesce(
      (
        select jsonb_agg(ar.role order by ar.role)
        from accounts.account_roles ar
        where ar.user_id = p.user_id
      ),
      '[]'::jsonb
    ),
    'referral_code', cp.referral_code,
    'tourney_username', ta.username,
    'tourney_role', ta.role,
    'tourney_active', ta.active
  )
  from accounts.login_aliases la
  join public.profiles p on p.user_id = la.user_id
  left join accounts.credential_migrations cm on cm.user_id = p.user_id
  left join accounts.creator_profiles cp on cp.user_id = p.user_id
  left join accounts.tourney_accounts ta on ta.user_id = p.user_id
  where la.normalized_value = lower(btrim(p_identifier))
  order by case la.alias_type
    when 'email' then 0
    when 'referral_code' then 1
    else 2
  end
  limit 1;
$$;

create or replace function public.roo_complete_credential_migration(
  p_user_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  update accounts.credential_migrations
  set
    credential_kind = 'bcrypt',
    status = 'upgraded',
    upgraded_at = now(),
    last_attempt_at = now(),
    attempt_count = attempt_count + 1,
    failure_reason = null,
    updated_at = now()
  where user_id = p_user_id;
$$;

create or replace function public.roo_claim_entitlement(
  p_user_id uuid,
  p_verified_email text,
  p_purchase_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement licensing.entitlements%rowtype;
begin
  select *
  into v_entitlement
  from licensing.entitlements
  where buyer_email = lower(btrim(p_verified_email))
    and status in ('unclaimed', 'active')
    and (p_purchase_reference is null or purchase_reference = p_purchase_reference)
    and (user_id is null or user_id = p_user_id)
  order by created_at
  limit 1
  for update;

  if not found then
    raise exception 'eligible entitlement not found'
      using errcode = 'P0002';
  end if;

  update licensing.entitlements
  set
    user_id = p_user_id,
    status = 'active',
    claimed_at = coalesce(claimed_at, now()),
    updated_at = now()
  where id = v_entitlement.id;

  insert into licensing.activation_events (
    entitlement_id,
    action,
    request_id,
    actor_user_id,
    metadata
  )
  values (
    v_entitlement.id,
    'claim',
    'claim:' || v_entitlement.id::text || ':' || p_user_id::text,
    p_user_id,
    jsonb_build_object('purchase_reference', v_entitlement.purchase_reference)
  )
  on conflict (request_id) do nothing;

  return jsonb_build_object(
    'entitlement_id', v_entitlement.id,
    'status', 'active',
    'product_id', v_entitlement.product_id,
    'max_devices', v_entitlement.max_devices
  );
end;
$$;

create or replace function public.roo_activate_device(
  p_user_id uuid,
  p_entitlement_id uuid,
  p_device_fingerprint_hmac text,
  p_request_id text,
  p_device_label text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entitlement licensing.entitlements%rowtype;
  v_activation licensing.device_activations%rowtype;
  v_existing_active licensing.device_activations%rowtype;
  v_action text := 'activate';
begin
  if p_device_fingerprint_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid device fingerprint'
      using errcode = '22023';
  end if;

  select *
  into v_entitlement
  from licensing.entitlements
  where id = p_entitlement_id
  for update;

  if not found
     or v_entitlement.user_id is distinct from p_user_id
     or v_entitlement.status <> 'active' then
    raise exception 'active entitlement not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_existing_active
  from licensing.device_activations
  where entitlement_id = p_entitlement_id
    and status = 'active'
  for update;

  if found then
    if v_existing_active.device_fingerprint_hmac <> p_device_fingerprint_hmac then
      raise exception 'device limit reached'
        using errcode = '23505';
    end if;

    update licensing.device_activations
    set
      last_seen_at = now(),
      app_version = coalesce(p_app_version, app_version),
      device_label = coalesce(p_device_label, device_label)
    where id = v_existing_active.id
    returning * into v_activation;
  else
    select *
    into v_activation
    from licensing.device_activations
    where entitlement_id = p_entitlement_id
      and device_fingerprint_hmac = p_device_fingerprint_hmac
    for update;

    if found then
      v_action := 'reactivate';
      update licensing.device_activations
      set
        status = 'active',
        activated_at = now(),
        last_seen_at = now(),
        revoked_at = null,
        revoked_by = null,
        revocation_reason = null,
        app_version = coalesce(p_app_version, app_version),
        device_label = coalesce(p_device_label, device_label)
      where id = v_activation.id
      returning * into v_activation;
    else
      insert into licensing.device_activations (
        entitlement_id,
        device_fingerprint_hmac,
        device_label,
        app_version,
        status,
        last_seen_at
      )
      values (
        p_entitlement_id,
        p_device_fingerprint_hmac,
        p_device_label,
        p_app_version,
        'active',
        now()
      )
      returning * into v_activation;
    end if;
  end if;

  insert into licensing.activation_events (
    entitlement_id,
    activation_id,
    action,
    request_id,
    actor_user_id,
    metadata
  )
  values (
    p_entitlement_id,
    v_activation.id,
    v_action,
    p_request_id,
    p_user_id,
    jsonb_build_object('app_version', p_app_version)
  )
  on conflict (request_id) do nothing;

  return jsonb_build_object(
    'activation_id', v_activation.id,
    'entitlement_id', p_entitlement_id,
    'status', 'active',
    'activated_at', v_activation.activated_at
  );
end;
$$;

create or replace function public.roo_revoke_device(
  p_entitlement_id uuid,
  p_request_id text,
  p_reason text,
  p_actor_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_activation licensing.device_activations%rowtype;
begin
  select *
  into v_activation
  from licensing.device_activations
  where entitlement_id = p_entitlement_id
    and status = 'active'
  for update;

  if not found then
    return jsonb_build_object(
      'entitlement_id', p_entitlement_id,
      'status', 'no_active_device'
    );
  end if;

  update licensing.device_activations
  set
    status = 'revoked',
    revoked_at = now(),
    revoked_by = p_actor_user_id,
    revocation_reason = nullif(p_reason, '')
  where id = v_activation.id;

  insert into licensing.activation_events (
    entitlement_id,
    activation_id,
    action,
    request_id,
    actor_user_id,
    metadata
  )
  values (
    p_entitlement_id,
    v_activation.id,
    'revoke',
    p_request_id,
    p_actor_user_id,
    jsonb_build_object('reason', nullif(p_reason, ''))
  )
  on conflict (request_id) do nothing;

  return jsonb_build_object(
    'activation_id', v_activation.id,
    'entitlement_id', p_entitlement_id,
    'status', 'revoked'
  );
end;
$$;

create or replace function public.roo_entitlement_status(
  p_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'entitlement_id', e.id,
        'product_id', e.product_id,
        'sku', p.sku,
        'name', p.name,
        'status', e.status,
        'max_devices', e.max_devices,
        'claimed_at', e.claimed_at,
        'expires_at', e.expires_at,
        'active_device', (
          select jsonb_build_object(
            'activation_id', da.id,
            'device_label', da.device_label,
            'app_version', da.app_version,
            'activated_at', da.activated_at,
            'last_seen_at', da.last_seen_at
          )
          from licensing.device_activations da
          where da.entitlement_id = e.id
            and da.status = 'active'
          limit 1
        )
      )
      order by e.created_at
    ),
    '[]'::jsonb
  )
  from licensing.entitlements e
  join licensing.products p on p.id = e.product_id
  where e.user_id = p_user_id;
$$;

revoke all on function public.roo_import_account(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_resolve_account_alias(text)
  from public, anon, authenticated;
revoke all on function public.roo_complete_credential_migration(uuid)
  from public, anon, authenticated;
revoke all on function public.roo_claim_entitlement(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_revoke_device(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.roo_entitlement_status(uuid)
  from public, anon, authenticated;

grant execute on function public.roo_import_account(jsonb)
  to service_role;
grant execute on function public.roo_resolve_account_alias(text)
  to service_role;
grant execute on function public.roo_complete_credential_migration(uuid)
  to service_role;
grant execute on function public.roo_claim_entitlement(uuid, text, text)
  to service_role;
grant execute on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.roo_revoke_device(uuid, text, text, uuid)
  to service_role;
grant execute on function public.roo_entitlement_status(uuid)
  to service_role;
