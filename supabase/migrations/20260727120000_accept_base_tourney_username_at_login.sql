set lock_timeout = '5s';
set statement_timeout = '120s';

-- The tourney username is derived, not chosen: buildInternalTourneyUsername joins
-- the registered Discord name to the first eight hex digits of its SHA-256, so the
-- stored identifier reads `alexisbobana-ce7105e9`. A player types `alexisbobana`.
-- Accepting the roster display name (20260726114500) covered the players who had
-- one, but the plain username -- the value people actually consider their login --
-- still resolved for nobody. Forty-eight of eighty-five approved players could sign
-- in with neither the identifier they knew nor a display name.
--
-- Register the suffix-stripped username as a second `tourney_username` alias so it
-- becomes a first-class identifier, rather than teaching the resolver to strip
-- suffixes at lookup time. An alias row is exact, unique and auditable; a resolver
-- that trimmed a trailing `-[0-9a-f]{8}` would silently merge two distinct
-- identifier spaces and could match a player whose chosen name genuinely ends in
-- eight hex characters.
--
-- The base value is claimed only when it is free. `(alias_type, normalized_value)`
-- is unique, so a base that collides with an existing username or with another
-- player's base is skipped and that player keeps their full identifier; nobody
-- inherits someone else's login. Verified before deploy: 0 duplicate base values
-- and 0 collisions with a different account across the live roster.

create or replace function public.roo_import_tourney_player_account(p_account jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (p_account->>'user_id')::uuid;
  v_auth_email text := lower(btrim(p_account->>'auth_email'));
  v_login_email text := lower(btrim(p_account->>'login_email'));
  v_username text := lower(btrim(p_account->>'username'));
  v_player_id text := btrim(p_account->>'player_id');
  v_version text := coalesce(nullif(p_account->>'credential_version', ''), '1');
  v_source_hash text := lower(btrim(p_account->>'source_hash'));
  v_base_username text;
begin
  if v_user_id is null
     or v_auth_email = ''
     or v_login_email = ''
     or v_username = ''
     or v_player_id = ''
     or v_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'tourney player account is invalid'
      using errcode = '22023';
  end if;

  -- Only the generated eight-hex-digit suffix is stripped. A username without one
  -- yields itself, so the alias insert below collapses into the same row rather
  -- than duplicating it.
  v_base_username := lower(btrim(regexp_replace(v_username, '-[0-9a-f]{8}$', '')));
  if v_base_username = '' or char_length(v_base_username) > 254 then
    v_base_username := null;
  end if;

  insert into public.profiles (
    user_id,
    primary_email,
    display_name,
    status,
    legacy_sanity_id,
    source_hash,
    source_backend,
    updated_at
  )
  values (
    v_user_id,
    v_auth_email,
    coalesce(nullif(p_account->>'display_name', ''), v_username),
    case when coalesce(p_account->>'status', 'pending') in ('approved', 'pending')
      then 'active' else 'disabled' end,
    v_player_id,
    v_source_hash,
    'sanity',
    now()
  )
  on conflict (user_id) do update
  set
    display_name = excluded.display_name,
    status = excluded.status,
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_hash = excluded.source_hash,
    updated_at = now();

  insert into accounts.account_roles (
    user_id, role, source_backend, legacy_sanity_id, source_hash, backend_owner
  )
  values (v_user_id, 'tourney_player', 'sanity', v_player_id, v_source_hash, 'sanity')
  on conflict (user_id, role) do update
  set source_hash = excluded.source_hash, backend_owner = 'sanity';

  insert into accounts.login_aliases (
    user_id,
    alias_type,
    normalized_value,
    verified,
    legacy_sanity_id,
    source_hash,
    backend_owner,
    updated_at
  )
  values
    (v_user_id, 'tourney_username', v_username, true, v_player_id, v_source_hash, 'sanity', now()),
    (v_user_id, 'tourney_email', v_login_email, true, v_player_id, v_source_hash, 'sanity', now())
  on conflict (alias_type, normalized_value) do update
  set
    verified = true,
    source_hash = excluded.source_hash,
    backend_owner = 'sanity',
    updated_at = now()
  where accounts.login_aliases.user_id = excluded.user_id;

  -- Claimed separately from the pair above so a collision cannot abort the import:
  -- the `where` clause on that ON CONFLICT leaves a row owned by another user
  -- unchanged, and a zero-row update there would be indistinguishable from success.
  -- Here the base alias is genuinely optional, so skipping it must be silent.
  if v_base_username is not null and v_base_username <> v_username then
    insert into accounts.login_aliases (
      user_id,
      alias_type,
      normalized_value,
      verified,
      legacy_sanity_id,
      source_hash,
      backend_owner,
      updated_at
    )
    values (
      v_user_id, 'tourney_username', v_base_username, true,
      v_player_id, v_source_hash, 'sanity', now()
    )
    on conflict (alias_type, normalized_value) do update
    set
      verified = true,
      source_hash = excluded.source_hash,
      backend_owner = 'sanity',
      updated_at = now()
    where accounts.login_aliases.user_id = excluded.user_id;
  end if;

  insert into accounts.credential_migrations (
    user_id,
    legacy_sanity_id,
    legacy_source,
    credential_kind,
    status,
    source_hash,
    backend_owner,
    imported_at,
    updated_at
  )
  values (
    v_user_id,
    v_player_id,
    'tourney',
    'bcrypt',
    'imported',
    v_source_hash,
    'sanity',
    now(),
    now()
  )
  on conflict (user_id) do update
  set
    credential_kind = 'bcrypt',
    status = 'imported',
    source_hash = excluded.source_hash,
    backend_owner = 'sanity',
    imported_at = coalesce(accounts.credential_migrations.imported_at, now()),
    updated_at = now();

  insert into accounts.tourney_accounts (
    user_id,
    username,
    role,
    active,
    credential_version,
    legacy_sanity_id,
    source_hash,
    legacy_payload,
    backend_owner,
    updated_at
  )
  values (
    v_user_id,
    v_username,
    'tourney_player',
    coalesce(p_account->>'status', 'pending') = 'approved',
    v_version,
    v_player_id,
    v_source_hash,
    coalesce(p_account->'legacy_payload', '{}'::jsonb),
    'sanity',
    now()
  )
  on conflict (user_id) do update
  set
    username = excluded.username,
    active = excluded.active,
    credential_version = excluded.credential_version,
    legacy_sanity_id = excluded.legacy_sanity_id,
    source_hash = excluded.source_hash,
    legacy_payload = excluded.legacy_payload,
    backend_owner = 'sanity',
    updated_at = now();

  return jsonb_build_object('user_id', v_user_id, 'imported', true);
end;
$function$;
