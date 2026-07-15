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

export const SUPABASE_FULL_SNAPSHOT_EXCLUDED_RELATIONS = Object.freeze([
  "migration.tourney_pre_cutover_snapshots",
  "vault.tourney_snapshot_keys",
]);

export const SUPABASE_FULL_CAPTURE_REQUIRED_RELATIONS = Object.freeze(
  SUPABASE_FULL_REQUIRED_RELATIONS.filter(
    (relation) => !SUPABASE_FULL_SNAPSHOT_EXCLUDED_RELATIONS.includes(relation)
  )
);

export const SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION = "20260714230345";
export const SUPABASE_FULL_EXPANDED_MINIMUM_MIGRATION_VERSION = "20260715120000";
export const SUPABASE_FULL_EXPANDED_MIGRATION_NAMES = Object.freeze([
  "add_referral_creator_terms_editor",
  "add_document_mutation_mirror_outbox",
  "add_referral_fallback_authority",
  "add_referral_email_dispatch_ledger",
  "harden_commerce_readiness_evidence",
  "add_global_cms_publish_authority",
]);
export const SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS = Object.freeze([
  "accounts.creator_fallback_authorities",
  "accounts.creator_terms_audit",
  "accounts.referral_email_dispatches",
  "migration.cms_publish_commands",
  "migration.document_mutation_mirror_actions",
  "migration.document_mutation_mirror_outbox",
]);

export const SUPABASE_FULL_PRE_EXPAND_PROFILE =
  "roo-supabase-pre-expand-20260714230345-v1";
export const SUPABASE_FULL_EXPANDED_PROFILE = "roo-supabase-expanded-v1";
export const SUPABASE_FULL_COMPACT_EXPANDED_PROFILE = "roo-supabase-expanded-v2";

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
const MIGRATION_VERSION = /^\d{14}$/;
const MIGRATION_NAME = /^[a-z0-9][a-z0-9_]{0,127}$/;

const invalidFullSnapshot = () => Object.assign(
  new Error("The full Supabase logical snapshot is incomplete or invalid."),
  { code: "SUPABASE_FULL_LOGICAL_SNAPSHOT_INVALID" }
);

const matchingStringLists = (left, right) =>
  stableSnapshotJson([...left].sort()) === stableSnapshotJson([...right].sort());

const validRelationPayload = ({ rowsText, count, expectedHash, hash }) => {
  if (
    typeof rowsText !== "string" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !SHA256.test(String(expectedHash || "")) ||
    typeof hash !== "function" ||
    hash(rowsText) !== expectedHash
  ) {
    return false;
  }
  try {
    const rows = JSON.parse(rowsText);
    return Array.isArray(rows) && rows.length === count;
  } catch {
    return false;
  }
};

export const resolveFullLogicalSnapshotProfile = ({
  relationNames,
  sourceMigrationVersion,
  sourceMigrationNames,
} = {}) => {
  const names = Array.isArray(relationNames) ? [...new Set(relationNames)].sort() : [];
  const version = String(sourceMigrationVersion || "");
  if (!MIGRATION_VERSION.test(version)) throw invalidFullSnapshot();
  const migrationNames = Array.isArray(sourceMigrationNames)
    ? [...new Set(sourceMigrationNames)].sort()
    : [];
  const validMigrationNames = migrationNames.length === (sourceMigrationNames?.length || 0) &&
    migrationNames.every((name) => MIGRATION_NAME.test(name));
  const missing = SUPABASE_FULL_REQUIRED_RELATIONS.filter(
    (relation) => !names.includes(relation)
  );
  const compactMissing = SUPABASE_FULL_CAPTURE_REQUIRED_RELATIONS.filter(
    (relation) => !names.includes(relation)
  );
  const excludesSnapshotArtifacts = SUPABASE_FULL_SNAPSHOT_EXCLUDED_RELATIONS.every(
    (relation) => !names.includes(relation)
  );
  const expandedMigrationsPresent = validMigrationNames &&
    SUPABASE_FULL_EXPANDED_MIGRATION_NAMES.every((name) => migrationNames.includes(name));
  if (
    compactMissing.length === 0 &&
    excludesSnapshotArtifacts &&
    version > SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION &&
    expandedMigrationsPresent
  ) {
    return {
      contractProfile: SUPABASE_FULL_COMPACT_EXPANDED_PROFILE,
      deferredRelations: [],
      requiredRelations: [...SUPABASE_FULL_CAPTURE_REQUIRED_RELATIONS],
    };
  }
  if (
    missing.length === 0 &&
    version > SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION &&
    expandedMigrationsPresent
  ) {
    return {
      contractProfile: SUPABASE_FULL_EXPANDED_PROFILE,
      deferredRelations: [],
      requiredRelations: [...SUPABASE_FULL_REQUIRED_RELATIONS],
    };
  }
  if (
    version === SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION &&
    matchingStringLists(missing, SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS)
  ) {
    return {
      contractProfile: SUPABASE_FULL_PRE_EXPAND_PROFILE,
      deferredRelations: [...SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS],
      requiredRelations: SUPABASE_FULL_REQUIRED_RELATIONS.filter(
        (relation) => !SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS.includes(relation)
      ),
    };
  }
  throw invalidFullSnapshot();
};

