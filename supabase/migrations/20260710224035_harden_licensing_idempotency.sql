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
  v_existing_event licensing.activation_events%rowtype;
  v_action text := 'activate';
begin
  if p_device_fingerprint_hmac !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid device fingerprint'
      using errcode = '22023';
  end if;
  if p_request_id is null or char_length(p_request_id) not between 8 and 128 then
    raise exception 'invalid activation request id'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id, 0)
  );

  select *
  into v_existing_event
  from licensing.activation_events
  where request_id = p_request_id;

  if found then
    if v_existing_event.entitlement_id <> p_entitlement_id
       or v_existing_event.actor_user_id is distinct from p_user_id
       or v_existing_event.action not in ('activate', 'reactivate', 'heartbeat', 'reject') then
      raise exception 'activation request id was reused'
        using errcode = '23505';
    end if;
    if v_existing_event.action = 'reject' then
      if v_existing_event.metadata->>'device_fingerprint_hmac'
         is distinct from p_device_fingerprint_hmac then
        raise exception 'activation request id payload mismatch'
          using errcode = '23505';
      end if;
      return jsonb_build_object(
        'activation_id', v_existing_event.activation_id,
        'entitlement_id', p_entitlement_id,
        'status', 'device_limit_reached',
        'idempotent_replay', true
      );
    end if;
    select *
    into v_activation
    from licensing.device_activations
    where id = v_existing_event.activation_id;
    if not found
       or v_activation.device_fingerprint_hmac <> p_device_fingerprint_hmac then
      raise exception 'activation request id payload mismatch'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'activation_id', v_activation.id,
      'entitlement_id', p_entitlement_id,
      'status', v_activation.status,
      'activated_at', v_activation.activated_at,
      'idempotent_replay', true
    );
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
        v_existing_active.id,
        'reject',
        p_request_id,
        p_user_id,
        jsonb_build_object(
          'reason', 'device_limit_reached',
          'device_fingerprint_hmac', p_device_fingerprint_hmac
        )
      );
      return jsonb_build_object(
        'activation_id', v_existing_active.id,
        'entitlement_id', p_entitlement_id,
        'status', 'device_limit_reached',
        'idempotent_replay', false
      );
    end if;

    v_action := 'heartbeat';
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
  );

  return jsonb_build_object(
    'activation_id', v_activation.id,
    'entitlement_id', p_entitlement_id,
    'status', 'active',
    'activated_at', v_activation.activated_at,
    'idempotent_replay', false
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
  v_existing_event licensing.activation_events%rowtype;
  v_outcome text;
begin
  if p_request_id is null or char_length(p_request_id) not between 8 and 128 then
    raise exception 'invalid revocation request id'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id, 0)
  );

  select *
  into v_existing_event
  from licensing.activation_events
  where request_id = p_request_id;
  if found then
    if v_existing_event.entitlement_id <> p_entitlement_id
       or v_existing_event.actor_user_id is distinct from p_actor_user_id
       or v_existing_event.action <> 'revoke' then
      raise exception 'revocation request id was reused'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'activation_id', v_existing_event.activation_id,
      'entitlement_id', p_entitlement_id,
      'status', coalesce(v_existing_event.metadata->>'outcome', 'revoked'),
      'idempotent_replay', true
    );
  end if;

  perform 1
  from licensing.entitlements
  where id = p_entitlement_id
  for update;
  if not found then
    raise exception 'entitlement not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_activation
  from licensing.device_activations
  where entitlement_id = p_entitlement_id
    and status = 'active'
  for update;

  if found then
    update licensing.device_activations
    set
      status = 'revoked',
      revoked_at = now(),
      revoked_by = p_actor_user_id,
      revocation_reason = nullif(p_reason, '')
    where id = v_activation.id;
    v_outcome := 'revoked';
  else
    v_outcome := 'no_active_device';
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
    'revoke',
    p_request_id,
    p_actor_user_id,
    jsonb_build_object(
      'reason', nullif(p_reason, ''),
      'outcome', v_outcome
    )
  );

  return jsonb_build_object(
    'activation_id', v_activation.id,
    'entitlement_id', p_entitlement_id,
    'status', v_outcome,
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_revoke_device(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.roo_revoke_device(uuid, text, text, uuid)
  to service_role;
