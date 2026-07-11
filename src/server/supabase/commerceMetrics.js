import { logSafeError } from "../safeErrorLog.js";
import { createSupabaseAdminClient, isSupabaseAdminConfigured } from "./adminClient.js";
import { resolveSupabaseRuntimePolicy } from "./runtime.js";

export const recordCommerceMetric = async ({
  route,
  durationMs,
  statusCode,
  responseBytes = 0,
} = {}) => {
  if (!isSupabaseAdminConfigured()) return;
  try {
    const policy = resolveSupabaseRuntimePolicy();
    const { error } = await createSupabaseAdminClient().rpc(
      "roo_record_commerce_metric",
      {
        p_route: String(route || "unknown").toLowerCase().slice(0, 120),
        p_backend: policy.commercePrimaryBackend,
        p_cutover_generation: policy.commerceFailoverGeneration,
        p_duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
        p_status_code: Math.max(100, Math.min(599, Number(statusCode) || 500)),
        p_response_bytes: Math.max(0, Math.round(Number(responseBytes) || 0)),
      }
    );
    if (error) throw Object.assign(new Error("Commerce metric write failed."), error);
  } catch (error) {
    logSafeError("Commerce metric recording failed", error);
  }
};

export const recordCommerceResponseMetric = async ({ response, ...metric }) => {
  let responseBytes = Number(response?.headers?.get?.("content-length") || 0);
  if (!responseBytes && response) {
    try {
      responseBytes = (await response.arrayBuffer()).byteLength;
    } catch {
      responseBytes = 0;
    }
  }
  return recordCommerceMetric({ ...metric, responseBytes });
};
