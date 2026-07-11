create or replace function public.roo_resolve_verified_drift_findings(
  p_successful_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run migration.sync_runs%rowtype;
  v_resolved integer := 0;
begin
  select *
  into v_run
  from migration.sync_runs
  where id = p_successful_run_id
  for update;

  if not found or v_run.status <> 'running' then
    raise exception 'successful comparison run is not active'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from migration.drift_findings
    where sync_run_id = p_successful_run_id
      and status = 'open'
  ) then
    raise exception 'comparison run still has open drift'
      using errcode = '22023';
  end if;

  update migration.drift_findings
  set
    status = 'resolved',
    resolved_at = now()
  where status = 'open'
    and sync_run_id <> p_successful_run_id;
  get diagnostics v_resolved = row_count;

  return jsonb_build_object('resolved', v_resolved);
end;
$$;

revoke all on function public.roo_resolve_verified_drift_findings(uuid)
  from public, anon, authenticated;
grant execute on function public.roo_resolve_verified_drift_findings(uuid)
  to service_role;
