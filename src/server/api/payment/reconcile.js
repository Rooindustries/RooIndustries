import { reconcilePaymentSessions } from "./flow.js";
import { cleanupExpiredRateLimitBuckets } from "../ref/rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { createPaymentBackendClient } from "./backend.js";
import { isSupabaseAdminConfigured } from "../../supabase/adminClient.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const backends = isSupabaseAdminConfigured()
    ? ["sanity", "supabase"]
    : ["sanity"];
  const results = [];
  let supabaseClient = null;
  for (const backend of backends) {
    const client = createPaymentBackendClient(backend);
    if (backend === "supabase") supabaseClient = client;
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
    if (typeof supabaseClient?.reconcileReverseMirror === "function") {
      try {
        result.body.summary.reverseMirror =
          await supabaseClient.reconcileReverseMirror({ limit: 25 });
      } catch (error) {
        logSafeError("Reverse-mirror reconciliation failed", error);
        result.body.summary.reverseMirror = { pending: true };
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
