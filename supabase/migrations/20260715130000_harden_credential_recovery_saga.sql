set lock_timeout = '5s';
set statement_timeout = '120s';

alter table accounts.credential_operations
  add column source_backend text,
  add column source_document_id text,
  add column source_expected_revision text,
  add column source_preconditions jsonb,
  add column source_mutation jsonb,
  add column source_applied_revision text,
  add column source_applied_at timestamptz,
  add column sessions_revoked_at timestamptz,
  add column source_recovery_blocked boolean not null default false;

alter table accounts.credential_operations
  add constraint credential_operations_source_backend_check
    check (source_backend in ('sanity', 'supabase')) not valid,
  add constraint credential_operations_source_document_id_check
    check (
      source_document_id is null
      or (
        source_document_id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
        and position('..' in source_document_id) = 0
      )
    ) not valid,
  add constraint credential_operations_source_mutation_check
    check (source_mutation is null or jsonb_typeof(source_mutation) = 'object') not valid,
  add constraint credential_operations_source_preconditions_check
    check (
      source_preconditions is null
      or jsonb_typeof(source_preconditions) = 'object'
    ) not valid,
  add constraint credential_operations_source_applied_check
    check (
      (source_applied_at is null and source_applied_revision is null)
      or (source_applied_at is not null and source_applied_revision is not null)
    ) not valid;

alter table accounts.credential_operations
  validate constraint credential_operations_source_backend_check;
alter table accounts.credential_operations
  validate constraint credential_operations_source_document_id_check;
alter table accounts.credential_operations
  validate constraint credential_operations_source_mutation_check;
alter table accounts.credential_operations
  validate constraint credential_operations_source_preconditions_check;
alter table accounts.credential_operations
  validate constraint credential_operations_source_applied_check;

update accounts.credential_operations operation
set
  source_backend = case
    when creator.backend_owner in ('sanity', 'supabase')
      then creator.backend_owner
    else 'sanity'
  end,
  source_document_id = creator.legacy_sanity_id,
  source_expected_revision = operation.source_revision,
  source_preconditions = coalesce(
    jsonb_strip_nulls(
      jsonb_build_object(
        'creatorPassword', source.payload->'creatorPassword',
        'credentialVersion', source.payload->'credentialVersion',
        'resetTokenHash', source.payload->'resetTokenHash',
        'resetTokenExpiresAt', source.payload->'resetTokenExpiresAt'
      )
    ),
    '{}'::jsonb
  ),
  source_mutation = jsonb_build_object(
    'set', jsonb_build_object(
      'creatorPassword', operation.password_hash,
      'credentialVersion', 2,
      'passwordLoginEnabled', true,
      'passwordResetRequired', false,
      'passwordChangedAt', coalesce(
        operation.auth_applied_at,
        operation.created_at
      )
    ),
    'unset', jsonb_build_array(
      'resetToken',
      'resetTokenHash',
      'resetTokenExpiresAt',
      'resetDeliveryToken'
    )
  )
from accounts.creator_profiles creator
join migration.source_documents source
  on source.legacy_sanity_id = creator.legacy_sanity_id
where creator.principal_id = operation.principal_id
  and operation.status in ('prepared', 'auth_applied')
  and operation.source_backend is null
  and creator.legacy_sanity_id is not null
  and operation.source_revision is not null
  and jsonb_strip_nulls(
    jsonb_build_object(
      'creatorPassword', source.payload->'creatorPassword',
      'credentialVersion', source.payload->'credentialVersion',
      'resetTokenHash', source.payload->'resetTokenHash',
      'resetTokenExpiresAt', source.payload->'resetTokenExpiresAt'
    )
  ) <> '{}'::jsonb;

update accounts.credential_operations operation
set
  source_recovery_blocked = true,
  last_error_code = 'CREDENTIAL_SOURCE_REPAIR_REQUIRED',
  updated_at = now()
where operation.status in ('prepared', 'auth_applied')
  and operation.source_backend is null;

