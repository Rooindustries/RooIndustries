set lock_timeout = '5s';
set statement_timeout = '120s';
create or replace function migration.release_credential_mirror_wait(p_operation_key text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity',0));
 update accounts.credential_operations operation set status='auth_applied',source_recovery_blocked=false,source_recovery_blocked_at=null,next_retry_at=null,attempt_count=0,consecutive_error_count=0,last_error_class=null,last_error=null,last_error_code=null
 where operation.operation_key in (
 select candidate.operation_key from accounts.credential_operations candidate join accounts.principals principal on principal.id=candidate.principal_id where principal.status='active' and (p_operation_key is null or candidate.operation_key=p_operation_key) and candidate.status in ('auth_applied','failed') and candidate.source_backend in ('sanity','supabase') and candidate.last_error_code in ('CREDENTIAL_MIRROR_PENDING','CREDENTIAL_MIRROR_DEAD_LETTER') and candidate.sessions_revoked_at is not null and candidate.source_applied_at is not null and candidate.source_applied_revision is not null and exists(select 1 from auth.users u join accounts.principal_auth_users identity_link on identity_link.user_id=u.id where u.id=candidate.user_id and identity_link.principal_id=candidate.principal_id)
 and exists(select 1 from migration.source_documents source where source.legacy_sanity_id=candidate.source_document_id and not source.tombstoned and source.document_type='referral' and jsonb_typeof(candidate.source_mutation->'set')='object' and source.payload @> (candidate.source_mutation->'set') and jsonb_typeof(candidate.source_mutation->'unset')='array' and not exists(select 1 from jsonb_array_elements_text(candidate.source_mutation->'unset') key where source.payload ? key))
 order by candidate.created_at for update of principal skip locked limit 25
 );
end;
$$;
revoke all on function migration.release_credential_mirror_wait(text) from public,anon,authenticated,service_role;


create or replace function migration.assert_referral_coupon_namespace(p_mutations jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_mutation jsonb; v_document jsonb; v_code text; v_old_code text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity',0));
 for v_mutation in select value from jsonb_array_elements(p_mutations) loop
  v_document:=v_mutation->'document';
  if v_mutation->>'operation' not in ('create','replace') or v_document->>'_type' is distinct from 'referral' then continue; end if;
  v_code:=lower(btrim(v_document#>>'{slug,current}'));
  select lower(btrim(payload#>>'{slug,current}')) into v_old_code from migration.source_documents where legacy_sanity_id=v_document->>'_id' and not tombstoned;
  if v_code is not distinct from v_old_code then continue; end if;
  if nullif(v_code,'') is not null and exists(select 1 from migration.source_documents where document_type='coupon' and not tombstoned and lower(btrim(payload->>'code'))=v_code) then raise exception 'CMS_CODE_CONFLICT' using errcode='23505'; end if;
 end loop;
end;
$$;
revoke all on function migration.assert_referral_coupon_namespace(jsonb) from public,anon,authenticated,service_role;

create or replace function public.roo_apply_referral_registration_mutations(p_mutations jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform migration.assert_referral_coupon_namespace(p_mutations);
 return public.roo_apply_document_mutations(p_mutations);
end;
$$;
revoke all on function public.roo_apply_referral_registration_mutations(jsonb) from public,anon,authenticated;
grant execute on function public.roo_apply_referral_registration_mutations(jsonb) to service_role;

do $referral_namespace$
declare v_definition text; v_begin integer;
begin
 select pg_get_functiondef('public.roo_enqueue_referral_email_mutation(jsonb,text,text,text,text,text,jsonb,timestamptz)'::regprocedure) into v_definition;
 v_begin:=position(E'\nbegin\n' in lower(v_definition));
 if v_begin=0 then raise exception 'Referral email enqueue outer body was not found'; end if;
 v_definition:=overlay(v_definition placing substring(v_definition from v_begin for 6)||E'\n perform migration.assert_referral_coupon_namespace(p_mutations);\n' from v_begin for 7);
 execute v_definition;
end;
$referral_namespace$;

create or replace function public.roo_resume_prepared_credential_operation(p_operation_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_operation accounts.credential_operations%rowtype; v_principal uuid; v_auth_hash text; v_checkpoint jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cms-reference-integrity',0));
 select operation.principal_id into v_principal from accounts.credential_operations operation where operation.operation_key=p_operation_key;
 if v_principal is null then return jsonb_build_object('resumed',false); end if;
 perform 1 from accounts.principals principal where principal.id=v_principal and principal.status='active' for update;
 if not found then raise exception 'Active principal was not found' using errcode='P0002'; end if;
 select * into v_operation from accounts.credential_operations operation where operation.operation_key=p_operation_key for update;
 if v_operation.principal_id is distinct from v_principal or v_operation.source_backend not in ('sanity','supabase') or not exists(select 1 from accounts.principal_auth_users identity_link where identity_link.user_id=v_operation.user_id and identity_link.principal_id=v_operation.principal_id) then raise exception 'Credential operation identity changed' using errcode='55000'; end if;
 if v_operation.status<>'prepared' then return jsonb_build_object('resumed',false,'status',v_operation.status); end if;
 if v_operation.source_recovery_blocked and v_operation.last_error_code is distinct from 'CREDENTIAL_AUTH_PLAINTEXT_REQUIRED' then return jsonb_build_object('resumed',false,'status','parked'); end if;
 select encrypted_password into v_auth_hash from auth.users where id=v_operation.user_id;
 if v_operation.password_hash is null or v_auth_hash is null or v_auth_hash is distinct from v_operation.password_hash then return jsonb_build_object('resumed',false,'status','prepared','auth_password_hash',v_auth_hash); end if;
 v_checkpoint:=public.roo_mark_credential_operation_v2(p_operation_key,'auth_applied',null);
 return v_checkpoint||jsonb_build_object('resumed',true);
end;
$$;
revoke all on function public.roo_resume_prepared_credential_operation(text) from public,anon,authenticated;
grant execute on function public.roo_resume_prepared_credential_operation(text) to service_role;

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
  perform migration.release_credential_mirror_wait(p_operation_key);
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
       or (case when v_existing.source_backend in ('sanity','supabase') then 'supabase' else v_existing.source_backend end) is distinct from (case when p_source_backend in ('sanity','supabase') then 'supabase' else p_source_backend end)
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
      'source_backend', case when v_existing.source_backend in ('sanity','supabase') then 'supabase' else v_existing.source_backend end,
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
    'supabase',
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
    and (case when accounts.credential_operations.source_backend in ('sanity','supabase') then 'supabase' else accounts.credential_operations.source_backend end) = excluded.source_backend
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
    'source_backend', case when v_row.source_backend in ('sanity','supabase') then 'supabase' else v_row.source_backend end,
    'source_document_id', v_row.source_document_id,
    'source_preconditions', v_row.source_preconditions,
    'source_mutation', v_row.source_mutation,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_apply_credential_source_operation_v2(
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
  perform migration.release_credential_mirror_wait(p_operation_key);
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

  if v_operation.source_backend not in ('sanity','supabase')
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
      'transient'
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

create or replace function public.roo_complete_credential_operation_v2(
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
  perform migration.release_credential_mirror_wait(p_operation_key);
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

create or replace function public.roo_get_credential_operation_v2(
  p_operation_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
 perform migration.release_credential_mirror_wait(p_operation_key);
 return (select jsonb_build_object(
    'operation_key', operation.operation_key,
    'user_id', operation.user_id,
    'principal_id', operation.principal_id,
    'password_hash', operation.password_hash,
    'status', operation.status,
    'source_revision', operation.source_revision,
    'source_backend', case when operation.source_backend in ('sanity','supabase') then 'supabase' else operation.source_backend end,
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
  where operation.operation_key = p_operation_key);
end;
$$;


create or replace function public.roo_list_credential_recovery_v2(
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
  perform migration.release_credential_mirror_wait(null);
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
    perform public.roo_mark_credential_operation_v2(
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
        'source_backend', case when operation.source_backend in ('sanity','supabase') then 'supabase' else operation.source_backend end,
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

do $readiness$
declare d text; b text;
begin
 select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_commerce_readiness';
 b:=split_part(split_part(d,'$function$',2),'$function$',1);
 b:=regexp_replace(b,';[[:space:]]*$','');
 execute split_part(d,'$function$',1)||'$function$ select value - ''last_parity'' - ''last_mirror_checkpoint'' - ''mirror'' from ('||b||') source(value); $function$';
end;
$readiness$;

do $readiness$
declare d text; b text;
begin
 select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_commerce_integrity_readiness';
 b:=split_part(split_part(d,'$function$',2),'$function$',1);
 b:=regexp_replace(b,';[[:space:]]*$','');
 execute split_part(d,'$function$',1)||'$function$ select value - ''mirror'' from ('||b||') source(value); $function$';
end;
$readiness$;

do $readiness$
declare d text; b text;
begin
 select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='roo_supabase_port_readiness';
 b:=split_part(split_part(d,'$function$',2),'$function$',1);
 b:=regexp_replace(b,';[[:space:]]*$','');
 execute split_part(d,'$function$',1)||'$function$ select value - ''documentMutationMirror'' - ''parityAgeSeconds'' - ''commerceMirror'' from ('||b||') source(value); $function$';
end;
$readiness$;

create or replace function public.roo_cms_publish_readiness()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('receipts',jsonb_build_object('committed',(select count(*) from migration.cms_publish_commands where status='committed'),'processing',(select count(*) from migration.cms_publish_commands where status='processing'),'ready',not exists(select 1 from migration.cms_publish_commands where status='processing')),'assets',jsonb_build_object('links',(select count(*) from cms.document_assets),'unverified_links',(select count(*) from cms.document_assets l left join cms.assets a on a.id=l.asset_id where a.id is null or a.migration_status<>'verified'),'ready',not exists(select 1 from cms.document_assets l left join cms.assets a on a.id=l.asset_id where a.id is null or a.migration_status<>'verified')),'ready',not exists(select 1 from migration.cms_publish_commands where status='processing') and not exists(select 1 from cms.document_assets l left join cms.assets a on a.id=l.asset_id where a.id is null or a.migration_status<>'verified'));
$$;


do $lock_order$
declare v record; v_target record; v_closure oid[]; v_previous integer; v_body text; v_definition text; v_statement text; v_begin integer;
begin
 v_closure:=array['public.roo_apply_document_mutations(jsonb)'::regprocedure::oid,'migration.roo_apply_commerce_document_mutations_unbounded(text,jsonb,integer)'::regprocedure::oid,'migration.apply_cms_commerce_mutation(text,jsonb)'::regprocedure::oid];
 loop
  v_previous:=cardinality(v_closure);
  for v in select p.oid,pg_get_functiondef(p.oid) definition from pg_proc p where p.prokind in ('f','p') and not p.oid=any(v_closure) loop
   v_body:=split_part(v.definition,'AS $function$',2);
   for v_target in select p.proname,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.oid=any(v_closure) loop
    if v_body ~* ('(^|[^[:alnum:]_.])('||v_target.nspname||'[.])?'||v_target.proname||'[[:space:]]*[(]') then v_closure:=array_append(v_closure,v.oid); exit; end if;
   end loop;
  end loop;
  exit when cardinality(v_closure)=v_previous;
 end loop;
 for v in select p.oid,pg_get_functiondef(p.oid) definition,l.lanname from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=any(v_closure) loop
  if v.lanname<>'plpgsql' then raise exception 'writer caller requires explicit lock-order alignment: %',v.oid::regprocedure; end if;
  v_definition:=regexp_replace(v.definition,'[[:space:]]*perform[[:space:]]+(pg_catalog[.])?pg_advisory_xact_lock[[:space:]]*[(][[:space:]]*(pg_catalog[.])?hashtextextended[[:space:]]*[(]''cms-reference-integrity'',[[:space:]]*0[)][)][;]','','gi');
  v_statement:=E'\n  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(''cms-reference-integrity'', 0));';
  v_begin:=position(E'\nbegin\n' in lower(v_definition));
  if v_begin=0 then raise exception 'missing outer begin for writer caller: %',v.oid::regprocedure; end if;
  v_definition:=overlay(v_definition placing substring(v_definition from v_begin for 6)||v_statement||E'\n' from v_begin for 7);
  if position(v_statement in v_definition)=0 then raise exception 'missing outer body for writer caller: %',v.oid::regprocedure; end if;
  execute v_definition;
 end loop;
end;
$lock_order$;
