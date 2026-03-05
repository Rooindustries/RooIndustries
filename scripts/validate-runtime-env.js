const vercelEnv = (process.env.VERCEL_ENV || "").trim().toLowerCase();
const hasExplicitVercelEnv = vercelEnv.length > 0;

// Vercel previews typically run with NODE_ENV=production.
// Only hard-block when VERCEL_ENV explicitly says production.
const isProdBuild = hasExplicitVercelEnv
  ? vercelEnv === "production"
  : process.env.NODE_ENV === "production" && process.env.CI === "true";

const hasAny = (keys = []) => keys.some((key) => !!process.env[key]);

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
    keys: ["REF_SESSION_SECRET"],
    label: "REF_SESSION_SECRET",
  },
  {
    keys: ["HOLD_TOKEN_SECRET", "REF_SESSION_SECRET"],
    label: "HOLD_TOKEN_SECRET (or REF_SESSION_SECRET fallback)",
  },
  {
    keys: ["REF_ADMIN_KEY", "REFERRAL_ADMIN_KEY"],
    label: "REF_ADMIN_KEY or REFERRAL_ADMIN_KEY",
  },
  {
    keys: ["CRON_SECRET"],
    label: "CRON_SECRET",
  },
  {
    keys: ["SANITY_WEBHOOK_SECRET"],
    label: "SANITY_WEBHOOK_SECRET",
  },
  {
    keys: ["RAZORPAY_KEY_SECRET"],
    label: "RAZORPAY_KEY_SECRET",
  },
  {
    keys: ["PAYPAL_CLIENT_ID"],
    label: "PAYPAL_CLIENT_ID",
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
  process.exit(0);
}

if (!isProdBuild) {
  console.warn(
    `[env] Non-production build: missing optional runtime secrets:\n- ${missing.join(
      "\n- "
    )}`
  );
  process.exit(0);
}

console.error(
  `[env] Production build blocked: missing required runtime secrets:\n- ${missing.join(
    "\n- "
  )}`
);
process.exit(1);