do $$
begin
  if exists (
    select operation.principal_id
    from accounts.credential_operations operation
    where operation.status in ('prepared', 'auth_applied')
    group by operation.principal_id
    having count(*) > 1
  ) then
    raise exception 'Multiple active credential operations require repair'
      using errcode = '23505';
  end if;
end;
$$;

create unique index credential_operations_one_active_principal_idx
  on accounts.credential_operations (principal_id)
  where status in ('prepared', 'auth_applied');

create or replace function public.roo_prepare_credential_operation_v2(
  p_operation_key text,
  p_user_id uuid,
  p_password_hash text,
  p_source_backend text,
  p_source_document_id text,
  p_source_expected_revision text,
  p_source_preconditions jsonb,
  p_source_mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal_id uuid;
  v_existing accounts.credential_operations%rowtype;
  v_row accounts.credential_operations%rowtype;
  v_set jsonb := p_source_mutation->'set';
  v_unset jsonb := p_source_mutation->'unset';
  v_allowed_preconditions constant text[] := array[
    'creatorPassword',
    'credentialVersion',
    'resetTokenHash',
    'resetTokenExpiresAt'
  ];
  v_allowed_set constant text[] := array[
    'creatorPassword',
    'credentialVersion',
    'passwordLoginEnabled',
    'passwordResetRequired',
    'passwordChangedAt'
  ];
  v_allowed_unset constant text[] := array[
    'resetToken',
    'resetTokenHash',
    'resetTokenExpiresAt',
    'resetDeliveryToken'
  ];
begin
  select mapping.principal_id
  into v_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;

  if v_principal_id is null
     or p_password_hash !~ '^[$]2[aby][$][0-9]{2}[$]'
     or nullif(btrim(p_operation_key), '') is null
     or p_source_backend not in ('sanity', 'supabase')
     or p_source_document_id is null
     or p_source_document_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
     or position('..' in p_source_document_id) > 0
     or nullif(btrim(p_source_expected_revision), '') is null
     or jsonb_typeof(p_source_preconditions) <> 'object'
     or coalesce(p_source_preconditions, '{}'::jsonb) = '{}'::jsonb
     or jsonb_typeof(p_source_mutation) <> 'object'
     or jsonb_typeof(v_set) <> 'object'
     or jsonb_typeof(v_unset) <> 'array'
     or v_set->>'creatorPassword' is distinct from p_password_hash
     or v_set->'credentialVersion' is distinct from '2'::jsonb
     or v_set->'passwordLoginEnabled' is distinct from 'true'::jsonb
     or v_set->'passwordResetRequired' is distinct from 'false'::jsonb
     or nullif(btrim(v_set->>'passwordChangedAt'), '') is null
     or exists (
       select 1
       from jsonb_object_keys(p_source_preconditions) field
       where not (field = any(v_allowed_preconditions))
     )
     or exists (
       select 1
       from jsonb_object_keys(v_set) field
       where not (field = any(v_allowed_set))
     )
     or exists (
       select 1
       from jsonb_array_elements_text(v_unset) field
       where not (field = any(v_allowed_unset))
     ) then
    raise exception 'Credential source operation is invalid'
      using errcode = '22023';
  end if;

  perform (v_set->>'passwordChangedAt')::timestamptz;

  perform 1
  from accounts.principals principal
  where principal.id = v_principal_id
    and principal.status = 'active'
  for update;
  if not found then
    raise exception 'Active principal was not found'
      using errcode = 'P0002';
  end if;

  select *
  into v_existing
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if found then
    if v_existing.user_id is distinct from p_user_id
       or v_existing.principal_id is distinct from v_principal_id
       or v_existing.password_hash is distinct from p_password_hash
       or v_existing.source_backend is distinct from p_source_backend
       or v_existing.source_document_id is distinct from p_source_document_id
       or v_existing.source_expected_revision is distinct from p_source_expected_revision
       or v_existing.source_preconditions is distinct from p_source_preconditions
       or v_existing.source_mutation is distinct from p_source_mutation
       or v_existing.status = 'failed' then
      raise exception 'Credential operation conflicts'
        using errcode = '23505';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'status', v_existing.status,
      'principal_id', v_existing.principal_id,
      'password_hash', v_existing.password_hash,
      'source_backend', v_existing.source_backend,
      'source_document_id', v_existing.source_document_id,
      'source_preconditions', v_existing.source_preconditions,
      'source_mutation', v_existing.source_mutation,
      'idempotent', true
    );
  end if;

  if exists (
    select 1
    from accounts.credential_operations operation
    where operation.principal_id = v_principal_id
      and operation.status in ('prepared', 'auth_applied')
  ) then
    raise exception 'Another credential operation is in progress'
      using errcode = '55006';
  end if;

  insert into accounts.credential_operations (
    operation_key,
    user_id,
    principal_id,
    password_hash,
    source_revision,
    source_backend,
    source_document_id,
    source_expected_revision,
    source_preconditions,
    source_mutation
  )
  values (
    p_operation_key,
    p_user_id,
    v_principal_id,
    p_password_hash,
    p_source_expected_revision,
    p_source_backend,
    p_source_document_id,
    p_source_expected_revision,
    p_source_preconditions,
    p_source_mutation
  )
  on conflict (operation_key) do update
  set updated_at = accounts.credential_operations.updated_at
  where accounts.credential_operations.user_id = excluded.user_id
    and accounts.credential_operations.principal_id = excluded.principal_id
    and accounts.credential_operations.password_hash = excluded.password_hash
    and accounts.credential_operations.source_backend = excluded.source_backend
    and accounts.credential_operations.source_document_id = excluded.source_document_id
    and accounts.credential_operations.source_expected_revision = excluded.source_expected_revision
    and accounts.credential_operations.source_preconditions = excluded.source_preconditions
    and accounts.credential_operations.source_mutation = excluded.source_mutation
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Credential operation conflicts'
      using errcode = '23505';
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'principal_id', v_principal_id,
    'password_hash', v_row.password_hash,
    'source_backend', v_row.source_backend,
    'source_document_id', v_row.source_document_id,
    'source_preconditions', v_row.source_preconditions,
    'source_mutation', v_row.source_mutation,
    'idempotent', false
  );
