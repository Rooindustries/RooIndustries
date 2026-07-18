set lock_timeout = '5s';
set statement_timeout = '120s';

alter table accounts.credential_operations
  add column if not exists last_error text,
  add column if not exists last_error_class text,
  add column if not exists consecutive_error_count integer not null default 0,
  add column if not exists next_retry_at timestamptz,
  add column if not exists source_recovery_blocked_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'accounts.credential_operations'::regclass
      and conname = 'credential_operations_last_error_class_check'
  ) then
    alter table accounts.credential_operations
      add constraint credential_operations_last_error_class_check
      check (
        last_error_class is null
        or last_error_class in ('deterministic', 'transient')
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'accounts.credential_operations'::regclass
      and conname = 'credential_operations_consecutive_error_count_check'
  ) then
    alter table accounts.credential_operations
      add constraint credential_operations_consecutive_error_count_check
      check (consecutive_error_count >= 0) not valid;
  end if;
end;
$$;

alter table accounts.credential_operations
  validate constraint credential_operations_last_error_class_check;
alter table accounts.credential_operations
  validate constraint credential_operations_consecutive_error_count_check;

create index if not exists credential_operations_retry_ready_idx
  on accounts.credential_operations (
    coalesce(next_retry_at, '-infinity'::timestamptz),
    created_at
  )
  where status in ('prepared', 'auth_applied')
    and not source_recovery_blocked;

create or replace function public.roo_record_credential_recovery_failure(
  p_operation_key text,
  p_expected_status text,
  p_error_code text,
  p_error_message text default null,
  p_error_class text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row accounts.credential_operations%rowtype;
  v_error_code text := upper(left(btrim(coalesce(p_error_code, '')), 128));
  v_error_class text;
  v_error_message text;
  v_attempt_count integer;
  v_consecutive_error_count integer;
  v_park boolean;
  v_next_retry_at timestamptz;
begin
  if p_expected_status not in ('prepared', 'auth_applied')
     or v_error_code = ''
     or (
       p_error_class is not null
       and p_error_class not in ('deterministic', 'transient')
     ) then
    raise exception 'Credential recovery failure input is invalid'
      using errcode = '22023';
  end if;

  v_error_class := coalesce(
    p_error_class,
    case
      when v_error_code in (
        '40001',
        '55000',
        'P0002',
        'SOURCE_REVISION_CONFLICT',
        'CREDENTIAL_AUTH_PLAINTEXT_REQUIRED',
        'CREDENTIAL_MIRROR_DEAD_LETTER',
        'CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE',
        'CREDENTIAL_SOURCE_PRECONDITION_CHANGED',
        'CREDENTIAL_SOURCE_REPAIR_REQUIRED'
      ) then 'deterministic'
      else 'transient'
    end
  );
  v_error_message := left(
    coalesce(
      nullif(btrim(p_error_message), ''),
      case v_error_code
        when '40001' then 'Credential source precondition changed.'
        when '55000' then 'Credential source operation is not ready.'
        when 'P0002' then 'Credential source document is unavailable.'
        when 'SOURCE_REVISION_CONFLICT' then 'Credential source revision changed.'
        when 'CREDENTIAL_AUTH_PLAINTEXT_REQUIRED' then
          'Credential recovery requires the original password request.'
        when 'CREDENTIAL_MIRROR_DEAD_LETTER' then
          'Credential fallback mirror requires manual repair.'
        when 'CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE' then
          'Credential source document is unavailable.'
        when 'CREDENTIAL_SOURCE_PRECONDITION_CHANGED' then
          'Credential source precondition changed.'
        when 'CREDENTIAL_SOURCE_REPAIR_REQUIRED' then
          'Credential source operation requires audited repair.'
        when 'CREDENTIAL_SOURCE_WRITE_CONFLICT' then
          'Credential source write conflicted with another transaction.'
        else replace(initcap(lower(v_error_code)), '_', ' ') || '.'
      end
    ),
    512
  );

  select *
  into v_row
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_row.status in ('mirrored', 'failed') then
    return jsonb_build_object(
      'status', v_row.status,
      'retry_status', 'terminal',
      'idempotent', true,
      'parked', v_row.source_recovery_blocked,
      'attempt_count', v_row.attempt_count,
      'error_code', v_row.last_error_code,
      'last_error', v_row.last_error
    );
  end if;

  if v_row.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_row.attempt_count,
      'error_code', v_row.last_error_code,
      'last_error', v_row.last_error,
      'error_class', v_row.last_error_class,
      'parked_at', v_row.source_recovery_blocked_at
    );
  end if;

  if v_row.status is distinct from p_expected_status then
    return jsonb_build_object(
      'status', v_row.status,
      'retry_status', 'stale',
      'idempotent', true,
      'parked', false,
      'attempt_count', v_row.attempt_count
    );
  end if;

  if v_row.next_retry_at is not null and v_row.next_retry_at > now() then
    return jsonb_build_object(
      'status', 'backoff',
      'retry_status', 'backoff',
      'idempotent', true,
      'parked', false,
      'attempt_count', v_row.attempt_count,
      'error_code', v_row.last_error_code,
      'last_error', v_row.last_error,
      'error_class', v_row.last_error_class,
      'next_retry_at', v_row.next_retry_at
    );
  end if;

  v_attempt_count := least(v_row.attempt_count + 1, 6);
  v_consecutive_error_count := case
    when v_row.last_error_code = v_error_code
      and v_row.last_error_class = v_error_class
      then v_row.consecutive_error_count + 1
    else 1
  end;
  v_park := (
    v_error_class = 'deterministic'
    and v_consecutive_error_count >= 2
  ) or v_attempt_count >= 6;
  v_next_retry_at := case
    when v_park then null
    when v_error_class = 'deterministic' then now() + interval '5 minutes'
    else now() + least(
      interval '1 hour',
      interval '1 minute' * power(2, least(v_attempt_count - 1, 6))
    )
  end;

  update accounts.credential_operations operation
  set
    attempt_count = v_attempt_count,
    last_error_code = v_error_code,
    last_error = v_error_message,
    last_error_class = v_error_class,
    consecutive_error_count = v_consecutive_error_count,
    next_retry_at = v_next_retry_at,
    source_recovery_blocked = v_park,
    source_recovery_blocked_at = case
      when v_park then coalesce(operation.source_recovery_blocked_at, now())
      else null
    end,
    updated_at = now()
  where operation.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'status', case when v_park then 'parked' else 'backoff' end,
    'retry_status', case when v_park then 'parked' else 'backoff' end,
    'idempotent', false,
    'parked', v_park,
    'attempt_count', v_row.attempt_count,
    'consecutive_error_count', v_row.consecutive_error_count,
    'error_code', v_row.last_error_code,
    'last_error', v_row.last_error,
    'error_class', v_row.last_error_class,
    'next_retry_at', v_row.next_retry_at,
    'parked_at', v_row.source_recovery_blocked_at
  );
