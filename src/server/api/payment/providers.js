import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";
import providerConfig from "./providerConfig.js";

const { resolvePaymentProviders } = providerConfig;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const clientAddress = getClientAddress(req);
  if (
    !requireRateLimit(res, {
      key: `payment-providers:${clientAddress}`,
      max: 60,
      message: "Too many payment provider requests. Please try again later.",
    })
  ) {
    return;
  }

  const providers = resolvePaymentProviders({
    hostname: req.headers?.host || req.headers?.["x-forwarded-host"] || "",
  });

  return res.status(200).json({
    ok: true,
    providers: {
      razorpay: {
        enabled: !!providers?.razorpay?.enabled,
        mode: providers?.razorpay?.mode || "unknown",
      },
      paypal: {
        enabled: !!providers?.paypal?.enabled,
        mode: providers?.paypal?.mode || "unknown",
        clientId: String(providers?.paypal?.clientId || "").trim(),
      },
    },
    market: providers?.market || { id: "global", currency: "USD" },
    environment: {
      runtime: providers?.runtime || "development",
      previewPaymentsEnabled: providers?.previewPaymentsEnabled === true,
      livePaymentsEnabled: providers?.livePaymentsEnabled === true,
    },
  });
}
