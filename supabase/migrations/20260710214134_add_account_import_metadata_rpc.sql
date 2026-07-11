
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
as $$
declare
  v_email text;
begin
  if p_source_hash is null or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'account source hash is invalid'
      using errcode = '22023';
  end if;

  select primary_email
  into v_email
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
      backend_owner
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
      'sanity'
    )
    on conflict (provider, provider_subject) do update
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
    'metadata_finalized', true
  );
end;
$$;

revoke all on function public.roo_finalize_imported_account_metadata(
  uuid,
  text,
  text,
  boolean
) from public, anon, authenticated;

grant execute on function public.roo_finalize_imported_account_metadata(
  uuid,
  text,
  text,
  boolean
) to service_role;
