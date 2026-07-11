import { finalizePaymentSession } from "./flow.js";
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
  res.setHeader("Pragma", "no-cache");
  const bearerToken = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const legacyDeadline = new Date(
    String(process.env.PAYMENT_LEGACY_COMPLETION_UNTIL || "")
  ).getTime();
  const legacyOpen = Number.isFinite(legacyDeadline) && legacyDeadline > Date.now();
  const paymentAccessToken =
    bearerToken ||
    (legacyOpen ? String(req?.body?.paymentAccessToken || "").trim() : "");
  const backend = getPaymentTokenBackend(paymentAccessToken) || "sanity";
  const client = createPaymentBackendClientOverride(backend);
  const result = await finalizePaymentSession({
    body: req.body,
    paymentAccessToken,
    allowLegacyTokenFallback: false,
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