end;
$$;

create or replace function public.roo_record_credential_recovery_error(
  p_operation_key text,
  p_expected_status text,
  p_error_code text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.roo_record_credential_recovery_failure(
    p_operation_key,
    p_expected_status,
    p_error_code,
    null,
    null
  );
$$;

create or replace function public.roo_get_credential_operation(
  p_operation_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'operation_key', operation.operation_key,
    'user_id', operation.user_id,
    'principal_id', operation.principal_id,
    'password_hash', operation.password_hash,
    'status', operation.status,
    'source_revision', operation.source_revision,
    'source_backend', operation.source_backend,
    'source_document_id', operation.source_document_id,
    'source_expected_revision', operation.source_expected_revision,
    'source_preconditions', operation.source_preconditions,
    'source_mutation', operation.source_mutation,
    'source_applied_revision', operation.source_applied_revision,
    'source_applied_at', operation.source_applied_at,
    'sessions_revoked_at', operation.sessions_revoked_at,
    'source_recovery_blocked', operation.source_recovery_blocked,
    'source_recovery_blocked_at', operation.source_recovery_blocked_at,
    'creator_legacy_sanity_id', creator.legacy_sanity_id,
    'attempt_count', operation.attempt_count,
    'consecutive_error_count', operation.consecutive_error_count,
    'last_error_code', operation.last_error_code,
    'last_error', operation.last_error,
    'last_error_class', operation.last_error_class,
    'next_retry_at', operation.next_retry_at
  )
  from accounts.credential_operations operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id
  where operation.operation_key = p_operation_key;
$$;

create or replace function public.roo_mark_credential_operation(
  p_operation_key text,
  p_status text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_version bigint;
  v_row accounts.credential_operations%rowtype;
begin
  if p_status not in ('auth_applied', 'mirrored', 'failed') then
    raise exception 'Credential status is invalid'
      using errcode = '22023';
  end if;

  select operation.principal_id
  into v_principal_id
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  select principal.session_version
  into v_version
  from accounts.principals principal
  where principal.id = v_principal_id
  for update;

  if not found then
    raise exception 'Credential principal was not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_row
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if v_row.principal_id is distinct from v_principal_id then
    raise exception 'Credential operation principal changed'
      using errcode = '55000';
  end if;

  if v_row.status = 'mirrored' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'session_version', v_version,
      'idempotent', true
    );
  end if;

  if v_row.status = 'auth_applied' and p_status = 'auth_applied' then
    if v_row.sessions_revoked_at is null then
      update accounts.principals principal
      set
        session_version = principal.session_version + 1,
        updated_at = now()
      where principal.id = v_principal_id
        and principal.status = 'active'
      returning principal.session_version into v_version;

      if v_version is null then
        raise exception 'Active principal was not found'
          using errcode = 'P0002';
      end if;

      delete from auth.sessions session
      where session.user_id in (
        select mapping.user_id
        from accounts.principal_auth_users mapping
        where mapping.principal_id = v_principal_id
      );

      update accounts.credential_operations operation
      set
        sessions_revoked_at = now(),
        updated_at = now()
      where operation.id = v_row.id
      returning * into v_row;
    end if;
    perform public.roo_complete_credential_migration(v_row.user_id);
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'session_version', v_version,
      'idempotent', true
    );
  end if;

  if p_status = 'mirrored'
     or (p_status = 'failed' and v_row.status <> 'prepared')
     or v_row.status not in ('prepared', 'auth_applied') then
    raise exception 'Credential status transition is invalid'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    status = p_status,
    attempt_count = case
      when p_status = 'auth_applied' then 0
      else operation.attempt_count
    end,
    last_error_code = nullif(left(coalesce(p_error_code, ''), 128), ''),
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    source_recovery_blocked = case
      when p_status = 'auth_applied' then false
      else operation.source_recovery_blocked
    end,
    source_recovery_blocked_at = case
      when p_status = 'auth_applied' then null
      else operation.source_recovery_blocked_at
    end,
    auth_applied_at = case
      when p_status = 'auth_applied'
        then coalesce(operation.auth_applied_at, now())
      else operation.auth_applied_at
    end,
    updated_at = now()
  where operation.id = v_row.id
  returning * into v_row;

  if p_status = 'auth_applied' then
    update accounts.principals principal
    set
      session_version = principal.session_version + 1,
      updated_at = now()
    where principal.id = v_principal_id
      and principal.status = 'active'
    returning principal.session_version into v_version;

    if v_version is null then
      raise exception 'Active principal was not found'
        using errcode = 'P0002';
    end if;

    delete from auth.sessions session
    where session.user_id in (
      select mapping.user_id
      from accounts.principal_auth_users mapping
      where mapping.principal_id = v_principal_id
    );

    update accounts.credential_operations operation
    set
      sessions_revoked_at = now(),
      updated_at = now()
    where operation.id = v_row.id
    returning * into v_row;

    perform public.roo_complete_credential_migration(v_row.user_id);
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'session_version', v_version,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_apply_credential_source_operation(
  p_operation_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation accounts.credential_operations%rowtype;
  v_source migration.source_documents%rowtype;
  v_set jsonb;
  v_unset text[];
  v_document jsonb;
  v_results jsonb;
  v_applied_revision text;
  v_retry jsonb;
begin
  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'parked_at', v_operation.source_recovery_blocked_at
    );
  end if;

  if v_operation.attempt_count >= 6 then
    update accounts.credential_operations operation
    set
      source_recovery_blocked = true,
      source_recovery_blocked_at = coalesce(
        operation.source_recovery_blocked_at,
        now()
      ),
      next_retry_at = null,
      last_error_code = coalesce(
        operation.last_error_code,
        'CREDENTIAL_RECOVERY_ATTEMPT_LIMIT'
      ),
      last_error = coalesce(
        operation.last_error,
        'Credential recovery reached the automatic attempt limit.'
      ),
      last_error_class = coalesce(operation.last_error_class, 'transient'),
      updated_at = now()
    where operation.id = v_operation.id
    returning * into v_operation;

    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', false,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'parked_at', v_operation.source_recovery_blocked_at
    );
  end if;

  if v_operation.next_retry_at is not null
     and v_operation.next_retry_at > now() then
    return jsonb_build_object(
      'status', 'backoff',
      'retry_status', 'backoff',
      'idempotent', true,
      'parked', false,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'error_class', v_operation.last_error_class,
      'next_retry_at', v_operation.next_retry_at
    );
  end if;

  if v_operation.source_backend <> 'supabase'
     or v_operation.status not in ('auth_applied', 'mirrored') then
    return jsonb_build_object(
      'status', 'not_ready',
      'retry_status', 'not_ready',
      'idempotent', true,
      'parked', false,
      'error_code', 'CREDENTIAL_SOURCE_NOT_READY'
    );
  end if;

  if v_operation.source_applied_at is not null then
    return jsonb_build_object(
      'status', 'source_applied',
      'source_document_id', v_operation.source_document_id,
      'source_revision', v_operation.source_applied_revision,
      'idempotent', true
    );
  end if;

  select *
  into v_source
  from migration.source_documents source
  where source.legacy_sanity_id = v_operation.source_document_id
    and not source.tombstoned
  for update;

  if not found then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_DOCUMENT_UNAVAILABLE',
      'Credential source document is unavailable.',
      'deterministic'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end if;

  if v_operation.source_preconditions is null
     or v_operation.source_preconditions = '{}'::jsonb
     or not (v_source.payload @> v_operation.source_preconditions) then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_PRECONDITION_CHANGED',
      'Credential source precondition changed.',
      'deterministic'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end if;

  v_set := v_operation.source_mutation->'set';
  select coalesce(array_agg(field), '{}'::text[])
  into v_unset
  from jsonb_array_elements_text(v_operation.source_mutation->'unset') field;
  v_document := (v_source.payload || v_set) - v_unset;

  begin
    v_results := public.roo_apply_document_mutations(
      jsonb_build_array(
        jsonb_build_object(
          'operation', 'replace',
          'id', v_operation.source_document_id,
          'expected_revision', v_source.source_revision,
          'document', v_document
        )
      )
    );
  exception when sqlstate '40001' then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'CREDENTIAL_SOURCE_WRITE_CONFLICT',
      'Credential source write conflicted with another transaction.',
      'transient'
    );
    return v_retry || jsonb_build_object(
      'source_document_id', v_operation.source_document_id
    );
  end;

  v_applied_revision := nullif(v_results->0->>'_rev', '');

  if v_applied_revision is null then
    raise exception 'Credential source mutation did not return a revision'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    source_applied_revision = v_applied_revision,
    source_applied_at = now(),
    last_error_code = null,
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'source_applied',
    'source_document_id', v_operation.source_document_id,
    'source_revision', v_applied_revision,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_mark_credential_source_applied(
  p_operation_key text,
  p_source_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation accounts.credential_operations%rowtype;
  v_retry jsonb;
begin
  if nullif(btrim(p_source_revision), '') is null then
    raise exception 'Credential source revision is invalid'
      using errcode = '22023';
  end if;

  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'parked_at', v_operation.source_recovery_blocked_at
    );
  end if;

  if v_operation.next_retry_at is not null
     and v_operation.next_retry_at > now() then
    return jsonb_build_object(
      'status', 'backoff',
      'retry_status', 'backoff',
      'idempotent', true,
      'parked', false,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error,
      'next_retry_at', v_operation.next_retry_at
    );
  end if;

  if v_operation.source_backend <> 'sanity'
     or v_operation.status not in ('auth_applied', 'mirrored') then
    return jsonb_build_object(
      'status', 'not_ready',
      'retry_status', 'not_ready',
      'idempotent', true,
      'parked', false,
      'error_code', 'CREDENTIAL_SOURCE_NOT_READY'
    );
  end if;

  if v_operation.source_applied_at is not null
     and v_operation.source_applied_revision is distinct from p_source_revision then
    v_retry := public.roo_record_credential_recovery_failure(
      p_operation_key,
      v_operation.status,
      'SOURCE_REVISION_CONFLICT',
      'Credential source revision conflicts with the stored checkpoint.',
      'deterministic'
    );
    return v_retry;
  end if;

  update accounts.credential_operations operation
  set
    source_applied_revision = coalesce(
      operation.source_applied_revision,
      p_source_revision
    ),
    source_applied_at = coalesce(operation.source_applied_at, now()),
    last_error_code = null,
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'source_applied',
    'source_document_id', v_operation.source_document_id,
    'source_revision', coalesce(
      v_operation.source_applied_revision,
      p_source_revision
    ),
    'idempotent', v_operation.source_applied_at is not null
  );
