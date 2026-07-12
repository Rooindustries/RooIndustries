create index oauth_intents_claimed_user_id_idx
  on accounts.oauth_intents (claimed_user_id);

create policy oauth_intents_service_role_only
  on accounts.oauth_intents
  for all
  to service_role
  using (true)
  with check (true);

create policy discord_role_assignments_service_role_only
  on accounts.discord_role_assignments
  for all
  to service_role
  using (true)
  with check (true);
