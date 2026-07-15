set lock_timeout = '5s';
set statement_timeout = '120s';

create table accounts.referral_email_dispatches (
  id uuid primary key default gen_random_uuid(),
  command_id text not null unique,
  idempotency_key text not null unique,
  referral_id text not null,
  dispatch_kind text not null
    check (dispatch_kind in ('registration_verification', 'password_reset')),
  recipient_email text not null,
  recipient_hash text not null check (recipient_hash ~ '^[0-9a-f]{64}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  delivery_payload jsonb not null check (
    jsonb_typeof(delivery_payload) = 'object'
    and octet_length(delivery_payload::text) <= 8192
  ),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'retry', 'sent', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 12 check (max_attempts between 1 and 100),
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error_code text,
  expires_at timestamptz not null,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (recipient_email = lower(btrim(recipient_email))),
  check (char_length(recipient_email) between 3 and 254),
  check (expires_at > created_at),
  check (
    (status = 'sending' and lease_id is not null and lease_expires_at is not null)
    or (status <> 'sending' and lease_id is null and lease_expires_at is null)
  ),
  check ((status = 'sent' and sent_at is not null) or status <> 'sent'),
  check (
    (status = 'dead_letter' and dead_lettered_at is not null)
    or status <> 'dead_letter'
  )
);

create table accounts.referral_email_dispatch_actions (
  id bigint generated always as identity primary key,
  dispatch_id uuid not null
    references accounts.referral_email_dispatches(id) on delete restrict,
  action text not null check (action = 'requeue'),
  previous_status text not null check (previous_status = 'dead_letter'),
  previous_attempt_count integer not null check (previous_attempt_count >= 0),
  actor text not null check (actor = 'service_role_recovery'),
  acted_at timestamptz not null default now()
);

alter table accounts.referral_email_dispatches enable row level security;
alter table accounts.referral_email_dispatch_actions enable row level security;
revoke all on table accounts.referral_email_dispatches,
  accounts.referral_email_dispatch_actions
  from public, anon, authenticated, service_role;
revoke all on sequence accounts.referral_email_dispatch_actions_id_seq
  from public, anon, authenticated, service_role;

create policy "referral_email_dispatches_deny_browser"
  on accounts.referral_email_dispatches
  for all to anon, authenticated using (false) with check (false);
create policy "referral_email_dispatch_actions_deny_browser"
  on accounts.referral_email_dispatch_actions
  for all to anon, authenticated using (false) with check (false);

create index referral_email_dispatches_claim_idx
  on accounts.referral_email_dispatches (next_attempt_at, created_at, id)
  where status in ('pending', 'retry', 'sending');
create index referral_email_dispatches_expired_lease_idx
  on accounts.referral_email_dispatches (lease_expires_at, id)
  where status = 'sending';
create index referral_email_dispatches_dead_letter_idx
  on accounts.referral_email_dispatches (dead_lettered_at desc, id)
  where status = 'dead_letter';
create index referral_email_dispatches_referral_kind_idx
  on accounts.referral_email_dispatches (referral_id, dispatch_kind, created_at desc);
create index referral_email_dispatch_actions_dispatch_idx
  on accounts.referral_email_dispatch_actions (dispatch_id, acted_at desc);

create or replace function accounts.guard_referral_email_dispatch_terminal_state()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = 'sent' and new.status <> 'sent' then
    raise exception 'A sent referral email dispatch cannot regress'
      using errcode = '23514';
  end if;
  if old.status = 'sent' and new is distinct from old then
    raise exception 'A sent referral email dispatch is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_referral_email_dispatch_terminal_state
  on accounts.referral_email_dispatches;
create trigger guard_referral_email_dispatch_terminal_state
before update on accounts.referral_email_dispatches
for each row execute function accounts.guard_referral_email_dispatch_terminal_state();

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

  perform public.roo_apply_document_mutations(p_mutations);
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
  where (
      status in ('pending', 'retry')
      or (status = 'sending' and lease_expires_at <= now())
    )
    and (
      expires_at <= now()
      or attempt_count >= max_attempts
    );

  with candidates as (
    select dispatch.id
    from accounts.referral_email_dispatches dispatch
    where (
      dispatch.status in ('pending', 'retry')
      and dispatch.next_attempt_at <= now()
    ) or (
      dispatch.status = 'sending'
      and dispatch.lease_expires_at <= now()
    )
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

  v_blocked_reason := case
    when v_dispatch.expires_at <= now() then 'link_expired'
    when nullif(v_dispatch.delivery_payload->>'token', '') is null
      then 'delivery_token_missing'
    when encode(
      extensions.digest(v_dispatch.delivery_payload->>'token', 'sha256'),
      'hex'
    ) <> v_dispatch.token_hash then 'delivery_token_invalid'
    else null
  end;

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

create or replace function public.roo_referral_email_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with metrics as (
    select
      count(*) filter (
        where status in ('pending', 'sending', 'retry')
      )::bigint actionable,
      count(*) filter (
        where status = 'dead_letter'
      )::bigint dead_letters,
      count(*) filter (
        where status in ('pending', 'sending', 'retry')
          and created_at < now() - interval '300 seconds'
      )::bigint stale_actionable,
      count(*) filter (
        where status in ('pending', 'retry')
          and next_attempt_at < now() - interval '300 seconds'
      )::bigint overdue_over_300_seconds,
      count(*) filter (
        where status = 'sending' and lease_expires_at < now()
      )::bigint expired_leases,
      coalesce(floor(extract(epoch from (
        now() - min(created_at) filter (
          where status in ('pending', 'sending', 'retry')
        )
      )))::bigint, 0) oldest_actionable_age_seconds,
      coalesce(floor(extract(epoch from (
        now() - min(next_attempt_at) filter (
          where status in ('pending', 'retry')
            and next_attempt_at < now()
        )
      )))::bigint, 0) oldest_overdue_age_seconds
    from accounts.referral_email_dispatches
  )
  select jsonb_build_object(
    'ready', dead_letters = 0
      and stale_actionable = 0
      and overdue_over_300_seconds = 0
      and expired_leases = 0,
    'healthy', dead_letters = 0
      and stale_actionable = 0
      and overdue_over_300_seconds = 0
      and expired_leases = 0,
    'status_counts', coalesce((
      select jsonb_object_agg(status, dispatch_count)
      from (
        select status, count(*)::bigint dispatch_count
        from accounts.referral_email_dispatches
        group by status
      ) counts
    ), '{}'::jsonb),
    'actionable', actionable,
    'dead_letters', dead_letters,
    'stale_actionable', stale_actionable,
    'overdue_over_300_seconds', overdue_over_300_seconds,
    'expired_leases', expired_leases,
    'oldest_actionable_age_seconds', oldest_actionable_age_seconds,
    'oldest_overdue_age_seconds', oldest_overdue_age_seconds
  )
  from metrics;
$$;

revoke all on function accounts.guard_referral_email_dispatch_terminal_state()
  from public, anon, authenticated;
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
revoke all on function public.roo_referral_email_readiness()
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
grant execute on function public.roo_referral_email_readiness()
  to service_role;
