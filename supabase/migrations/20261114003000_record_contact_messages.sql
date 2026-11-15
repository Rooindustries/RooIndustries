set lock_timeout = '5s';
set statement_timeout = '120s';

do $migration$
begin
  create schema if not exists ops;

  create table if not exists ops.contact_messages (
    id uuid primary key default gen_random_uuid(),
    name text not null check (char_length(name) between 1 and 100),
    email text not null check (char_length(email) between 3 and 254),
    message text not null check (char_length(message) between 10 and 5000),
    client_hash text check (client_hash is null or client_hash ~ '^[a-f0-9]{64}$'),
    status text not null default 'pending'
      check (status in ('pending', 'sent', 'failed', 'dead', 'spam')),
    attempts integer not null default 0 check (attempts >= 0),
    last_error_code text check (last_error_code is null or char_length(last_error_code) <= 80),
    provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 200),
    next_attempt_at timestamptz,
    lease_until timestamptz,
    created_at timestamptz not null default now(),
    sent_at timestamptz
  );

  create index if not exists contact_messages_retry_idx
    on ops.contact_messages (next_attempt_at)
    where status in ('pending', 'failed');

  create index if not exists contact_messages_purge_idx
    on ops.contact_messages (created_at)
    where status in ('sent', 'spam');

  alter table ops.contact_messages enable row level security;
  revoke all on table ops.contact_messages from public, anon, authenticated;

  create or replace function public.roo_record_contact_message(
    p_name text,
    p_email text,
    p_message text,
    p_client_hash text,
    p_status text
  )
  returns uuid
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  declare
    v_id uuid;
  begin
    if p_status is null or p_status not in ('pending', 'spam') then
      raise exception 'contact message status is invalid' using errcode = '22023';
    end if;

    insert into ops.contact_messages (name, email, message, client_hash, status, next_attempt_at)
    values (
      p_name,
      p_email,
      p_message,
      nullif(p_client_hash, ''),
      p_status,
      case when p_status = 'pending' then now() + interval '10 minutes' end
    )
    returning id into v_id;

    return v_id;
  end;
  $$;

  create or replace function public.roo_complete_contact_message(
    p_id uuid,
    p_sent boolean,
    p_provider_message_id text,
    p_error_code text
  )
  returns text
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  declare
    v_row ops.contact_messages%rowtype;
    v_attempts integer;
  begin
    select * into v_row
    from ops.contact_messages
    where id = p_id
    for update;

    if not found then
      raise exception 'contact message not found' using errcode = 'P0002';
    end if;

    if v_row.status not in ('pending', 'failed') then
      return v_row.status;
    end if;

    v_attempts := v_row.attempts + 1;

    if coalesce(p_sent, false) then
      update ops.contact_messages
      set status = 'sent',
        attempts = v_attempts,
        provider_message_id = left(nullif(p_provider_message_id, ''), 200),
        last_error_code = null,
        next_attempt_at = null,
        lease_until = null,
        sent_at = now()
      where id = p_id;
      return 'sent';
    end if;

    update ops.contact_messages
    set status = case when v_attempts >= 5 then 'dead' else 'failed' end,
      attempts = v_attempts,
      last_error_code = left(coalesce(nullif(p_error_code, ''), 'email_send_failed'), 80),
      next_attempt_at = case
        when v_attempts >= 5 then null
        else now() + make_interval(mins => 5 * power(2, v_attempts - 1)::integer)
      end,
      lease_until = null
    where id = p_id;

    return case when v_attempts >= 5 then 'dead' else 'failed' end;
  end;
  $$;

  create or replace function public.roo_claim_contact_retries(p_limit integer)
  returns table (
    id uuid,
    name text,
    email text,
    message text,
    attempts integer
  )
  language plpgsql
  volatile
  security definer
  set search_path = ''
  as $$
  begin
    delete from ops.contact_messages as purged
    where purged.status in ('sent', 'spam')
      and purged.created_at < now() - interval '30 days';

    return query
    with due as (
      select candidate.id
      from ops.contact_messages as candidate
      where candidate.status in ('pending', 'failed')
        and candidate.next_attempt_at <= now()
        and (candidate.lease_until is null or candidate.lease_until <= now())
      order by candidate.next_attempt_at, candidate.created_at
      limit greatest(1, least(coalesce(p_limit, 20), 100))
      for update skip locked
    )
    update ops.contact_messages as claimed
    set lease_until = now() + interval '5 minutes'
    from due
    where claimed.id = due.id
    returning claimed.id, claimed.name, claimed.email, claimed.message, claimed.attempts;
  end;
  $$;

  revoke all on function public.roo_record_contact_message(text, text, text, text, text)
    from public, anon, authenticated;
  grant execute on function public.roo_record_contact_message(text, text, text, text, text)
    to service_role;

  revoke all on function public.roo_complete_contact_message(uuid, boolean, text, text)
    from public, anon, authenticated;
  grant execute on function public.roo_complete_contact_message(uuid, boolean, text, text)
    to service_role;

  revoke all on function public.roo_claim_contact_retries(integer)
    from public, anon, authenticated;
  grant execute on function public.roo_claim_contact_retries(integer)
    to service_role;

  notify pgrst, 'reload schema';
end;
$migration$;
