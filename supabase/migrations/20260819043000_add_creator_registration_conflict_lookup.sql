set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.roo_creator_registration_conflicts(
  p_email text,
  p_referral_code text,
  p_user_id uuid default null,
  p_legacy_sanity_ids text[] default '{}'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_code text := lower(btrim(coalesce(p_referral_code, '')));
  v_legacy_ids text[] := array(
    select distinct btrim(value)
    from unnest(coalesce(p_legacy_sanity_ids, '{}')) value
    where nullif(btrim(value), '') is not null
  );
  v_principal_id uuid;
begin
  if char_length(v_email) > 254
     or v_code !~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$' then
    raise exception 'creator registration conflict lookup is invalid'
      using errcode = '22023';
  end if;
  if p_user_id is not null then
    select mapping.principal_id
    into v_principal_id
    from accounts.principal_auth_users mapping
    where mapping.user_id = p_user_id;
  end if;

  return jsonb_build_object(
    'email_reserved', v_email <> '' and exists (
      select 1
      from (
        select profile.principal_id, creator.legacy_sanity_id
        from public.profiles profile
        left join accounts.creator_profiles creator
          on creator.principal_id = profile.principal_id
        where lower(btrim(profile.primary_email)) = v_email
        union
        select alias.principal_id,
          coalesce(creator.legacy_sanity_id, alias.legacy_sanity_id)
        from accounts.login_aliases alias
        left join accounts.creator_profiles creator
          on creator.principal_id = alias.principal_id
        where alias.alias_type = 'email'
          and alias.normalized_value = v_email
      ) reservation
      where (v_principal_id is null or reservation.principal_id <> v_principal_id)
        and not exists (
          select 1
          from unnest(v_legacy_ids) retry_id
          where reservation.legacy_sanity_id = retry_id
        )
    ),
    'referral_code_reserved', exists (
      select 1
      from (
        select creator.principal_id, creator.legacy_sanity_id
        from accounts.creator_profiles creator
        where creator.referral_code = v_code
        union
        select alias.principal_id, creator.legacy_sanity_id
        from accounts.login_aliases alias
        left join accounts.creator_profiles creator
          on creator.principal_id = alias.principal_id
        where alias.alias_type = 'referral_code'
          and alias.normalized_value = v_code
      ) reservation
      where (
        v_principal_id is null
        or reservation.principal_id <> v_principal_id
      )
        and not exists (
          select 1
          from unnest(v_legacy_ids) retry_id
          where reservation.legacy_sanity_id = retry_id
        )
    )
  );
end;
$$;

revoke all on function public.roo_creator_registration_conflicts(text, text, uuid, text[])
  from public, anon, authenticated;
grant execute on function public.roo_creator_registration_conflicts(text, text, uuid, text[])
  to service_role;

notify pgrst, 'reload schema';
