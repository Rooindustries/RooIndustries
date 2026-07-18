#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  hasBoundedMigrationPrefix,
  hasBrowserDataGrant,
  hasServiceRoleOnlyGrant,
} from "./lib/migration-sql-contracts.mjs";

const migrationsDirectory = path.resolve(process.cwd(), "supabase/migrations");
const files = fs
  .readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const failures = [];
const versions = new Set();
const localByVersion = new Map();

for (const file of files) {
  const match = file.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
  if (!match) failures.push(`Invalid migration filename: ${file}`);
  if (match && versions.has(match[1])) {
    failures.push(`Duplicate migration version: ${match[1]}`);
  }
  if (match) {
    versions.add(match[1]);
    localByVersion.set(match[1], file.slice(15, -4));
  }
  const sql = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
  if (!sql.trim()) failures.push(`Empty migration: ${file}`);
}

const requiredHashes = new Map([
  [
    "20260711231920_bootstrap_social_auth_identities.sql",
    "58bd19899743b3e0d3ee830bced0ab79ec26278b20561d79efa904ac779a8112",
  ],
  [
    "20260711232325_fix_social_auth_identity_timestamps.sql",
    "643db1fb0a84a44b3b8a492f268e861a78729a2ab23dc974367ba4a4ac4681dc",
  ],
]);

const hostedMigrationVersions = new Map([
  ["add_social_identity_linking_and_discord_roles", "20260712060649"],
  ["close_social_auth_advisor_findings", "20260712061107"],
  ["add_discord_role_retry_queue_rpc", "20260712062938"],
]);
for (const [name, version] of hostedMigrationVersions) {
  const expectedFile = `${version}_${name}.sql`;
  if (!files.includes(expectedFile)) {
    failures.push(`Hosted migration version mismatch: ${expectedFile}`);
  }
  const conflicting = files.filter(
    (file) => file.endsWith(`_${name}.sql`) && file !== expectedFile,
  );
  for (const file of conflicting) {
    failures.push(`Stale hosted migration version remains: ${file}`);
  }
}

const hostedHistoryRaw = String(
  process.env.SUPABASE_HOSTED_MIGRATIONS_JSON || "",
).trim();
if (hostedHistoryRaw) {
  try {
    const hostedHistory = JSON.parse(hostedHistoryRaw);
    if (!Array.isArray(hostedHistory))
      throw new Error("history must be an array");
    for (const entry of hostedHistory) {
      const version = String(entry?.version || "").trim();
      const name = String(entry?.name || "").trim();
      if (!/^\d{14}$/.test(version) || !/^[a-z0-9_]+$/.test(name)) {
        failures.push("Hosted migration history contains an invalid entry.");
        continue;
      }
      if (!localByVersion.has(version)) {
        failures.push(
          `Hosted migration is missing locally: ${version}_${name}.sql`,
        );
      } else if (localByVersion.get(version) !== name) {
        failures.push(
          `Hosted migration name mismatch: ${version}_${localByVersion.get(version)}.sql != ${version}_${name}.sql`,
        );
      }
    }
  } catch (error) {
    failures.push(
      `Hosted migration history could not be parsed: ${error.message}`,
    );
  }
}
for (const [file, expected] of requiredHashes) {
  const location = path.join(migrationsDirectory, file);
  if (!fs.existsSync(location)) {
    failures.push(`Hosted migration is missing locally: ${file}`);
    continue;
  }
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(location))
    .digest("hex");
  if (actual !== expected) failures.push(`Hosted migration changed: ${file}`);
}

for (const stale of [
  "20260711230055_bootstrap_social_auth_identities.sql",
  "20260711232258_fix_social_auth_identity_timestamps.sql",
]) {
  if (files.includes(stale))
    failures.push(`Stale migration filename remains: ${stale}`);
}

