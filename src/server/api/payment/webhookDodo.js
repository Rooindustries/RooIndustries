import { handleDodoWebhook } from "./flow.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const result = await handleDodoWebhook({ req });
  return res.status(result.httpStatus).json(result.body);
}
