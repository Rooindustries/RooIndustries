set lock_timeout = '5s';
set statement_timeout = '120s';

-- 20260726051500 scoped accounts.identity_links by domain so one Discord account
-- can hold a link row in referral and another in tourney. Only the tourney
-- direction was wired up: linking a Discord already used by a referral account
-- into a tourney account worked, while the reverse still returned
-- discord_account_not_linkable. Both directions are now the same operation with
-- the domain as a parameter.
--
-- Two additional guards, applied to both domains. A principal that already holds
-- a different Discord in the same domain reports it instead of failing on the
-- (user_id, domain, provider) unique index, and every result carries an explicit
-- linked flag so callers never read a refusal as a success.

create or replace function public.roo_link_domain_discord_identity(
  p_principal_id uuid,
  p_domain text,
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
  v_subject text := btrim(coalesce(p_provider_subject, ''));
  v_email text := nullif(lower(btrim(coalesce(p_provider_email, ''))), '');
  v_user_id uuid;
  v_linked integer := 0;
begin
  if p_principal_id is null
     or v_domain not in ('referral', 'tourney')
     or v_subject !~ '^[0-9]{5,30}$' then
    raise exception 'Discord link request is invalid' using errcode = '22023';
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

  if exists (
    select 1 from accounts.identity_links link
    where link.principal_id = p_principal_id
      and link.domain = v_domain
      and link.provider = 'discord'
      and link.provider_subject <> v_subject
  ) then
    return jsonb_build_object(
      'linked', false,
      'reason', 'another_discord_already_linked',
      'domain', v_domain
    );
  end if;

  insert into accounts.identity_links (
    user_id, principal_id, provider, provider_subject, provider_email,
    email_verified, linked_at, last_seen_at, metadata, backend_owner, domain
  )
  values (
    v_user_id, p_principal_id, 'discord', v_subject, v_email,
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
      'reason', 'discord_belongs_to_another_account',
      'domain', v_domain
    );
  end if;

  return jsonb_build_object(
    'linked', true,
    'principal_id', p_principal_id,
    'user_id', v_user_id,
    'provider_subject', v_subject,
    'domain', v_domain
  );
end;
$$;

-- Preserved signature so the tourney caller keeps working unchanged.
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
  select public.roo_link_domain_discord_identity(
    p_principal_id, 'tourney', p_provider_subject, p_provider_email, p_metadata
  );
$$;

revoke all on function public.roo_link_domain_discord_identity(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.roo_link_domain_discord_identity(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.roo_link_tourney_discord_identity(uuid, text, text, jsonb)
  to service_role;
