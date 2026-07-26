set lock_timeout = '5s';
set statement_timeout = '120s';

-- 20260726051500_scope_identity_links_by_domain.sql dropped the global unique
-- (provider, provider_subject) on accounts.identity_links and replaced it with
-- (domain, provider, provider_subject). It rewrote the two functions it defines
-- itself, but two older functions still name the dropped target and so fail with
-- 42P10 (invalid_column_reference) on every call:
--
--   public.roo_finalize_imported_account_metadata  (20260710214134)
--   public.roo_upsert_native_creator_account       (20260722...)
--
-- Live impact when this was found: 15 tourney.external_operations rows of kind
-- supabase_admin_auth sat at status='retry', last_error_code='42P10',
-- attempt_count 6-8 of 12 — every one of the 7 administrator accounts across two
-- commands, climbing toward dead_letter. The Supabase Auth write inside
-- syncSupabaseTourneyAdminAccount had already succeeded; only this trailing
-- metadata RPC failed, so the operation could never be marked applied and kept
-- re-running a credential write that had already landed. The native creator
-- signup path carries the identical defect.
--
-- Both inserts write the synthetic email subject 'email:' || user_id, which is
-- already unique per user, so widening the conflict target to include `domain`
-- cannot merge two distinct people's rows. Verified against production before
-- writing this: 0 provider_subject values exist in more than one domain, and all
-- 201 identity_links rows already have `domain` equal to
-- accounts.principal_domain(principal_id) — so no row will be re-homed.
--
-- The inserts previously omitted `domain` and would have taken the column default
-- 'referral'. For a tourney administrator that is the wrong domain and would
-- insert a second row rather than update the existing tourney-domain one, so both
-- now derive the domain from the principal the same way the domain-scoping
-- migration's backfill did. Ordering makes this sound: roo_import_account_v2
-- updates accounts.tourney_accounts before calling finalize, and
-- roo_upsert_native_creator_account inserts accounts.creator_profiles before its
-- own identity-link upsert, so principal_domain() sees the profile in both cases.

create or replace function public.roo_finalize_imported_account_metadata(
  p_user_id uuid,
  p_source_revision text,
  p_source_hash text,
  p_email_verified boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_principal_id uuid;
  v_domain text;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'account source hash is invalid'
      using errcode = '22023';
  end if;

  select primary_email, principal_id
  into v_email, v_principal_id
  from public.profiles
  where user_id = p_user_id;

  if not found then
    raise exception 'account profile not found'
      using errcode = 'P0002';
  end if;

  update accounts.account_roles
  set
    source_revision = p_source_revision,
    source_hash = p_source_hash,
    backend_owner = 'sanity'
  where user_id = p_user_id;

  update accounts.login_aliases
  set
    source_revision = p_source_revision,
    source_hash = p_source_hash,
    backend_owner = 'sanity',
    updated_at = now()
  where user_id = p_user_id;

  update accounts.credential_migrations
  set
    source_revision = p_source_revision,
    source_hash = p_source_hash,
    backend_owner = 'sanity',
    updated_at = now()
  where user_id = p_user_id;

  update accounts.creator_profiles
  set
    backend_owner = 'sanity',
    updated_at = now()
  where user_id = p_user_id;

  update accounts.tourney_accounts
  set
    backend_owner = 'sanity',
    updated_at = now()
  where user_id = p_user_id;

  if v_email is not null then
    -- Derived after the profile updates above so a tourney account established by
    -- roo_import_account_v2 resolves to the 'tourney' domain rather than the
    -- column default 'referral'.
    v_domain := accounts.principal_domain(v_principal_id);

    insert into accounts.identity_links (
      user_id,
      provider,
      provider_subject,
      provider_email,
      email_verified,
      linked_at,
      last_seen_at,
      metadata,
      legacy_sanity_id,
      source_revision,
      source_hash,
      backend_owner,
      domain
    )
    values (
      p_user_id,
      'email',
      'email:' || p_user_id::text,
      v_email,
      p_email_verified,
      now(),
      now(),
      jsonb_build_object('imported', true),
      (
        select legacy_sanity_id
        from public.profiles
        where user_id = p_user_id
      ),
      p_source_revision,
      p_source_hash,
      'sanity',
      v_domain
    )
    on conflict (domain, provider, provider_subject) do update
    set
      provider_email = excluded.provider_email,
      email_verified = accounts.identity_links.email_verified
        or excluded.email_verified,
      last_seen_at = now(),
      source_revision = excluded.source_revision,
      source_hash = excluded.source_hash,
      backend_owner = 'sanity';
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'email_linked', v_email is not null,
    'metadata_finalized', true,
    'identity_link_domain', v_domain
  );
