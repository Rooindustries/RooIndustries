import { handleRazorpayWebhook } from "./flow.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const result = await handleRazorpayWebhook({ req });
  return res.status(result.httpStatus).json(result.body);
}
