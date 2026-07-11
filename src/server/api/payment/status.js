import { getPaymentStatus } from "./flow.js";
import {
  createPaymentBackendClientOverride,
  getPaymentTokenBackend,
} from "./backend.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  const bearerToken = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const legacyDeadline = new Date(
    String(process.env.PAYMENT_LEGACY_STATUS_GET_UNTIL || "")
  ).getTime();
  const legacyOpen = Number.isFinite(legacyDeadline) && legacyDeadline > Date.now();
  if (req.method === "GET" && !legacyOpen) {
    res.setHeader("Allow", ["POST"]);
    return res.status(410).json({
      ok: false,
      code: "legacy_payment_status_expired",
      error: "This legacy payment-status link expired.",
    });
  }
  const legacyToken = req.method === "GET"
    ? String(req?.query?.paymentAccessToken || req?.query?.payment || "").trim()
    : "";
  const paymentAccessToken = bearerToken || (legacyOpen ? legacyToken : "");
  const backend = getPaymentTokenBackend(paymentAccessToken) || "sanity";
  const client = createPaymentBackendClientOverride(backend);
  const result = await getPaymentStatus({
    query: req.query,
    paymentAccessToken,
    allowLegacyTokenFallback: false,
    ...(client ? { client } : {}),
  });
  return res.status(result.httpStatus).json(result.body);
}
