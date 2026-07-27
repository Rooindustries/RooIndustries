set lock_timeout = '5s';
set statement_timeout = '120s';

-- 20260726120000 made the cross-domain link a single operation with the domain as
-- a parameter, but the provider stayed hardcoded to Discord. The tourney and
-- referral sign-in pages both offer Google alongside Discord, so a person who
-- signs in with a Google account that already belongs to their other domain hits
-- discord_account_not_linkable -- the same dead end the domain parameter was
-- added to remove, one axis over. The provider becomes a parameter too.
--
-- The subject format check has to vary by provider: a Discord snowflake is 5-30
-- digits, while a Google `sub` is an opaque 255-char-max string that is
-- conventionally 21 digits but is not specified to stay numeric. Each provider
-- gets the tightest check that is actually correct for it rather than one shared
-- pattern loose enough for both.

create or replace function public.roo_link_domain_social_identity(
  p_principal_id uuid,
  p_domain text,
  p_provider text,
  p_provider_subject text,
  p_provider_email text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := lower(btrim(coalesce(p_domain, '')));
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_subject text := btrim(coalesce(p_provider_subject, ''));
  v_email text := nullif(lower(btrim(coalesce(p_provider_email, ''))), '');
  v_user_id uuid;
  v_linked integer := 0;
begin
  if p_principal_id is null
     or v_domain not in ('referral', 'tourney')
     or v_provider not in ('google', 'discord')
     or (v_provider = 'discord' and v_subject !~ '^[0-9]{5,30}$')
     or (v_provider = 'google'
         and (char_length(v_subject) < 1 or char_length(v_subject) > 255
              or v_subject ~ '[[:space:]]')) then
    raise exception 'Social link request is invalid' using errcode = '22023';
  end if;

  if v_domain = 'tourney' then
    select tourney.user_id into v_user_id
    from accounts.tourney_accounts tourney
    where tourney.principal_id = p_principal_id
    limit 1;
  else
    select creator.user_id into v_user_id
    from accounts.creator_profiles creator
    where creator.principal_id = p_principal_id
    limit 1;
  end if;
  if v_user_id is null then
    raise exception 'Account was not found in the % domain', v_domain
      using errcode = 'P0002';
  end if;

  -- Scoped to this provider. A principal holding a Discord link in this domain
  -- must still be able to add a Google one; only a second account of the SAME
  -- provider is refused, which is what identity_links_one_social_provider_per_*
  -- enforces at the index level.
  if exists (
    select 1 from accounts.identity_links link
    where link.principal_id = p_principal_id
      and link.domain = v_domain
      and link.provider = v_provider
      and link.provider_subject <> v_subject
  ) then
    return jsonb_build_object(
      'linked', false,
      'reason', case
        when v_provider = 'google' then 'another_google_already_linked'
        else 'another_discord_already_linked'
      end,
      'domain', v_domain,
      'provider', v_provider
    );
  end if;

  insert into accounts.identity_links (
    user_id, principal_id, provider, provider_subject, provider_email,
    email_verified, linked_at, last_seen_at, metadata, backend_owner, domain
  )
  values (
    v_user_id, p_principal_id, v_provider, v_subject, v_email,
    false, now(), now(), coalesce(p_metadata, '{}'::jsonb),
    v_domain || '_link', v_domain
  )
  on conflict (domain, provider, provider_subject) do update set
    user_id = excluded.user_id,
    provider_email = coalesce(excluded.provider_email, accounts.identity_links.provider_email),
    last_seen_at = now(),
    metadata = excluded.metadata,
    backend_owner = excluded.backend_owner
  where accounts.identity_links.principal_id = excluded.principal_id;
  get diagnostics v_linked = row_count;

  if v_linked = 0 then
    return jsonb_build_object(
      'linked', false,
      'reason', case
        when v_provider = 'google' then 'google_belongs_to_another_account'
        else 'discord_belongs_to_another_account'
      end,
      'domain', v_domain,
      'provider', v_provider
    );
  end if;

  return jsonb_build_object(
    'linked', true,
    'principal_id', p_principal_id,
    'user_id', v_user_id,
    'provider', v_provider,
    'provider_subject', v_subject,
    'domain', v_domain
  );
end;
$$;

-- Preserved signatures so an in-flight request that started against the previous
-- deploy keeps working. Both delegate rather than duplicating the body.
create or replace function public.roo_link_domain_discord_identity(
  p_principal_id uuid,
  p_domain text,
  p_provider_subject text,
  p_provider_email text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.roo_link_domain_social_identity(
    p_principal_id, p_domain, 'discord', p_provider_subject,
    p_provider_email, p_metadata
  );
$$;

create or replace function public.roo_link_tourney_discord_identity(
  p_principal_id uuid,
  p_provider_subject text,
  p_provider_email text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.roo_link_domain_social_identity(
    p_principal_id, 'tourney', 'discord', p_provider_subject,
    p_provider_email, p_metadata
  );
$$;

revoke all on function public.roo_link_domain_social_identity(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_link_domain_discord_identity(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.roo_link_domain_social_identity(uuid, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.roo_link_domain_discord_identity(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  to service_role;
