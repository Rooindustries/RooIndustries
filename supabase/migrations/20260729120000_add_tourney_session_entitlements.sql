set lock_timeout = '5s';
set statement_timeout = '120s';

create table tourney.tourney_session_entitlements (
  id uuid primary key default gen_random_uuid(),
  player_id text not null
    references tourney.tourney_players(id) on delete cascade,
  status text not null default 'available'
    check (status in ('available', 'consumed', 'revoked')),
  booking_id uuid
    references commerce.bookings(id) on delete restrict,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint tourney_session_entitlements_player_unique unique (player_id),
  constraint tourney_session_entitlements_consumed_booking_check check (
    status <> 'consumed'
    or (booking_id is not null and consumed_at is not null)
  )
);

alter table tourney.tourney_session_entitlements enable row level security;
revoke all on table tourney.tourney_session_entitlements
  from public, anon, authenticated;
grant all on table tourney.tourney_session_entitlements to service_role;
create policy deny_browser_access
  on tourney.tourney_session_entitlements
  for all to anon, authenticated
  using (false)
  with check (false);
