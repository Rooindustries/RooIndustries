set lock_timeout = '5s';
set statement_timeout = '120s';

alter function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  rename to capture_tourney_hardening_snapshot_payload_v4;

alter function public.capture_tourney_hardening_snapshot_payload_v4(jsonb,jsonb,text)
  set schema tourney;

revoke all on function tourney.capture_tourney_hardening_snapshot_payload_v4(jsonb,jsonb,text)
  from public, anon, authenticated, service_role;

create function public.roo_capture_tourney_hardening_snapshot(
  p_legacy_snapshot jsonb default null,
  p_sanity_account jsonb default null,
  p_legacy_snapshot_text text default null
)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '120s'
as $$
  select proof.result - 'payload'
  from (
    select tourney.capture_tourney_hardening_snapshot_payload_v4(
      p_legacy_snapshot,
      p_sanity_account,
      p_legacy_snapshot_text
    ) result
  ) proof
$$;

revoke all on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.roo_capture_tourney_hardening_snapshot(jsonb,jsonb,text)
  to service_role;