const hardeningFile = path.join(
  migrationsDirectory,
  "20260712031331_harden_commerce_integrity_and_recovery.sql",
);
if (fs.existsSync(hardeningFile)) {
  const sql = fs.readFileSync(hardeningFile, "utf8");
  const mutationStart = sql.indexOf(
    "create or replace function public.roo_apply_commerce_document_mutations",
  );
  const mutationEnd = sql.indexOf(
    "create or replace function public.roo_fetch_recovery_payment_documents",
    mutationStart,
  );
  const mutationBody = sql.slice(mutationStart, mutationEnd);
  if (/roo_refresh_operational_shadow\s*\(/i.test(mutationBody)) {
    failures.push("Commerce mutation RPC still calls the full projector.");
  }
  for (const required of [
    "assert_commerce_start_fence",
    "project_commerce_document_ids",
    "roo_commerce_mirror_status_for_ids",
    "alter default privileges for role postgres\n  revoke execute on functions",
  ]) {
    if (!sql.includes(required))
      failures.push(`Hardening migration lacks: ${required}`);
  }
}

const referralAuthorityFile = path.join(
  migrationsDirectory,
  "20260715100000_add_referral_fallback_authority.sql"
);
if (!fs.existsSync(referralAuthorityFile)) {
  failures.push("Referral fallback authority migration is missing.");
} else {
  const sql = fs.readFileSync(referralAuthorityFile, "utf8");
  for (const required of [
    "migration.document_mutation_mirror_outbox",
    "public.roo_apply_document_mutations(jsonb)",
    "alter table accounts.creator_fallback_authorities enable row level security",
    "set search_path = ''",
    "roo_referral_fallback_authority_readiness",
    "roo_supabase_release_readiness",
    "from public, anon, authenticated, service_role",
    "to service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Referral fallback authority migration lacks: ${required}`);
    }
  }
  if (hasBrowserDataGrant(sql)) {
    failures.push("Referral fallback authority exposes private records to browser roles.");
  }
}

const readinessMirrorFile = path.join(
  migrationsDirectory,
  "20260712121529_fix_commerce_readiness_mirror_states.sql",
);
if (!fs.existsSync(readinessMirrorFile)) {
  failures.push("Commerce readiness mirror-state repair is missing.");
} else {
  const sql = fs.readFileSync(readinessMirrorFile, "utf8");
  if (sql.includes("status <> 'mirrored'")) {
    failures.push("Commerce readiness still counts superseded mirror events.");
  }
  if (
    !sql.includes("status in ('pending', 'retry', 'processing', 'dead_letter')")
  ) {
    failures.push(
      "Commerce readiness lacks the actionable mirror-state filter.",
    );
  }
}

const documentMutationOutboxFile = path.join(
  migrationsDirectory,
  "20260715090000_add_document_mutation_mirror_outbox.sql",
);
if (!fs.existsSync(documentMutationOutboxFile)) {
  failures.push("Document mutation mirror outbox migration is missing.");
} else {
  const sql = fs.readFileSync(documentMutationOutboxFile, "utf8");
  for (const required of [
    "migration.document_mutation_mirror_outbox",
    "insert into migration.document_mutation_mirror_outbox",
    "for update skip locked",
    "roo_complete_document_mutation_mirror_event",
    "roo_requeue_document_mutation_mirror_event",
    "actor text not null",
    "roo_document_mutation_mirror_backlog",
    "'documentMutationMirror', public.roo_document_mutation_mirror_backlog()",
    "status in ('pending', 'processing', 'retry', 'applied', 'dead_letter')",
    "from public, anon, authenticated, service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Document mutation outbox migration lacks: ${required}`);
    }
  }
  if (
    !hasServiceRoleOnlyGrant(
      sql,
      /^grant\s+execute\s+on\s+function\s+public\.roo_claim_document_mutation_mirror_events\s*\(\s*uuid\s*,\s*integer\s*,\s*integer\s*,\s*text\[\]\s*\)/i
    )
  ) {
    failures.push(
      "Document mutation outbox claim RPC is not service-role restricted.",
    );
  }
  if (
    !sql.includes(
      "roo_requeue_document_mutation_mirror_event(uuid, integer, text, text)",
    )
  ) {
    failures.push(
      "Document mutation outbox requeue RPC lacks actor attribution.",
    );
  }
}

const cmsAuthorityFile = path.join(
  migrationsDirectory,
  "20260715120000_add_global_cms_publish_authority.sql",
);
if (!fs.existsSync(cmsAuthorityFile)) {
  failures.push("Global CMS authority migration is missing.");
} else {
  const sql = fs.readFileSync(cmsAuthorityFile, "utf8");
  for (const required of [
    "migration.cms_publish_commands",
    "migration.apply_cms_commerce_mutation",
    "public.roo_apply_cms_publish_command",
    "public.roo_cms_publish_command_result",
    "public.roo_apply_document_mutations",
    "migration.commerce_mirror_outbox",
    "migration.project_commerce_document_ids",
    "migration.cleanup_commerce_document_ids",
    "roo_document_mutation_mirror_backlog",
    "asset.migration_status <> 'verified'",
    "'bookingSettings', 'coupon', 'package', 'upgradeLink'",
    "from public, anon, authenticated, service_role",
    "grant execute on function public.roo_apply_cms_publish_command",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Global CMS authority migration lacks: ${required}`);
    }
  }
  if (
    /create or replace function public\.roo_supabase_port_readiness/i.test(sql)
  ) {
    failures.push(
      "Global CMS authority migration replaces port readiness state.",
    );
  }
  if (
    !hasServiceRoleOnlyGrant(
      sql,
      /^grant\s+execute\s+on\s+function\s+public\.roo_apply_cms_publish_command\s*\(/i
    )
  ) {
    failures.push("Global CMS publish RPC is not service-role restricted.");
  }
}

const referralEmailFile = path.join(
  migrationsDirectory,
  "20260715110000_add_referral_email_dispatch_ledger.sql"
);
if (!fs.existsSync(referralEmailFile)) {
  failures.push("Referral email dispatch migration is missing.");
} else {
  const sql = fs.readFileSync(referralEmailFile, "utf8");
  for (const required of [
    "accounts.referral_email_dispatch_actions",
    "new is distinct from old",
    "public.roo_requeue_referral_email_dispatch",
    "delivery_token_missing",
    "delivery_token_invalid",
    "'service_role_recovery'",
    "when v_status = 'sent' then delivery_payload - 'token'",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Referral email dispatch migration lacks: ${required}`);
    }
  }
  if (
    !hasServiceRoleOnlyGrant(
      sql,
      /^grant\s+execute\s+on\s+function\s+public\.roo_requeue_referral_email_dispatch\s*\(\s*text\s*,\s*text\s*\)/i
    )
  ) {
    failures.push("Referral email requeue RPC is not service-role restricted.");
  }
  if (/when\s+v_status\s+in\s*\(\s*'sent'\s*,\s*'dead_letter'\s*\)/i.test(sql)) {
    failures.push("Referral email dead letters discard their recovery token.");
  }
}

