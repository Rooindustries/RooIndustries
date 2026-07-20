set lock_timeout = '5s';
set statement_timeout = '120s';

-- Prevent stale registration and reset dispatches from being replayed or leased
-- after the authoritative Supabase referral token state changes.

create or replace function accounts.referral_email_dispatch_source_error(
  p_referral_id text,
  p_dispatch_kind text,
  p_recipient_hash text,
  p_token_hash text,
  p_expires_at timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source migration.source_documents%rowtype;
  v_source_expiry timestamptz;
  v_expiry_text text;
begin
  select * into v_source
  from migration.source_documents source
  where source.legacy_sanity_id = p_referral_id
    and source.document_type = 'referral'
    and not source.tombstoned;

  if not found then
    return 'source_document_missing';
  end if;
  if encode(
    extensions.digest(lower(btrim(coalesce(v_source.payload->>'creatorEmail', ''))), 'sha256'),
    'hex'
  ) is distinct from p_recipient_hash then
    return 'source_recipient_changed';
  end if;

  if p_dispatch_kind = 'registration_verification' then
    if v_source.payload->>'registrationStatus' is distinct from 'pending_email' then
      return 'source_registration_not_pending';
    end if;
    if lower(coalesce(v_source.payload->>'registrationVerificationTokenHash', ''))
      is distinct from p_token_hash then
      return 'source_token_changed';
    end if;
    v_expiry_text := nullif(
      btrim(v_source.payload->>'registrationVerificationExpiresAt'),
      ''
    );
  elsif p_dispatch_kind = 'password_reset' then
    if coalesce(v_source.payload->>'registrationStatus', 'active') = 'pending_email' then
      return 'source_registration_pending';
    end if;
    if lower(coalesce(v_source.payload->>'resetTokenHash', ''))
      is distinct from p_token_hash then
      return 'source_token_changed';
    end if;
    v_expiry_text := nullif(btrim(v_source.payload->>'resetTokenExpiresAt'), '');
  else
    return 'source_dispatch_kind_invalid';
  end if;

  if v_expiry_text is null then
    return 'source_expiry_missing';
  end if;
  begin
    v_source_expiry := v_expiry_text::timestamptz;
  exception when others then
    return 'source_expiry_invalid';
  end;
  if v_source_expiry is distinct from p_expires_at then
    return 'source_expiry_changed';
  end if;
  if v_source_expiry <= now() then
    return 'link_expired';
  end if;
  return null;
end;
$$;

create or replace function public.roo_enqueue_referral_email_mutation(
  p_mutations jsonb,
  p_referral_id text,
  p_dispatch_kind text,
  p_recipient_email text,
  p_recipient_hash text,
  p_token_hash text,
  p_delivery_payload jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referral_id text := btrim(coalesce(p_referral_id, ''));
  v_kind text := lower(btrim(coalesce(p_dispatch_kind, '')));
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_recipient_hash text := lower(btrim(coalesce(p_recipient_hash, '')));
  v_token_hash text := lower(btrim(coalesce(p_token_hash, '')));
  v_idempotency_key text;
  v_dispatch accounts.referral_email_dispatches%rowtype;
  v_source_error text;
begin
  if v_referral_id = '' or char_length(v_referral_id) > 256
    or v_kind not in ('registration_verification', 'password_reset')
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_email) > 254
    or v_recipient_hash !~ '^[0-9a-f]{64}$'
    or v_token_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_delivery_payload) <> 'object'
    or nullif(p_delivery_payload->>'token', '') is null
    or char_length(p_delivery_payload->>'token') > 256
    or char_length(coalesce(p_delivery_payload->>'name', '')) > 200
    or octet_length(p_delivery_payload::text) > 8192
    or p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '24 hours'
    or jsonb_typeof(p_mutations) <> 'array'
    or jsonb_array_length(p_mutations) < 1 then
    raise exception 'invalid referral email enqueue request'
      using errcode = '22023';
  end if;
  if encode(extensions.digest(v_email, 'sha256'), 'hex') <> v_recipient_hash
    or encode(
      extensions.digest(p_delivery_payload->>'token', 'sha256'),
      'hex'
    ) <> v_token_hash then
    raise exception 'referral email digest mismatch'
      using errcode = '22023';
  end if;
  if not exists (
    select 1
    from jsonb_array_elements(p_mutations) mutation
    where mutation->>'operation' in ('create', 'replace')
      and mutation->'document'->>'_id' = v_referral_id
      and mutation->'document'->>'_type' = 'referral'
      and lower(btrim(mutation->'document'->>'creatorEmail')) = v_email
      and case v_kind
        when 'registration_verification' then
          mutation->'document'->>'registrationStatus' = 'pending_email'
          and mutation->'document'->>'registrationVerificationTokenHash' = v_token_hash
          and (mutation->'document'->>'registrationVerificationExpiresAt')::timestamptz
            = p_expires_at
        when 'password_reset' then
          coalesce(mutation->'document'->>'registrationStatus', '') <> 'pending_email'
          and mutation->'document'->>'resetTokenHash' = v_token_hash
          and (mutation->'document'->>'resetTokenExpiresAt')::timestamptz
            = p_expires_at
        else false
      end
  ) then
    raise exception 'referral email mutation does not match its dispatch'
      using errcode = '22023';
  end if;

  v_idempotency_key := 'referral-email-' || encode(
    extensions.digest(
      v_kind || ':' || v_referral_id || ':' || v_token_hash || ':' || v_recipient_hash,
      'sha256'
    ),
    'hex'
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-email:' || v_kind || ':' || v_referral_id, 0)
  );

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where idempotency_key = v_idempotency_key
  for update;
  if found then
    if v_dispatch.referral_id <> v_referral_id
      or v_dispatch.dispatch_kind <> v_kind
      or v_dispatch.recipient_hash <> v_recipient_hash
      or v_dispatch.token_hash <> v_token_hash then
      raise exception 'referral email idempotency conflict'
        using errcode = '23505';
    end if;
    v_source_error := accounts.referral_email_dispatch_source_error(
      v_dispatch.referral_id,
      v_dispatch.dispatch_kind,
      v_dispatch.recipient_hash,
      v_dispatch.token_hash,
      v_dispatch.expires_at
    );
    if v_source_error is not null then
      raise exception 'referral email source state changed'
        using errcode = '40001', detail = v_source_error;
    end if;
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'idempotency_key', v_dispatch.idempotency_key,
      'status', v_dispatch.status,
      'replayed', true,
      'token_hash', v_dispatch.token_hash
    );
  end if;

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where referral_id = v_referral_id
    and dispatch_kind = v_kind
    and status in ('pending', 'sending', 'retry')
    and expires_at > now()
  order by created_at desc, id
  limit 1
  for update;
  if found then
    v_source_error := accounts.referral_email_dispatch_source_error(
      v_dispatch.referral_id,
      v_dispatch.dispatch_kind,
      v_dispatch.recipient_hash,
      v_dispatch.token_hash,
      v_dispatch.expires_at
    );
    if v_source_error is null then
      if v_dispatch.recipient_hash <> v_recipient_hash then
        raise exception 'referral email recipient conflict'
          using errcode = '23505';
      end if;
      return jsonb_build_object(
        'dispatch_id', v_dispatch.id,
        'idempotency_key', v_dispatch.idempotency_key,
        'status', v_dispatch.status,
        'replayed', true,
        'token_hash', v_dispatch.token_hash
      );
    end if;
    if v_dispatch.status = 'sending' and v_dispatch.lease_expires_at > now() then
      raise exception 'referral email source state changed during delivery'
        using errcode = '40001', detail = v_source_error;
    end if;
    update accounts.referral_email_dispatches
    set status = 'dead_letter',
        lease_id = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        last_error_code = 'source_state_changed',
        dead_lettered_at = now(),
        delivery_payload = delivery_payload - 'token',
        updated_at = now()
    where id = v_dispatch.id;
  end if;

  perform public.roo_apply_document_mutations(p_mutations);
  v_source_error := accounts.referral_email_dispatch_source_error(
    v_referral_id,
    v_kind,
    v_recipient_hash,
    v_token_hash,
    p_expires_at
  );
  if v_source_error is not null then
    raise exception 'referral email mutation did not establish source state'
      using errcode = '40001', detail = v_source_error;
  end if;
  insert into accounts.referral_email_dispatches (
    command_id,
    idempotency_key,
    referral_id,
    dispatch_kind,
    recipient_email,
    recipient_hash,
    token_hash,
    delivery_payload,
    expires_at
  ) values (
    'dispatch:' || v_idempotency_key,
    v_idempotency_key,
    v_referral_id,
    v_kind,
    v_email,
    v_recipient_hash,
    v_token_hash,
    p_delivery_payload,
    p_expires_at
  )
  returning * into v_dispatch;

  return jsonb_build_object(
    'dispatch_id', v_dispatch.id,
    'idempotency_key', v_dispatch.idempotency_key,
    'status', v_dispatch.status,
    'replayed', false,
    'token_hash', v_dispatch.token_hash
  );
