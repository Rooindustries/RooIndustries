import { cancelPaymentSession } from "./flow.js";
import {
  createPaymentBackendClientOverride,
  getPaymentTokenBackend,
} from "./backend.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  const paymentAccessToken = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const backend = getPaymentTokenBackend(paymentAccessToken) || "sanity";
  const client = createPaymentBackendClientOverride(backend);
  const result = await cancelPaymentSession({
    paymentAccessToken,
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
