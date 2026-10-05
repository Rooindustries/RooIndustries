set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
declare
  signature text := 'licensing.roo_activate_device_without_principal_check(uuid,uuid,text,text,text,text)';
  definition text;
  patched text;
  entitlement_guard text := $guard$  select *
  into v_entitlement
  from licensing.entitlements
  where id = p_entitlement_id
  for update;

  if not found
     or v_entitlement.user_id is distinct from p_user_id
     or v_entitlement.status <> 'active' then
    raise exception 'active entitlement not found'
      using errcode = 'P0002';
  end if;$guard$;
  event_anchor text := $anchor$  select *
  into v_existing_event
  from licensing.activation_events
  where request_id = p_request_id;$anchor$;
  fingerprint_anchor text := $anchor$if p_device_fingerprint_hmac !~ '^[0-9a-f]{64}$' then$anchor$;
  replay_device_anchor text := $anchor$    if not found
       or v_activation.device_fingerprint_hmac <> p_device_fingerprint_hmac then$anchor$;
begin
  if to_regclass('licensing.entitlements') is null
    or to_regclass('licensing.device_activations') is null
    or to_regclass('licensing.activation_events') is null
    or to_regprocedure(signature) is null
    or to_regprocedure('public.roo_activate_device(uuid,uuid,text,text,text,text)') is null
    or to_regprocedure('accounts.require_active_principal_for_user(uuid)') is null then
    raise exception 'activation replay migration requires the current principal-guarded licensing contract';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc
    where oid = to_regprocedure(signature) and prosecdef
      and proconfig @> array['search_path=""']::text[]
  ) then
    raise exception 'activation replay migration requires the private security-definer contract';
  end if;

  definition := pg_get_functiondef(to_regprocedure(signature));
  if (length(definition) - length(replace(definition, entitlement_guard, ''))) <> length(entitlement_guard)
    or (length(definition) - length(replace(definition, event_anchor, ''))) <> length(event_anchor)
    or (length(definition) - length(replace(definition, fingerprint_anchor, ''))) <> length(fingerprint_anchor)
    or (length(definition) - length(replace(definition, replay_device_anchor, ''))) <> length(replay_device_anchor)
    or position(event_anchor in definition) >= position(entitlement_guard in definition) then
    raise exception 'activation replay migration: unexpected licensing contract anchors';
  end if;

  patched := replace(definition, entitlement_guard, '');
  entitlement_guard := replace(entitlement_guard,
    $before$or v_entitlement.status <> 'active' then$before$,
    $after$or v_entitlement.status <> 'active'
     or (v_entitlement.expires_at is not null and v_entitlement.expires_at <= clock_timestamp()) then$after$);
  patched := replace(patched, event_anchor, entitlement_guard || E'\n\n' || event_anchor);
  patched := replace(patched, fingerprint_anchor,
    $replacement$if p_device_fingerprint_hmac is null or p_device_fingerprint_hmac !~ '^[0-9a-f]{64}$' then$replacement$);
  patched := replace(patched, replay_device_anchor,
    $replacement$    if not found
       or v_activation.entitlement_id is distinct from p_entitlement_id
       or v_activation.device_fingerprint_hmac <> p_device_fingerprint_hmac then$replacement$);
  execute patched;
end;
$migration$;

notify pgrst, 'reload schema';
