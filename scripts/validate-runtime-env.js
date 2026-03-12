require("dotenv").config({ path: ".env.local" });

const vercelEnv = (process.env.VERCEL_ENV || "").trim().toLowerCase();
const hasExplicitVercelEnv = vercelEnv.length > 0;
const isCi = String(process.env.CI || "").toLowerCase() === "true";
const isVercelBuild = Boolean(process.env.VERCEL) || hasExplicitVercelEnv;
const nextPhase = String(process.env.NEXT_PHASE || "").trim().toLowerCase();
const isNextProductionBuild = nextPhase === "phase-production-build";
const forceStrict =
  String(process.env.VALIDATE_RUNTIME_ENV_STRICT || "").toLowerCase() === "1" ||
  String(process.env.REQUIRE_RUNTIME_SECRETS || "").toLowerCase() === "1";

const isProdBuild = hasExplicitVercelEnv
  ? vercelEnv === "production"
  : String(process.env.NODE_ENV || "").toLowerCase() === "production";
const isPreviewBuild = vercelEnv === "preview";
const previewPaymentsEnabled = ["1", "true", "yes", "on"].includes(
  String(
    process.env.ENABLE_PREVIEW_PAYMENTS ||
      process.env.ALLOW_PREVIEW_PAYMENTS ||
      ""
  )
    .trim()
    .toLowerCase()
);

const shouldFailClosed =
  missing => missing.length > 0 && isProdBuild && (isCi || isVercelBuild || isNextProductionBuild || forceStrict);

const hasAny = (keys = []) => keys.some((key) => !!process.env[key]);
const getFirstValue = (keys = []) => {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
};

const sessionSecretKeys = ["REF_SESSION_SECRET", "SESSION_SECRET", "JWT_SECRET"];
const holdTokenSecretKeys = ["HOLD_TOKEN_SECRET", ...sessionSecretKeys];
const adminKeyKeys = ["REF_ADMIN_KEY", "REFERRAL_ADMIN_KEY", "CRON_SECRET"];
const webhookSecretKeys = ["SANITY_WEBHOOK_SECRET", "CRON_SECRET"];
const paypalClientIdKeys = [
  "PAYPAL_CLIENT_ID",
  "REACT_APP_PAYPAL_CLIENT_ID",
  "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
];
const paypalClientSecretKeys = [
  "PAYPAL_CLIENT_SECRET",
  "REACT_APP_PAYPAL_CLIENT_SECRET",
];

const requiredChecks = [
  {
    keys: ["SANITY_PROJECT_ID"],
    label: "SANITY_PROJECT_ID",
  },
  {
    keys: ["SANITY_DATASET"],
    label: "SANITY_DATASET",
  },
  {
    keys: ["SANITY_WRITE_TOKEN"],
    label: "SANITY_WRITE_TOKEN",
  },
  {
    keys: sessionSecretKeys,
    label: "REF_SESSION_SECRET (or SESSION_SECRET/JWT_SECRET fallback)",
  },
  {
    keys: holdTokenSecretKeys,
    label: "HOLD_TOKEN_SECRET (or REF_SESSION_SECRET/SESSION_SECRET/JWT_SECRET fallback)",
  },
  {
    keys: adminKeyKeys,
    label: "REF_ADMIN_KEY / REFERRAL_ADMIN_KEY (or CRON_SECRET fallback)",
  },
  {
    keys: ["CRON_SECRET"],
    label: "CRON_SECRET",
  },
  {
    keys: webhookSecretKeys,
    label: "SANITY_WEBHOOK_SECRET (or CRON_SECRET fallback)",
  },
];

const missing = requiredChecks
  .filter((check) => !hasAny(check.keys))
  .map((check) => check.label);

const razorpayKeyId = getFirstValue(["RAZORPAY_KEY_ID"]);
const razorpayKeySecret = getFirstValue(["RAZORPAY_KEY_SECRET"]);
const paypalClientId = getFirstValue(paypalClientIdKeys);
const paypalClientSecret = getFirstValue(paypalClientSecretKeys);
const explicitPayPalEnv = String(
  process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
)
  .trim()
  .toLowerCase();

const providerConsistencyFailures = [];
const providerConsistencyWarnings = [];

if (!!razorpayKeyId !== !!razorpayKeySecret) {
  providerConsistencyFailures.push(
    "Razorpay must be fully configured with both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
  );
}

if (!!paypalClientId !== !!paypalClientSecret) {
  providerConsistencyFailures.push(
    "PayPal must be fully configured with both PAYPAL_CLIENT_ID (or public fallback) and PAYPAL_CLIENT_SECRET."
  );
}

if (!razorpayKeyId && !razorpayKeySecret) {
  providerConsistencyWarnings.push(
    "Razorpay keys are not configured. Razorpay payments will stay disabled."
  );
}

if (!paypalClientId && !paypalClientSecret) {
  providerConsistencyWarnings.push(
    "PayPal credentials are not configured. PayPal payments will stay disabled."
  );
}

if (
  isPreviewBuild &&
  (razorpayKeyId || razorpayKeySecret || paypalClientId || paypalClientSecret)
) {
  if (!previewPaymentsEnabled) {
    providerConsistencyWarnings.push(
      "Preview build detected: payment providers stay disabled by default. Set ENABLE_PREVIEW_PAYMENTS=1 only when you intentionally want sandbox/test checkout on preview."
    );
  } else {
    if (razorpayKeyId.startsWith("rzp_live_")) {
      providerConsistencyWarnings.push(
        "Preview build detected: live Razorpay keys will be ignored. Use test keys for preview payments."
      );
    }

    if (explicitPayPalEnv === "live" || explicitPayPalEnv === "production") {
      providerConsistencyWarnings.push(
        "Preview build detected: PayPal live mode will be ignored. Use sandbox mode for preview payments."
      );
    }
  }
}

if (missing.length === 0) {
  console.log("[env] Runtime secret validation passed.");
} else if (shouldFailClosed(missing)) {
  console.error(
    `[env] Production build blocked: missing required runtime secrets:\n- ${missing.join(
      "\n- "
    )}`
  );
  process.exit(1);
} else {
  console.warn(
    `[env] Local/non-release build: missing runtime secrets:\n- ${missing.join(
      "\n- "
    )}`
  );
}

if (providerConsistencyFailures.length > 0) {
  const rendered = providerConsistencyFailures.join("\n- ");
  if (shouldFailClosed(providerConsistencyFailures)) {
    console.error(`[env] Production build blocked:\n- ${rendered}`);
    process.exit(1);
  }

  console.warn(`[env] Local/non-release build warning:\n- ${rendered}`);
}

if (providerConsistencyWarnings.length > 0) {
  console.warn(`[env] ${providerConsistencyWarnings.join("\n[env] ")}`);
}
process.exit(0);