for (const file of [
  "20260715080000_add_referral_creator_terms_editor.sql",
  "20260715090000_add_document_mutation_mirror_outbox.sql",
  "20260715100000_add_referral_fallback_authority.sql",
  "20260715110000_add_referral_email_dispatch_ledger.sql",
  "20260715115000_harden_commerce_readiness_evidence.sql",
  "20260715120000_add_global_cms_publish_authority.sql",
  "20260715140000_terminalize_stale_provider_recovery.sql",
  "20260715150000_block_legacy_discord_reauth.sql",
  "20260715160000_generalize_stale_provider_recovery.sql",
  "20260715170000_repair_recovery_scope_guards.sql",
  "20260715180000_finalize_noop_discord_and_readiness.sql",
  "20260715180100_filter_commerce_traffic_metrics.sql",
]) {
  const sql = fs.readFileSync(path.join(migrationsDirectory, file), "utf8");
  if (!hasBoundedMigrationPrefix(sql)) {
    failures.push(`Final release migration lacks bounded timeouts: ${file}`);
  }
}

const finalReadinessRepairFile = path.join(
  migrationsDirectory,
  "20260715180000_finalize_noop_discord_and_readiness.sql"
);
if (!fs.existsSync(finalReadinessRepairFile)) {
  failures.push("Final readiness repair migration is missing.");
} else {
  const sql = fs.readFileSync(finalReadinessRepairFile, "utf8");
  for (const required of [
    "migration.finalize_inactive_noop_discord_assignments",
    "assignment.desired_role = 'none'",
    "assignment.applied_role = 'none'",
    "assignment.applied_generation < assignment.generation",
    "not account.active or account.lifecycle_status <> 'approved'",
    "operation.status in ('pending', 'processing', 'retry')",
    "set_config('roo.tourney_command_id'",
    "insert into tourney.command_receipts",
    "applied_generation = assignment.generation",
    "v_updated_count <> v_candidate_count",
    "from public, anon, authenticated, service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Final readiness repair migration lacks: ${required}`);
    }
  }
  if (
    /grant\s+execute\s+on\s+function\s+migration\.finalize_inactive_noop_discord_assignments/i.test(
      sql
    )
  ) {
    failures.push("No-op Discord repair must remain owner-only.");
  }
}

