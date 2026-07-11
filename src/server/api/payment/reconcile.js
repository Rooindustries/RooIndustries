import { reconcilePaymentSessions } from "./flow.js";
import { cleanupExpiredRateLimitBuckets } from "../ref/rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { createPaymentBackendClient } from "./backend.js";
import { isSupabaseAdminConfigured } from "../../supabase/adminClient.js";
import { reconcileBookingEmailDispatches } from "../ref/bookingEmails.js";
import { syncSanityCommerceChanges } from "../../supabase/incrementalCommerceSync.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

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
    const client = createPaymentBackendClient(backend);
    if (backend === "supabase") supabaseClient = client;
    backendClients.push({ backend, client });
    results.push(
      await reconcilePaymentSessions({
        req,
        backend,
        client,
      })
    );
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
    try {
      result.body.summary.rateLimitBucketsCleaned =
        await cleanupExpiredRateLimitBuckets();
    } catch (error) {
      logSafeError("Rate-limit cleanup failed", error);
      result.body.summary.rateLimitBucketsCleaned = 0;
      result.body.summary.rateLimitCleanupPending = true;
    }
  }
  return res.status(result.httpStatus).json(result.body);
}
