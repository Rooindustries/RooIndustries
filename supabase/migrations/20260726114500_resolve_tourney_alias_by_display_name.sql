set lock_timeout = '5s';
set statement_timeout = '120s';

-- Tourney sign-in accepted two identifiers: the generated tourney username and
-- the registered email. The username is derived, never chosen -- see
-- buildInternalTourneyUsername in src/server/tourney/playerStore.js, which joins
-- the registered Discord name to the first eight hex digits of its SHA-256. A
-- player has no way to know that value, and the roster name they do know was not
-- an identifier at all, so the sign-in box rejected the only name they had.
--
-- Accept the roster display name as a third identifier. Ambiguity is resolved by
-- refusing it rather than guessing: the name resolves only when exactly one live
-- player answers to it, so a display name shared by two players falls back to
-- email instead of selecting the wrong account. Exact alias matches still win,
-- which keeps a username or email that happens to equal someone else's display
-- name resolving to its owner. Password verification is untouched.

create or replace function public.roo_resolve_tourney_account_alias(p_identifier text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_needle text := lower(btrim(coalesce(p_identifier, '')));
  v_result jsonb;
  v_player_id text;
  v_matches integer := 0;
begin
  if v_needle = '' or length(v_needle) > 254 then
    return null;
  end if;

  select accounts.principal_account_json(alias.principal_id, alias.user_id)
      || jsonb_build_object('legacy_sanity_id', tourney.legacy_sanity_id)
    into v_result
  from accounts.login_aliases alias
  join accounts.tourney_accounts tourney
    on tourney.principal_id = alias.principal_id
  where alias.normalized_value = v_needle
    and alias.alias_type in ('tourney_username', 'tourney_email', 'email')
  order by case alias.alias_type
    when 'tourney_username' then 0 when 'tourney_email' then 1 else 2
  end
  limit 1;
  if v_result is not null then
    return v_result;
  end if;

  -- The roster table is created by the application (ensureTourneyPlayerSchema),
  -- not by a migration, so tolerate its absence instead of failing the lookup.
  if to_regclass('tourney.tourney_players') is null then
    return null;
  end if;

  -- Withdrawn, denied and removed registrations are excluded so a departed
  -- player's name cannot shadow a live one. Any failure reading the roster
  -- degrades to "the display name did not resolve" rather than propagating: this
  -- runs inside sign-in, where an exception would take out username and email
  -- sign-in too.
  begin
    select count(*), min(player.id)
      into v_matches, v_player_id
    from tourney.tourney_players player
    where lower(btrim(coalesce(player.display_name, ''))) = v_needle
      and player.status in ('approved', 'pending');
  exception when others then
    return null;
  end;

  if v_matches <> 1 or v_player_id is null then
    return null;
  end if;

  -- legacy_sanity_id carries the roster row id through the account import, so it
  -- is the mapping that does not depend on principal_id having been backfilled
  -- onto the player row.
  select accounts.principal_account_json(tourney.principal_id, tourney.user_id)
      || jsonb_build_object('legacy_sanity_id', tourney.legacy_sanity_id)
    into v_result
  from accounts.tourney_accounts tourney
  where tourney.legacy_sanity_id = v_player_id
  limit 1;

  return v_result;
end;
$$;

revoke all on function public.roo_resolve_tourney_account_alias(text)
  from public, anon, authenticated;
grant execute on function public.roo_resolve_tourney_account_alias(text)
  to service_role;
