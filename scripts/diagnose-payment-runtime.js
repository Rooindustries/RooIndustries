require("dotenv").config({ path: ".env.local" });

const {
  resolvePaymentProviders,
  resolvePaymentRuntimePolicy,
} = require("../src/server/api/payment/providerConfig.js");

const runtimePolicy = resolvePaymentRuntimePolicy();
const providers = resolvePaymentProviders();
const explicitPayPalEnv = String(
  process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
)
  .trim()
  .toLowerCase();

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    runtime: runtimePolicy.runtime,
    previewPaymentsEnabled: runtimePolicy.previewPaymentsEnabled === true,
    livePaymentsEnabled: runtimePolicy.livePaymentsEnabled === true,
    explicitPayPalEnv: explicitPayPalEnv || "default",
    allowLivePaymentsInDevelopment:
      String(process.env.ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT || "").trim() !== "",
    allowLivePaymentsInPreview:
      String(process.env.ALLOW_LIVE_PAYMENTS_IN_PREVIEW || "").trim() !== "",
  },
  providers: {
    razorpay: {
      enabled: providers?.razorpay?.enabled === true,
      mode: providers?.razorpay?.mode || "unknown",
      credentialsPresent:
        !!String(process.env.RAZORPAY_KEY_ID || "").trim() &&
        !!String(process.env.RAZORPAY_KEY_SECRET || "").trim(),
    },
    paypal: {
      enabled: providers?.paypal?.enabled === true,
      mode: providers?.paypal?.mode || "unknown",
      credentialsPresent:
        !!String(
          process.env.PAYPAL_CLIENT_ID ||
            process.env.REACT_APP_PAYPAL_CLIENT_ID ||
            process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ||
            ""
        ).trim() &&
        !!String(
          process.env.PAYPAL_CLIENT_SECRET || process.env.REACT_APP_PAYPAL_CLIENT_SECRET || ""
        ).trim(),
    },
  },
  notes: [
    "This report is redacted. It only shows runtime policy, modes, and credential presence.",
    "PayPal client credential type cannot be inferred from the client ID alone.",
  ],
};

console.log(JSON.stringify(report, null, 2));
