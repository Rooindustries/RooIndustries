import { startPaymentSession } from "./flow.js";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import {
  createPaymentBackendClientOverride,
  selectPaymentStartBackend,
} from "./backend.js";
import { resolveSupabaseRuntimePolicy } from "../../supabase/runtime.js";
import { assertCommerceStartAllowed } from "../../supabase/commerceControl.js";

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

  const clientAddress = getClientAddress(req);
  const allowed = await requireRateLimit(res, {
    key: `payment-start:${clientAddress}`,
    max: 12,
    windowMs: 15 * 60 * 1000,
    message: "Too many payment start attempts. Please try again later.",
  });
  if (!allowed) return;

  let commerceControl;
  try {
    commerceControl = await assertCommerceStartAllowed();
  } catch (error) {
    res.setHeader("Retry-After", "60");
    return res.status(503).json({
      ok: false,
      code: String(error?.code || "commerce_control_unavailable").toLowerCase(),
      error: "New payment starts are temporarily unavailable. Please try again shortly.",
    });
  }

  const body = req.body || {};
  const backend = selectPaymentStartBackend({
    body,
    clientAddress,
  });
  const client = createPaymentBackendClientOverride(backend);
  const result = await startPaymentSession({
    body,
    backend,
    cutoverGeneration: commerceControl.generation,
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
