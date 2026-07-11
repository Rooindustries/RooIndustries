import { startPaymentSession } from "./flow.js";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import {
  createPaymentBackendClientOverride,
  selectPaymentStartBackend,
} from "./backend.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
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
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
