do $$
declare v_table regclass;
begin
  foreach v_table in array array[
    'tourney.command_receipts'::regclass,
    'tourney.mirror_outbox'::regclass,
    'tourney.mirror_checkpoints'::regclass,
    'tourney.mirror_tombstones'::regclass,
    'tourney.parity_runs'::regclass,
    'tourney.cutover_metadata'::regclass,
    'tourney.email_dispatches'::regclass,
    'tourney.identity_conflicts'::regclass,
    'tourney.shadow_observations'::regclass,
    'migration.tourney_pre_cutover_snapshots'::regclass
  ] loop
    execute format('drop policy if exists deny_browser_access on %s', v_table);
    execute format(
      'create policy deny_browser_access on %s for all to anon, authenticated using (false) with check (false)',
      v_table
    );
  end loop;
end;
$$;
