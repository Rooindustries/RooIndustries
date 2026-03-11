import { startPaymentSession } from "./flow.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const result = await startPaymentSession({ body: req.body });
  return res.status(result.httpStatus).json(result.body);
}