end;
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
      using errcode = '40001';
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
    attempt_count = operation.attempt_count + 1,
    last_error_code = nullif(left(coalesce(p_error_code, ''), 128), ''),
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

create or replace function public.roo_record_credential_recovery_error(
  p_operation_key text,
  p_expected_status text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row accounts.credential_operations%rowtype;
begin
  if p_expected_status not in ('prepared', 'auth_applied')
     or nullif(btrim(p_error_code), '') is null then
    raise exception 'Credential recovery error input is invalid'
      using errcode = '22023';
  end if;

  select *
  into v_row
  from accounts.credential_operations operation
  where operation.operation_key = p_operation_key
  for update;

  if not found then
    raise exception 'Credential operation was not found'
      using errcode = 'P0002';
  end if;

  if v_row.status = 'mirrored' then
    return jsonb_build_object(
      'id', v_row.id,
      'status', v_row.status,
      'idempotent', true
    );
  end if;

  if v_row.status is distinct from p_expected_status then
    raise exception 'Credential operation status changed'
      using errcode = '40001';
  end if;

  update accounts.credential_operations operation
  set
    attempt_count = operation.attempt_count + 1,
    last_error_code = left(p_error_code, 128),
    updated_at = now()
  where operation.id = v_row.id
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'status', v_row.status,
    'idempotent', false
  );
