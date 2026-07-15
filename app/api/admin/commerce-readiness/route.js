import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { resolveGlobalCmsWriteControl } from "../../../../src/server/cms/writeControl";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { resolveSupabaseRuntimePolicy } from "../../../../src/server/supabase/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const authorized = (request) => {
  const configured = String(process.env.REF_ADMIN_KEY || "").trim();
  const supplied = String(request.headers.get("x-admin-key") || "").trim();
  return configured && safeEqual(configured, supplied);
};

const requiredNumber = ({ source, key, path, blockers, integer = false }) => {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) {
    blockers.add(`readiness_schema_invalid:${path}`);
    return null;
  }
  const raw = source[key];
  if (typeof raw !== "number") {
    blockers.add(`readiness_schema_invalid:${path}`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    blockers.add(`readiness_schema_invalid:${path}`);
    return null;
  }
  return value;
};

const timestampIsOverdue = ({ pending, oldestAt, maxAgeMs = 300_000 }) => {
  if (pending === 0) return false;
  const timestamp = Date.parse(String(oldestAt || ""));
  return (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60_000 ||
    Date.now() - timestamp > maxAgeMs
  );
};

const derivePortClosureBlockers = (portClosure) => {
  const blockers = new Set();
  const add = (blocker) => blockers.add(blocker);
  const requireCount = (source, key, path, blocker) => {
    const value = requiredNumber({
      source,
      key,
      path,
      blockers,
      integer: true,
    });
    if (value !== null && value > 0) add(blocker);
    return value;
  };
  const requireReady = (source, path, blocker) => {
    if (typeof source?.ready !== "boolean") {
      add(`readiness_schema_invalid:${path}.ready`);
      return;
    }
    if (!source.ready) add(blocker);
  };
  const requireFreshQueue = (source, path, blocker) => {
    const pending = requiredNumber({
      source,
      key: "pending",
      path: `${path}.pending`,
      blockers,
      integer: true,
    });
    if (pending === null || pending === 0) return;
    const oldestAt = Date.parse(String(source?.oldestAt || ""));
    if (
      !Number.isFinite(oldestAt) ||
      oldestAt > Date.now() + 60_000 ||
      Date.now() - oldestAt > 300_000
    ) {
      add(blocker);
    }
  };

  requireReady(
    portClosure?.documentMutationMirror,
    "portClosure.documentMutationMirror",
    "document_mutation_mirror_not_ready"
  );
  requireReady(
    portClosure?.referralFallbackAuthority,
    "portClosure.referralFallbackAuthority",
    "referral_fallback_authority_not_ready"
  );
  requireFreshQueue(
    portClosure?.credentialRecovery,
    "portClosure.credentialRecovery",
    "credential_recovery_overdue"
  );
  requireCount(
    portClosure?.identityDrift,
    "missing",
    "portClosure.identityDrift.missing",
    "identity_drift_missing"
  );
  requireCount(
    portClosure?.identityDrift,
    "stale",
    "portClosure.identityDrift.stale",
    "identity_drift_stale"
  );
  for (const [key, blocker] of [
    ["creatorProjectionDrift", "creator_projection_drift"],
    ["invalidPaymentAliases", "invalid_payment_aliases"],
    ["staleProviderRecovery", "stale_provider_recovery"],
    ["capturedWithoutBooking", "port_captured_without_booking"],
    ["reciprocalLinkMismatches", "reciprocal_link_mismatches"],
    ["providerRecoveryCases", "provider_recovery_cases"],
    ["unnotifiedRescheduleCases", "unnotified_reschedule_cases"],
  ]) {
    requireCount(portClosure, key, `portClosure.${key}`, blocker);
  }
  requireFreshQueue(
    portClosure?.discordRetry,
    "portClosure.discordRetry",
    "discord_retry_overdue"
  );
  requireCount(
    portClosure?.oauthIntents,
    "expiredPending",
    "portClosure.oauthIntents.expiredPending",
    "oauth_intents_expired_pending"
  );
  requireCount(
    portClosure?.oauthIntents,
    "terminalOlderThanSevenDays",
    "portClosure.oauthIntents.terminalOlderThanSevenDays",
    "oauth_intents_cleanup_overdue"
  );
  const parityAgeSeconds = requiredNumber({
    source: portClosure,
    key: "parityAgeSeconds",
    path: "portClosure.parityAgeSeconds",
    blockers,
  });
  if (parityAgeSeconds !== null && parityAgeSeconds > 900) {
    add("port_parity_stale");
  }
  return [...blockers];
};

