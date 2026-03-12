const resolveRuntime = () => {
  const vercelEnv = String(
    process.env.VERCEL_ENV || process.env.NEXT_PUBLIC_VERCEL_ENV || ""
  )
    .trim()
    .toLowerCase();

  if (
    vercelEnv === "production" ||
    vercelEnv === "preview" ||
    vercelEnv === "development"
  ) {
    return vercelEnv;
  }

  return process.env.NODE_ENV === "production" ? "production" : "development";
};

const resolvePreviewPaymentsEnabled = () =>
  ["1", "true", "yes", "on"].includes(
    String(
      process.env.ENABLE_PREVIEW_PAYMENTS ||
        process.env.ALLOW_PREVIEW_PAYMENTS ||
        ""
    )
      .trim()
      .toLowerCase()
  );

const normalizeRuntimePolicy = (input) => {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }

  const isProdLike = Boolean(input);
  return {
    runtime: isProdLike ? "production" : "development",
    isProdLike,
    isPreview: false,
    previewPaymentsEnabled: false,
  };
};

const resolvePaymentRuntimePolicy = () => {
  const runtime = resolveRuntime();
  const isProdLike = runtime === "production";
  const isPreview = runtime === "preview";

  return {
    runtime,
    isProdLike,
    isPreview,
    previewPaymentsEnabled: isPreview && resolvePreviewPaymentsEnabled(),
  };
};

const resolveIsProdLike = () => resolvePaymentRuntimePolicy().isProdLike;

const allowProviderModeInRuntime = (
  mode,
  runtimePolicy = resolvePaymentRuntimePolicy()
) => {
  const policy = normalizeRuntimePolicy(runtimePolicy);

  if (!mode || mode === "missing" || mode === "unknown") return false;
  if (policy.isProdLike) return mode === "live";
  if (policy.isPreview) {
    if (!policy.previewPaymentsEnabled) return false;
    return mode === "test" || mode === "sandbox";
  }
  return mode === "live" || mode === "test" || mode === "sandbox";
};

const resolvePayPalMode = (runtimePolicy = resolvePaymentRuntimePolicy()) => {
  const policy = normalizeRuntimePolicy(runtimePolicy);
  const explicit = String(
    process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
  )
    .trim()
    .toLowerCase();

  if (explicit === "live" || explicit === "production") return "live";
  if (explicit === "sandbox" || explicit === "test") return "sandbox";
  return policy.isProdLike ? "live" : "sandbox";
};

const resolveRazorpayMode = (keyId = "") => {
  if (!keyId) return "missing";
  if (keyId.startsWith("rzp_live_")) return "live";
  if (keyId.startsWith("rzp_test_")) return "test";
  return "unknown";
};

const resolvePaymentProviders = () => {
  const runtimePolicy = resolvePaymentRuntimePolicy();

  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const razorpayMode = resolveRazorpayMode(razorpayKeyId);
  const razorpayEnabled =
    !!razorpayKeyId &&
    !!razorpayKeySecret &&
    allowProviderModeInRuntime(razorpayMode, runtimePolicy);

  const paypalClientId = String(
    process.env.PAYPAL_CLIENT_ID || process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || ""
  ).trim();
  const paypalClientSecret = String(process.env.PAYPAL_CLIENT_SECRET || "").trim();
  const paypalMode = resolvePayPalMode(runtimePolicy);
  const paypalEnabled =
    !!paypalClientId &&
    !!paypalClientSecret &&
    allowProviderModeInRuntime(paypalMode, runtimePolicy);

  return {
    runtime: runtimePolicy.runtime,
    previewPaymentsEnabled: runtimePolicy.previewPaymentsEnabled,
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
  resolvePaymentRuntimePolicy,
  resolveRazorpayMode,
  resolveServerPaymentSessionsEnabled,
};
