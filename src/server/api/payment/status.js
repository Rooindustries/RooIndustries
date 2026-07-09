import { getPaymentStatus } from "./flow.js";

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
  const legacyToken =
    req.method === "GET"
      ? String(req?.query?.paymentAccessToken || req?.query?.payment || "").trim()
      : String(req?.body?.paymentAccessToken || "").trim();
  const result = await getPaymentStatus({
    query: req.query,
    paymentAccessToken: bearerToken || (legacyOpen ? legacyToken : ""),
    allowLegacyTokenFallback: false,
  });
  return res.status(result.httpStatus).json(result.body);
}