const deriveCommerceBlockers = ({ readiness, integrity, databaseControl }) => {
  const blockers = new Set();
  const add = (blocker) => blockers.add(blocker);
  const mirror = readiness.mirror || {};
  const integrityMirror = integrity.mirror || {};
  const lastParity = readiness.last_parity;
  const parityCompletedAt = Date.parse(String(lastParity?.completed_at || ""));
  if (
    !lastParity ||
    lastParity.status !== "completed" ||
    !Number.isFinite(parityCompletedAt)
  ) {
    add("parity_invalid");
  } else if (
    parityCompletedAt > Date.now() + 60_000 ||
    Date.now() - parityCompletedAt > 15 * 60_000
  ) {
    add("parity_stale");
  }
  const parity = lastParity?.counters?.parity;
  const parityFailures = requiredNumber({
    source: parity,
    key: "failures",
    path: "last_parity.counters.parity.failures",
    blockers,
    integer: true,
  });
  const parityCompared = requiredNumber({
    source: parity,
    key: "compared",
    path: "last_parity.counters.parity.compared",
    blockers,
    integer: true,
  });
  const parityMirrorPending = requiredNumber({
    source: parity,
    key: "mirrorPending",
    path: "last_parity.counters.parity.mirrorPending",
    blockers,
    integer: true,
  });
  const parityCapturedWithoutBooking = requiredNumber({
    source: parity,
    key: "capturedWithoutBooking",
    path: "last_parity.counters.parity.capturedWithoutBooking",
    blockers,
    integer: true,
  });
  if (
    parity?.ok !== true ||
    parityFailures !== 0 ||
    parityCompared === null ||
    parityCompared < 1 ||
    parityMirrorPending !== 0 ||
    parityCapturedWithoutBooking !== 0
  ) {
    add("parity_drift");
  }
  const checkpoint = readiness.last_mirror_checkpoint;
  if (!["sanity", "supabase"].includes(databaseControl?.primary_backend)) {
    add("readiness_schema_invalid:control.primary_backend");
  }
  if (typeof databaseControl?.starts_paused !== "boolean") {
    add("readiness_schema_invalid:control.starts_paused");
  }
  const checkpointGeneration = requiredNumber({
    source: checkpoint,
    key: "generation",
    path: "last_mirror_checkpoint.generation",
    blockers,
    integer: true,
  });
  const controlGeneration = requiredNumber({
    source: databaseControl,
    key: "generation",
    path: "control.generation",
    blockers,
    integer: true,
  });
  const checkpointAt = Date.parse(String(checkpoint?.mirrored_at || ""));
  if (!Number.isFinite(checkpointAt) || checkpointAt > Date.now() + 60_000) {
    add("mirror_checkpoint_invalid");
  }
  if (
    checkpointGeneration !== null &&
    controlGeneration !== null &&
    checkpointGeneration !== controlGeneration
  ) {
    add("mirror_checkpoint_generation_mismatch");
  }
  const mirrorPending = requiredNumber({
    source: mirror,
    key: "pending",
    path: "mirror.pending",
    blockers,
    integer: true,
  });
  const mirrorDeadLetters = requiredNumber({
    source: mirror,
    key: "dead_letters",
    path: "mirror.dead_letters",
    blockers,
    integer: true,
  });
  if (mirrorDeadLetters !== null && mirrorDeadLetters > 0) {
    add("mirror_dead_letters");
  }
  if (
    mirrorPending !== null &&
    timestampIsOverdue({
      pending: mirrorPending,
      oldestAt: mirror.oldest_pending_at,
    })
  ) {
    add("mirror_overdue");
  }
  const capturedWithoutBooking = requiredNumber({
    source: readiness,
    key: "captured_without_booking",
    path: "captured_without_booking",
    blockers,
    integer: true,
  });
  if (capturedWithoutBooking !== null && capturedWithoutBooking > 0) {
    add("captured_without_booking");
  }
  const emailRetries = requiredNumber({
    source: readiness,
    key: "email_retries",
    path: "email_retries",
    blockers,
    integer: true,
  });
  if (
    emailRetries !== null &&
    timestampIsOverdue({
      pending: emailRetries,
      oldestAt: readiness.email_oldest_retry_at,
    })
  ) {
    add("email_retry_overdue");
  }
  for (const [key, blocker] of [
    ["coupon_mismatches", "coupon_mismatches"],
    ["referral_ambiguous", "referral_ambiguous"],
    ["duplicate_active_slots", "duplicate_active_slots"],
  ]) {
    const value = requiredNumber({
      source: readiness,
      key,
      path: key,
      blockers,
      integer: true,
    });
    if (value !== null && value > 0) add(blocker);
  }
  const integrityPending = requiredNumber({
    source: integrityMirror,
    key: "pending",
    path: "integrity.mirror.pending",
    blockers,
    integer: true,
  });
  const integrityDeadLetters = requiredNumber({
    source: integrityMirror,
    key: "dead_letters",
    path: "integrity.mirror.dead_letters",
    blockers,
    integer: true,
  });
  const integrityOldestAge = requiredNumber({
    source: integrityMirror,
    key: "oldest_age_seconds",
    path: "integrity.mirror.oldest_age_seconds",
    blockers,
    integer: true,
  });
  if (integrityDeadLetters !== null && integrityDeadLetters > 0) {
    add("integrity_mirror_dead_letters");
  }
  if (
    integrityPending !== null &&
    integrityOldestAge !== null &&
    integrityPending > 0 &&
    integrityOldestAge > 300
  ) {
    add("integrity_mirror_overdue");
  }
  for (const [key, blocker] of [
    ["orphan_claimed_proofs", "orphan_claimed_proofs"],
    ["orphan_free_proofs", "orphan_free_proofs"],
    ["command_conflicts", "command_conflicts"],
    ["full_projector_calls_in_commands", "full_projector_calls_in_commands"],
  ]) {
    const value = requiredNumber({
      source: integrity,
      key,
      path: `integrity.${key}`,
      blockers,
      integer: true,
    });
    if (value !== null && value > 0) add(blocker);
  }
  const metrics = readiness.recent_metrics;
  const sampleCount = requiredNumber({
    source: metrics,
    key: "sample_count",
    path: "recent_metrics.sample_count",
    blockers,
    integer: true,
  });
  const p95Ms = requiredNumber({
    source: metrics,
    key: "p95_ms",
    path: "recent_metrics.p95_ms",
    blockers,
  });
  const errorRate = requiredNumber({
    source: metrics,
    key: "error_rate",
    path: "recent_metrics.error_rate",
    blockers,
  });
  if (sampleCount !== null && sampleCount < 30) add("traffic_samples_insufficient");
  if (p95Ms !== null && p95Ms >= 750) add("traffic_p95_exceeded");
  if (errorRate !== null && errorRate >= 1) add("traffic_error_rate_exceeded");
  return [...blockers];
};

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404, headers: noStore },
    );
  }

  try {
    const policy = resolveSupabaseRuntimePolicy();
    const client = createSupabaseAdminClient();
    const [
      readinessResult,
      integrityResult,
      portResult,
      referralEmailResult,
      cmsResult,
    ] = await Promise.all([
      client.rpc("roo_commerce_readiness"),
      client.rpc("roo_commerce_integrity_readiness"),
      client.rpc("roo_supabase_release_readiness"),
      client.rpc("roo_referral_email_readiness"),
      client.rpc("roo_cms_publish_readiness"),
    ]);
    if (
      readinessResult.error ||
      integrityResult.error ||
      portResult.error ||
      referralEmailResult.error ||
      cmsResult.error
    ) {
      throw Object.assign(
        new Error("Readiness query failed."),
        readinessResult.error ||
          integrityResult.error ||
          portResult.error ||
          referralEmailResult.error ||
          cmsResult.error,
      );
    }
    const readiness = readinessResult.data || {};
    const integrity = integrityResult.data || {};
    const portClosure = portResult.data || {};
    const cms = cmsResult.data || {};
    const documentMutationMirror = portClosure.documentMutationMirror || {};
    const referralFallbackAuthority =
      portClosure.referralFallbackAuthority || {};
    const referralEmails = referralEmailResult.data || {};
    const databaseControl = integrity.control || {};
    const commerceBlockers = deriveCommerceBlockers({
      readiness,
      integrity,
      databaseControl,
    });
    const portClosureBlockers = derivePortClosureBlockers(portClosure);
    const commerceReady = commerceBlockers.length === 0;
    const portClosureReady = portClosureBlockers.length === 0;
    const cmsControl = resolveGlobalCmsWriteControl(process.env);
    const cmsBlockers = [
      ...cmsControl.blockers,
      ...(cms.ready === true ? [] : ["cms_publish_readiness_not_ready"]),
    ];
    const cmsReady = cmsBlockers.length === 0;
    const controlMatchesDeployment =
      databaseControl.primary_backend === policy.commercePrimaryBackend &&
      Number(databaseControl.generation) ===
        policy.commerceFailoverGeneration &&
      databaseControl.starts_paused === policy.commerceStartsPaused;
    return NextResponse.json(
      {
        ok: true,
        ...readiness,
        commerceReady,
        commerceBlockers,
        ready:
          commerceReady &&
          controlMatchesDeployment &&
          portClosureReady &&
          referralEmails.ready === true &&
          cmsReady,
        primaryBackend: policy.commercePrimaryBackend,
        cutoverEnabled: policy.commerceCutoverEnabled,
        startsPaused: policy.commerceStartsPaused,
        failoverGeneration: policy.commerceFailoverGeneration,
        databaseControl,
        controlMatchesDeployment,
        portClosureReady,
        portClosureBlockers,
        integrity: {
          mirror: integrity.mirror || {},
          orphanClaimedProofs: Number(integrity.orphan_claimed_proofs || 0),
          orphanFreeProofs: Number(integrity.orphan_free_proofs || 0),
          commandConflicts: Number(integrity.command_conflicts || 0),
          fullProjectorCallsInCommands: Number(
            integrity.full_projector_calls_in_commands || 0,
          ),
        },
        documentMutationMirrorReady: documentMutationMirror.ready === true,
        referralFallbackAuthorityReady:
          referralFallbackAuthority.ready === true,
        referralEmailReady: referralEmails.ready === true,
        cmsReady,
        cmsBlockers,
        cmsControl,
        globalCmsReady: cmsReady,
        globalCmsBlockers: cmsBlockers,
        globalCmsControl: cmsControl,
        cms,
        portClosure,
        referralEmails,
      },
      { headers: noStore },
    );
  } catch (error) {
    logSafeError("Commerce readiness check failed", error);
    return NextResponse.json(
      { ok: false, error: "Commerce readiness is unavailable." },
      { status: 503, headers: noStore },
    );
  }
}