const commerceTrafficMetricsFile = path.join(
  migrationsDirectory,
  "20260715180100_filter_commerce_traffic_metrics.sql"
);
if (!fs.existsSync(commerceTrafficMetricsFile)) {
  failures.push("Commerce traffic metric filter migration is missing.");
} else {
  const sql = fs.readFileSync(commerceTrafficMetricsFile, "utf8");
  for (const required of [
    "public.roo_commerce_readiness",
    "migration.commerce_request_metrics",
    "route not in ('payment/reconcile', 'ref/cronsyncall')",
    "from public, anon, authenticated",
    "to service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Commerce traffic metric filter migration lacks: ${required}`);
    }
  }
}

const recoveryScopeGuardsFile = path.join(
  migrationsDirectory,
  "20260715170000_repair_recovery_scope_guards.sql"
);
if (!fs.existsSync(recoveryScopeGuardsFile)) {
  failures.push("Recovery scope guard migration is missing.");
} else {
  const sql = fs.readFileSync(recoveryScopeGuardsFile, "utf8");
  for (const required of [
    "migration.terminalize_stale_provider_recoveries",
    "join migration.source_documents payment_source",
    "payment.recovery_attempt_count >= 24",
    "payment.resource_release_pending",
    "hold.phase in ('active', 'payment')",
    "redemption.state = 'reserved'",
    "group by payment.id",
    "migration.block_legacy_discord_reauth",
    "from accounts.principal_auth_users auth_mapping",
    "identity.user_id = auth_mapping.user_id",
    "auth_mapping.principal_id = assignment.principal_id",
    "from public, anon, authenticated, service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Recovery scope guard migration lacks: ${required}`);
    }
  }
  if (/grant\s+execute\s+on\s+function\s+migration\./i.test(sql)) {
    failures.push("Recovery scope guard functions must remain owner-only.");
  }
}

const generalizedProviderRecoveryFile = path.join(
  migrationsDirectory,
  "20260715160000_generalize_stale_provider_recovery.sql"
);
if (!fs.existsSync(generalizedProviderRecoveryFile)) {
  failures.push("Generalized provider recovery migration is missing.");
} else {
  const sql = fs.readFileSync(generalizedProviderRecoveryFile, "utf8");
  for (const required of [
    "migration.terminalize_stale_provider_recoveries",
    "payment.provider in ('paypal', 'razorpay')",
    "recovery.reason = payment.provider || '_lookup_failed_404'",
    "provider_order_not_found_after_recovery_window",
    "v_starts_paused",
    "payment.resource_release_pending",
    "redemption.state = 'reserved'",
    "hold.phase in ('active', 'payment')",
    "from public, anon, authenticated, service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Generalized provider recovery migration lacks: ${required}`);
    }
  }
  if (
    /grant\s+execute\s+on\s+function\s+migration\.terminalize_stale_provider_recoveries/i.test(
      sql
    )
  ) {
    failures.push("Generalized provider recovery repair must remain owner-only.");
  }
}