end;
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
    'creator_legacy_sanity_id', creator.legacy_sanity_id,
    'attempt_count', operation.attempt_count
  )
  from accounts.credential_operations operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id
  where operation.operation_key = p_operation_key;
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

  if v_operation.source_backend <> 'supabase'
     or v_operation.source_recovery_blocked
     or v_operation.status not in ('auth_applied', 'mirrored') then
    raise exception 'Credential source operation is not ready'
      using errcode = '55000';
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
    raise exception 'Credential source document was not found'
      using errcode = 'P0002';
  end if;

  if v_operation.source_preconditions is null
     or v_operation.source_preconditions = '{}'::jsonb
     or not (v_source.payload @> v_operation.source_preconditions) then
    raise exception 'Credential source precondition changed'
      using errcode = '40001';
  end if;

  v_set := v_operation.source_mutation->'set';
  select coalesce(array_agg(field), '{}'::text[])
  into v_unset
  from jsonb_array_elements_text(v_operation.source_mutation->'unset') field;
  v_document := (v_source.payload || v_set) - v_unset;

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

  if v_operation.source_backend <> 'sanity'
     or v_operation.source_recovery_blocked
     or v_operation.status not in ('auth_applied', 'mirrored') then
    raise exception 'Credential source operation is not ready'
      using errcode = '55000';
  end if;

  if v_operation.source_applied_at is not null
     and v_operation.source_applied_revision is distinct from p_source_revision then
    raise exception 'Credential source revision conflicts'
      using errcode = '40001';
  end if;

  update accounts.credential_operations operation
  set
    source_applied_revision = coalesce(
      operation.source_applied_revision,
      p_source_revision
    ),
    source_applied_at = coalesce(operation.source_applied_at, now()),
    last_error_code = null,
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
      using errcode = '40001';
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
    raise exception 'Credential source operation requires audited repair'
      using errcode = '55000';
  end if;

  if v_operation.source_backend is not null
     and v_operation.source_applied_at is null then
    raise exception 'Credential source operation is not complete'
      using errcode = '55000';
  end if;

  update accounts.credential_operations operation
  set
    status = 'mirrored',
    attempt_count = operation.attempt_count + 1,
    last_error_code = null,
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
  for v_operation_key in
    select operation.operation_key
    from accounts.principals principal
    join accounts.credential_operations operation
      on operation.principal_id = principal.id
    left join auth.users auth_user on auth_user.id = operation.user_id
    where (
      operation.status = 'auth_applied'
      and operation.sessions_revoked_at is null
    ) or (
      operation.status = 'prepared'
      and auth_user.encrypted_password = operation.password_hash
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
        'creator_legacy_sanity_id', creator.legacy_sanity_id,
        'attempt_count', operation.attempt_count
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
    order by candidate.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 25))
  ) operation
  left join accounts.creator_profiles creator
    on creator.principal_id = operation.principal_id;

  return v_result;
end;
$$;

revoke all on function public.roo_prepare_credential_operation_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb
) from public, anon, authenticated;
revoke all on function public.roo_mark_credential_operation(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_record_credential_recovery_error(text, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_get_credential_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_apply_credential_source_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_mark_credential_source_applied(text, text)
  from public, anon, authenticated;
revoke all on function public.roo_complete_credential_operation(text)
  from public, anon, authenticated;
revoke all on function public.roo_list_credential_recovery(integer)
  from public, anon, authenticated;

grant execute on function public.roo_prepare_credential_operation_v2(
  text,
  uuid,
  text,
  text,
  text,
  text,
  jsonb,
  jsonb
) to service_role;
grant execute on function public.roo_mark_credential_operation(text, text, text)
  to service_role;
grant execute on function public.roo_record_credential_recovery_error(text, text, text)
  to service_role;
grant execute on function public.roo_get_credential_operation(text)
  to service_role;
grant execute on function public.roo_apply_credential_source_operation(text)
  to service_role;
grant execute on function public.roo_mark_credential_source_applied(text, text)
  to service_role;
grant execute on function public.roo_complete_credential_operation(text)
  to service_role;
grant execute on function public.roo_list_credential_recovery(integer)
  to service_role;
