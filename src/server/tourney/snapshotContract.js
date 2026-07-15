import { TOURNEY_MIRROR_CONTRACT } from "./mirrorContract.js";

export const TOURNEY_LEGACY_SNAPSHOT_TABLES = Object.freeze([
  "tourney_players",
  "tourney_player_tokens",
  "tourney_registration_config",
  "tourney_bracket_teams",
  "tourney_bracket_team_members",
  "tourney_bracket_meta",
  "tourney_bracket_entities",
  "tourney_bracket_counters",
  "tourney_bracket_audit",
  "tourney_bracket_lock",
  "tourney_appeals",
  "tourney_payouts",
  "tourney_email_dispatches",
  "tourney_command_receipts",
  "tourney_mirror_outbox",
  "tourney_mirror_checkpoints",
  "tourney_mirror_tombstones",
  "tourney_account_snapshots",
  "tourney_external_operations",
  "tourney_discord_role_assignments",
  "tourney_identity_conflicts",
  "tourney_parity_runs",
  "tourney_cutover_metadata",
  "tourney_schema_metadata",
  "tourney_mirror_contracts",
  "tourney_cutover_gate_events",
  "tourney_import_quarantine",
  "tourney_shadow_observations",
  "tourney_shadow_latency_baselines",
]);

export const TOURNEY_HOSTED_SNAPSHOT_RELATIONS = Object.freeze([
  ...Object.keys(TOURNEY_MIRROR_CONTRACT),
  "accounts.tourney_accounts",
  "accounts.principals",
  "accounts.login_aliases",
  "accounts.identity_links",
  "accounts.principal_auth_users",
  "auth.users",
  "auth.identities",
  "tourney.mirror_outbox",
  "tourney.mirror_checkpoints",
  "tourney.mirror_tombstones",
  "tourney.schema_metadata",
  "tourney.tourney_player_auth_operations",
  "tourney.external_operation_secrets",
  "tourney.mirror_contracts",
  "tourney.parity_runs",
  "tourney.cutover_metadata",
  "tourney.identity_conflicts",
  "tourney.shadow_observations",
  "tourney.shadow_latency_baselines",
  "tourney.cutover_gate_events",
  "migration.tourney_sync_runs",
  "migration.tourney_import_quarantine",
  "migration.tourney_import_preflights",
  "accounts.oauth_intents",
]);

export const SUPABASE_FULL_SNAPSHOT_SCHEMAS = Object.freeze([
  "accounts",
  "auth",
  "cms",
  "commerce",
  "migration",
  "tourney",
]);

export const SUPABASE_FULL_REQUIRED_RELATIONS = Object.freeze([
  "accounts.account_roles",
  "accounts.creator_fallback_authorities",
  "accounts.creator_profiles",
  "accounts.creator_terms_audit",
  "accounts.credential_migrations",
  "accounts.credential_operations",
  "accounts.discord_role_assignments",
  "accounts.identity_links",
  "accounts.login_aliases",
  "accounts.oauth_intents",
  "accounts.principal_auth_users",
  "accounts.principal_merge_audit",
  "accounts.principals",
  "accounts.reauth_grants",
  "accounts.referral_email_dispatches",
  "accounts.tourney_accounts",
  "auth.identities",
  "auth.users",
  "cms.assets",
  "cms.document_assets",
  "cms.documents",
  "commerce.booking_settings",
  "commerce.booking_slots",
  "commerce.bookings",
  "commerce.coupon_redemptions",
  "commerce.coupons",
  "commerce.email_dispatches",
  "commerce.payment_events",
  "commerce.payment_proof_claims",
  "commerce.payment_records",
  "commerce.payment_start_claims",
  "commerce.payment_upgrade_locks",
  "commerce.rate_limit_buckets",
  "commerce.recovery_cases",
  "commerce.referral_ledger",
  "commerce.refunds",
  "commerce.slot_claims",
  "commerce.slot_holds",
  "commerce.webhook_receipts",
  "migration.cms_publish_commands",
  "migration.commerce_commands",
  "migration.commerce_control",
  "migration.commerce_control_events",
  "migration.commerce_mirror_actions",
  "migration.commerce_mirror_checkpoints",
  "migration.commerce_mirror_outbox",
  "migration.commerce_mirror_state",
  "migration.commerce_request_metrics",
  "migration.dead_letters",
  "migration.document_mutation_mirror_actions",
  "migration.document_mutation_mirror_outbox",
  "migration.drift_findings",
  "migration.shadow_events",
  "migration.source_documents",
  "migration.sync_cursors",
  "migration.sync_runs",
  "migration.tourney_import_preflights",
  "migration.tourney_import_quarantine",
  "migration.tourney_pre_cutover_snapshots",
  "migration.tourney_sync_runs",
  "tourney.account_snapshots",
  "tourney.command_receipts",
  "tourney.cutover_control_operations",
  "tourney.cutover_gate_events",
  "tourney.cutover_metadata",
  "tourney.email_dispatches",
  "tourney.external_operation_secrets",
  "tourney.external_operations",
  "tourney.identity_conflicts",
  "tourney.mirror_checkpoints",
  "tourney.mirror_contracts",
  "tourney.mirror_outbox",
  "tourney.mirror_tombstones",
  "tourney.parity_runs",
  "tourney.schema_metadata",
  "tourney.shadow_latency_baselines",
  "tourney.shadow_observations",
  "tourney.tourney_appeals",
  "tourney.tourney_bracket_audit",
  "tourney.tourney_bracket_counters",
  "tourney.tourney_bracket_entities",
  "tourney.tourney_bracket_lock",
  "tourney.tourney_bracket_meta",
  "tourney.tourney_bracket_team_members",
  "tourney.tourney_bracket_teams",
  "tourney.tourney_payouts",
  "tourney.tourney_player_auth_operations",
  "tourney.tourney_player_tokens",
  "tourney.tourney_players",
  "tourney.tourney_registration_config",
  "vault.tourney_snapshot_keys",
]);

