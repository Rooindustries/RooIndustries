set lock_timeout = '5s';
set statement_timeout = '120s';

do $repair$
declare
  v_features boolean[];
  v_complete boolean;
  v_constraints jsonb;
  v_index text;
  v_function record;
  v_expected record;
begin
  if to_regclass('accounts.oauth_intents') is null
     or to_regclass('accounts.reauth_grants') is null
     or to_regprocedure('public.roo_create_oauth_intent(jsonb)') is null then
    raise exception 'Orphan-reclaim prerequisite repair requires the unified account schema'
      using errcode = '55000';
  end if;

  lock table accounts.oauth_intents, accounts.reauth_grants in access exclusive mode;
  v_features := array[
    exists(select 1 from pg_attribute where attrelid='accounts.reauth_grants'::regclass and attname='bound_intent_id' and not attisdropped),
    exists(select 1 from pg_attribute where attrelid='accounts.reauth_grants'::regclass and attname='bound_at' and not attisdropped),
    exists(select 1 from pg_attribute where attrelid='accounts.oauth_intents'::regclass and attname='recovery_for_intent_id' and not attisdropped),
    to_regclass('accounts.orphan_identity_reclaim_audit') is not null,
    to_regclass('accounts.reauth_grants_bound_intent_key') is not null,
    to_regclass('accounts.oauth_intents_recovery_source_idx') is not null,
    exists(select 1 from pg_proc where pronamespace='accounts'::regnamespace and proname='reject_orphan_identity_reclaim_audit_mutation'),
    exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='roo_read_reauth_grant'),
    exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='roo_fail_oauth_intent'),
    exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname='roo_reclaim_referral_orphan_identity'),
    exists(select 1 from pg_constraint where conrelid='accounts.reauth_grants'::regclass and conname='reauth_grants_bound_intent_check'),
    exists(select 1 from pg_constraint where conrelid='accounts.oauth_intents'::regclass and conname='oauth_intents_reclaim_source_check')
  ];
  v_complete := not (false = any(v_features));
  if not v_complete and true = any(v_features) then
    raise exception 'Orphan-reclaim feature is partially installed; review schema before repair'
      using errcode = '55000';
  end if;

  select jsonb_object_agg(conname, pg_get_constraintdef(oid)) into v_constraints
  from pg_constraint where conrelid='accounts.oauth_intents'::regclass
    and conname in ('oauth_intents_action_check','oauth_intents_target_action_check');
  select pg_get_indexdef(to_regclass('accounts.oauth_intents_one_active_sensitive_action_idx')) into v_index;

  if v_complete then
    if v_constraints is distinct from jsonb_build_object(
      'oauth_intents_action_check',
      $check$CHECK ((action = ANY (ARRAY['signin'::text, 'signup'::text, 'link'::text, 'reauth'::text, 'merge'::text, 'reclaim'::text])))$check$,
      'oauth_intents_target_action_check',
      $check$CHECK (((action = ANY (ARRAY['link'::text, 'reauth'::text, 'merge'::text, 'reclaim'::text])) = (target_user_id IS NOT NULL)))$check$
    ) or v_index is distinct from
      $index$CREATE UNIQUE INDEX oauth_intents_one_active_sensitive_action_idx ON accounts.oauth_intents USING btree (target_user_id, provider, action) WHERE ((action = ANY (ARRAY['link'::text, 'reauth'::text, 'merge'::text, 'reclaim'::text])) AND (status = 'pending'::text))$index$ then
      raise exception 'Orphan-reclaim action constraints or uniqueness contract changed'
        using errcode = '55000';
    end if;

    for v_expected in select * from (values
      ('accounts.reauth_grants','bound_intent_id','uuid'),
      ('accounts.reauth_grants','bound_at','timestamp with time zone'),
      ('accounts.oauth_intents','recovery_for_intent_id','uuid')
    ) expected(relation,column_name,column_type) loop
      if not exists(select 1 from pg_attribute
        where attrelid=to_regclass(v_expected.relation) and attname=v_expected.column_name
          and atttypid=to_regtype(v_expected.column_type) and not attnotnull and not attisdropped) then
        raise exception 'Orphan-reclaim binding column contract changed' using errcode='55000';
      end if;
    end loop;
    for v_expected in select * from (values
      ('id','uuid',true), ('oauth_intent_id','uuid',true),
      ('original_link_intent_id','uuid',false), ('provider','text',true),
      ('provider_subject','text',false), ('source_user_id','uuid',false),
      ('source_principal_id','uuid',false), ('target_user_id','uuid',true),
      ('target_principal_id','uuid',true), ('outcome','text',true),
      ('reason','text',true), ('details','jsonb',true),
      ('created_at','timestamp with time zone',true)
    ) expected(column_name,column_type,required) loop
      if not exists(select 1 from pg_attribute
        where attrelid='accounts.orphan_identity_reclaim_audit'::regclass
          and attname=v_expected.column_name and atttypid=to_regtype(v_expected.column_type)
          and attnotnull=v_expected.required and not attisdropped) then
        raise exception 'Orphan-reclaim audit column contract changed' using errcode='55000';
      end if;
    end loop;
    for v_expected in select * from (values
      ('accounts.reauth_grants','reauth_grants_bound_intent_check',
        $check$CHECK (((bound_intent_id IS NULL) = (bound_at IS NULL)))$check$),
      ('accounts.reauth_grants','reauth_grants_bound_intent_id_fkey',
        'FOREIGN KEY (bound_intent_id) REFERENCES accounts.oauth_intents(id) ON DELETE CASCADE'),
      ('accounts.oauth_intents','oauth_intents_reclaim_source_check',
        $check$CHECK (((action = 'reclaim'::text) = (recovery_for_intent_id IS NOT NULL)))$check$),
      ('accounts.oauth_intents','oauth_intents_recovery_for_intent_id_fkey',
        'FOREIGN KEY (recovery_for_intent_id) REFERENCES accounts.oauth_intents(id) ON DELETE CASCADE')
    ) expected(relation,constraint_name,definition) loop
      if not exists(select 1 from pg_constraint where conrelid=to_regclass(v_expected.relation)
        and conname=v_expected.constraint_name and convalidated
        and pg_get_constraintdef(oid)=v_expected.definition) then
        raise exception 'Orphan-reclaim binding constraint contract changed' using errcode='55000';
      end if;
    end loop;
    if pg_get_indexdef(to_regclass('accounts.reauth_grants_bound_intent_key')) is distinct from
      'CREATE UNIQUE INDEX reauth_grants_bound_intent_key ON accounts.reauth_grants USING btree (bound_intent_id) WHERE (bound_intent_id IS NOT NULL)'
      or not exists(select 1 from pg_class where oid='accounts.orphan_identity_reclaim_audit'::regclass
        and relkind='r' and relrowsecurity)
      or not exists(select 1 from pg_trigger where tgrelid='accounts.orphan_identity_reclaim_audit'::regclass
        and tgname='orphan_identity_reclaim_audit_immutable' and tgenabled='O' and tgtype=27
        and tgfoid=to_regprocedure('accounts.reject_orphan_identity_reclaim_audit_mutation()'))
      or not exists(select 1 from pg_proc
        where oid=to_regprocedure('accounts.reject_orphan_identity_reclaim_audit_mutation()')
          and prorettype='trigger'::regtype and md5(prosrc)='c3476be56857c44bae26110fefe6b211')
      or exists(select 1 from pg_index where indexrelid in (
        'accounts.reauth_grants_bound_intent_key'::regclass,
        'accounts.oauth_intents_one_active_sensitive_action_idx'::regclass,
        'accounts.oauth_intents_recovery_source_idx'::regclass
      ) and (not indisvalid or not indisready))
      or has_table_privilege('anon','accounts.orphan_identity_reclaim_audit','SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('authenticated','accounts.orphan_identity_reclaim_audit','SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'Orphan-reclaim audit or unique proof binding is not protected' using errcode='55000';
    end if;

    for v_expected in select * from (values
      ('public.roo_create_oauth_intent(jsonb)',array['86c5544a9469f859a54bebcbe57333e5','893bb134511009c6e32d43353e8c7982']),
      ('public.roo_read_reauth_grant(text,uuid,text)',array['ba0b8b7b40dbb129e4f2c023e59e878d']),
      ('public.roo_fail_oauth_intent(uuid,text,text)',array['e728b10342b7f734264e9d50ade410bc']),
      ('public.roo_reclaim_referral_orphan_identity(text,uuid,text)',array['7e3c14ebed30d10211db75ee52f5ac20','bf6af272cfa658888364aa2f2bbc72b6'])
    ) expected(signature,body_hashes) loop
      select * into v_function from pg_proc where oid=to_regprocedure(v_expected.signature);
      if not found or not (md5(v_function.prosrc)=any(v_expected.body_hashes))
         or not v_function.prosecdef or v_function.prorettype<>'jsonb'::regtype
         or v_function.proconfig is distinct from array['search_path=""']
         or has_function_privilege('anon',v_function.oid,'EXECUTE')
         or has_function_privilege('authenticated',v_function.oid,'EXECUTE')
         or not has_function_privilege('service_role',v_function.oid,'EXECUTE') then
        raise exception 'Orphan-reclaim RPC contract is unknown or unsafe: %',v_expected.signature
          using errcode='55000';
      end if;
    end loop;
    return;
  end if;

  select * into v_function from pg_proc where oid='public.roo_create_oauth_intent(jsonb)'::regprocedure;
  if md5(v_function.prosrc)<>'956cddca92bf2afddedf171cdc02c97e'
     or not v_function.prosecdef or v_function.prorettype<>'jsonb'::regtype
     or v_function.proconfig is distinct from array['search_path=""']
     or has_function_privilege('anon',v_function.oid,'EXECUTE')
     or has_function_privilege('authenticated',v_function.oid,'EXECUTE')
     or not has_function_privilege('service_role',v_function.oid,'EXECUTE') then
    raise exception 'OAuth intent predecessor changed; refusing to overwrite installed behavior'
      using errcode='55000';
  end if;
  if v_constraints is distinct from jsonb_build_object(
    'oauth_intents_action_check',
    $check$CHECK ((action = ANY (ARRAY['signin'::text, 'signup'::text, 'link'::text, 'reauth'::text, 'merge'::text])))$check$,
    'oauth_intents_target_action_check',
    $check$CHECK (((action = ANY (ARRAY['link'::text, 'reauth'::text, 'merge'::text])) = (target_user_id IS NOT NULL)))$check$
  ) or v_index is distinct from
    $index$CREATE UNIQUE INDEX oauth_intents_one_active_sensitive_action_idx ON accounts.oauth_intents USING btree (target_user_id, provider, action) WHERE ((action = ANY (ARRAY['link'::text, 'reauth'::text, 'merge'::text])) AND (status = 'pending'::text))$index$ then
    raise exception 'OAuth intent predecessor constraints changed; refusing repair'
      using errcode='55000';
  end if;

  execute $feature$
alter table accounts.reauth_grants
  add column if not exists bound_intent_id uuid
    references accounts.oauth_intents(id) on delete cascade,
  add column if not exists bound_at timestamptz;

alter table accounts.reauth_grants
  drop constraint if exists reauth_grants_bound_intent_check;
alter table accounts.reauth_grants
  add constraint reauth_grants_bound_intent_check check (
    (bound_intent_id is null) = (bound_at is null)
  );

create unique index if not exists reauth_grants_bound_intent_key
  on accounts.reauth_grants (bound_intent_id)
  where bound_intent_id is not null;

alter table accounts.oauth_intents
  add column if not exists recovery_for_intent_id uuid
    references accounts.oauth_intents(id) on delete cascade;

alter table accounts.oauth_intents
  drop constraint if exists oauth_intents_action_check;
alter table accounts.oauth_intents
  add constraint oauth_intents_action_check check (
    action in ('signin', 'signup', 'link', 'reauth', 'merge', 'reclaim')
  );

alter table accounts.oauth_intents
  drop constraint if exists oauth_intents_target_action_check;
alter table accounts.oauth_intents
  add constraint oauth_intents_target_action_check check (
    (action in ('link', 'reauth', 'merge', 'reclaim')) =
      (target_user_id is not null)
  );

alter table accounts.oauth_intents
  drop constraint if exists oauth_intents_reclaim_source_check;
alter table accounts.oauth_intents
  add constraint oauth_intents_reclaim_source_check check (
    (action = 'reclaim') = (recovery_for_intent_id is not null)
  );

drop index if exists accounts.oauth_intents_one_active_sensitive_action_idx;
create unique index oauth_intents_one_active_sensitive_action_idx
  on accounts.oauth_intents (target_user_id, provider, action)
  where action in ('link', 'reauth', 'merge', 'reclaim')
    and status = 'pending';

create index if not exists oauth_intents_recovery_source_idx
  on accounts.oauth_intents (recovery_for_intent_id)
  where recovery_for_intent_id is not null;

create table accounts.orphan_identity_reclaim_audit (
  id uuid primary key default gen_random_uuid(),
  oauth_intent_id uuid not null,
  original_link_intent_id uuid,
  provider text not null check (provider in ('google', 'discord')),
  provider_subject text,
  source_user_id uuid,
  source_principal_id uuid,
  target_user_id uuid not null,
  target_principal_id uuid not null,
  outcome text not null check (outcome in (
    'reclaimed',
    'already_linked',
    'blocked_active_account',
    'blocked_not_orphan',
    'blocked_conflict'
  )),
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (provider_subject is null or char_length(provider_subject) <= 300)
);

create index orphan_identity_reclaim_audit_subject_idx
  on accounts.orphan_identity_reclaim_audit (
    provider,
    provider_subject,
    created_at desc
  );
create index orphan_identity_reclaim_audit_target_idx
  on accounts.orphan_identity_reclaim_audit (
    target_principal_id,
    created_at desc
  );

alter table accounts.orphan_identity_reclaim_audit enable row level security;
revoke all on table accounts.orphan_identity_reclaim_audit
  from public, anon, authenticated;
revoke all on table accounts.orphan_identity_reclaim_audit from service_role;
grant select, insert on table accounts.orphan_identity_reclaim_audit
  to service_role;

create or replace function accounts.reject_orphan_identity_reclaim_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Orphan identity reclaim audit rows are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists orphan_identity_reclaim_audit_immutable
  on accounts.orphan_identity_reclaim_audit;
create trigger orphan_identity_reclaim_audit_immutable
  before update or delete on accounts.orphan_identity_reclaim_audit
  for each row execute function accounts.reject_orphan_identity_reclaim_audit_mutation();

revoke all on function accounts.reject_orphan_identity_reclaim_audit_mutation()
  from public, anon, authenticated;

create or replace function public.roo_read_reauth_grant(
  p_token_hash text,
  p_user_id uuid,
  p_purpose text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', grant_row.id,
    'purpose', grant_row.purpose,
    'provider', grant_row.provider,
    'expires_at', grant_row.expires_at
  )
  from accounts.reauth_grants grant_row
  join accounts.principal_auth_users mapping
    on mapping.user_id = p_user_id
   and mapping.principal_id = grant_row.principal_id
  where grant_row.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
    and grant_row.user_id = p_user_id
    and grant_row.purpose = p_purpose
    and grant_row.used_at is null
    and grant_row.bound_intent_id is null
    and grant_row.expires_at > pg_catalog.now();
$$;

create or replace function public.roo_fail_oauth_intent(
  p_intent_id uuid,
  p_token_hash text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent accounts.oauth_intents%rowtype;
  v_failure_code text := pg_catalog.lower(pg_catalog.btrim(p_failure_code));
begin
  if v_failure_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'OAuth failure code is invalid' using errcode = '22023';
  end if;

  select * into v_intent
  from accounts.oauth_intents intent
  where intent.id = p_intent_id
    and intent.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
  for update;

  if not found then
    raise exception 'OAuth intent was not found' using errcode = 'P0002';
  end if;
  if v_intent.status = 'failed' and v_intent.failure_code = v_failure_code then
    return pg_catalog.jsonb_build_object(
      'id', v_intent.id,
      'failed', true,
      'idempotent', true
    );
  end if;
  if v_intent.status <> 'pending' then
    raise exception 'OAuth intent is no longer active' using errcode = '22023';
  end if;

  update accounts.oauth_intents intent
  set
    status = 'failed',
    failure_code = v_failure_code,
    completed_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  where intent.id = v_intent.id;

  return pg_catalog.jsonb_build_object(
    'id', v_intent.id,
    'failed', true,
    'failure_code', v_failure_code,
    'idempotent', false
  );
end;
$$;

create or replace function public.roo_create_oauth_intent(p_intent jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flow text := pg_catalog.lower(pg_catalog.btrim(p_intent->>'flow'));
  v_action text := pg_catalog.lower(pg_catalog.btrim(p_intent->>'action'));
  v_provider text := pg_catalog.lower(pg_catalog.btrim(p_intent->>'provider'));
  v_token_hash text := pg_catalog.lower(pg_catalog.btrim(p_intent->>'token_hash'));
  v_target_user_id uuid := nullif(p_intent->>'target_user_id', '')::uuid;
  v_domain_subject text := nullif(pg_catalog.btrim(p_intent->>'domain_subject'), '');
  v_return_path text := p_intent->>'return_path';
  v_expires_at timestamptz := (p_intent->>'expires_at')::timestamptz;
  v_reauth_hash text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_intent->>'reauth_token_hash', ''))
  );
  v_reauth_purpose text := nullif(
    pg_catalog.lower(pg_catalog.btrim(p_intent->>'reauth_purpose')),
    ''
  );
  v_recovery_for_intent_id uuid :=
    nullif(p_intent->>'recovery_for_intent_id', '')::uuid;
  v_principal_id uuid;
  v_reauth_grant_id uuid;
  v_id uuid;
  v_recovery_source accounts.oauth_intents%rowtype;
