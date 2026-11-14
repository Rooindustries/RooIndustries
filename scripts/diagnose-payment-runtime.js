require("dotenv").config({ path: ".env.local", quiet: true });

const {
  resolvePaymentProviders,
  resolvePaymentRuntimePolicy,
} = require("../src/server/api/payment/providerConfig.js");
const {
  readProcessEnvValue: env,
  readFirstProcessEnvValue: firstEnv,
} = require("../src/server/supabase/envValue.cjs");

const runtimePolicy = resolvePaymentRuntimePolicy();
const providers = resolvePaymentProviders();
const explicitPayPalEnv = firstEnv("PAYPAL_ENV", "NEXT_PUBLIC_PAYPAL_ENV").toLowerCase();

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    runtime: runtimePolicy.runtime,
    previewPaymentsEnabled: runtimePolicy.previewPaymentsEnabled === true,
    livePaymentsEnabled: runtimePolicy.livePaymentsEnabled === true,
    explicitPayPalEnv: explicitPayPalEnv || "default",
    allowLivePaymentsInDevelopment: env("ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT") !== "",
    allowLivePaymentsInPreview: env("ALLOW_LIVE_PAYMENTS_IN_PREVIEW") !== "",
  },
  providers: {
    dodo: {
      enabled: providers?.dodo?.enabled === true,
      mode: providers?.dodo?.mode || "missing",
      credentialsPresent: !!env("DODO_PAYMENTS_API_KEY"),
      webhookKeyPresent: !!env("DODO_PAYMENTS_WEBHOOK_KEY"),
    },
    razorpay: {
      enabled: providers?.razorpay?.enabled === true,
      mode: providers?.razorpay?.mode || "unknown",
      credentialsPresent: !!env("RAZORPAY_KEY_ID") && !!env("RAZORPAY_KEY_SECRET"),
    },
    paypal: {
      enabled: providers?.paypal?.enabled === true,
      mode: providers?.paypal?.mode || "unknown",
      credentialsPresent:
        !!firstEnv("PAYPAL_CLIENT_ID", "REACT_APP_PAYPAL_CLIENT_ID", "NEXT_PUBLIC_PAYPAL_CLIENT_ID") &&
        !!env("PAYPAL_CLIENT_SECRET"),
    },
  },
  notes: [
    "This report is redacted. It only shows runtime policy, modes, and credential presence.",
    "PayPal client credential type cannot be inferred from the client ID alone.",
  ],
};

console.log(JSON.stringify(report, null, 2));
