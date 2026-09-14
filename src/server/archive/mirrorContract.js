const columns = (...names) => Object.freeze(names);

export const TOURNEY_MIRROR_CONTRACT = Object.freeze({
  tourney_players: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_players", legacy: "tourney_players" },
    allowedColumns: columns(
      "id", "username", "email", "password_hash", "status", "discord",
      "display_name", "discord_key", "battlenet", "rank_name", "role_play",
      "secondary_role_play", "approved_role_play", "registration_pool",
      "time_zone", "twitch_username", "team_name", "available_aug_1_2",
      "accepted_rules", "accepted_roo_visibility", "notes", "version",
      "created_at", "updated_at", "approved_at", "approved_by", "denied_at",
      "denied_by", "removed_at", "removed_by", "withdrawn_at", "withdrawn_by",
      "discord_invite_sent_at", "discord_invite_email_id",
      "discord_invite_last_error", "discord_user_id", "discord_oauth_username",
      "discord_oauth_global_name", "discord_linked_at",
      "discord_role_assigned_at", "discord_role_last_error", "principal_id"
    ),
  },
  tourney_player_tokens: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_player_tokens", legacy: "tourney_player_tokens" },
    allowedColumns: columns(
      "id", "player_id", "token_hash", "purpose", "recipient_username",
      "recipient_email", "recipient_role", "recipient_version", "expires_at",
      "used_at", "used_by", "created_at"
    ),
  },
  tourney_registration_config: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_registration_config", legacy: "tourney_registration_config" },
    allowedColumns: columns("id", "team_count", "updated_at", "updated_by"),
  },
  tourney_bracket_teams: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_bracket_teams", legacy: "tourney_bracket_teams" },
    allowedColumns: columns("id", "name", "seed_order", "status", "created_at", "updated_at", "updated_by"),
  },
  tourney_bracket_team_members: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_bracket_team_members", legacy: "tourney_bracket_team_members" },
    allowedColumns: columns("id", "team_id", "player_id", "display_name", "role_play", "created_at"),
  },
  tourney_bracket_meta: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_bracket_meta", legacy: "tourney_bracket_meta" },
    allowedColumns: columns("id", "stage_id", "status", "published", "generated_at", "updated_at", "updated_by"),
  },
  tourney_bracket_entities: {
    keyColumns: columns("entity_type", "entity_id"),
    relations: { supabase: "tourney.tourney_bracket_entities", legacy: "tourney_bracket_entities" },
    allowedColumns: columns("entity_type", "entity_id", "data", "updated_at"),
  },
  tourney_bracket_counters: {
    keyColumns: columns("entity_type"),
    relations: { supabase: "tourney.tourney_bracket_counters", legacy: "tourney_bracket_counters" },
    allowedColumns: columns("entity_type", "next_id"),
  },
  tourney_bracket_audit: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_bracket_audit", legacy: "tourney_bracket_audit" },
    allowedColumns: columns("id", "action", "actor_username", "match_id", "team_id", "reason", "payload", "created_at"),
  },
  tourney_bracket_lock: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_bracket_lock", legacy: "tourney_bracket_lock" },
    allowedColumns: columns("id", "locked_until", "locked_by"),
  },
  tourney_appeals: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_appeals", legacy: "tourney_appeals" },
    allowedColumns: columns(
      "id", "type", "status", "team_name", "captain_name",
      "submitter_player_id", "submitter_username", "subject_player_id",
      "subject_name", "title", "details", "evidence_url", "ruling",
      "created_at", "updated_at", "updated_by"
    ),
  },
  tourney_payouts: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.tourney_payouts", legacy: "tourney_payouts" },
    allowedColumns: columns(
      "id", "player_id", "display_name", "team_name", "payout_type",
      "amount_usd", "status", "payout_email", "notes", "created_at",
      "updated_at", "updated_by"
    ),
  },
  email_dispatches: {
    keyColumns: columns("id"),
    relations: { supabase: "tourney.email_dispatches", legacy: "tourney_email_dispatches" },
    allowedColumns: columns(
      "id", "idempotency_key", "command_id", "dispatch_kind", "recipient",
      "recipient_hash", "payload", "status", "attempt_count", "next_attempt_at",
      "lease_id", "lease_expires_at", "provider_message_id", "sent_at",
      "last_error_code", "created_at", "updated_at", "audited_override_at",
      "audited_override_by", "audited_override_reason"
    ),
  },
  command_receipts: {
    keyColumns: columns("command_id"),
    relations: { supabase: "tourney.command_receipts", legacy: "tourney_command_receipts" },
    allowedColumns: columns(
      "command_id", "purpose", "request_hash", "status", "result_status",
      "result_body", "generation", "created_at", "committed_at", "completed_at",
      "failed_at", "failure_code", "failure_evidence", "recovered_at", "recovery_evidence",
      "updated_at"
    ),
  },
  account_snapshots: {
    keyColumns: columns("snapshot_id"),
    relations: { supabase: "tourney.account_snapshots", legacy: "tourney_account_snapshots" },
    allowedColumns: columns(
      "snapshot_id", "version", "accounts_json", "canonical_hash", "generation",
      "created_at", "created_by", "supersedes_snapshot_id"
    ),
  },
  external_operations: {
    keyColumns: columns("operation_key"),
    relations: { supabase: "tourney.external_operations", legacy: "tourney_external_operations" },
    allowedColumns: columns(
      "operation_key", "command_id", "operation_kind", "entity_type", "entity_id",
      "serialization_key",
      "desired_state", "desired_state_hash", "status", "attempt_count",
      "max_attempts", "next_attempt_at", "lease_id", "lease_expires_at",
      "last_error_code", "completed_at", "created_at", "updated_at"
    ),
  },
  discord_role_assignments: {
    keyColumns: columns("principal_id"),
    relations: { supabase: "accounts.discord_role_assignments", legacy: "tourney_discord_role_assignments" },
    allowedColumns: columns(
      "principal_id", "user_id", "player_id", "discord_user_id",
      "previous_discord_user_id", "stale_discord_user_ids", "guild_id",
      "tourney_role", "desired_role",
      "applied_role", "generation", "applied_generation", "status",
      "attempt_count", "last_error", "joined_at", "applied_at", "created_at",
      "updated_at", "lease_id", "lease_expires_at", "max_attempts", "blocked_at",
      "pending_since"
    ),
  },
});

