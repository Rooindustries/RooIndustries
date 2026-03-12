const resolveIsProdLike = () => {
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  if (vercelEnv) return vercelEnv === "production";
  return process.env.NODE_ENV === "production";
};

const allowProviderModeInRuntime = (mode, isProdLike) => {
  if (!mode || mode === "missing" || mode === "unknown") return false;
  if (isProdLike) return mode === "live";
  return mode === "live" || mode === "test" || mode === "sandbox";
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

const resolvePaymentProviders = () => {
  const isProdLike = resolveIsProdLike();

  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const razorpayMode = resolveRazorpayMode(razorpayKeyId);
  const razorpayEnabled =
    !!razorpayKeyId &&
    !!razorpayKeySecret &&
    allowProviderModeInRuntime(razorpayMode, isProdLike);

  const paypalClientId = String(
    process.env.PAYPAL_CLIENT_ID || process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || ""
  ).trim();
  const paypalClientSecret = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();
  const paypalMode = resolvePayPalMode(isProdLike);
  const paypalEnabled =
    !!paypalClientId &&
    !!paypalClientSecret &&
    allowProviderModeInRuntime(paypalMode, isProdLike);

  return {
    serverSessionsEnabled: resolveServerPaymentSessionsEnabled(),
    razorpay: {
      enabled: razorpayEnabled,
      mode: razorpayMode,
    },
    paypal: {
      enabled: paypalEnabled,
      mode: paypalMode,
      clientId: paypalEnabled ? paypalClientId : "",
    },
  };
};

const resolveServerPaymentSessionsEnabled = () =>
  String(
    process.env.ENABLE_SERVER_PAYMENT_SESSIONS === undefined
      ? "1"
      : process.env.ENABLE_SERVER_PAYMENT_SESSIONS
  )
    .trim()
    .toLowerCase() !== "0";

module.exports = {
  allowProviderModeInRuntime,
  resolveIsProdLike,
  resolvePayPalMode,
  resolvePaymentProviders,
  resolveRazorpayMode,
  resolveServerPaymentSessionsEnabled,
};