end;
$$;

create or replace function public.roo_claim_referral_email_dispatch(
  p_idempotency_key text,
  p_lease_id uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_dispatch accounts.referral_email_dispatches%rowtype;
  v_source_error text;
begin
  if v_key !~ '^referral-email-[0-9a-f]{64}$'
    or p_lease_id is null
    or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid referral email lease request'
      using errcode = '22023';
  end if;

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where idempotency_key = v_key
  for update;
  if not found then
    raise exception 'referral email dispatch not found'
      using errcode = 'P0002';
  end if;
  if v_dispatch.status = 'sent' then
    return jsonb_build_object(
      'claimed', false,
      'sent', true,
      'dead_letter', false,
      'idempotency_key', v_dispatch.idempotency_key,
      'provider_message_id', v_dispatch.provider_message_id
    );
  end if;
  if v_dispatch.status = 'resolved' then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', true,
      'resolved', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;
  if v_dispatch.status = 'dead_letter' then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;
  if v_dispatch.status = 'sending'
    and v_dispatch.lease_expires_at > now() then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', false,
      'in_progress', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;

  v_source_error := accounts.referral_email_dispatch_source_error(
    v_dispatch.referral_id,
    v_dispatch.dispatch_kind,
    v_dispatch.recipient_hash,
    v_dispatch.token_hash,
    v_dispatch.expires_at
  );
  if v_source_error is not null then
    update accounts.referral_email_dispatches
    set status = 'dead_letter',
        lease_id = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        last_error_code = 'source_state_changed',
        dead_lettered_at = now(),
        delivery_payload = delivery_payload - 'token',
        updated_at = now()
    where id = v_dispatch.id;
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', true,
      'source_state_changed', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;
  if v_dispatch.expires_at <= now()
    or v_dispatch.attempt_count >= v_dispatch.max_attempts then
    update accounts.referral_email_dispatches
    set status = 'dead_letter',
        lease_id = null,
        lease_expires_at = null,
        next_attempt_at = now(),
        last_error_code = case
          when expires_at <= now() then 'link_expired'
          else 'retry_exhausted'
        end,
        dead_lettered_at = now(),
        updated_at = now()
    where id = v_dispatch.id;
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;
  if v_dispatch.status in ('pending', 'retry')
    and v_dispatch.next_attempt_at > now() then
    return jsonb_build_object(
      'claimed', false,
      'sent', false,
      'dead_letter', false,
      'in_progress', true,
      'idempotency_key', v_dispatch.idempotency_key
    );
  end if;

  update accounts.referral_email_dispatches
  set status = 'sending',
      attempt_count = attempt_count + 1,
      lease_id = p_lease_id,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_error_code = null,
      updated_at = now()
  where id = v_dispatch.id
  returning * into v_dispatch;

  return jsonb_build_object(
    'claimed', true,
    'sent', false,
    'dead_letter', false,
    'idempotency_key', v_dispatch.idempotency_key,
    'dispatch_kind', v_dispatch.dispatch_kind,
    'recipient_email', v_dispatch.recipient_email,
    'delivery_payload', v_dispatch.delivery_payload,
    'attempt_count', v_dispatch.attempt_count,
    'expires_at', v_dispatch.expires_at
  );
end;
$$;

create or replace function public.roo_claim_referral_email_dispatches(
  p_lease_id uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if p_lease_id is null
    or coalesce(p_limit, 0) not between 1 and 100
    or coalesce(p_lease_seconds, 0) not between 30 and 300 then
    raise exception 'invalid referral email batch lease request'
      using errcode = '22023';
  end if;

  with eligible as (
    select dispatch.id
    from accounts.referral_email_dispatches dispatch
    where dispatch.status in ('pending', 'retry')
      or (dispatch.status = 'sending' and dispatch.lease_expires_at <= now())
    order by dispatch.next_attempt_at, dispatch.created_at, dispatch.id
    for update skip locked
    limit least(400, greatest(p_limit * 4, p_limit))
  ), source_invalid as (
    select dispatch.id
    from eligible
    join accounts.referral_email_dispatches dispatch on dispatch.id = eligible.id
    where accounts.referral_email_dispatch_source_error(
      dispatch.referral_id,
      dispatch.dispatch_kind,
      dispatch.recipient_hash,
      dispatch.token_hash,
      dispatch.expires_at
    ) is not null
  )
  update accounts.referral_email_dispatches dispatch
  set status = 'dead_letter',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = 'source_state_changed',
      dead_lettered_at = now(),
      delivery_payload = dispatch.delivery_payload - 'token',
      updated_at = now()
  from source_invalid
  where dispatch.id = source_invalid.id;

  with eligible as (
    select dispatch.id
    from accounts.referral_email_dispatches dispatch
    where dispatch.status in ('pending', 'retry')
      or (dispatch.status = 'sending' and dispatch.lease_expires_at <= now())
    order by dispatch.next_attempt_at, dispatch.created_at, dispatch.id
    for update skip locked
    limit least(400, greatest(p_limit * 4, p_limit))
  ), terminal as (
    select dispatch.id
    from eligible
    join accounts.referral_email_dispatches dispatch on dispatch.id = eligible.id
    where dispatch.expires_at <= now()
      or dispatch.attempt_count >= dispatch.max_attempts
  )
  update accounts.referral_email_dispatches dispatch
  set status = 'dead_letter',
      lease_id = null,
      lease_expires_at = null,
      next_attempt_at = now(),
      last_error_code = case
        when dispatch.expires_at <= now() then 'link_expired'
        else 'retry_exhausted'
      end,
      dead_lettered_at = now(),
      delivery_payload = dispatch.delivery_payload - 'token',
      updated_at = now()
  from terminal
  where dispatch.id = terminal.id;

  with candidates as (
    select dispatch.id
    from accounts.referral_email_dispatches dispatch
    where ((
      dispatch.status in ('pending', 'retry')
      and dispatch.next_attempt_at <= now()
    ) or (
      dispatch.status = 'sending'
      and dispatch.lease_expires_at <= now()
    ))
    and accounts.referral_email_dispatch_source_error(
      dispatch.referral_id,
      dispatch.dispatch_kind,
      dispatch.recipient_hash,
      dispatch.token_hash,
      dispatch.expires_at
    ) is null
    order by dispatch.next_attempt_at, dispatch.created_at, dispatch.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update accounts.referral_email_dispatches dispatch
    set status = 'sending',
        attempt_count = dispatch.attempt_count + 1,
        lease_id = p_lease_id,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        last_error_code = null,
        updated_at = now()
    from candidates
    where dispatch.id = candidates.id
    returning dispatch.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'idempotency_key', claimed.idempotency_key,
        'dispatch_kind', claimed.dispatch_kind,
        'recipient_email', claimed.recipient_email,
        'delivery_payload', claimed.delivery_payload,
        'attempt_count', claimed.attempt_count,
        'expires_at', claimed.expires_at
      )
      order by claimed.next_attempt_at, claimed.created_at, claimed.id
    ),
    '[]'::jsonb
  ) into v_rows
  from claimed;

  return v_rows;