const discordReauthRepairFile = path.join(
  migrationsDirectory,
  "20260715150000_block_legacy_discord_reauth.sql"
);
if (!fs.existsSync(discordReauthRepairFile)) {
  failures.push("Legacy Discord re-auth repair migration is missing.");
} else {
  const sql = fs.readFileSync(discordReauthRepairFile, "utf8");
  for (const required of [
    "migration.block_legacy_discord_reauth",
    "discord_auth_reconnect_required",
    "assignment.desired_role = 'none'",
    "assignment.applied_role = 'participant'",
    "principal.status = 'active'",
    "mapping.principal_id = assignment.principal_id",
    "player.principal_id = assignment.principal_id",
    "identity.provider = 'discord'",
    "operation.status in ('pending', 'processing', 'retry')",
    "set_config('roo.tourney_command_id'",
    "insert into tourney.command_receipts",
    "status = 'blocked_reauth'",
    "v_updated_count <> v_candidate_count",
    "from public, anon, authenticated, service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Discord re-auth repair migration lacks: ${required}`);
    }
  }
  if (
    /grant\s+execute\s+on\s+function\s+migration\.block_legacy_discord_reauth/i.test(
      sql
    )
  ) {
    failures.push("Discord re-auth repair must remain owner-only.");
  }
}

const credentialRecoveryFile = path.join(
  migrationsDirectory,
  "20260715130000_harden_credential_recovery_saga.sql"
);
if (!fs.existsSync(credentialRecoveryFile)) {
  failures.push("Credential recovery saga migration is missing.");
} else {
  const sql = fs.readFileSync(credentialRecoveryFile, "utf8");
  if (!hasBoundedMigrationPrefix(sql)) {
    failures.push(
      "Final release migration lacks bounded timeouts: 20260715130000_harden_credential_recovery_saga.sql"
    );
  }
  for (const required of [
    "source_preconditions jsonb",
    "sessions_revoked_at timestamptz",
    "source_recovery_blocked boolean not null default false",
    "CREDENTIAL_SOURCE_REPAIR_REQUIRED",
    "roo_prepare_credential_operation_v2",
    "Another credential operation is in progress",
    "credential_operations_one_active_principal_idx",
    "Multiple active credential operations require repair",
    "roo_get_credential_operation",
    "roo_apply_credential_source_operation",
    "public.roo_apply_document_mutations",
    "roo_record_credential_recovery_error",
    "roo_complete_credential_operation",
    "roo_complete_credential_migration",
    "delete from auth.sessions",
    "Credential sessions have not been revoked",
    "for update skip locked",
    "from public, anon, authenticated",
    "to service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Credential recovery saga migration lacks: ${required}`);
    }
  }
  if (/v_source\.source_revision\s+is distinct from\s+v_operation\.source_expected_revision/i.test(sql)) {
    failures.push("Credential recovery still rejects unrelated source revisions.");
  }
  if (sql.includes("credential_operations_source_recovery_idx")) {
    failures.push("Credential recovery queue index is not staged separately.");
  }
}

