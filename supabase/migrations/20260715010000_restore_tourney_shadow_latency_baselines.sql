set lock_timeout = '5s';
set statement_timeout = '120s';

create table if not exists tourney.shadow_latency_baselines (
  route text primary key check (route in (
    'public_roster','public_bracket','admin_players','appeals','payouts'
  )),
  primary_p95_ms integer not null check (primary_p95_ms >= 0),
  sample_count integer not null check (sample_count >= 30),
  source_window_started_at timestamptz,
  source_window_ended_at timestamptz,
  captured_at timestamptz not null default now(),
  captured_by text not null
);

alter table tourney.shadow_latency_baselines enable row level security;
revoke all on table tourney.shadow_latency_baselines
  from public, anon, authenticated;
grant select, insert, update, delete on table tourney.shadow_latency_baselines
  to service_role;