end;
$$;

create or replace function public.roo_complete_referral_email_dispatch(
  p_idempotency_key text,
  p_lease_id uuid,
  p_success boolean,
  p_provider_message_id text default null,
  p_error_code text default null,
  p_retry_delay_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_dispatch accounts.referral_email_dispatches%rowtype;
  v_status text;
  v_error_code text;
begin
  if v_key !~ '^referral-email-[0-9a-f]{64}$'
    or p_lease_id is null
    or char_length(coalesce(p_provider_message_id, '')) > 256
    or char_length(coalesce(p_error_code, '')) > 256
    or coalesce(p_retry_delay_seconds, 0) not between 30 and 3600 then
    raise exception 'invalid referral email completion request'
      using errcode = '22023';
  end if;

  select * into v_dispatch
  from accounts.referral_email_dispatches
  where idempotency_key = v_key
  for update;
  if not found then
    raise exception 'referral email dispatch not found'
      using errcode = 'P0002';
  end if;
  if v_dispatch.status = 'sent' then
    return jsonb_build_object(
      'completed', true,
      'sent', true,
      'idempotent', true,
      'provider_message_id', v_dispatch.provider_message_id
    );
  end if;
  if v_dispatch.status = 'resolved' then
    return jsonb_build_object(
      'completed', true,
      'sent', false,
      'resolved', true,
      'idempotent', true,
      'provider_message_id', v_dispatch.provider_message_id
    );
  end if;
  if v_dispatch.lease_id is distinct from p_lease_id
    or v_dispatch.status <> 'sending' then
    raise exception 'referral email dispatch lease conflict'
      using errcode = '40001';
  end if;

  v_error_code := left(
    regexp_replace(
      coalesce(nullif(btrim(p_error_code), ''), 'email_send_failed'),
      '[^A-Za-z0-9_.:-]',
      '_',
      'g'
    ),
    128
  );
  v_status := case
    when coalesce(p_success, false) then 'sent'
    when v_dispatch.attempt_count >= v_dispatch.max_attempts
      or v_dispatch.expires_at <= now() + make_interval(secs => p_retry_delay_seconds)
      then 'dead_letter'
    else 'retry'
  end;

  update accounts.referral_email_dispatches
  set status = v_status,
      provider_message_id = case
        when coalesce(p_success, false)
          then coalesce(nullif(btrim(p_provider_message_id), ''), provider_message_id)
        else provider_message_id
      end,
      sent_at = case when coalesce(p_success, false) then now() else sent_at end,
      last_error_code = case
        when coalesce(p_success, false) then null
        else v_error_code
      end,
      next_attempt_at = case
        when v_status = 'retry'
          then now() + make_interval(secs => p_retry_delay_seconds)
        else next_attempt_at
      end,
      dead_lettered_at = case when v_status = 'dead_letter' then now() else null end,
      delivery_payload = case
        when v_status = 'sent' then delivery_payload - 'token'
        else delivery_payload
      end,
      lease_id = null,
      lease_expires_at = null,
      updated_at = now()
  where id = v_dispatch.id
  returning * into v_dispatch;

  return jsonb_build_object(
    'completed', true,
    'sent', v_dispatch.status = 'sent',
    'dead_letter', v_dispatch.status = 'dead_letter',
    'status', v_dispatch.status,
    'idempotent', false,
    'provider_message_id', v_dispatch.provider_message_id
  );
end;
$$;

create or replace function public.roo_requeue_referral_email_dispatch(
  p_referral_id text,
  p_dispatch_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referral_id text := btrim(coalesce(p_referral_id, ''));
  v_kind text := lower(btrim(coalesce(p_dispatch_kind, '')));
  v_dispatch accounts.referral_email_dispatches%rowtype;
  v_blocked_reason text;
  v_source_error text;
begin
  if v_referral_id = ''
    or char_length(v_referral_id) > 256
    or v_kind not in ('registration_verification', 'password_reset') then
    raise exception 'invalid referral email requeue request'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'referral-email:' || v_kind || ':' || v_referral_id,
      0
    )
  );

  select * into v_dispatch
  from accounts.referral_email_dispatches dispatch
  where dispatch.referral_id = v_referral_id
    and dispatch.dispatch_kind = v_kind
  order by dispatch.created_at desc, dispatch.id desc
  limit 1
  for update;

  if not found then
    raise exception 'referral email dispatch not found'
      using errcode = 'P0002';
  end if;

  if v_dispatch.status = 'resolved' then
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'idempotency_key', v_dispatch.idempotency_key,
      'status', v_dispatch.status,
      'sent', false,
      'dead_letter', false,
      'requeued', false,
      'idempotent', true,
      'recovery_blocked_reason', 'dispatch_resolved'
    );
  end if;

  if v_dispatch.status <> 'dead_letter' then
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'idempotency_key', v_dispatch.idempotency_key,
      'status', v_dispatch.status,
      'sent', v_dispatch.status = 'sent',
      'dead_letter', false,
      'requeued', false,
      'idempotent', true,
      'recovery_blocked_reason', null
    );
  end if;

  v_source_error := accounts.referral_email_dispatch_source_error(
    v_dispatch.referral_id,
    v_dispatch.dispatch_kind,
    v_dispatch.recipient_hash,
    v_dispatch.token_hash,
    v_dispatch.expires_at
  );
  v_blocked_reason := case
    when v_source_error is not null then v_source_error
    when v_dispatch.expires_at <= now() then 'link_expired'
    when nullif(v_dispatch.delivery_payload->>'token', '') is null
      then 'delivery_token_missing'
    when encode(
      extensions.digest(v_dispatch.delivery_payload->>'token', 'sha256'),
      'hex'
    ) <> v_dispatch.token_hash then 'delivery_token_invalid'
    else null
  end;

  if v_source_error is not null then
    update accounts.referral_email_dispatches
    set last_error_code = 'source_state_changed',
        delivery_payload = delivery_payload - 'token',
        updated_at = now()
    where id = v_dispatch.id;
  end if;

  if v_blocked_reason is not null then
    return jsonb_build_object(
      'dispatch_id', v_dispatch.id,
      'idempotency_key', v_dispatch.idempotency_key,
      'status', v_dispatch.status,
      'sent', false,
      'dead_letter', true,
      'requeued', false,
      'idempotent', true,
      'recovery_blocked_reason', v_blocked_reason
    );
  end if;

  insert into accounts.referral_email_dispatch_actions (
    dispatch_id,
    action,
    previous_status,
    previous_attempt_count,
    actor
  ) values (
    v_dispatch.id,
    'requeue',
    v_dispatch.status,
    v_dispatch.attempt_count,
    'service_role_recovery'
  );

  update accounts.referral_email_dispatches dispatch
  set
    status = 'retry',
    attempt_count = 0,
    next_attempt_at = now(),
    lease_id = null,
    lease_expires_at = null,
    last_error_code = null,
    dead_lettered_at = null,
    updated_at = now()
  where dispatch.id = v_dispatch.id
  returning * into v_dispatch;

  return jsonb_build_object(
    'dispatch_id', v_dispatch.id,
    'idempotency_key', v_dispatch.idempotency_key,
    'status', v_dispatch.status,
    'sent', false,
    'dead_letter', false,
    'requeued', true,
    'idempotent', false,
    'recovery_blocked_reason', null
  );
end;
$$;

revoke all on function accounts.referral_email_dispatch_source_error(
  text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function public.roo_enqueue_referral_email_mutation(
  jsonb, text, text, text, text, text, jsonb, timestamptz
) from public, anon, authenticated;
revoke all on function public.roo_claim_referral_email_dispatch(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.roo_claim_referral_email_dispatches(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.roo_complete_referral_email_dispatch(
  text, uuid, boolean, text, text, integer
) from public, anon, authenticated;
revoke all on function public.roo_requeue_referral_email_dispatch(text, text)
  from public, anon, authenticated;

grant execute on function public.roo_enqueue_referral_email_mutation(
  jsonb, text, text, text, text, text, jsonb, timestamptz
) to service_role;
grant execute on function public.roo_claim_referral_email_dispatch(text, uuid, integer)
  to service_role;
grant execute on function public.roo_claim_referral_email_dispatches(uuid, integer, integer)
  to service_role;
grant execute on function public.roo_complete_referral_email_dispatch(
  text, uuid, boolean, text, text, integer
) to service_role;
grant execute on function public.roo_requeue_referral_email_dispatch(text, text)
  to service_role;

notify pgrst, 'reload schema';
