-- Production schema for the accounts objects that
-- 20260726185500_scope_account_import_identity_link_conflict_by_domain.sql
-- reads and writes, captured with pg_dump --schema-only so the fixture cannot
-- drift from the constraint the rewritten functions actually run against.
-- Regenerate with the pg_dump invocation in
-- scripts/test-account-domain-identity-postgres.mjs.
--
-- The creator fallback-authority and creator-terms triggers are deliberately
-- excluded: they pull in an unrelated dependency chain and play no part in
-- identity-link conflict resolution. The assign_principal_id triggers ARE kept,
-- along with their ensure_principal_for_user dependency, because they are how
-- principal_id gets populated and therefore how the domain is derived.


-- roo_upsert_native_creator_account takes a for-share lock on this row and
-- raises 40001 when the revision moved, so it has to be the real table. Its
-- project_referral_source_change trigger is excluded: that projection is an
-- unrelated dependency chain and plays no part in identity-link conflicts.
CREATE TABLE migration.source_documents (
    legacy_sanity_id text NOT NULL,
    document_type text NOT NULL,
    source_revision text,
    source_hash text NOT NULL,
    payload jsonb NOT NULL,
    source_created_at timestamp with time zone,
    source_updated_at timestamp with time zone,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    operational_imported boolean DEFAULT false NOT NULL,
    cms_imported boolean DEFAULT false NOT NULL,
    tombstoned boolean DEFAULT false NOT NULL,
    tombstoned_at timestamp with time zone,
    backend_owner text DEFAULT 'sanity'::text NOT NULL,
    cutover_generation integer DEFAULT 0 NOT NULL,
    CONSTRAINT source_documents_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT source_documents_source_hash_check CHECK ((source_hash ~ '^[0-9a-f]{64}$'::text))
);
ALTER TABLE ONLY migration.source_documents
    ADD CONSTRAINT source_documents_pkey PRIMARY KEY (legacy_sanity_id);
CREATE INDEX source_documents_type_idx ON migration.source_documents USING btree (document_type);
CREATE POLICY deny_browser_access ON migration.source_documents TO authenticated, anon USING (false) WITH CHECK (false);
ALTER TABLE migration.source_documents ENABLE ROW LEVEL SECURITY;

CREATE TABLE accounts.account_roles (
    user_id uuid NOT NULL,
    role text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    granted_by uuid,
    source_backend text DEFAULT 'supabase'::text NOT NULL,
    legacy_sanity_id text,
    source_revision text,
    source_hash text,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    principal_id uuid NOT NULL,
    CONSTRAINT account_roles_role_check CHECK ((role = ANY (ARRAY['customer'::text, 'creator'::text, 'tourney_player'::text, 'tourney_viewer'::text, 'tourney_caster'::text, 'tourney_owner'::text, 'administrator'::text]))),
    CONSTRAINT account_roles_source_backend_check CHECK ((source_backend = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT accounts_account_roles_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text])))
);

CREATE TABLE accounts.creator_profiles (
    user_id uuid NOT NULL,
    referral_code text NOT NULL,
    paypal_email text,
    contact_discord text,
    contact_telegram text,
    contact_phone text,
    commission_basis_points integer DEFAULT 1000 NOT NULL,
    discount_basis_points integer DEFAULT 0 NOT NULL,
    successful_referrals integer DEFAULT 0 NOT NULL,
    payout_details jsonb DEFAULT '{}'::jsonb NOT NULL,
    accounting_totals jsonb DEFAULT '{}'::jsonb NOT NULL,
    active boolean DEFAULT true NOT NULL,
    legacy_sanity_id text,
    source_revision text,
    source_hash text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    principal_id uuid NOT NULL,
    total_basis_points integer DEFAULT 1500 NOT NULL,
    bypass_referral_requirement boolean DEFAULT false NOT NULL,
    terms_version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT accounts_creator_profiles_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT creator_profiles_commission_basis_points_check CHECK (((commission_basis_points >= 0) AND (commission_basis_points <= 10000))),
    CONSTRAINT creator_profiles_discount_basis_points_check CHECK (((discount_basis_points >= 0) AND (discount_basis_points <= 10000))),
    CONSTRAINT creator_profiles_paypal_email_check CHECK (((paypal_email IS NULL) OR (paypal_email = lower(btrim(paypal_email))))),
    CONSTRAINT creator_profiles_referral_code_check CHECK (((referral_code = lower(btrim(referral_code))) AND ((char_length(referral_code) >= 2) AND (char_length(referral_code) <= 50)))),
    CONSTRAINT creator_profiles_successful_referrals_check CHECK ((successful_referrals >= 0)),
    CONSTRAINT creator_profiles_terms_allocation_check CHECK (((commission_basis_points + discount_basis_points) <= total_basis_points)),
    CONSTRAINT creator_profiles_terms_version_check CHECK ((terms_version > 0)),
    CONSTRAINT creator_profiles_total_basis_points_check CHECK (((total_basis_points >= 0) AND (total_basis_points <= 10000)))
);

