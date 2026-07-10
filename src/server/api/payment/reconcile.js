import { reconcilePaymentSessions } from "./flow.js";
import { cleanupExpiredRateLimitBuckets } from "../ref/rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const result = await reconcilePaymentSessions({ req });
  if (result.httpStatus === 200) {
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
