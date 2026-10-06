import {
  authorizeCronRequest,
  reconcilePaymentSessions,
} from "./flow.js";
import { cleanupExpiredRateLimitBuckets } from "../ref/rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";
import { createPaymentBackendClient } from "./backend.js";
import { createSupabaseAdminClient } from "../../supabase/adminClient.js";
import { reconcileBookingEmailDispatches } from "../ref/bookingEmails.js";
import { reconcileReferralEmailDispatches } from "../ref/referralEmailDispatches.js";

import { reconcileCredentialOperations } from "../../supabase/credentialRecovery.js";

import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";

const cleanupExpiredSupabaseHolds = async ({ generation, limit = 25 }) => {
  const client = createSupabaseAdminClient();
  const { data, error } = await client.rpc(
    "roo_cleanup_expired_supabase_holds",
    {
      p_cutover_generation: generation,
      p_limit: Math.max(1, Math.min(Number(limit) || 25, 25)),
    }
  );
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

  const scope = String(
    req?.headers?.["x-reconcile-scope"] || req?.headers?.["X-Reconcile-Scope"] || ""
  ).trim().toLowerCase();
  if (scope && !["full", "mirror-only", "parity-only"].includes(scope)) {
    return res.status(400).json({ ok: false, error: "Unsupported reconciliation scope." });
  }


  if (scope === "mirror-only" || scope === "parity-only") return res.status(200).json({ok:true,skipped:true,reason:"retired"});
  const policy = resolveSupabaseRuntimePolicy();
  let client;
  const summary = {};
  const duty = async (name, run) => {
    let timer;
    try {
      summary[name] = await Promise.race([Promise.resolve().then(run),new Promise((_,reject) => { timer=setTimeout(() => reject(Object.assign(new Error("Reconciliation duty timed out."),{code:"RECONCILIATION_TIMEOUT"})),name === "paymentSessions" ? 120000 : 30000); })]);
    } catch (error) {
      logSafeError(`${name} reconciliation failed`,error);
      summary[name] = {pending:true,errorCode:String(error?.code || "RECONCILIATION_FAILED").slice(0,128)};
    } finally {clearTimeout(timer);}
  };
  let paymentResult;
  await duty("paymentSessions",async () => {
    client = createPaymentBackendClient("supabase");
    paymentResult = await reconcilePaymentSessions({req,backend:"supabase",client});
    return paymentResult.body?.summary || {};
  });
  if(paymentResult?.body?.summary)Object.assign(summary,paymentResult.body.summary);
  await Promise.all([
    duty("expiredSupabaseHoldCleanup",() => cleanupExpiredSupabaseHolds({generation:policy.commerceFailoverGeneration})),
    duty("referralEmailRecovery",() => reconcileReferralEmailDispatches({limit:10})),
    duty("credentialRecovery",() => reconcileCredentialOperations({limit:10})),
    duty("rateLimitBucketsCleaned",() => cleanupExpiredRateLimitBuckets()),
    duty("emailOnlyRecovery",async () => ({supabase:await reconcileBookingEmailDispatches({client:client || createPaymentBackendClient("supabase")})})),
    duty("commerceMetricsCleaned",async () => {
      const result=await createSupabaseAdminClient().rpc("roo_cleanup_commerce_metrics",{});if(result.error)throw result.error;return Number(result.data || 0);
    }),
    duty("typedGapSnapshot",async () => {
      const result=await createSupabaseAdminClient().rpc("roo_commerce_typed_gap_summary",{});if(result.error)throw result.error;return result.data || {};
    }),
    ...(["1","true","yes","on"].includes(String(process.env.SUPABASE_SOCIAL_AUTH_ENABLED || "").trim().toLowerCase()) ? [duty("accountSecurity",async () => {const result=await createSupabaseAdminClient().rpc("roo_reconcile_account_security",{p_guild_id:null});if(result.error)throw result.error;return result.data || {};})] : []),
  ]);
  summary.backendReconciliation={supabase:{ok:paymentResult?.httpStatus === 200,pending:paymentResult?.httpStatus !== 200}};
  await duty("reconciliationCheckpoint",async () => {
    const result=await createSupabaseAdminClient().rpc("roo_record_reconciliation_checkpoint",{p_counters:summary,p_parity:{}});if(result.error)throw result.error;return result.data || {};
  });
  return res.status(paymentResult?.httpStatus || 503).json({ok:paymentResult?.httpStatus === 200,summary,...(paymentResult?.httpStatus === 200 ? {} : {error:"Payment reconciliation is temporarily unavailable."})});
}
