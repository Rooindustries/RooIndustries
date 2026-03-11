import { getPaymentStatus } from "./flow.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const result = await getPaymentStatus({ query: req.query });
  return res.status(result.httpStatus).json(result.body);
}
