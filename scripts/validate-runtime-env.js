const vercelEnv = (process.env.VERCEL_ENV || "").trim().toLowerCase();
const hasExplicitVercelEnv = vercelEnv.length > 0;

// Vercel previews typically run with NODE_ENV=production.
// Only hard-block when VERCEL_ENV explicitly says production.
const isProdBuild = hasExplicitVercelEnv
  ? vercelEnv === "production"
  : process.env.NODE_ENV === "production" && process.env.CI === "true";

const hasAny = (keys = []) => keys.some((key) => !!process.env[key]);

const sessionSecretKeys = ["REF_SESSION_SECRET", "SESSION_SECRET", "JWT_SECRET"];
const holdTokenSecretKeys = ["HOLD_TOKEN_SECRET", ...sessionSecretKeys];
const adminKeyKeys = ["REF_ADMIN_KEY", "REFERRAL_ADMIN_KEY", "CRON_SECRET"];
const webhookSecretKeys = ["SANITY_WEBHOOK_SECRET", "CRON_SECRET"];

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
  {
    keys: ["RAZORPAY_KEY_SECRET"],
    label: "RAZORPAY_KEY_SECRET",
  },
];

const optionalChecks = [
  {
    keys: ["PAYPAL_CLIENT_ID", "REACT_APP_PAYPAL_CLIENT_ID"],
    label: "PAYPAL_CLIENT_ID (or REACT_APP_PAYPAL_CLIENT_ID fallback)",
  },
  {
    keys: ["PAYPAL_CLIENT_SECRET"],
    label: "PAYPAL_CLIENT_SECRET",
  },
];

const missing = requiredChecks
  .filter((check) => !hasAny(check.keys))
  .map((check) => check.label);

if (missing.length === 0) {
  console.log("[env] Runtime secret validation passed.");
} else if (!isProdBuild) {
  console.warn(
    `[env] Non-production build: missing optional runtime secrets:\n- ${missing.join(
      "\n- "
    )}`
  );
} else {
  console.error(
    `[env] Production build blocked: missing required runtime secrets:\n- ${missing.join(
      "\n- "
    )}`
  );
  process.exit(1);
}

const missingOptional = optionalChecks
  .filter((check) => !hasAny(check.keys))
  .map((check) => check.label);

if (missingOptional.length > 0) {
  console.warn(
    `[env] Optional runtime payment secrets not set:\n- ${missingOptional.join(
      "\n- "
    )}\nSome payment-provider verification paths may be unavailable.`
  );
}
process.exit(0);
