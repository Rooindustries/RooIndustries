import crypto from "node:crypto";
import {
  authorizeCronRequest,
  reconcilePaymentSessions,
} from "./flow.js";
import { cleanupExpiredRateLimitBuckets } from "../ref/rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { createPaymentBackendClient } from "./backend.js";
import {
  createSupabaseAdminClient,
  isSupabaseAdminConfigured,
} from "../../supabase/adminClient.js";
import { reconcileBookingEmailDispatches } from "../ref/bookingEmails.js";
import { reconcileReferralEmailDispatches } from "../ref/referralEmailDispatches.js";
import { syncSanityCommerceChanges } from "../../supabase/incrementalCommerceSync.js";
import {
  runTourneyReconciliation,
} from "../../tourney/reconcile.js";
import { reconcileCredentialOperations } from "../../supabase/credentialRecovery.js";
import { isEnabledTourneyFlag } from "../../tourney/canonical.js";
import { createDocumentWriteClient } from "../../data/documentClient.js";
import { refreshCommerceParityIfStale } from "../../supabase/commerceParity.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import { logSanityMirrorEvent } from "../../supabase/mirrorObservability.js";
import sanityConfiguration from "../../supabase/sanityConfiguration.cjs";

const { inspectSanityConfiguration } = sanityConfiguration;

const reconcileDocumentMirror = async (options = {}) => {
  const client = createDocumentWriteClient({ backendOverride: "supabase" });
  if (typeof client?.reconcileReverseMirror !== "function") {
    return { supported: false, attempted: 0, applied: 0 };
  }
  return client.reconcileReverseMirror(options);
};

const CLEANUP_RPC_MISSING_CODES = new Set(["42883", "PGRST202"]);
const CLEANUP_PHASES = new Set([
  "active",
  "holding",
  "payment",
  "payment_pending",
]);

const cleanupExpiredSupabaseHoldsFallback = async ({
  client,
  generation,
  limit,
}) => {
  const now = new Date();
  const nowIso = now.toISOString();
  const fetched = await client.rpc("roo_fetch_shadow_documents_targeted", {
    p_document_types: ["slotHold"],
    p_ids: null,
    p_filters: [
      { path: "backendOwner", op: "ieq", value: "supabase" },
      { path: "cutoverGeneration", op: "eq", value: generation },
      {
        path: "phase",
        op: "in",
        value: [...CLEANUP_PHASES],
      },
      { path: "expiresAt", op: "lte", value: nowIso },
    ],
    p_limit: limit,
  });
  if (fetched.error) throw fetched.error;
  const candidates = (Array.isArray(fetched.data) ? fetched.data : []).filter(
    (document) => {
      const expiresAt = Date.parse(String(document?.expiresAt || ""));
      return (
        document?._type === "slotHold" &&
        /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(document?._id || "") &&
        !String(document?._id || "").includes("..") &&
        Boolean(String(document?._rev || "").trim()) &&
        String(document?.backendOwner || "").toLowerCase() === "supabase" &&
        Number(document?.cutoverGeneration) === generation &&
        CLEANUP_PHASES.has(String(document?.phase || "").toLowerCase()) &&
        Number.isFinite(expiresAt) &&
        expiresAt <= now.getTime()
      );
    }
  );

  let expiredHolds = 0;
  let mirrorEventsEnqueued = 0;
  for (const document of candidates) {
    const commandDigest = crypto
      .createHash("sha256")
      .update(`${document._id}:${document._rev}`)
      .digest("hex");
    const mutation = await client.rpc("roo_apply_commerce_document_mutations", {
      p_command_id: `cleanup.expired-hold.${commandDigest}`,
      p_mutations: [
        {
          operation: "replace",
          expected_revision: document._rev,
          document: {
            ...document,
            phase: "expired",
            releasedAt: nowIso,
            releaseReason: "expired_by_operational_cleanup",
            holdNonce: crypto.randomUUID(),
          },
        },
      ],
      p_cutover_generation: generation,
    });
    if (mutation.error) throw mutation.error;
    expiredHolds += 1;
    if (mutation.data?.event_key) mirrorEventsEnqueued += 1;
  }

  return {
    expired_holds: expiredHolds,
    removed_slot_claims: null,
    mirror_events_enqueued: mirrorEventsEnqueued,
    cutover_generation: generation,
    fallback: "canonical_document_mutations",
  };
};

