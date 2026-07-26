-- The roster name is a login credential. Both resolvers (verifyTourneyCredentials
-- and createTourneyResetToken) select with `limit 2` and accept the row only when
-- exactly one comes back, so a duplicate does not leak one player's account to
-- another -- it locks BOTH of them out with a generic "invalid credentials" and no
-- signal about why. The application now rejects the collision on write, but that
-- check reads before it writes and two concurrent requests can interleave between
-- the two statements. This index is the backstop that cannot race.
--
-- Partial on the statuses that can actually sign in (mirrors
-- DISPLAY_NAME_LOGIN_STATUSES in playerStore.js) so a denied, withdrawn, or
-- removed entry never squats on a name a live player wants. Blank and NULL names
-- are excluded: they are legitimately common (players who never set one log in by
-- discord handle or email instead) and must not collide with each other.

create unique index if not exists tourney_players_display_name_login_unique
  on tourney.tourney_players (lower(btrim(display_name)))
  where status in ('approved', 'pending')
    and display_name is not null
    and btrim(display_name) <> '';