CREATE TABLE accounts.credential_migrations (
    user_id uuid NOT NULL,
    legacy_sanity_id text,
    legacy_source text NOT NULL,
    credential_kind text NOT NULL,
    status text NOT NULL,
    source_revision text,
    imported_at timestamp with time zone,
    upgraded_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    failure_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_hash text,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    principal_id uuid NOT NULL,
    CONSTRAINT accounts_credential_migrations_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT credential_migrations_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT credential_migrations_credential_kind_check CHECK ((credential_kind = ANY (ARRAY['bcrypt'::text, 'legacy_plaintext'::text, 'none'::text]))),
    CONSTRAINT credential_migrations_legacy_source_check CHECK ((legacy_source = ANY (ARRAY['referral'::text, 'tourney'::text, 'none'::text]))),
    CONSTRAINT credential_migrations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'imported'::text, 'upgraded'::text, 'blocked'::text])))
);

CREATE TABLE accounts.identity_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    provider_subject text NOT NULL,
    provider_email text,
    email_verified boolean DEFAULT false NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    legacy_sanity_id text,
    source_revision text,
    source_hash text,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    principal_id uuid NOT NULL,
    domain text DEFAULT 'referral'::text NOT NULL,
    CONSTRAINT accounts_identity_links_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text, 'tourney_link'::text, 'referral_link'::text]))),
    CONSTRAINT identity_links_domain_check CHECK ((domain = ANY (ARRAY['referral'::text, 'tourney'::text]))),
    CONSTRAINT identity_links_provider_check CHECK ((provider = ANY (ARRAY['email'::text, 'google'::text, 'apple'::text, 'discord'::text]))),
    CONSTRAINT identity_links_provider_email_check CHECK (((provider_email IS NULL) OR (provider_email = lower(btrim(provider_email)))))
);

CREATE TABLE accounts.login_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    alias_type text NOT NULL,
    normalized_value text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    legacy_sanity_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    source_revision text,
    source_hash text,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    principal_id uuid NOT NULL,
    CONSTRAINT accounts_login_aliases_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT login_aliases_alias_type_check CHECK ((alias_type = ANY (ARRAY['email'::text, 'referral_code'::text, 'tourney_username'::text, 'tourney_email'::text]))),
    CONSTRAINT login_aliases_normalized_value_check CHECK (((normalized_value = lower(btrim(normalized_value))) AND ((char_length(normalized_value) >= 1) AND (char_length(normalized_value) <= 254))))
);

CREATE TABLE accounts.principal_auth_users (
    principal_id uuid NOT NULL,
    user_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    source text DEFAULT 'migration'::text NOT NULL,
    CONSTRAINT principal_auth_users_source_check CHECK ((source = ANY (ARRAY['migration'::text, 'signup'::text, 'link'::text, 'merge'::text])))
);

CREATE TABLE accounts.principals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    session_version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT principals_session_version_check CHECK ((session_version > 0)),
    CONSTRAINT principals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'deleted'::text])))
);

CREATE TABLE accounts.tourney_accounts (
    user_id uuid NOT NULL,
    username text NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    credential_version text DEFAULT '1'::text NOT NULL,
    legacy_sanity_id text,
    source_revision text,
    source_hash text,
    legacy_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    backend_owner text DEFAULT 'supabase'::text NOT NULL,
    lifecycle_status text DEFAULT 'approved'::text NOT NULL,
    principal_id uuid NOT NULL,
    CONSTRAINT accounts_tourney_accounts_backend_owner_check CHECK ((backend_owner = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT tourney_accounts_lifecycle_status_check CHECK ((lifecycle_status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'withdrawn'::text, 'removed'::text, 'disabled'::text]))),
    CONSTRAINT tourney_accounts_role_check CHECK ((role = ANY (ARRAY['tourney_player'::text, 'tourney_viewer'::text, 'tourney_caster'::text, 'tourney_owner'::text]))),
    CONSTRAINT tourney_accounts_username_check CHECK (((username = lower(btrim(username))) AND ((char_length(username) >= 1) AND (char_length(username) <= 80))))
);