export const TOURNEY_MIRROR_TABLES = Object.freeze(
  Object.fromEntries(
    Object.entries(TOURNEY_MIRROR_CONTRACT).map(([name, contract]) => [
      name,
      contract.keyColumns,
    ])
  )
);

export const getTourneyMirrorContract = (tableName) => {
  const contract = TOURNEY_MIRROR_CONTRACT[String(tableName || "")];
  if (!contract) {
    const error = new Error("Unsupported Tourney mirror table.");
    error.code = "TOURNEY_MIRROR_CONTRACT_MISSING";
    throw error;
  }
  return contract;
};

export const buildTourneyMirrorKey = (tableName, row = {}) => {
  const contract = getTourneyMirrorContract(tableName);
  const key = Object.fromEntries(
    contract.keyColumns.map((column) => [column, row?.[column]])
  );
  if (contract.keyColumns.some((column) => key[column] === null || key[column] === undefined || key[column] === "")) {
    const error = new Error("Tourney mirror record key is incomplete.");
    error.code = "TOURNEY_MIRROR_KEY_INCOMPLETE";
    throw error;
  }
  return key;
};

export const filterTourneyMirrorRow = (tableName, row = {}) => {
  const contract = getTourneyMirrorContract(tableName);
  const unsupported = Object.keys(row).filter(
    (column) => !contract.allowedColumns.includes(column)
  );
  if (unsupported.length > 0) {
    const error = new Error("Tourney mirror row contains unsupported columns.");
    error.code = "TOURNEY_MIRROR_COLUMNS_UNSUPPORTED";
    throw error;
  }
  buildTourneyMirrorKey(tableName, row);
  return Object.fromEntries(
    contract.allowedColumns
      .filter((column) => Object.hasOwn(row, column))
      .map((column) => [column, row[column]])
  );
};
