set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function accounts.require_active_principal_for_user(
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
begin
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping
  join accounts.principals principal on principal.id = mapping.principal_id
  where mapping.user_id = p_user_id
    and principal.status = 'active'
  for share of principal;

  if v_principal_id is null then
    raise exception 'active licensing principal not found'
      using errcode = 'P0002';
  end if;
  return v_principal_id;
end;
$$;

alter function public.roo_claim_entitlement(uuid, text, text)
  rename to roo_claim_entitlement_without_principal_check;
alter function public.roo_claim_entitlement_without_principal_check(uuid, text, text)
  set schema licensing;

alter function public.roo_activate_device(uuid, uuid, text, text, text, text)
  rename to roo_activate_device_without_principal_check;
alter function public.roo_activate_device_without_principal_check(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) set schema licensing;

alter function public.roo_revoke_device(uuid, text, text, uuid)
  rename to roo_revoke_device_without_principal_check;
alter function public.roo_revoke_device_without_principal_check(uuid, text, text, uuid)
  set schema licensing;

alter function public.roo_entitlement_status(uuid)
  rename to roo_entitlement_status_without_principal_check;
alter function public.roo_entitlement_status_without_principal_check(uuid)
  set schema licensing;

create function public.roo_claim_entitlement(
  p_user_id uuid,
  p_verified_email text,
  p_purchase_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform accounts.require_active_principal_for_user(p_user_id);
  return licensing.roo_claim_entitlement_without_principal_check(
    p_user_id,
    p_verified_email,
    p_purchase_reference
  );
end;
$$;

create function public.roo_activate_device(
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
begin
  perform accounts.require_active_principal_for_user(p_user_id);
  return licensing.roo_activate_device_without_principal_check(
    p_user_id,
    p_entitlement_id,
    p_device_fingerprint_hmac,
    p_request_id,
    p_device_label,
    p_app_version
  );
end;
$$;

create function public.roo_revoke_device(
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
begin
  if p_actor_user_id is not null then
    perform accounts.require_active_principal_for_user(p_actor_user_id);
  end if;
  return licensing.roo_revoke_device_without_principal_check(
    p_entitlement_id,
    p_request_id,
    p_reason,
    p_actor_user_id
  );
end;
$$;

create function public.roo_entitlement_status(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform accounts.require_active_principal_for_user(p_user_id);
  return licensing.roo_entitlement_status_without_principal_check(p_user_id);
end;
$$;

create or replace function accounts.revoke_inactive_principal_sessions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
begin
  if tg_op = 'DELETE' then
    v_principal_id := old.id;
  elsif new.status in ('disabled', 'deleted')
        and new.status is distinct from old.status then
    v_principal_id := new.id;
    new.session_version := greatest(new.session_version, old.session_version + 1);
  else
    return new;
  end if;

  update auth.users auth_user
  set
    banned_until = 'infinity'::timestamptz,
    updated_at = pg_catalog.clock_timestamp()
  where auth_user.id in (
    select mapping.user_id
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_principal_id
  );

  delete from auth.refresh_tokens refresh_token
  where refresh_token.user_id::text in (
    select mapping.user_id::text
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_principal_id
  );

  delete from auth.sessions session
  where session.user_id in (
    select mapping.user_id
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_principal_id
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger principals_revoke_sessions_on_inactive
before update of status on accounts.principals
for each row execute function accounts.revoke_inactive_principal_sessions();

create trigger principals_revoke_sessions_on_delete
before delete on accounts.principals
for each row execute function accounts.revoke_inactive_principal_sessions();

revoke all on function accounts.require_active_principal_for_user(uuid)
  from public, anon, authenticated, service_role;
revoke all on function accounts.revoke_inactive_principal_sessions()
  from public, anon, authenticated, service_role;
revoke all on function licensing.roo_claim_entitlement_without_principal_check(
  uuid,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function licensing.roo_activate_device_without_principal_check(
  uuid,
  uuid,
  text,
  text,
  text,
  text
) from public, anon, authenticated, service_role;
revoke all on function licensing.roo_revoke_device_without_principal_check(
  uuid,
  text,
  text,
  uuid
) from public, anon, authenticated, service_role;
revoke all on function licensing.roo_entitlement_status_without_principal_check(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.roo_claim_entitlement(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_revoke_device(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.roo_entitlement_status(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.roo_claim_entitlement(uuid, text, text)
  to service_role;
grant execute on function public.roo_activate_device(uuid, uuid, text, text, text, text)
  to service_role;
grant execute on function public.roo_revoke_device(uuid, text, text, uuid)
  to service_role;
grant execute on function public.roo_entitlement_status(uuid)
  to service_role;

notify pgrst, 'reload schema';
