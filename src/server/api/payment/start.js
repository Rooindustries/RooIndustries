import { startPaymentSession } from "./flow.js";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import {
  createPaymentBackendClientOverride,
  selectPaymentStartBackend,
} from "./backend.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const commercePolicy = resolveSupabaseRuntimePolicy();
  if (commercePolicy.commerceStartsPaused) {
    res.setHeader("Retry-After", "60");
    return res.status(503).json({
      ok: false,
      code: "commerce_starts_paused",
      error: "New payment starts are temporarily paused. Please try again shortly.",
    });
  }

  const allowed = await requireRateLimit(res, {
    key: `payment-start:${getClientAddress(req)}`,
    max: 12,
    windowMs: 15 * 60 * 1000,
    message: "Too many payment start attempts. Please try again later.",
  });
  if (!allowed) return;

  const body = req.body || {};
  const backend = selectPaymentStartBackend({
    body,
    clientAddress: getClientAddress(req),
  });
  const client = createPaymentBackendClientOverride(backend);
  const result = await startPaymentSession({
    body,
    backend,
    cutoverGeneration: commercePolicy.commerceFailoverGeneration,
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
