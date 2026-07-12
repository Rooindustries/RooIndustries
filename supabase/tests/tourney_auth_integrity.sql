begin;

insert into tourney.tourney_players (
  id, username, email, password_hash, status, discord, discord_key, battlenet,
  rank_name, role_play, secondary_role_play, approved_role_play,
  registration_pool, time_zone
) values (
  'player.auth-fixture', 'auth-fixture', 'auth-fixture@example.com',
  '$2b$12$0Omm7D6lCqK6hK2FdfQF.eprvq8EwJ38NU4xOGVhGxIpp02jW/9Xu',
  'pending', 'Fixture#1', 'fixture#1', 'Fixture#1', 'Master', 'Support',
  'Damage', '', 'main', 'UTC'
);

insert into tourney.tourney_player_tokens (
  id, player_id, token_hash, purpose, expires_at
) values (
  'token.auth-fixture', 'player.auth-fixture', repeat('a', 64), 'approve',
  now() + interval '1 day'
);

insert into tourney.tourney_player_auth_operations (
  operation_key, player_id, token_id, operation_kind, desired_status,
  desired_role, desired_credential_version, operation_payload,
  operation_status, lease_id, lease_expires_at
) values (
  'decision:player.auth-fixture', 'player.auth-fixture', 'token.auth-fixture',
  'decision', 'approved', 'player', '2',
  '{"approvedRolePlay":"Support","registrationPool":"main"}'::jsonb,
  'processing', gen_random_uuid(), now() + interval '2 minutes'
);

do $$
begin
  begin
    perform public.roo_import_tourney_snapshot(
      '{"_counts":{}}'::jsonb,
      repeat('b', 64)
    );
    raise exception 'snapshot import erased an active Auth operation';
  exception when sqlstate '55006' then null;
  end;

  begin
    insert into tourney.tourney_player_auth_operations (
      operation_key, player_id, operation_kind, password_hash,
      operation_status
    ) values (
      'reset:plaintext-fixture', 'player.auth-fixture', 'password_reset',
      'plaintext-password', 'pending'
    );
    raise exception 'plaintext password entered the Auth operation ledger';
  exception when check_violation then null;
  end;

  begin
    insert into tourney.tourney_player_auth_operations (
      operation_key, player_id, operation_kind, desired_status,
      operation_status
    ) values (
      'decision:second-active-fixture', 'player.auth-fixture', 'decision',
      'denied', 'pending'
    );
    raise exception 'a second active decision was accepted';
  exception when unique_violation then null;
  end;
end;
$$;

rollback;
