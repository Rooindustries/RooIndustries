import { getClientAddress, requireRateLimit } from "../ref/rateLimit.js";

const resolveIsProdLike = () => {
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
};

const resolvePayPalMode = (isProdLike) => {
  const explicit = String(
    process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
  )
    .trim()
    .toLowerCase();

  if (explicit === "live" || explicit === "production") return "live";
  if (explicit === "sandbox" || explicit === "test") return "sandbox";
  return isProdLike ? "live" : "sandbox";
};

const resolveRazorpayMode = (keyId = "") => {
  if (!keyId) return "missing";
  if (keyId.startsWith("rzp_live_")) return "live";
  if (keyId.startsWith("rzp_test_")) return "test";
  return "unknown";
};

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

  const isProdLike = resolveIsProdLike();

  const razorpayKeyId = process.env.RAZORPAY_KEY_ID || "";
  const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET || "";
  const razorpayMode = resolveRazorpayMode(razorpayKeyId);
  const razorpayEnabled =
    !!razorpayKeyId &&
    !!razorpayKeySecret &&
    !(isProdLike && razorpayMode === "test");

  const paypalClientId = String(
    process.env.PAYPAL_CLIENT_ID ||
    process.env.REACT_APP_PAYPAL_CLIENT_ID ||
    process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
    ""
  ).trim();
  const paypalClientSecret = String(
    process.env.PAYPAL_CLIENT_SECRET ||
    process.env.REACT_APP_PAYPAL_CLIENT_SECRET ||
    ""
  ).trim();
  const paypalMode = resolvePayPalMode(isProdLike);
  const hasPayPalClientId = !!paypalClientId;
  const hasPayPalClientSecret = !!paypalClientSecret;
  const hasRequiredPayPalCredentials = hasPayPalClientId && hasPayPalClientSecret;
  const paypalEnabled =
    hasRequiredPayPalCredentials &&
    !(isProdLike && paypalMode !== "live");

  return res.status(200).json({
    ok: true,
    providers: {
      razorpay: {
        enabled: razorpayEnabled,
        mode: razorpayMode,
      },
      paypal: {
        enabled: paypalEnabled,
        mode: paypalMode,
        clientId: hasPayPalClientId ? paypalClientId : "",
      },
    },
  });
}