CREATE TABLE public.profiles (
    user_id uuid NOT NULL,
    primary_email text,
    display_name text DEFAULT ''::text NOT NULL,
    avatar_url text,
    timezone text,
    status text DEFAULT 'active'::text NOT NULL,
    legacy_sanity_id text,
    source_revision text,
    source_hash text,
    source_backend text DEFAULT 'supabase'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    principal_id uuid NOT NULL,
    CONSTRAINT profiles_primary_email_check CHECK (((primary_email IS NULL) OR ((primary_email = lower(btrim(primary_email))) AND ((char_length(primary_email) >= 3) AND (char_length(primary_email) <= 254))))),
    CONSTRAINT profiles_source_backend_check CHECK ((source_backend = ANY (ARRAY['sanity'::text, 'supabase'::text]))),
    CONSTRAINT profiles_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'disabled'::text, 'deleted'::text])))
);

ALTER TABLE ONLY accounts.account_roles
    ADD CONSTRAINT account_roles_pkey PRIMARY KEY (user_id, role);

ALTER TABLE ONLY accounts.creator_profiles
    ADD CONSTRAINT creator_profiles_legacy_sanity_id_key UNIQUE (legacy_sanity_id);

ALTER TABLE ONLY accounts.creator_profiles
    ADD CONSTRAINT creator_profiles_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY accounts.creator_profiles
    ADD CONSTRAINT creator_profiles_referral_code_key UNIQUE (referral_code);

ALTER TABLE ONLY accounts.credential_migrations
    ADD CONSTRAINT credential_migrations_legacy_sanity_id_key UNIQUE (legacy_sanity_id);

ALTER TABLE ONLY accounts.credential_migrations
    ADD CONSTRAINT credential_migrations_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY accounts.identity_links
    ADD CONSTRAINT identity_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY accounts.login_aliases
    ADD CONSTRAINT login_aliases_alias_type_normalized_value_key UNIQUE (alias_type, normalized_value);

ALTER TABLE ONLY accounts.login_aliases
    ADD CONSTRAINT login_aliases_pkey PRIMARY KEY (id);

ALTER TABLE ONLY accounts.principal_auth_users
    ADD CONSTRAINT principal_auth_users_pkey PRIMARY KEY (principal_id, user_id);

ALTER TABLE ONLY accounts.principal_auth_users
    ADD CONSTRAINT principal_auth_users_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY accounts.principals
    ADD CONSTRAINT principals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY accounts.tourney_accounts
    ADD CONSTRAINT tourney_accounts_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY accounts.tourney_accounts
    ADD CONSTRAINT tourney_accounts_username_key UNIQUE (username);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_legacy_sanity_id_key UNIQUE (legacy_sanity_id);

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);

CREATE INDEX account_roles_granted_by_idx ON accounts.account_roles USING btree (granted_by);

CREATE UNIQUE INDEX account_roles_principal_role_key ON accounts.account_roles USING btree (principal_id, role);

CREATE UNIQUE INDEX creator_profiles_principal_key ON accounts.creator_profiles USING btree (principal_id);

CREATE INDEX credential_migrations_principal_id_idx ON accounts.credential_migrations USING btree (principal_id);

CREATE UNIQUE INDEX identity_links_domain_provider_subject_key ON accounts.identity_links USING btree (domain, provider, provider_subject);

CREATE UNIQUE INDEX identity_links_one_social_provider_per_principal ON accounts.identity_links USING btree (principal_id, domain, provider) WHERE (provider = ANY (ARRAY['google'::text, 'discord'::text, 'apple'::text]));

CREATE UNIQUE INDEX identity_links_one_social_provider_per_user ON accounts.identity_links USING btree (user_id, domain, provider) WHERE (provider = ANY (ARRAY['google'::text, 'discord'::text, 'apple'::text]));

CREATE INDEX identity_links_user_id_idx ON accounts.identity_links USING btree (user_id);

CREATE INDEX login_aliases_principal_id_idx ON accounts.login_aliases USING btree (principal_id);

CREATE INDEX login_aliases_user_id_idx ON accounts.login_aliases USING btree (user_id);

CREATE UNIQUE INDEX principal_auth_users_one_primary_idx ON accounts.principal_auth_users USING btree (principal_id) WHERE is_primary;