end;
$$;

create or replace function public.roo_complete_credential_operation(
  p_operation_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_operation accounts.credential_operations%rowtype;
  v_version bigint;
begin
  select operation.principal_id
  into v_principal_id
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  select principal.session_version
  into v_version
  from accounts.principals principal
  where principal.id = v_principal_id
  for update;

  if not found then
    raise exception 'Credential principal was not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_operation
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if v_operation.principal_id is distinct from v_principal_id then
    raise exception 'Credential operation principal changed'
      using errcode = '55000';
  end if;

  if v_operation.status = 'mirrored' then
    return jsonb_build_object(
      'status', 'mirrored',
      'session_version', v_version,
      'idempotent', true
    );
  end if;

  if v_operation.status <> 'auth_applied' then
    raise exception 'Credential operation is not ready to complete'
      using errcode = '55000';
  end if;

  if v_operation.sessions_revoked_at is null then
    raise exception 'Credential sessions have not been revoked'
      using errcode = '55000';
  end if;

  if v_operation.source_recovery_blocked then
    return jsonb_build_object(
      'status', 'parked',
      'retry_status', 'parked',
      'idempotent', true,
      'parked', true,
      'attempt_count', v_operation.attempt_count,
      'error_code', v_operation.last_error_code,
      'last_error', v_operation.last_error
    );
  end if;

  if v_operation.source_backend is not null
     and v_operation.source_applied_at is null then
    raise exception 'Credential source operation is not complete'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    status = 'mirrored',
    last_error_code = null,
    last_error = null,
    last_error_class = null,
    consecutive_error_count = 0,
    next_retry_at = null,
    mirrored_at = coalesce(operation.mirrored_at, now()),
    updated_at = now()
  where operation.id = v_operation.id;

  return jsonb_build_object(
    'status', 'mirrored',
    'session_version', v_version,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_list_credential_recovery(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_operation_key text;
begin
  update accounts.credential_operations operation
  set
    source_recovery_blocked = true,
    source_recovery_blocked_at = coalesce(
      operation.source_recovery_blocked_at,
      now()
    ),
    next_retry_at = null,
    last_error_code = coalesce(
      operation.last_error_code,
      'CREDENTIAL_RECOVERY_ATTEMPT_LIMIT'
    ),
    last_error = coalesce(
      operation.last_error,
      'Credential recovery reached the automatic attempt limit.'
    ),
    last_error_class = coalesce(operation.last_error_class, 'transient'),
    updated_at = now()
  where operation.status in ('prepared', 'auth_applied')
    and not operation.source_recovery_blocked
    and operation.attempt_count >= 6;

  for v_operation_key in
    select operation.operation_key
    from accounts.principals principal
    join accounts.credential_operations operation
      on operation.principal_id = principal.id
    left join auth.users auth_user on auth_user.id = operation.user_id
    where not operation.source_recovery_blocked
      and operation.attempt_count < 6
      and (
        operation.next_retry_at is null
        or operation.next_retry_at <= now()
      )
      and (
        (
          operation.status = 'auth_applied'
          and operation.sessions_revoked_at is null
        ) or (
          operation.status = 'prepared'
          and auth_user.encrypted_password = operation.password_hash
        )
      )
    order by operation.created_at
    for update of principal skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  loop
    perform public.roo_mark_credential_operation(
      v_operation_key,
      'auth_applied',
      null
    );
  end loop;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'operation_key', operation.operation_key,
        'user_id', operation.user_id,
        'principal_id', operation.principal_id,
        'password_hash', operation.password_hash,
        'status', operation.status,
        'source_revision', operation.source_revision,
        'source_backend', operation.source_backend,
        'source_document_id', operation.source_document_id,
        'source_expected_revision', operation.source_expected_revision,
        'source_preconditions', operation.source_preconditions,
        'source_mutation', operation.source_mutation,
        'source_applied_revision', operation.source_applied_revision,
        'source_applied_at', operation.source_applied_at,
        'sessions_revoked_at', operation.sessions_revoked_at,
        'source_recovery_blocked', operation.source_recovery_blocked,
        'source_recovery_blocked_at', operation.source_recovery_blocked_at,
        'creator_legacy_sanity_id', creator.legacy_sanity_id,
        'attempt_count', operation.attempt_count,
        'consecutive_error_count', operation.consecutive_error_count,
        'last_error_code', operation.last_error_code,
        'last_error', operation.last_error,
        'last_error_class', operation.last_error_class,
        'next_retry_at', operation.next_retry_at
      )
      order by operation.created_at
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select candidate.*
    from accounts.credential_operations candidate
    where candidate.status in ('prepared', 'auth_applied')
      and not candidate.source_recovery_blocked
      and candidate.attempt_count < 6
      and (
        candidate.next_retry_at is null
        or candidate.next_retry_at <= now()
      )
    order by candidate.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  ) operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id;

  return v_result;
end;
$$;

create schema if not exists ops;
grant usage on schema ops to service_role;

create or replace view ops.credential_failures
with (security_invoker = true)
as
select
  operation.operation_key as "operationKey",
  operation.user_id as "userId",
  operation.principal_id as "principalId",
  operation.status,
  operation.source_backend as "sourceBackend",
  operation.source_document_id as "sourceDocumentId",
  operation.attempt_count as "attemptCount",
  operation.consecutive_error_count as "consecutiveErrorCount",
  operation.last_error_code as "lastErrorCode",
  coalesce(
    operation.last_error,
    operation.last_error_code,
    'no failure reason recorded'
  ) as "lastError",
  operation.last_error_class as "errorClass",
  case
    when operation.source_recovery_blocked then 'parked'
    when operation.attempt_count >= 6 then 'attempt limit reached'
    when operation.next_retry_at > now() then 'retry scheduled'
    when operation.next_retry_at is not null then 'retry due'
    else 'needs attention'
  end as verdict,
  operation.next_retry_at as "nextRetryUTC",
  case when operation.next_retry_at is not null then to_char(
    operation.next_retry_at at time zone 'Asia/Kolkata',
    'DD Mon YYYY, HH12:MI AM'
  ) || ' IST' end as "nextRetryIST",
  operation.source_recovery_blocked as "parked",
  operation.source_recovery_blocked_at as "parkedUTC",
  case when operation.source_recovery_blocked_at is not null then to_char(
    operation.source_recovery_blocked_at at time zone 'Asia/Kolkata',
    'DD Mon YYYY, HH12:MI AM'
  ) || ' IST' end as "parkedIST",
  operation.created_at as "createdUTC",
  operation.updated_at as "updatedUTC"
from accounts.credential_operations operation
where operation.source_recovery_blocked
   or (
     operation.status in ('prepared', 'auth_applied')
     and (
       operation.last_error_code is not null
       or operation.next_retry_at is not null
       or operation.attempt_count >= 6
     )
   )
order by
  operation.source_recovery_blocked desc,
  operation.updated_at desc,
  operation.created_at desc;

revoke all on function public.roo_record_credential_recovery_failure(
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;
revoke all on function public.roo_record_credential_recovery_error(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_get_credential_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_mark_credential_operation(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_apply_credential_source_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_mark_credential_source_applied(text, text)
  from public, anon, authenticated;
revoke all on function public.roo_complete_credential_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_list_credential_recovery(integer)
  from public, anon, authenticated;
revoke all on table ops.credential_failures from public, anon, authenticated;

grant execute on function public.roo_record_credential_recovery_failure(
  text,
  text,
  text,
  text,
  text
) to service_role;
grant execute on function public.roo_record_credential_recovery_error(text, text, text)
  to service_role;
grant execute on function public.roo_get_credential_operation(text)
  to service_role;
grant execute on function public.roo_mark_credential_operation(text, text, text)
  to service_role;
grant execute on function public.roo_apply_credential_source_operation(text)
  to service_role;
grant execute on function public.roo_mark_credential_source_applied(text, text)
  to service_role;
grant execute on function public.roo_complete_credential_operation(text)
  to service_role;
grant execute on function public.roo_list_credential_recovery(integer)
  to service_role;
grant select on table ops.credential_failures to service_role;