begin
  if v_flow not in ('referral', 'tourney')
     or v_action not in ('signin', 'signup', 'link', 'reauth', 'merge', 'reclaim')
     or v_provider not in ('google', 'discord')
     or v_token_hash !~ '^[0-9a-f]{64}$'
     or v_return_path is null
     or pg_catalog.left(v_return_path, 1) <> '/'
     or pg_catalog.left(v_return_path, 2) = '//'
     or v_return_path ~ '[[:cntrl:]\\]'
     or pg_catalog.char_length(v_return_path) > 500
     or v_expires_at <= pg_catalog.now()
     or v_expires_at > pg_catalog.now() + interval '15 minutes 10 seconds'
     or ((v_action in ('link', 'reauth', 'merge', 'reclaim')) <>
       (v_target_user_id is not null))
     or ((v_action = 'reauth') <> (v_reauth_purpose is not null))
     or ((v_action = 'reclaim') <> (v_recovery_for_intent_id is not null))
     or (v_action = 'reclaim' and v_flow <> 'referral') then
    raise exception 'OAuth intent is invalid' using errcode = '22023';
  end if;
  if v_reauth_purpose is not null and v_reauth_purpose not in (
    'link_identity', 'unlink_identity', 'merge_account', 'change_password'
  ) then
    raise exception 'OAuth reauthentication purpose is invalid'
      using errcode = '22023';
  end if;

  if v_target_user_id is not null then
    select mapping.principal_id into v_principal_id
    from accounts.principal_auth_users mapping
    where mapping.user_id = v_target_user_id;
    if v_principal_id is null then
      raise exception 'OAuth target principal was not found' using errcode = 'P0002';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        v_principal_id::text || ':' || v_provider || ':' || v_action,
        0
      )
    );
  end if;

  if v_action = 'reclaim' then
    select * into v_recovery_source
    from accounts.oauth_intents source_intent
    where source_intent.id = v_recovery_for_intent_id
      and source_intent.action = 'link'
      and source_intent.flow = 'referral'
      and source_intent.provider = v_provider
      and source_intent.target_user_id = v_target_user_id
      and source_intent.principal_id = v_principal_id
      and source_intent.domain_subject is not distinct from v_domain_subject
      and source_intent.status = 'failed'
      and source_intent.failure_code = 'identity_already_exists'
    for share;
    if not found then
      raise exception 'Identity recovery source was not found' using errcode = '42501';
    end if;
  end if;

  if v_action = 'reclaim' or (v_action = 'link' and v_reauth_hash <> '') then
    if v_reauth_hash !~ '^[0-9a-f]{64}$' then
      raise exception 'Recent authentication is required' using errcode = '42501';
    end if;
    select grant_row.id into v_reauth_grant_id
    from accounts.reauth_grants grant_row
    where grant_row.token_hash = v_reauth_hash
      and grant_row.user_id = v_target_user_id
      and grant_row.principal_id = v_principal_id
      and grant_row.purpose = 'link_identity'
      and (grant_row.provider is null or grant_row.provider = v_provider)
      and grant_row.used_at is null
      and grant_row.bound_intent_id is null
      and grant_row.expires_at > pg_catalog.now()
    for update;
    if v_reauth_grant_id is null then
      raise exception 'Recent authentication is required' using errcode = '42501';
    end if;
  end if;

  if v_target_user_id is not null then
    update accounts.oauth_intents intent
    set
      status = 'replaced',
      failure_code = 'replaced',
      updated_at = pg_catalog.now()
    where intent.target_user_id = v_target_user_id
      and intent.provider = v_provider
      and intent.action = v_action
      and intent.status = 'pending';
  end if;

  insert into accounts.oauth_intents (
    token_hash,
    flow,
    action,
    provider,
    target_user_id,
    principal_id,
    domain_subject,
    return_path,
    expires_at,
    reauth_grant_id,
    reauth_purpose,
    recovery_for_intent_id
  ) values (
    v_token_hash,
    v_flow,
    v_action,
    v_provider,
    v_target_user_id,
    v_principal_id,
    v_domain_subject,
    v_return_path,
    v_expires_at,
    v_reauth_grant_id,
    v_reauth_purpose,
    v_recovery_for_intent_id
  ) returning id into v_id;

  if v_reauth_grant_id is not null then
    update accounts.reauth_grants grant_row
    set
      bound_intent_id = v_id,
      bound_at = pg_catalog.now()
    where grant_row.id = v_reauth_grant_id
      and grant_row.bound_intent_id is null;
    if not found then
      raise exception 'Recent authentication is already in use' using errcode = '42501';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_id,
    'expires_at', v_expires_at
  );
