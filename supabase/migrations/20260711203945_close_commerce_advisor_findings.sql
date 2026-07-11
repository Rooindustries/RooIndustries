create index if not exists commerce_mirror_outbox_command_id_idx
  on migration.commerce_mirror_outbox (command_id);

create policy "commerce_commands_deny_browser"
  on migration.commerce_commands
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "commerce_mirror_outbox_deny_browser"
  on migration.commerce_mirror_outbox
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "commerce_mirror_checkpoints_deny_browser"
  on migration.commerce_mirror_checkpoints
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "commerce_request_metrics_deny_browser"
  on migration.commerce_request_metrics
  for all
  to anon, authenticated
  using (false)
  with check (false);
