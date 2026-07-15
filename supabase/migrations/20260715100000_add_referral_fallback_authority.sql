set lock_timeout = '5s';
set statement_timeout = '120s';

do $$
begin
  if to_regclass('migration.document_mutation_mirror_outbox') is null
     or to_regprocedure('public.roo_apply_document_mutations(jsonb)') is null then
    raise exception 'Document mutation mirror outbox migration must be applied first'
      using errcode = '55000';
  end if;
end;
$$;

create table accounts.creator_fallback_authorities (
  legacy_creator_id text primary key
    check (
      legacy_creator_id ~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
      and position('..' in legacy_creator_id) = 0
    ),
  document_id text generated always as (
    'referralAuthAuthority.' || substr(
      encode(extensions.digest(legacy_creator_id, 'sha256'), 'hex'),
      1,
      64
    )
  ) stored unique,
  principal_id uuid not null,
  referral_code text not null
    check (
      referral_code = lower(btrim(referral_code))
      and char_length(referral_code) between 2 and 50
    ),
  principal_session_version bigint not null
    check (principal_session_version > 0),
  principal_status text not null
    check (principal_status in ('active', 'disabled', 'deleted')),
  creator_active boolean not null,
  creator_role_present boolean not null,
  credential_version bigint not null check (credential_version > 0),
  credential_changed_at timestamptz not null,
  current_record boolean not null default true,
  authority_version bigint not null default 1 check (authority_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index creator_fallback_authorities_principal_idx
  on accounts.creator_fallback_authorities (principal_id, current_record);

create index creator_fallback_authorities_readiness_idx
  on accounts.creator_fallback_authorities (
    principal_status,
    creator_active,
    creator_role_present,
    updated_at
  );

alter table accounts.creator_fallback_authorities enable row level security;

revoke all on table accounts.creator_fallback_authorities
  from public, anon, authenticated, service_role;

create policy "creator_fallback_authorities_deny_browser"
  on accounts.creator_fallback_authorities
  for all to anon, authenticated using (false) with check (false);

create or replace function accounts.refresh_creator_fallback_authority(
  p_principal_id uuid,
  p_legacy_creator_id text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legacy_ids text[];
  v_legacy_id text;
  v_principal accounts.principals%rowtype;
  v_creator accounts.creator_profiles%rowtype;
  v_existing accounts.creator_fallback_authorities%rowtype;
  v_authority accounts.creator_fallback_authorities%rowtype;
  v_principal_found boolean;
  v_creator_found boolean;
  v_role_present boolean;
  v_session_version bigint;
  v_credential_changed_at timestamptz;
  v_source_revision text;
  v_document jsonb;
  v_mutation jsonb;
  v_changed integer := 0;
  v_authority_changed boolean;
begin
  if p_principal_id is null then
    raise exception 'Creator fallback authority principal is required'
      using errcode = '22023';
  end if;

  if p_legacy_creator_id is not null then
    if p_legacy_creator_id !~ '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$'
       or position('..' in p_legacy_creator_id) > 0 then
      raise exception 'Creator fallback authority legacy id is invalid'
        using errcode = '22023';
    end if;
    v_legacy_ids := array[p_legacy_creator_id];
  else
    select coalesce(array_agg(candidate.legacy_creator_id order by candidate.legacy_creator_id), '{}')
    into v_legacy_ids
    from (
      select creator.legacy_sanity_id legacy_creator_id
      from accounts.creator_profiles creator
      where creator.principal_id = p_principal_id
        and creator.legacy_sanity_id is not null
      union
      select authority.legacy_creator_id
      from accounts.creator_fallback_authorities authority
      where authority.principal_id = p_principal_id
    ) candidate;
  end if;

  select principal.* into v_principal
  from accounts.principals principal
  where principal.id = p_principal_id;
  v_principal_found := found;

  foreach v_legacy_id in array v_legacy_ids
  loop
    select creator.* into v_creator
    from accounts.creator_profiles creator
    where creator.principal_id = p_principal_id
      and creator.legacy_sanity_id = v_legacy_id;
    v_creator_found := found;

    select authority.* into v_existing
    from accounts.creator_fallback_authorities authority
    where authority.legacy_creator_id = v_legacy_id
    for update;

    if not v_creator_found and not found then
      continue;
    end if;

    v_role_present := exists (
      select 1
      from accounts.account_roles role
      where role.principal_id = p_principal_id
        and role.role = 'creator'
    );
    v_session_version := case
      when v_principal_found then v_principal.session_version
      else v_existing.principal_session_version
    end;
    v_credential_changed_at := case
      when v_existing.legacy_creator_id is not null
       and v_existing.principal_id = p_principal_id
       and v_existing.credential_version = v_session_version
        then v_existing.credential_changed_at
      when v_principal_found and v_principal.session_version > 1
        then v_principal.updated_at
      when v_principal_found then coalesce(
        (
          select coalesce(
            credential.upgraded_at,
            credential.imported_at,
            credential.created_at
          )
          from accounts.credential_migrations credential
          where credential.principal_id = p_principal_id
          order by credential.updated_at desc, credential.user_id
          limit 1
        ),
        v_principal.created_at
      )
      else v_existing.credential_changed_at
    end;

    insert into accounts.creator_fallback_authorities (
      legacy_creator_id,
      principal_id,
      referral_code,
      principal_session_version,
      principal_status,
      creator_active,
      creator_role_present,
      credential_version,
      credential_changed_at,
      current_record
    )
    values (
      v_legacy_id,
      p_principal_id,
      coalesce(v_creator.referral_code, v_existing.referral_code),
      v_session_version,
      case when v_principal_found then v_principal.status else 'deleted' end,
      v_creator_found and v_creator.active,
      v_role_present,
      v_session_version,
      v_credential_changed_at,
      v_creator_found
    )
    on conflict (legacy_creator_id) do update
    set
      principal_id = excluded.principal_id,
      referral_code = excluded.referral_code,
      principal_session_version = excluded.principal_session_version,
      principal_status = excluded.principal_status,
      creator_active = excluded.creator_active,
      creator_role_present = excluded.creator_role_present,
      credential_version = excluded.credential_version,
      credential_changed_at = excluded.credential_changed_at,
      current_record = excluded.current_record,
      authority_version = accounts.creator_fallback_authorities.authority_version + 1,
      updated_at = now()
    where (
      accounts.creator_fallback_authorities.principal_id,
      accounts.creator_fallback_authorities.referral_code,
      accounts.creator_fallback_authorities.principal_session_version,
      accounts.creator_fallback_authorities.principal_status,
      accounts.creator_fallback_authorities.creator_active,
      accounts.creator_fallback_authorities.creator_role_present,
      accounts.creator_fallback_authorities.credential_version,
      accounts.creator_fallback_authorities.credential_changed_at,
      accounts.creator_fallback_authorities.current_record
    ) is distinct from (
      excluded.principal_id,
      excluded.referral_code,
      excluded.principal_session_version,
      excluded.principal_status,
      excluded.creator_active,
      excluded.creator_role_present,
      excluded.credential_version,
      excluded.credential_changed_at,
      excluded.current_record
    )
    returning * into v_authority;

    v_authority_changed := found;
    if not v_authority_changed then
      select authority.* into v_authority
      from accounts.creator_fallback_authorities authority
      where authority.legacy_creator_id = v_legacy_id
      for update;
    end if;
    if not found then
      continue;
    end if;

    v_document := jsonb_build_object(
      '_id', v_authority.document_id,
      '_type', 'referralAuthAuthority',
      'authoritySchemaVersion', 1,
      'legacyCreatorId', v_authority.legacy_creator_id,
      'principalId', v_authority.principal_id::text,
      'referralCode', v_authority.referral_code,
      'principalSessionVersion', v_authority.principal_session_version,
      'principalStatus', v_authority.principal_status,
      'creatorActive', v_authority.creator_active,
      'creatorRolePresent', v_authority.creator_role_present,
      'credentialVersion', v_authority.credential_version,
      'credentialChangedAt', to_char(
        v_authority.credential_changed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'currentRecord', v_authority.current_record,
      'authorityVersion', v_authority.authority_version
    );

    if not v_authority_changed and exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = v_authority.document_id
        and source.document_type = 'referralAuthAuthority'
        and source.backend_owner = 'supabase'
        and not source.tombstoned
        and source.payload @> v_document
    ) then
      continue;
    end if;

    select source.source_revision into v_source_revision
    from migration.source_documents source
    where source.legacy_sanity_id = v_authority.document_id
    for update;

    v_mutation := case
      when found then jsonb_build_object(
        'operation', 'replace',
        'id', v_authority.document_id,
        'expected_revision', v_source_revision,
        'document', v_document
      )
      else jsonb_build_object(
        'operation', 'create_if_missing',
        'id', v_authority.document_id,
        'document', v_document
      )
    end;

    perform public.roo_apply_document_mutations(jsonb_build_array(v_mutation));

    if not exists (
      select 1
      from migration.source_documents source
      where source.legacy_sanity_id = v_authority.document_id
        and source.document_type = 'referralAuthAuthority'
        and source.payload->>'legacyCreatorId' = v_authority.legacy_creator_id
        and source.payload->>'principalId' = v_authority.principal_id::text
        and (source.payload->>'principalSessionVersion')::bigint
          = v_authority.principal_session_version
        and (source.payload->>'authorityVersion')::bigint
          = v_authority.authority_version
        and source.backend_owner = 'supabase'
        and not source.tombstoned
    ) then
      raise exception 'Creator fallback authority mirror event was not recorded'
        using errcode = '55000';
    end if;

    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$$;

create or replace function accounts.refresh_creator_fallback_authority_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'principals' then
    perform accounts.refresh_creator_fallback_authority(
      case when tg_op = 'DELETE' then old.id else new.id end,
      null
    );
  elsif tg_table_name = 'creator_profiles' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform accounts.refresh_creator_fallback_authority(
        old.principal_id,
        old.legacy_sanity_id
      );
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and (
         tg_op = 'INSERT'
         or new.principal_id is distinct from old.principal_id
         or new.legacy_sanity_id is distinct from old.legacy_sanity_id
         or new.referral_code is distinct from old.referral_code
         or new.active is distinct from old.active
       ) then
      perform accounts.refresh_creator_fallback_authority(
        new.principal_id,
        new.legacy_sanity_id
      );
    end if;
  elsif tg_table_name = 'account_roles' then
    if tg_op in ('UPDATE', 'DELETE') and old.role = 'creator' then
      perform accounts.refresh_creator_fallback_authority(old.principal_id, null);
    end if;
    if tg_op in ('INSERT', 'UPDATE')
       and new.role = 'creator'
       and (
         tg_op = 'INSERT'
         or new.principal_id is distinct from old.principal_id
         or new.role is distinct from old.role
       ) then
      perform accounts.refresh_creator_fallback_authority(new.principal_id, null);
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger principals_refresh_creator_fallback_authority
  after insert or update of status, session_version or delete
  on accounts.principals
  for each row execute function accounts.refresh_creator_fallback_authority_trigger();

create trigger creator_profiles_refresh_creator_fallback_authority
  after insert or update of principal_id, legacy_sanity_id, referral_code, active or delete
  on accounts.creator_profiles
  for each row execute function accounts.refresh_creator_fallback_authority_trigger();

create trigger account_roles_refresh_creator_fallback_authority
  after insert or update of principal_id, role or delete
  on accounts.account_roles
  for each row execute function accounts.refresh_creator_fallback_authority_trigger();

do $$
declare
  v_creator record;
begin
  for v_creator in
    select creator.principal_id, creator.legacy_sanity_id
    from accounts.creator_profiles creator
    where creator.legacy_sanity_id is not null
    order by creator.legacy_sanity_id
  loop
    perform accounts.refresh_creator_fallback_authority(
      v_creator.principal_id,
      v_creator.legacy_sanity_id
    );
  end loop;
end;
$$;

create or replace function public.roo_referral_fallback_authority_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_creators bigint;
  v_unaddressable bigint;
  v_authorities bigint;
  v_missing bigint;
  v_inconsistent bigint;
  v_source_drift bigint;
  v_pending bigint;
  v_processing bigint;
  v_retry bigint;
  v_dead_letter bigint;
  v_oldest_actionable_age numeric;
  v_actionable bigint;
begin
  select
    count(*),
    count(*) filter (where creator.legacy_sanity_id is null)
  into v_creators, v_unaddressable
  from accounts.creator_profiles creator;

  select count(*) into v_authorities
  from accounts.creator_fallback_authorities authority;

  select count(*) into v_missing
  from accounts.creator_profiles creator
  where creator.legacy_sanity_id is not null
    and not exists (
      select 1
      from accounts.creator_fallback_authorities authority
      where authority.legacy_creator_id = creator.legacy_sanity_id
        and authority.principal_id = creator.principal_id
        and authority.current_record
    );

  select count(*) into v_inconsistent
  from accounts.creator_profiles creator
  join accounts.principals principal on principal.id = creator.principal_id
  join accounts.creator_fallback_authorities authority
    on authority.legacy_creator_id = creator.legacy_sanity_id
  where authority.principal_id is distinct from creator.principal_id
     or authority.referral_code is distinct from creator.referral_code
     or authority.principal_session_version is distinct from principal.session_version
     or authority.principal_status is distinct from principal.status
     or authority.creator_active is distinct from creator.active
     or authority.creator_role_present is distinct from exists (
       select 1
       from accounts.account_roles role
       where role.principal_id = creator.principal_id
         and role.role = 'creator'
     )
     or authority.credential_version is distinct from principal.session_version
     or not authority.current_record;

  select count(*) into v_source_drift
  from accounts.creator_fallback_authorities authority
  left join migration.source_documents source
    on source.legacy_sanity_id = authority.document_id
  where source.legacy_sanity_id is null
     or source.tombstoned
     or source.backend_owner is distinct from 'supabase'
     or source.document_type is distinct from 'referralAuthAuthority'
     or source.payload->>'authoritySchemaVersion' is distinct from '1'
     or source.payload->>'legacyCreatorId' is distinct from authority.legacy_creator_id
     or source.payload->>'principalId' is distinct from authority.principal_id::text
     or source.payload->>'referralCode' is distinct from authority.referral_code
     or source.payload->>'principalSessionVersion'
       is distinct from authority.principal_session_version::text
     or source.payload->>'principalStatus' is distinct from authority.principal_status
     or source.payload->>'creatorActive'
       is distinct from authority.creator_active::text
     or source.payload->>'creatorRolePresent'
       is distinct from authority.creator_role_present::text
     or source.payload->>'credentialVersion'
       is distinct from authority.credential_version::text
     or source.payload->>'credentialChangedAt' is distinct from to_char(
       authority.credential_changed_at at time zone 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     or source.payload->>'currentRecord'
       is distinct from authority.current_record::text
     or source.payload->>'authorityVersion'
       is distinct from authority.authority_version::text;

  select
    count(*) filter (where event.status = 'pending'),
    count(*) filter (where event.status = 'processing'),
    count(*) filter (where event.status = 'retry'),
    count(*) filter (where event.status = 'dead_letter'),
    count(*) filter (where event.status in ('pending', 'processing', 'retry')),
    coalesce(
      extract(epoch from now() - min(event.created_at) filter (
        where event.status in ('pending', 'processing', 'retry')
      )),
      0
    )
  into
    v_pending,
    v_processing,
    v_retry,
    v_dead_letter,
    v_actionable,
    v_oldest_actionable_age
  from migration.document_mutation_mirror_outbox event
  where exists (
    select 1
    from accounts.creator_fallback_authorities authority
    where authority.document_id = any(event.document_ids)
  );

  return jsonb_build_object(
    'ready',
      v_unaddressable = 0
      and v_missing = 0
      and v_inconsistent = 0
      and v_source_drift = 0
      and v_dead_letter = 0
      and v_actionable = 0,
    'healthy',
      v_unaddressable = 0
      and v_missing = 0
      and v_inconsistent = 0
      and v_source_drift = 0
      and v_dead_letter = 0
      and v_oldest_actionable_age <= 300,
    'creators', v_creators,
    'authorities', v_authorities,
    'unaddressableCreators', v_unaddressable,
    'missingAuthorities', v_missing,
    'inconsistentAuthorities', v_inconsistent,
    'sourceDrift', v_source_drift,
    'mirror', jsonb_build_object(
      'pending', v_pending,
      'processing', v_processing,
      'retry', v_retry,
      'deadLetter', v_dead_letter,
      'actionable', v_actionable,
      'oldestActionableAgeSeconds', floor(v_oldest_actionable_age)
    )
  );
end;
$$;

create or replace function public.roo_supabase_release_readiness()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.roo_supabase_port_readiness(), '{}'::jsonb)
    || jsonb_build_object(
      'referralFallbackAuthority',
      public.roo_referral_fallback_authority_readiness()
    );
$$;

revoke all on function accounts.refresh_creator_fallback_authority(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function accounts.refresh_creator_fallback_authority_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.roo_referral_fallback_authority_readiness()
  from public, anon, authenticated;
revoke all on function public.roo_supabase_release_readiness()
  from public, anon, authenticated;

grant execute on function public.roo_referral_fallback_authority_readiness()
  to service_role;
grant execute on function public.roo_supabase_release_readiness()
  to service_role;