end;
$$;

create or replace function public.roo_reclaim_referral_orphan_identity(
  p_token_hash text,
  p_orphan_user_id uuid,
  p_provider text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intent accounts.oauth_intents%rowtype;
  v_grant accounts.reauth_grants%rowtype;
  v_identity auth.identities%rowtype;
  v_provider text := pg_catalog.lower(pg_catalog.btrim(p_provider));
  v_provider_subject text;
  v_source_principal_id uuid;
  v_source_mapping_count integer := 0;
  v_owner_identity_count integer := 0;
  v_target_principal_id uuid;
  v_target_status text;
  v_block_reason text;
  v_block_outcome text;
  v_public_reason text;
  v_target_providers jsonb;
  v_moved_count integer := 0;
begin
  if v_provider not in ('google', 'discord')
     or pg_catalog.lower(pg_catalog.btrim(p_token_hash)) !~ '^[0-9a-f]{64}$'
     or p_orphan_user_id is null then
    raise exception 'Identity recovery input is invalid' using errcode = '22023';
  end if;

  select * into v_intent
  from accounts.oauth_intents intent
  where intent.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
  for update;
  if not found
     or v_intent.action <> 'reclaim'
     or v_intent.flow <> 'referral'
     or v_intent.provider <> v_provider
     or v_intent.status <> 'pending'
     or v_intent.expires_at <= pg_catalog.now()
     or v_intent.target_user_id is null
     or v_intent.principal_id is null
     or v_intent.recovery_for_intent_id is null then
    raise exception 'Identity recovery intent is not active' using errcode = '42501';
  end if;

  select * into v_grant
  from accounts.reauth_grants grant_row
  where grant_row.id = v_intent.reauth_grant_id
    and grant_row.bound_intent_id = v_intent.id
    and grant_row.user_id = v_intent.target_user_id
    and grant_row.principal_id = v_intent.principal_id
    and grant_row.purpose = 'link_identity'
    and (grant_row.provider is null or grant_row.provider = v_provider)
    and grant_row.used_at is null
    and grant_row.expires_at > pg_catalog.now()
  for update;
  if not found then
    raise exception 'Recent authentication expired' using errcode = '42501';
  end if;

  select mapping.principal_id, principal.status
  into v_target_principal_id, v_target_status
  from accounts.principal_auth_users mapping
  join accounts.principals principal on principal.id = mapping.principal_id
  where mapping.user_id = v_intent.target_user_id
  for update of mapping, principal;

  perform 1
  from auth.users auth_user
  where auth_user.id = v_intent.target_user_id
  for update;
  perform 1
  from accounts.creator_profiles creator
  where creator.principal_id = v_target_principal_id
  for update;
  perform 1
  from accounts.account_roles role
  where role.principal_id = v_target_principal_id
    and role.role = 'creator'
  for update;

  if v_target_principal_id is null
     or v_target_principal_id <> v_intent.principal_id
     or v_target_status <> 'active'
     or not exists (
       select 1
       from accounts.creator_profiles creator
       where creator.principal_id = v_target_principal_id
         and creator.active
     )
     or not exists (
       select 1
       from accounts.account_roles role
       where role.principal_id = v_target_principal_id
         and role.role = 'creator'
     ) then
    raise exception 'Active creator target was not found' using errcode = '42501';
  end if;

  perform 1
  from auth.users auth_user
  where auth_user.id = p_orphan_user_id
  for update;

  select * into v_identity
  from auth.identities identity
  where identity.user_id = p_orphan_user_id
    and identity.provider = v_provider
  order by identity.last_sign_in_at desc nulls last,
    identity.created_at desc,
    identity.id desc
  limit 1
  for update;

  if found then
    v_provider_subject := v_identity.provider_id;
  end if;

  select pg_catalog.count(*)::integer into v_owner_identity_count
  from auth.identities identity
  where identity.user_id = p_orphan_user_id;

  select mapping.principal_id into v_source_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_orphan_user_id
  for update;

  if v_source_principal_id is not null then
    select pg_catalog.count(*)::integer into v_source_mapping_count
    from accounts.principal_auth_users mapping
    where mapping.principal_id = v_source_principal_id;

    perform 1
    from accounts.principals principal
    where principal.id = v_source_principal_id
    for update;
    perform 1
    from accounts.creator_profiles creator
    where creator.principal_id = v_source_principal_id
    for update;
    perform 1
    from accounts.tourney_accounts tourney_account
    where tourney_account.principal_id = v_source_principal_id
    for update;
  end if;

  if v_provider_subject is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'orphan-reclaim:' || v_provider || ':' || v_provider_subject,
        0
      )
    );
  end if;

  if p_orphan_user_id = v_intent.target_user_id
     and v_provider_subject is not null then
    perform public.roo_reconcile_auth_identity_links(v_intent.target_user_id);
    update accounts.reauth_grants
    set used_at = pg_catalog.now()
    where id = v_grant.id and used_at is null;
    update accounts.oauth_intents
    set
      claimed_user_id = v_intent.target_user_id,
      provider_subject = v_provider_subject,
      status = 'completed',
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where id = v_intent.id;
    insert into accounts.orphan_identity_reclaim_audit (
      oauth_intent_id,
      original_link_intent_id,
      provider,
      provider_subject,
      source_user_id,
      source_principal_id,
      target_user_id,
      target_principal_id,
      outcome,
      reason,
      details
    ) values (
      v_intent.id,
      v_intent.recovery_for_intent_id,
      v_provider,
      v_provider_subject,
      p_orphan_user_id,
      v_target_principal_id,
      v_intent.target_user_id,
      v_target_principal_id,
      'already_linked',
      'identity_already_reached_target',
      pg_catalog.jsonb_build_object('identity_id', v_identity.id)
    );
    return pg_catalog.jsonb_build_object(
      'reclaimed', false,
      'alreadyLinked', true,
      'reason', 'already_linked'
    );
  end if;

  if v_provider_subject is null then
    v_block_reason := 'provider_identity_missing';
    v_block_outcome := 'blocked_not_orphan';
    v_public_reason := 'not_orphan';
  elsif v_source_principal_id is null
     or v_owner_identity_count <> 1
     or v_source_mapping_count <> 1 then
    v_block_reason := 'provider_only_orphan_required';
    v_block_outcome := 'blocked_not_orphan';
    v_public_reason := 'not_orphan';
  elsif v_source_principal_id = v_target_principal_id
     or exists (
       select 1
       from accounts.creator_profiles creator
       where creator.principal_id = v_source_principal_id
         and creator.active
     )
     or exists (
       select 1
       from accounts.tourney_accounts tourney_account
       where tourney_account.principal_id = v_source_principal_id
         and tourney_account.active
     ) then
    v_block_reason := 'active_domain_account';
    v_block_outcome := 'blocked_active_account';
    v_public_reason := 'active_account';
  elsif exists (
    select 1
    from accounts.identity_links projected
    where projected.provider = v_provider
      and projected.provider_subject = v_provider_subject
      and (
        projected.user_id <> p_orphan_user_id
        or projected.principal_id <> v_source_principal_id
      )
  ) or exists (
    select 1
    from auth.identities target_identity
    where target_identity.user_id = v_intent.target_user_id
      and target_identity.provider = v_provider
  ) or exists (
    select 1
    from accounts.identity_links target_link
    where target_link.principal_id = v_target_principal_id
      and target_link.provider = v_provider
  ) then
    v_block_reason := 'identity_projection_conflict';
    v_block_outcome := 'blocked_conflict';
    v_public_reason := 'conflict';
  end if;

  if v_block_reason is not null then
    update accounts.reauth_grants
    set used_at = pg_catalog.now()
    where id = v_grant.id and used_at is null;
    update accounts.oauth_intents
    set
      claimed_user_id = p_orphan_user_id,
      provider_subject = v_provider_subject,
      status = 'failed',
      failure_code = v_block_reason,
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    where id = v_intent.id;
    insert into accounts.orphan_identity_reclaim_audit (
      oauth_intent_id,
      original_link_intent_id,
      provider,
      provider_subject,
      source_user_id,
      source_principal_id,
      target_user_id,
      target_principal_id,
      outcome,
      reason,
      details
    ) values (
      v_intent.id,
      v_intent.recovery_for_intent_id,
      v_provider,
      v_provider_subject,
      p_orphan_user_id,
      v_source_principal_id,
      v_intent.target_user_id,
      v_target_principal_id,
      v_block_outcome,
      v_block_reason,
      pg_catalog.jsonb_build_object(
        'owner_identity_count', v_owner_identity_count,
        'source_mapping_count', v_source_mapping_count
      )
    );
    return pg_catalog.jsonb_build_object(
      'reclaimed', false,
      'reason', v_public_reason
    );
  end if;

  update auth.identities identity
  set
    user_id = v_intent.target_user_id,
    updated_at = pg_catalog.now()
  where identity.id = v_identity.id
    and identity.user_id = p_orphan_user_id
    and identity.provider = v_provider
    and identity.provider_id = v_provider_subject;
  get diagnostics v_moved_count = row_count;
  if v_moved_count <> 1 then
    raise exception 'Orphan identity move lost its row guard' using errcode = '40001';
  end if;

  update accounts.identity_links projected
  set
    user_id = v_intent.target_user_id,
    principal_id = v_target_principal_id,
    last_seen_at = pg_catalog.now(),
    metadata = projected.metadata || pg_catalog.jsonb_build_object(
      'orphan_reclaimed_at', pg_catalog.now(),
      'orphan_reclaim_audit_intent_id', v_intent.id
    )
  where projected.provider = v_provider
    and projected.provider_subject = v_provider_subject
    and projected.user_id = p_orphan_user_id
    and projected.principal_id = v_source_principal_id;

  perform public.roo_reconcile_auth_identity_links(v_intent.target_user_id);

  select coalesce(
    pg_catalog.jsonb_agg(provider_row.provider order by provider_row.provider),
    '[]'::jsonb
  ) into v_target_providers
  from (
    select distinct identity.provider
    from auth.identities identity
    where identity.user_id = v_intent.target_user_id
  ) provider_row;

  update auth.users auth_user
  set
    raw_app_meta_data = pg_catalog.jsonb_set(
      coalesce(auth_user.raw_app_meta_data, '{}'::jsonb),
      '{providers}',
      v_target_providers,
      true
    ),
    updated_at = pg_catalog.now()
  where auth_user.id = v_intent.target_user_id;

  update auth.users auth_user
  set
    raw_app_meta_data = pg_catalog.jsonb_set(
      coalesce(auth_user.raw_app_meta_data, '{}'::jsonb) - 'provider',
      '{providers}',
      '[]'::jsonb,
      true
    ),
    updated_at = pg_catalog.now()
  where auth_user.id = p_orphan_user_id;

  delete from auth.sessions session
  where session.user_id = p_orphan_user_id;

  update accounts.reauth_grants
  set used_at = pg_catalog.now()
  where id = v_grant.id and used_at is null;

  update accounts.oauth_intents
  set
    claimed_user_id = p_orphan_user_id,
    provider_subject = v_provider_subject,
    status = 'completed',
    completed_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
  where id = v_intent.id;

  insert into accounts.orphan_identity_reclaim_audit (
    oauth_intent_id,
    original_link_intent_id,
    provider,
    provider_subject,
    source_user_id,
    source_principal_id,
    target_user_id,
    target_principal_id,
    outcome,
    reason,
    details
  ) values (
    v_intent.id,
    v_intent.recovery_for_intent_id,
    v_provider,
    v_provider_subject,
    p_orphan_user_id,
    v_source_principal_id,
    v_intent.target_user_id,
    v_target_principal_id,
    'reclaimed',
    'provider_only_orphan_released',
    pg_catalog.jsonb_build_object(
      'identity_id', v_identity.id,
      'owner_identity_count', v_owner_identity_count,
      'source_mapping_count', v_source_mapping_count
    )
  );

  return pg_catalog.jsonb_build_object(
    'reclaimed', true,
    'alreadyLinked', false,
    'reason', 'orphan_reclaimed',
    'account', accounts.principal_account_json(
      v_target_principal_id,
      v_intent.target_user_id
    )
  );
end;
$$;

revoke all on function public.roo_read_reauth_grant(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.roo_fail_oauth_intent(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.roo_create_oauth_intent(jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_reclaim_referral_orphan_identity(text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.roo_read_reauth_grant(text, uuid, text)
  to service_role;
grant execute on function public.roo_fail_oauth_intent(uuid, text, text)
  to service_role;
grant execute on function public.roo_create_oauth_intent(jsonb)
  to service_role;
grant execute on function public.roo_reclaim_referral_orphan_identity(text, uuid, text)
  to service_role;

comment on table accounts.orphan_identity_reclaim_audit is
  'Immutable outcomes for referral-only release of provider identities from guarded dead orphans.';
comment on function public.roo_reclaim_referral_orphan_identity(text, uuid, text) is
  'Moves one proven provider-only orphan identity to an active creator without merging principals.';

$feature$;
  perform pg_notify('pgrst','reload schema');
end;
$repair$;
