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
import { syncSanityCommerceChanges } from "../../supabase/incrementalCommerceSync.js";
import {
  runTourneyReconciliation,
} from "../../tourney/reconcile.js";
import { reconcileCredentialOperations } from "../../supabase/credentialRecovery.js";
import { isEnabledTourneyFlag } from "../../tourney/canonical.js";

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

  const scope = String(
    req?.headers?.["x-reconcile-scope"] || req?.headers?.["X-Reconcile-Scope"] || ""
  )
    .trim()
    .toLowerCase();
  if (scope && !["full", "mirror-only", "tourney-only"].includes(scope)) {
    return res.status(400).json({ ok: false, error: "Invalid reconciliation scope." });
  }

  if (scope === "mirror-only") {
    if (!isSupabaseAdminConfigured()) {
      return res.status(503).json({
        ok: false,
        error: "Commerce mirror reconciliation is unavailable.",
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
      return res.status(200).json({ ok: true, summary: { reverseMirror } });
    } catch (error) {
      logSafeError("Reverse-mirror reconciliation failed", error);
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

  const tourneyReconciliationPromise = runTourneyReconciliation({
    budgetMs: 90_000,
  }).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );

  let incrementalShadowSync = null;
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

  const backends = isSupabaseAdminConfigured()
    ? ["sanity", "supabase"]
    : ["sanity"];
  const results = [];
  const backendClients = [];
  let supabaseClient = null;
  for (const backend of backends) {
    try {
      const client = createPaymentBackendClient(backend);
      if (backend === "supabase") supabaseClient = client;
      backendClients.push({ backend, client });
      results.push(await reconcilePaymentSessions({
        req,
        backend,
        client,
      }));
    } catch (error) {
      logSafeError(`${backend} payment reconciliation failed`, error);
      results.push({
        httpStatus: 503,
        body: {
          ok: false,
          error: "Payment reconciliation is temporarily unavailable.",
          summary: {},
        },
      });
    }
  }
  const failed = results.find((entry) => entry.httpStatus !== 200);
  const result = failed || {
    httpStatus: 200,
    body: {
      ok: true,
      summary: results.reduce((summary, entry) => {
        for (const [key, value] of Object.entries(entry.body?.summary || {})) {
          summary[key] = Number(summary[key] || 0) + Number(value || 0);
        }
        return summary;
      }, {}),
    },
  };
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
    if (typeof supabaseClient?.reconcileReverseMirror === "function") {
      try {
        result.body.summary.reverseMirror =
          await supabaseClient.reconcileReverseMirror({ limit: 25 });
      } catch (error) {
        logSafeError("Reverse-mirror reconciliation failed", error);
        result.body.summary.reverseMirror = { pending: true };
      }
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
  result.body.summary ||= {};
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