export const validateFullLogicalSnapshot = (payload, { hash } = {}) => {
  const snapshot = payload?.full_logical;
  const relationPayloads = snapshot?.relationPayloads;
  const counts = snapshot?.relationCounts;
  const hashes = snapshot?.relationHashes;
  const relationNames = relationPayloads && typeof relationPayloads === "object" &&
    !Array.isArray(relationPayloads)
    ? Object.keys(relationPayloads).sort()
    : [];
  const catalogRelations = Array.isArray(snapshot?.catalogRelations)
    ? [...snapshot.catalogRelations].sort()
    : [];
  const expectedSchemas = [...SUPABASE_FULL_SNAPSHOT_SCHEMAS];
  const actualSchemas = Array.isArray(snapshot?.schemas) ? [...snapshot.schemas].sort() : [];
  const required = Array.isArray(snapshot?.requiredRelations)
    ? [...snapshot.requiredRelations].sort()
    : [];
  const deferred = Array.isArray(snapshot?.deferredRelations)
    ? [...snapshot.deferredRelations].sort()
    : [];
  const profile = resolveFullLogicalSnapshotProfile({
    relationNames,
    sourceMigrationVersion: snapshot?.sourceMigrationVersion,
    sourceMigrationNames: snapshot?.sourceMigrationNames,
  });
  const validNames = relationNames.every((name) =>
    SNAPSHOT_RELATION.test(name) || name === "vault.tourney_snapshot_keys"
  );
  const validRelations = relationNames.length > 0 && relationNames.every((name) =>
    validRelationPayload({
      rowsText: relationPayloads[name],
      count: counts?.[name],
      expectedHash: hashes?.[name],
      hash,
    })
  );
  const matchingKeys = relationNames.length === Object.keys(counts || {}).length &&
    relationNames.length === Object.keys(hashes || {}).length;
  const matchingCatalog = matchingStringLists(catalogRelations, relationNames) &&
    SHA256.test(String(snapshot?.catalogSha256 || "")) &&
    typeof hash === "function" &&
    hash(stableSnapshotJson(catalogRelations)) === snapshot.catalogSha256;
  const complete = profile.requiredRelations.every((name) =>
    relationNames.includes(name)
  );
  if (
    snapshot?.format !== "roo-supabase-full-logical-snapshot-v1" ||
    !UUID.test(String(snapshot?.sourceSnapshotId || "")) ||
    !Number.isFinite(Date.parse(String(snapshot?.capturedAt || ""))) ||
    stableSnapshotJson(actualSchemas) !== stableSnapshotJson(expectedSchemas) ||
    snapshot?.contractProfile !== profile.contractProfile ||
    !matchingStringLists(required, profile.requiredRelations) ||
    !matchingStringLists(deferred, profile.deferredRelations) ||
    !validNames || !validRelations || !matchingKeys || !matchingCatalog || !complete
  ) {
    throw invalidFullSnapshot();
  }
  return {
    relationCount: relationNames.length,
    contractProfile: profile.contractProfile,
    deferredRelations: profile.deferredRelations,
    rowCount: relationNames.reduce((total, name) => total + counts[name], 0),
    relationNames,
  };
};