const cleanupExpiredSupabaseHolds = async ({ generation, limit = 100 }) => {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc(
    "roo_cleanup_expired_supabase_holds",
    {
      p_cutover_generation: generation,
      p_limit: limit,
    }
  );
  if (error && CLEANUP_RPC_MISSING_CODES.has(String(error.code || ""))) {
    return cleanupExpiredSupabaseHoldsFallback({ client, generation, limit });
  }
  if (error) throw error;
  return data || { expired_holds: 0, removed_slot_claims: 0 };
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    authorizeCronRequest(req);
  } catch (error) {
    return res.status(Number(error?.status || 403)).json({
      ok: false,
      error: "Payment reconciliation is temporarily unavailable.",
    });
  }

  const policy = resolveSupabaseRuntimePolicy();
  const sanity = inspectSanityConfiguration(process.env);
  const sanityConfigured = sanity.writeConfigured;
  if (!sanityConfigured) {
    logSanityMirrorEvent({
      event: "sanity_mirror_skipped",
      reason: sanity.status === "partial" ? "sanity_incomplete" : "sanity_unconfigured",
      domain: "commerce",
    });
  }

  const scope = String(
    req?.headers?.["x-reconcile-scope"] || req?.headers?.["X-Reconcile-Scope"] || ""
  )
    .trim()
    .toLowerCase();
  if (
    scope &&
    !["full", "mirror-only", "parity-only", "tourney-only"].includes(scope)
  ) {
    return res.status(400).json({ ok: false, error: "Invalid reconciliation scope." });
  }

  if (scope === "mirror-only") {
    if (!isSupabaseAdminConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Commerce mirror reconciliation is unavailable.",
      });
    }
    if (!sanityConfigured) {
      return res.status(200).json({
        ok: true,
        summary: {
          reverseMirror: { skipped: true, reason: "sanity_unconfigured" },
          documentMirror: { skipped: true, reason: "sanity_unconfigured" },
        },
      });
    }
    const client = createPaymentBackendClient("supabase");
    if (typeof client?.reconcileReverseMirror !== "function") {
      return res.status(503).json({
        ok: false,
        error: "Commerce mirror reconciliation is unavailable.",
      });
    }
    try {
      const reverseMirror = await client.reconcileReverseMirror({
        limit: 100,
        maxBatches: 10,
      });
      const documentMirror = await reconcileDocumentMirror({
        limit: 100,
        maxBatches: 10,
        budgetMs: 60_000,
      });
      return res.status(200).json({
        ok: true,
        summary: { reverseMirror, documentMirror },
      });
    } catch (error) {
      logSafeError("Reverse-mirror reconciliation failed", error);
      logSanityMirrorEvent({
        event: "sanity_mirror_lag",
        reason: "reconciliation_failed",
        domain: "commerce",
      });
      return res.status(503).json({
        ok: false,
        error: "Commerce mirror reconciliation is temporarily unavailable.",
      });
    }
  }

  if (scope === "tourney-only") {
    try {
      return res.status(200).json({
        ok: true,
        ...(await runTourneyReconciliation()),
      });
    } catch (error) {
      logSafeError("Tourney-only reconciliation failed", error);
      return res.status(Number(error?.status || 503)).json({
        ok: false,
        error: "Tournament reconciliation is temporarily unavailable.",
        failedStage: String(error?.failedStage || "tourneyUnknown").slice(0, 64),
        summary: error?.partialSummary || {},
      });
    }
  }

  if (scope === "parity-only") {
    if (!sanityConfigured) {
      return res.status(200).json({
        ok: true,
        summary: {
          commerceParity: { skipped: true, reason: "sanity_unconfigured" },
        },
      });
    }
    try {
      return res.status(200).json({
        ok: true,
        summary: {
          commerceParity: await refreshCommerceParityIfStale({ force: true }),
        },
      });
    } catch (error) {
      logSafeError("Commerce parity refresh failed", error);
      return res.status(Number(error?.status || 503)).json({
        ok: false,
        error: "Commerce parity verification is temporarily unavailable.",
      });
    }
  }

  const referralEmailReconciliationPromise = isSupabaseAdminConfigured()
    ? reconcileReferralEmailDispatches({ limit: 10 }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      )
    : Promise.resolve({
        value: { skipped: true, reason: "supabase_unavailable" },
        error: null,
      });
  const tourneyReconciliationPromise = runTourneyReconciliation({
    budgetMs: 90_000,
  }).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );
  const supabaseConfigured = isSupabaseAdminConfigured();
  const mirrorSkipReason = supabaseConfigured
    ? "sanity_unconfigured"
    : "supabase_unavailable";
  const documentMirrorPromise = supabaseConfigured && sanityConfigured
    ? reconcileDocumentMirror({
        limit: 25,
        maxBatches: 4,
        budgetMs: 30_000,
      }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      )
    : Promise.resolve({
        value: { skipped: true, reason: mirrorSkipReason },
        error: null,
      });
  const commerceParityPromise = supabaseConfigured && sanityConfigured
    ? refreshCommerceParityIfStale().then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      )
    : Promise.resolve({
        value: { supported: false, skipped: true, reason: mirrorSkipReason },
        error: null,
      });
  const expiredHoldCleanupPromise =
    supabaseConfigured && policy.commercePrimaryBackend === "supabase"
      ? cleanupExpiredSupabaseHolds({
          generation: policy.commerceFailoverGeneration,
        }).then(
          (value) => ({ value, error: null }),
          (error) => ({ value: null, error })
        )
      : Promise.resolve({
          value: { skipped: true, reason: "supabase_not_primary" },
          error: null,
        });

  let incrementalShadowSync = {
    skipped: true,
    reason: sanityConfigured
      ? "sanity_non_authoritative"
      : "sanity_unconfigured",
  };
  if (policy.commercePrimaryBackend === "sanity" && sanityConfigured) {
    try {
      incrementalShadowSync = await syncSanityCommerceChanges();
    } catch (error) {
      logSafeError("Incremental commerce shadow sync failed", error);
      incrementalShadowSync = {
        supported: true,
        pending: true,
        errorCode: String(error?.code || "COMMERCE_SYNC_FAILED").slice(0, 128),
      };
    }
  }

  const primaryBackend = policy.commercePrimaryBackend;
  const secondaryBackend = primaryBackend === "supabase" ? "sanity" : "supabase";
  const backends = [
    primaryBackend,
    ...(secondaryBackend === "sanity" && !sanityConfigured
      ? []
      : [secondaryBackend]),
  ];
  const results = [];
  const backendClients = [];
  let supabaseClient = null;
  for (const backend of backends) {
    try {
      const client = createPaymentBackendClient(backend);
      if (backend === "supabase") supabaseClient = client;
      backendClients.push({ backend, client });
      results.push({
        backend,
        result: await reconcilePaymentSessions({
          req,
          backend,
          client,
        }),
      });
    } catch (error) {
      logSafeError(`${backend} payment reconciliation failed`, error);
      results.push({
        backend,
        result: {
          httpStatus: 503,
          body: {
            ok: false,
            error: "Payment reconciliation is temporarily unavailable.",
            summary: {},
          },
        },
      });
    }
  }
  const primaryResult = results.find((entry) => entry.backend === primaryBackend)?.result;
  const aggregateSummary = results
    .filter((entry) => entry.result.httpStatus === 200)
    .reduce((summary, entry) => {
      for (const [key, value] of Object.entries(entry.result.body?.summary || {})) {
        summary[key] = Number(summary[key] || 0) + Number(value || 0);
      }
      return summary;
    }, {});
  const result = primaryResult?.httpStatus === 200
    ? { httpStatus: 200, body: { ok: true, summary: aggregateSummary } }
    : primaryResult || {
        httpStatus: 503,
        body: {
          ok: false,
          error: "Primary payment reconciliation is unavailable.",
          summary: {},
        },
      };
  result.body.summary ||= {};
  result.body.summary.backendReconciliation = Object.fromEntries(
    results.map(({ backend, result: backendResult }) => [
      backend,
      backendResult.httpStatus === 200
        ? { ok: true }
        : { ok: false, pending: true },
    ])
  );
  if (!sanityConfigured) {
    result.body.summary.backendReconciliation.sanity = {
      skipped: true,
      reason: "sanity_unconfigured",
    };
  }
  const documentMirror = await documentMirrorPromise;
  if (documentMirror.error) {
    logSafeError("Document mirror reconciliation failed", documentMirror.error);
    logSanityMirrorEvent({
      event: "sanity_mirror_lag",
      reason: "document_reconciliation_failed",
      domain: "global",
    });
    result.body.summary.documentMirror = { pending: true };
  } else {
    result.body.summary.documentMirror = documentMirror.value;
  }
  const referralEmailReconciliation = await referralEmailReconciliationPromise;
  if (referralEmailReconciliation.error) {
    logSafeError(
      "Referral email reconciliation failed",
      referralEmailReconciliation.error
    );
    result.body.summary.referralEmailRecovery = { pending: true };
  } else {
    result.body.summary.referralEmailRecovery =
      referralEmailReconciliation.value;
  }
  const commerceParity = await commerceParityPromise;
  if (commerceParity.error) {
    logSafeError("Commerce parity refresh failed", commerceParity.error);
    result.body.summary.commerceParity = { pending: true };
  } else {
    result.body.summary.commerceParity = commerceParity.value;
  }
  const expiredHoldCleanup = await expiredHoldCleanupPromise;
  if (expiredHoldCleanup.error) {
    logSafeError("Expired Supabase hold cleanup failed", expiredHoldCleanup.error);
    result.body.summary.expiredSupabaseHoldCleanup = { pending: true };
  } else {
    result.body.summary.expiredSupabaseHoldCleanup = expiredHoldCleanup.value;
  }
  if (result.httpStatus === 200) {
    result.body.summary.incrementalShadowSync = incrementalShadowSync;
    result.body.summary.emailOnlyRecovery = {};
    for (const { backend, client } of backendClients) {
      try {
        result.body.summary.emailOnlyRecovery[backend] =
          await reconcileBookingEmailDispatches({ client });
      } catch (error) {
        logSafeError(`${backend} email-only reconciliation failed`, error);
        result.body.summary.emailOnlyRecovery[backend] = { pending: true };
      }
    }
    if (
      sanityConfigured &&
      typeof supabaseClient?.reconcileReverseMirror === "function"
    ) {
      try {
        result.body.summary.reverseMirror =
          await supabaseClient.reconcileReverseMirror({ limit: 25 });
      } catch (error) {
        logSafeError("Reverse-mirror reconciliation failed", error);
        logSanityMirrorEvent({
          event: "sanity_mirror_lag",
          reason: "reconciliation_failed",
          domain: "commerce",
        });
        result.body.summary.reverseMirror = { pending: true };
      }
    } else if (!sanityConfigured) {
      result.body.summary.reverseMirror = {
        skipped: true,
        reason: "sanity_unconfigured",
      };
    }
    if (supabaseClient?.shadowClient?.rpc) {
      try {
        const [metrics, typedGaps] = await Promise.all([
          supabaseClient.shadowClient.rpc("roo_cleanup_commerce_metrics", {}),
          supabaseClient.shadowClient.rpc("roo_commerce_typed_gap_summary", {}),
        ]);
        if (metrics.error) throw metrics.error;
        if (typedGaps.error) throw typedGaps.error;
        result.body.summary.commerceMetricsCleaned = Number(metrics.data || 0);
        result.body.summary.typedGapSnapshot = typedGaps.data || {};
      } catch (error) {
        logSafeError("Commerce reconciliation bookkeeping failed", error);
        result.body.summary.commerceBookkeepingPending = true;
      }
    }
    if (isSupabaseAdminConfigured()) {
      try {
        result.body.summary.credentialRecovery =
          await reconcileCredentialOperations({ limit: 10 });
      } catch (error) {
        logSafeError("Credential recovery reconciliation failed", error);
        result.body.summary.credentialRecovery = { pending: true };
      }
    }
    try {
      result.body.summary.rateLimitBucketsCleaned =
        await cleanupExpiredRateLimitBuckets();
    } catch (error) {
      logSafeError("Rate-limit cleanup failed", error);
      result.body.summary.rateLimitBucketsCleaned = 0;
      result.body.summary.rateLimitCleanupPending = true;
    }
    if (["1", "true", "yes", "on"].includes(
      String(process.env.SUPABASE_SOCIAL_AUTH_ENABLED || "").trim().toLowerCase()
    )) {
      try {
        const accountSecurity = await createSupabaseAdminClient().rpc(
          "roo_reconcile_account_security",
          {
            p_guild_id: isEnabledTourneyFlag(process.env.TOURNEY_HARDENING_V4_ENABLED)
              ? null
              : String(process.env.DISCORD_GUILD_ID || "").trim() || null,
          }
        );
        if (accountSecurity.error) throw accountSecurity.error;
        result.body.summary.accountSecurity = accountSecurity.data || {};
      } catch (error) {
        logSafeError("Account security reconciliation failed", error);
        result.body.summary.accountSecurity = { pending: true };
      }
    }
    if (result.httpStatus === 200 && isSupabaseAdminConfigured()) {
      try {
        const checkpoint = await createSupabaseAdminClient().rpc(
          "roo_record_reconciliation_checkpoint",
          {
            p_counters: result.body.summary,
            p_parity: {
              incrementalShadowSync,
              reverseMirror: result.body.summary.reverseMirror || {},
            },
          }
        );
        if (checkpoint.error) throw checkpoint.error;
        result.body.summary.reconciliationCheckpoint = checkpoint.data || {};
      } catch (error) {
        logSafeError("Reconciliation checkpoint recording failed", error);
        result.body.summary.reconciliationCheckpointPending = true;
      }
    }
  }
  const tourneyReconciliation = await tourneyReconciliationPromise;
  if (tourneyReconciliation.error) {
    const error = tourneyReconciliation.error;
    logSafeError("Tourney reconciliation failed", error);
    result.body.summary.tourneyReconciliation = {
      pending: true,
      failedStage: String(error?.failedStage || "tourneyUnknown").slice(0, 64),
      partialSummary: error?.partialSummary || {},
    };
  } else if (tourneyReconciliation.value.skipped) {
    result.body.summary.tourneyReconciliation = {
      skipped: true,
      reason: tourneyReconciliation.value.reason,
    };
  } else {
    Object.assign(result.body.summary, tourneyReconciliation.value.summary);
  }
  return res.status(result.httpStatus).json(result.body);
}
