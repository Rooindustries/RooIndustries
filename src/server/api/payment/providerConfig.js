const TRUTHY_ENV_VALUES = ["1", "true", "yes", "on"];
const KNOWN_RUNTIMES = new Set(["production", "preview", "development"]);
const marketConfig = require("../../../lib/market.js");

const { resolveMarket } = marketConfig;

const isTruthyEnv = (value) =>
  TRUTHY_ENV_VALUES.includes(String(value || "").trim().toLowerCase());

const normalizeRuntime = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return KNOWN_RUNTIMES.has(normalized) ? normalized : "development";
};

const resolveRuntime = () => {
  const rawVercelEnv =
    process.env.VERCEL_ENV ||
    process.env.NEXT_PUBLIC_VERCEL_ENV ||
    process.env.REACT_APP_VERCEL_ENV ||
    "";
  const hasExplicitRuntime = String(rawVercelEnv || "").trim().length > 0;
  const vercelEnv = normalizeRuntime(rawVercelEnv);

  if (hasExplicitRuntime) {
    return vercelEnv;
  }

  return process.env.NODE_ENV === "production" ? "production" : "development";
};

const resolvePreviewPaymentsEnabled = () =>
  isTruthyEnv(
    process.env.ENABLE_PREVIEW_PAYMENTS || process.env.ALLOW_PREVIEW_PAYMENTS
  );

const resolveLivePaymentsEnabled = (runtime = resolveRuntime()) => {
  if (runtime === "production") return true;
  if (runtime === "preview") {
    return isTruthyEnv(process.env.ALLOW_LIVE_PAYMENTS_IN_PREVIEW);
  }
  return isTruthyEnv(process.env.ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT);
};

const buildRuntimePolicy = (
  runtime,
  {
    previewPaymentsEnabled = false,
    livePaymentsEnabled = false,
  } = {}
) => ({
  runtime,
  isProdLike: runtime === "production",
  isPreview: runtime === "preview",
  previewPaymentsEnabled:
    runtime === "preview" && previewPaymentsEnabled === true,
  livePaymentsEnabled:
    runtime === "production" || livePaymentsEnabled === true,
});

const normalizeRuntimePolicy = (input) => {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const runtime =
      input.runtime !== undefined
        ? normalizeRuntime(input.runtime)
        : input.isPreview
          ? "preview"
          : input.isProdLike
            ? "production"
            : "development";

    return buildRuntimePolicy(runtime, {
      previewPaymentsEnabled:
        input.previewPaymentsEnabled === true && runtime === "preview",
      livePaymentsEnabled:
        input.livePaymentsEnabled === true || runtime === "production",
    });
  }

  if (typeof input === "string") {
    return buildRuntimePolicy(normalizeRuntime(input));
  }

  if (typeof input === "boolean") {
    return buildRuntimePolicy(input ? "production" : "development", {
      livePaymentsEnabled: input,
    });
  }

  return buildRuntimePolicy("development");
};

const resolvePaymentRuntimePolicy = () => {
  const runtime = resolveRuntime();
  return buildRuntimePolicy(runtime, {
    previewPaymentsEnabled: resolvePreviewPaymentsEnabled(),
    livePaymentsEnabled: resolveLivePaymentsEnabled(runtime),
  });
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
    if (mode === "live") return policy.livePaymentsEnabled;
    if (!policy.previewPaymentsEnabled) return false;
    return mode === "test" || mode === "sandbox";
  }

  if (mode === "live") return policy.livePaymentsEnabled;
  return mode === "test" || mode === "sandbox";
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
  return policy.isProdLike || policy.livePaymentsEnabled ? "live" : "sandbox";
};

const resolveRazorpayMode = (keyId = "") => {
  if (!keyId) return "missing";
  if (keyId.startsWith("rzp_live_")) return "live";
  if (keyId.startsWith("rzp_test_")) return "test";
  return "unknown";
};

const resolvePaymentProviders = (options = {}) => {
  const runtimePolicy = resolvePaymentRuntimePolicy();
  const market = resolveMarket({
    hostname: options.hostname || options.host || "",
    env: options.env || process.env,
  });

  const razorpayKeyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const razorpayKeySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const razorpayMode = resolveRazorpayMode(razorpayKeyId);
  const allowIndiaRazorpay =
    market.id !== "india" ||
    isTruthyEnv(process.env.ENABLE_RAZORPAY_INDIA_CHECKOUT);
  const marketAllowsRazorpay =
    market.razorpayEnabled || (market.id === "india" && allowIndiaRazorpay);
  const razorpayEnabled =
    marketAllowsRazorpay &&
    allowIndiaRazorpay &&
    !!razorpayKeyId &&
    !!razorpayKeySecret &&
    allowProviderModeInRuntime(razorpayMode, runtimePolicy);

  const paypalClientId = String(
    process.env.PAYPAL_CLIENT_ID ||
      process.env.REACT_APP_PAYPAL_CLIENT_ID ||
      process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
      ""
  ).trim();
  const paypalClientSecret = String(
    process.env.PAYPAL_CLIENT_SECRET || process.env.REACT_APP_PAYPAL_CLIENT_SECRET || ""
  ).trim();
  const paypalMode = resolvePayPalMode(runtimePolicy);
  const paypalEnabled =
    market.paypalEnabled &&
    !!paypalClientId &&
    !!paypalClientSecret &&
    allowProviderModeInRuntime(paypalMode, runtimePolicy);

  const payuKey = String(process.env.PAYU_KEY || process.env.PAYU_MERCHANT_KEY || "").trim();
  const payuSalt = String(process.env.PAYU_SALT || process.env.PAYU_MERCHANT_SALT || "").trim();
  const payuMode = String(process.env.PAYU_ENV || "").trim().toLowerCase() === "test"
    ? "test"
    : "live";
  const payuEnabled =
    market.payuEnabled &&
    !!payuKey &&
    !!payuSalt &&
    allowProviderModeInRuntime(payuMode, runtimePolicy);

  return {
    market: {
      id: market.id,
      label: market.label,
      currency: market.currency,
      siteUrl: market.siteUrl,
    },
    runtime: runtimePolicy.runtime,
    previewPaymentsEnabled: runtimePolicy.previewPaymentsEnabled,
    livePaymentsEnabled: runtimePolicy.livePaymentsEnabled,
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
    payu: {
      enabled: payuEnabled,
      mode: payuKey && payuSalt ? payuMode : "missing",
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
  isTruthyEnv,
  normalizeRuntimePolicy,
  resolveIsProdLike,
  resolveLivePaymentsEnabled,
  resolvePayPalMode,
  resolvePaymentProviders,
  resolvePaymentRuntimePolicy,
  resolvePreviewPaymentsEnabled,
  resolveRazorpayMode,
  resolveRuntime,
  resolveServerPaymentSessionsEnabled,
};
