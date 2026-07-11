import { handleRazorpayWebhook } from "./flow.js";
import {
  createPaymentBackendClient,
  resolveWebhookBackend,
} from "./backend.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const backend = await resolveWebhookBackend({
    provider: "razorpay",
    body: req.body,
  });
  const result = await handleRazorpayWebhook({
    req,
    backendOwner: backend,
    client: createPaymentBackendClient(backend),
  });
  return res.status(result.httpStatus).json(result.body);
}
