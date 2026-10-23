import { recoverPaymentSession } from "./flow.js";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import { createPaymentBackendClientOverride, selectPaymentStartBackend } from "./backend.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  if (!await requireRateLimit(res, {
    key: `payment-recover:${getClientAddress(req)}`, max: 30, windowMs: 15 * 60 * 1000,
    message: "Too many checkout recovery attempts. Please try again later.",
  })) return;
  const body = req.body || {};
  const backend = selectPaymentStartBackend({ body });
  const client = createPaymentBackendClientOverride(backend);
  const result = await recoverPaymentSession({ body, backend, ...(client ? { client } : {}) });
  return res.status(result.httpStatus).json(result.body);
}