export const canonicalizeSnapshotJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeSnapshotJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonicalizeSnapshotJson(value[key]),
    ])
  );
};

export const stableSnapshotJson = (value) =>
  JSON.stringify(canonicalizeSnapshotJson(value));

const SNAPSHOT_RELATION = /^(accounts|auth|cms|commerce|migration|tourney)\.[a-z0-9_]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const invalidFullSnapshot = () => Object.assign(
  new Error("The full Supabase logical snapshot is incomplete or invalid."),
  { code: "SUPABASE_FULL_LOGICAL_SNAPSHOT_INVALID" }
);

export const validateFullLogicalSnapshot = (payload, { hash } = {}) => {
  const snapshot = payload?.full_logical;
  const relationPayloads = snapshot?.relationPayloads;
  const counts = snapshot?.relationCounts;
  const hashes = snapshot?.relationHashes;
  const relationNames = relationPayloads && typeof relationPayloads === "object" &&
    !Array.isArray(relationPayloads)
    ? Object.keys(relationPayloads).sort()
    : [];
  const expectedSchemas = [...SUPABASE_FULL_SNAPSHOT_SCHEMAS];
  const actualSchemas = Array.isArray(snapshot?.schemas) ? [...snapshot.schemas].sort() : [];
  const required = Array.isArray(snapshot?.requiredRelations)
    ? [...snapshot.requiredRelations].sort()
    : [];
  const validNames = relationNames.every((name) =>
    SNAPSHOT_RELATION.test(name) || name === "vault.tourney_snapshot_keys"
  );
  const validRelations = relationNames.length > 0 && relationNames.every((name) =>
    typeof relationPayloads[name] === "string" &&
    relationPayloads[name].startsWith("[") &&
    relationPayloads[name].endsWith("]") &&
    Number.isSafeInteger(counts?.[name]) &&
    counts[name] >= 0 &&
    SHA256.test(String(hashes?.[name] || "")) &&
    typeof hash === "function" &&
    hash(relationPayloads[name]) === hashes[name]
  );
  const matchingKeys = relationNames.length === Object.keys(counts || {}).length &&
    relationNames.length === Object.keys(hashes || {}).length;
  const complete = SUPABASE_FULL_REQUIRED_RELATIONS.every((name) =>
    relationNames.includes(name)
  );
  if (
    snapshot?.format !== "roo-supabase-full-logical-snapshot-v1" ||
    !UUID.test(String(snapshot?.sourceSnapshotId || "")) ||
    !Number.isFinite(Date.parse(String(snapshot?.capturedAt || ""))) ||
    stableSnapshotJson(actualSchemas) !== stableSnapshotJson(expectedSchemas) ||
    stableSnapshotJson(required) !== stableSnapshotJson(
      [...SUPABASE_FULL_REQUIRED_RELATIONS].sort()
    ) ||
    !validNames || !validRelations || !matchingKeys || !complete
  ) {
    throw invalidFullSnapshot();
  }
  return {
    relationCount: relationNames.length,
    rowCount: relationNames.reduce((total, name) => total + counts[name], 0),
    relationNames,
  };
};
