create policy "principals_deny_browser"
  on accounts.principals
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "principal_auth_users_deny_browser"
  on accounts.principal_auth_users
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "reauth_grants_deny_browser"
  on accounts.reauth_grants
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "credential_operations_deny_browser"
  on accounts.credential_operations
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "principal_merge_audit_deny_browser"
  on accounts.principal_merge_audit
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create index credential_operations_principal_id_idx
  on accounts.credential_operations (principal_id);
create index credential_operations_user_id_idx
  on accounts.credential_operations (user_id);
create index oauth_intents_reauth_grant_id_idx
  on accounts.oauth_intents (reauth_grant_id)
  where reauth_grant_id is not null;
create index principal_merge_audit_initiated_by_user_id_idx
  on accounts.principal_merge_audit (initiated_by_user_id);
create index reauth_grants_principal_id_idx
  on accounts.reauth_grants (principal_id);
