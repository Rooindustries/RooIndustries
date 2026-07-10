import { startPaymentSession } from "./flow.js";
import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";

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
  const result = await startPaymentSession({ body });
  return res.status(result.httpStatus).json(result.body);
}