const providerRecoveryFile = path.join(
  migrationsDirectory,
  "20260715140000_terminalize_stale_provider_recovery.sql"
);
if (!fs.existsSync(providerRecoveryFile)) {
  failures.push("Stale provider recovery migration is missing.");
} else {
  const sql = fs.readFileSync(providerRecoveryFile, "utf8");
  for (const required of [
    "migration.terminalize_stale_provider_recoveries",
    "provider_order_not_found_after_recovery_window",
    "paymentAliasesTotal",
    "validPaymentAliases",
    "invalidPaymentAliases",
    "openRescheduleCases",
    "notifiedRescheduleCases",
    "unnotifiedRescheduleCases",
    "v_starts_paused",
    "payment.resource_release_pending",
    "redemption.state = 'reserved'",
    "hold.phase in ('active', 'payment')",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Stale provider recovery migration lacks: ${required}`);
    }
  }
  if (
    /grant\s+execute\s+on\s+function\s+migration\.terminalize_stale_provider_recoveries/i.test(
      sql
    )
  ) {
    failures.push("Stale provider recovery repair must remain owner-only.");
  }
}

const credentialRecoveryIndexFile = files.find((file) =>
  file.endsWith("_add_credential_recovery_queue_index.sql")
);
if (!credentialRecoveryIndexFile) {
  failures.push("Credential recovery queue index migration is missing.");
} else {
  const sql = fs.readFileSync(
    path.join(migrationsDirectory, credentialRecoveryIndexFile),
    "utf8"
  );
  if (!hasBoundedMigrationPrefix(sql)) {
    failures.push("Credential recovery queue index migration lacks bounded timeouts.");
  }
  if (/\bconcurrently\b/i.test(sql)) {
    failures.push("Credential recovery queue index cannot use CONCURRENTLY in transactional migration runners.");
  }
  if (
    !/create\s+index\s+if\s+not\s+exists\s+credential_operations_source_recovery_idx\s+on\s+accounts\.credential_operations\s*\(\s*source_backend\s*,\s*source_document_id\s*,\s*updated_at\s*\)\s+where\s+status\s+in\s*\(\s*'prepared'\s*,\s*'auth_applied'\s*\)\s*;\s*$/i.test(sql)
  ) {
    failures.push("Credential recovery queue index migration has the wrong definition.");
  }
}

const credentialRetryHardeningFile = files.find((file) =>
  file.endsWith("_harden_credential_reconciliation_retry.sql")
);
if (!credentialRetryHardeningFile) {
  failures.push("Credential retry hardening migration is missing.");
} else {
  const sql = fs.readFileSync(
    path.join(migrationsDirectory, credentialRetryHardeningFile),
    "utf8"
  );
  if (!hasBoundedMigrationPrefix(sql)) {
    failures.push("Credential retry hardening migration lacks bounded timeouts.");
  }
  for (const required of [
    "last_error text",
    "last_error_class text",
    "consecutive_error_count integer not null default 0",
    "next_retry_at timestamptz",
    "source_recovery_blocked_at timestamptz",
    "credential_operations_retry_ready_idx",
    "roo_record_credential_recovery_failure",
    "v_consecutive_error_count >= 2",
    "v_attempt_count >= 6",
    "interval '5 minutes'",
    "interval '1 minute' * power",
    "v_operation.next_retry_at > now()",
    "candidate.next_retry_at <= now()",
    "exception when sqlstate '40001'",
    "CREDENTIAL_SOURCE_PRECONDITION_CHANGED",
    "CREDENTIAL_SOURCE_WRITE_CONFLICT",
    "create or replace view ops.credential_failures",
    "with (security_invoker = true)",
    "grant select on table ops.credential_failures to service_role",
  ]) {
    if (!sql.includes(required)) {
      failures.push(`Credential retry hardening migration lacks: ${required}`);
    }
  }
  if (
    /Credential source precondition changed'[\s\S]{0,80}errcode\s*=\s*'40001'/i.test(
      sql
    )
  ) {
    failures.push(
      "Credential retry hardening still exposes the deterministic precondition as SQLSTATE 40001."
    );
  }
  if (
    !hasServiceRoleOnlyGrant(
      sql,
      /^grant\s+select\s+on\s+table\s+ops\.credential_failures\b/i
    )
  ) {
    failures.push("Credential failure ops view is not service-role only.");
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, migrations: files.length }, null, 2));