end;
$function$;

-- Same defect, same fix, on the native creator signup path. Everything above the
-- identity-link tail is reproduced verbatim from the live definition so nothing
-- else shifts; only `domain` on the insert and the conflict target change.
create or replace function public.roo_upsert_native_creator_account(p_account jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_email text := lower(btrim(p_account->>'primary_email'));
  v_code text := lower(btrim(p_account->>'referral_code'));
  v_legacy_id text := nullif(p_account->>'legacy_sanity_id', '');
  v_source_hash text := nullif(lower(p_account->>'source_hash'), '');
  v_source_revision text := nullif(p_account->>'source_revision', '');
  v_registration_status text := coalesce(
    nullif(lower(btrim(p_account->>'registration_status')), ''),
    'active'
  );
  v_account_active boolean := false;
  v_email_verified boolean := false;
  v_domain text;
  v_source migration.source_documents%rowtype;
begin
  if v_user_id is null
     or v_email is null
     or v_email = ''
     or v_code is null
     or v_code = '' then
    raise exception 'native creator account is incomplete'
      using errcode = '22023';
  end if;
  if v_source_hash is not null and v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'native creator source hash is invalid'
      using errcode = '22023';
  end if;
  if v_registration_status not in ('active', 'pending_email') then
    raise exception 'native creator registration status is invalid'
      using errcode = '22023';
  end if;
  if v_legacy_id is not null and v_source_revision is not null then
    select * into v_source
    from migration.source_documents source
    where source.legacy_sanity_id = v_legacy_id
      and source.document_type = 'referral'
      and not source.tombstoned
    for share;
    if found and (
      v_source.source_revision is distinct from v_source_revision
      or coalesce(v_source.payload->>'registrationStatus', 'active')
        is distinct from v_registration_status
    ) then
      raise exception 'native creator source state changed'
        using errcode = '40001';
    end if;
  end if;
  v_account_active := v_registration_status = 'active';
  v_email_verified := v_account_active;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_revision,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_email,
    coalesce(p_account->>'display_name', v_code),
    case when v_account_active then 'active' else 'pending' end,
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    primary_email = excluded.primary_email,
    display_name = excluded.display_name,
    status = case
      when public.profiles.status in ('disabled', 'deleted')
        then public.profiles.status
      else excluded.status
    end,
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, public.profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    source_backend = 'supabase',
    updated_at = now();

  insert into accounts.account_roles (
    user_id,
    role,
    source_backend,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner
  )
  select
    v_user_id,
    role,
    'supabase',
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase'
  from unnest(array['customer', 'creator']) role
  on conflict (user_id, role) do update
  set
    source_backend = 'supabase',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  insert into accounts.login_aliases (
    user_id,
    alias_type,
    normalized_value,
    verified,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values
    (
      v_user_id,
      'email',
      v_email,
      v_email_verified,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    ),
    (
      v_user_id,
      'referral_code',
      v_code,
      v_email_verified,
      v_legacy_id,
      nullif(p_account->>'source_revision', ''),
      v_source_hash,
      'supabase',
      now()
    )
  on conflict (alias_type, normalized_value) do update
  set
    verified = accounts.login_aliases.verified or excluded.verified,
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now()
  where accounts.login_aliases.user_id = excluded.user_id;

  insert into accounts.credential_migrations (
    user_id,
    legacy_sanity_id,
    legacy_source,
    credential_kind,
    status,
    source_revision,
    source_hash,
    backend_owner,
    imported_at,
    upgraded_at,
    updated_at
  )
  values (
    v_user_id,
    v_legacy_id,
    'none',
    'bcrypt',
    'upgraded',
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now(),
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.credential_migrations.legacy_sanity_id),
    legacy_source = 'none',
    credential_kind = 'bcrypt',
    status = 'upgraded',
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    imported_at = coalesce(accounts.credential_migrations.imported_at, now()),
    upgraded_at = coalesce(accounts.credential_migrations.upgraded_at, now()),
    failure_reason = null,
    updated_at = now();

  insert into accounts.creator_profiles (
    user_id,
    referral_code,
    paypal_email,
    contact_discord,
    active,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    updated_at
  )
  values (
    v_user_id,
    v_code,
    nullif(lower(btrim(p_account->>'paypal_email')), ''),
    nullif(p_account->>'contact_discord', ''),
    v_account_active,
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    now()
  )
  on conflict (user_id) do update
  set
    referral_code = excluded.referral_code,
    paypal_email = excluded.paypal_email,
    contact_discord = excluded.contact_discord,
    active = excluded.active and not exists (
      select 1
      from public.profiles profile
      where profile.user_id = excluded.user_id
        and profile.status in ('disabled', 'deleted')
    ),
    legacy_sanity_id = coalesce(excluded.legacy_sanity_id, accounts.creator_profiles.legacy_sanity_id),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase',
    updated_at = now();

  -- Resolved after accounts.creator_profiles is written above, so a brand-new
  -- creator resolves to 'referral' rather than relying on the column default.
  select accounts.principal_domain(profile.principal_id)
  into v_domain
  from public.profiles profile
  where profile.user_id = v_user_id;

  insert into accounts.identity_links (
    user_id,
    provider,
    provider_subject,
    provider_email,
    email_verified,
    linked_at,
    last_seen_at,
    metadata,
    legacy_sanity_id,
    source_revision,
    source_hash,
    backend_owner,
    domain
  )
  values (
    v_user_id,
    'email',
    'email:' || v_user_id::text,
    v_email,
    v_email_verified,
    now(),
    now(),
    jsonb_build_object('native', true),
    v_legacy_id,
    nullif(p_account->>'source_revision', ''),
    v_source_hash,
    'supabase',
    coalesce(v_domain, 'referral')
  )
  on conflict (domain, provider, provider_subject) do update
  set
    provider_email = excluded.provider_email,
    email_verified = accounts.identity_links.email_verified
      or excluded.email_verified,
    last_seen_at = now(),
    source_revision = excluded.source_revision,
    source_hash = excluded.source_hash,
    backend_owner = 'supabase';

  return jsonb_build_object('user_id', v_user_id, 'upserted', true);
end;
$function$;

-- `create or replace` preserves the existing ACL; both were already service_role
-- only, and these statements keep that true without depending on it.
revoke all on function public.roo_finalize_imported_account_metadata(uuid, text, text, boolean)
  from public, anon, authenticated;
revoke all on function public.roo_upsert_native_creator_account(jsonb)
  from public, anon, authenticated;
grant execute on function public.roo_finalize_imported_account_metadata(uuid, text, text, boolean)
  to service_role;
grant execute on function public.roo_upsert_native_creator_account(jsonb)
  to service_role;

-- Fail the migration rather than leave a stale target behind.
do $verify$
declare
  v_stale text[];
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by 1), '{}')
  into v_stale
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'accounts', 'tourney', 'referral')
    and p.prokind = 'f'
    and pg_get_functiondef(p.oid) like '%on conflict (provider, provider_subject)%';

  if array_length(v_stale, 1) > 0 then
    raise exception
      'functions still target the dropped identity_links unique index: %',
      array_to_string(v_stale, ', ')
      using errcode = '22023';
  end if;
end;
$verify$;
