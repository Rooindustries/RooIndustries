import { cancelPaymentSession } from "./flow.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  const paymentAccessToken = String(req?.headers?.authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  const result = await cancelPaymentSession({
    paymentAccessToken,
  });
  return res.status(result.httpStatus).json(result.body);
}