CREATE UNIQUE INDEX tourney_accounts_legacy_id_unique ON accounts.tourney_accounts USING btree (legacy_sanity_id) WHERE (legacy_sanity_id IS NOT NULL);

CREATE UNIQUE INDEX tourney_accounts_principal_key ON accounts.tourney_accounts USING btree (principal_id);

CREATE UNIQUE INDEX profiles_primary_email_key ON public.profiles USING btree (lower(primary_email)) WHERE (primary_email IS NOT NULL);

CREATE INDEX profiles_principal_id_idx ON public.profiles USING btree (principal_id);








ALTER TABLE ONLY accounts.account_roles
    ADD CONSTRAINT account_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY accounts.account_roles
    ADD CONSTRAINT account_roles_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.account_roles
    ADD CONSTRAINT account_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.creator_profiles
    ADD CONSTRAINT creator_profiles_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.creator_profiles
    ADD CONSTRAINT creator_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.credential_migrations
    ADD CONSTRAINT credential_migrations_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.credential_migrations
    ADD CONSTRAINT credential_migrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.identity_links
    ADD CONSTRAINT identity_links_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.identity_links
    ADD CONSTRAINT identity_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.login_aliases
    ADD CONSTRAINT login_aliases_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.login_aliases
    ADD CONSTRAINT login_aliases_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.principal_auth_users
    ADD CONSTRAINT principal_auth_users_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.principal_auth_users
    ADD CONSTRAINT principal_auth_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.tourney_accounts
    ADD CONSTRAINT tourney_accounts_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY accounts.tourney_accounts
    ADD CONSTRAINT tourney_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES accounts.principals(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE accounts.account_roles ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts.creator_profiles ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts.credential_migrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY deny_browser_access ON accounts.account_roles TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY deny_browser_access ON accounts.creator_profiles TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY deny_browser_access ON accounts.credential_migrations TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY deny_browser_access ON accounts.identity_links TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY deny_browser_access ON accounts.login_aliases TO authenticated, anon USING (false) WITH CHECK (false);

CREATE POLICY deny_browser_access ON accounts.tourney_accounts TO authenticated, anon USING (false) WITH CHECK (false);

ALTER TABLE accounts.identity_links ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts.login_aliases ENABLE ROW LEVEL SECURITY;

ALTER TABLE accounts.principal_auth_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY principal_auth_users_deny_browser ON accounts.principal_auth_users AS RESTRICTIVE TO authenticated, anon USING (false) WITH CHECK (false);

ALTER TABLE accounts.principals ENABLE ROW LEVEL SECURITY;

CREATE POLICY principals_deny_browser ON accounts.principals AS RESTRICTIVE TO authenticated, anon USING (false) WITH CHECK (false);

ALTER TABLE accounts.tourney_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_select_own ON public.profiles FOR SELECT TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id));

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));

CREATE OR REPLACE FUNCTION accounts.ensure_principal_for_user(p_user_id uuid, p_source text DEFAULT 'migration'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_principal_id uuid;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users auth_user where auth_user.id = p_user_id
  ) then
    raise exception 'Auth user was not found' using errcode = 'P0002';
  end if;
  select mapping.principal_id into v_principal_id
  from accounts.principal_auth_users mapping
  where mapping.user_id = p_user_id;
  if v_principal_id is not null then return v_principal_id; end if;

  insert into accounts.principals (id) values (p_user_id)
  on conflict (id) do nothing;
  insert into accounts.principal_auth_users (
    principal_id, user_id, is_primary, source
  ) values (
    p_user_id, p_user_id, true,
    case when p_source in ('migration', 'signup', 'link', 'merge')
      then p_source else 'migration' end
  ) on conflict (user_id) do nothing;
  return (
    select mapping.principal_id
    from accounts.principal_auth_users mapping
    where mapping.user_id = p_user_id
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION accounts.assign_principal_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.user_id is null then
    new.principal_id := null;
    return new;
  end if;
  new.principal_id := accounts.ensure_principal_for_user(new.user_id, 'migration');
  return new;
end;
$function$
;

CREATE TRIGGER account_roles_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.account_roles FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER creator_profiles_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.creator_profiles FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER credential_migrations_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.credential_migrations FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER identity_links_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.identity_links FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER login_aliases_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.login_aliases FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER tourney_accounts_assign_principal BEFORE INSERT OR UPDATE OF user_id ON accounts.tourney_accounts FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
CREATE TRIGGER profiles_assign_principal BEFORE INSERT OR UPDATE OF user_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION accounts.assign_principal_id();
