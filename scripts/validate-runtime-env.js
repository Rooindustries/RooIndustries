if (!process.env.CI && !process.env.VERCEL) {
  require("dotenv").config({ path: ".env.local" });
}

const {
  resolvePaymentProviders,
  resolvePaymentRuntimePolicy,
} = require("../src/server/api/payment/providerConfig.js");

const vercelEnv = (process.env.VERCEL_ENV || "").trim().toLowerCase();
const hasExplicitVercelEnv = vercelEnv.length > 0;
const isCi = String(process.env.CI || "").toLowerCase() === "true";
const isVercelBuild = Boolean(process.env.VERCEL) || hasExplicitVercelEnv;
const nextPhase = String(process.env.NEXT_PHASE || "").trim().toLowerCase();
const isNextProductionBuild = nextPhase === "phase-production-build";
const forceStrict =
  String(process.env.VALIDATE_RUNTIME_ENV_STRICT || "").toLowerCase() === "1" ||
  String(process.env.REQUIRE_RUNTIME_SECRETS || "").toLowerCase() === "1";
const paymentRuntimePolicy = resolvePaymentRuntimePolicy();
const paymentProviders = resolvePaymentProviders();

const isProdBuild = paymentRuntimePolicy.runtime === "production";
const isPreviewBuild = paymentRuntimePolicy.runtime === "preview";
const isDevelopmentBuild = paymentRuntimePolicy.runtime === "development";
const previewPaymentsEnabled = paymentRuntimePolicy.previewPaymentsEnabled === true;
const livePaymentsEnabled = paymentRuntimePolicy.livePaymentsEnabled === true;

const isReleaseBuild = isProdBuild || isPreviewBuild;
const shouldFailClosed =
  missing => missing.length > 0 && isReleaseBuild && (isCi || isVercelBuild || isNextProductionBuild || forceStrict);

const getFirstValue = (keys = []) => {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
};
const hasAny = (keys = []) => Boolean(getFirstValue(keys));
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const isEnabled = (key) =>
  TRUE_VALUES.has(String(process.env[key] || "").trim().toLowerCase());
const numericPercent = (key) => {
  const parsed = Number(String(process.env[key] || "").trim() || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
};

const sessionSecretKeys = ["REF_SESSION_SECRET"];
const adminKeyKeys = ["REF_ADMIN_KEY"];
const webhookSecretKeys = ["SANITY_WEBHOOK_SECRET"];
const paypalClientIdKeys = [
  "PAYPAL_CLIENT_ID",
  "REACT_APP_PAYPAL_CLIENT_ID",
  "NEXT_PUBLIC_PAYPAL_CLIENT_ID",
];
const paypalClientSecretKeys = [
  "PAYPAL_CLIENT_SECRET",
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
    keys: ["SANITY_READ_TOKEN", "SANITY_PRIVATE_READ_TOKEN"],
    label: "SANITY_READ_TOKEN",
  },
  {
    keys: sessionSecretKeys,
    label: "REF_SESSION_SECRET",
  },
  {
    keys: ["PAYMENT_SESSION_SECRET"],
    label: "PAYMENT_SESSION_SECRET",
  },
  {
    keys: ["HOLD_TOKEN_SECRET"],
    label: "HOLD_TOKEN_SECRET",
  },
  {
    keys: ["BOOKING_EMAIL_TOKEN_SECRET"],
    label: "BOOKING_EMAIL_TOKEN_SECRET",
  },
  {
    keys: ["UPGRADE_INTENT_SECRET"],
    label: "UPGRADE_INTENT_SECRET",
  },
  {
    keys: ["DOWNLOAD_TOKEN_SECRET"],
    label: "DOWNLOAD_TOKEN_SECRET",
  },
  {
    keys: adminKeyKeys,
    label: "REF_ADMIN_KEY",
  },
  {
    keys: ["CRON_SECRET"],
    label: "CRON_SECRET",
  },
  {
    keys: webhookSecretKeys,
    label: "SANITY_WEBHOOK_SECRET",
  },
  {
    keys: ["RAZORPAY_WEBHOOK_SECRET"],
    label: "RAZORPAY_WEBHOOK_SECRET",
  },
  {
    keys: ["RATE_LIMIT_HASH_SECRET"],
    label: "RATE_LIMIT_HASH_SECRET",
  },
  {
    keys: ["TOURNEY_SESSION_SECRET"],
    label: "TOURNEY_SESSION_SECRET",
  },
  {
    keys: ["TOURNEY_DATABASE_URL", "POSTGRES_URL"],
    label: "TOURNEY_DATABASE_URL (or POSTGRES_URL fallback)",
  },
  {
    keys: ["RESEND_API_KEY"],
    label: "RESEND_API_KEY",
  },
  {
    keys: ["FROM_EMAIL"],
    label: "FROM_EMAIL",
  },
  {
    keys: ["PAYMENT_LEGACY_COMPLETION_UNTIL"],
    label: "PAYMENT_LEGACY_COMPLETION_UNTIL",
  },
  {
    keys: ["PAYMENT_LEGACY_CHECKOUT_UNTIL"],
    label: "PAYMENT_LEGACY_CHECKOUT_UNTIL",
  },
  {
    keys: ["PAYMENT_LEGACY_STATUS_GET_UNTIL"],
    label: "PAYMENT_LEGACY_STATUS_GET_UNTIL",
  },
  {
    keys: ["LEGACY_UPGRADE_GET_UNTIL"],
    label: "LEGACY_UPGRADE_GET_UNTIL",
  },
];

const missing = requiredChecks
  .filter((check) => !hasAny(check.keys))
  .map((check) => check.label);

const razorpayKeyId = getFirstValue(["RAZORPAY_KEY_ID"]);
const razorpayKeySecret = getFirstValue(["RAZORPAY_KEY_SECRET"]);
const razorpayWebhookSecret = getFirstValue(["RAZORPAY_WEBHOOK_SECRET"]);
const paypalClientId = getFirstValue(paypalClientIdKeys);
const paypalClientSecret = getFirstValue(paypalClientSecretKeys);
const explicitPayPalEnv = String(
  process.env.PAYPAL_ENV || process.env.NEXT_PUBLIC_PAYPAL_ENV || ""
)
  .trim()
  .toLowerCase();

const providerConsistencyFailures = [];
const providerConsistencyWarnings = [];
const supabaseConsistencyFailures = [];
const compatibilityDeadlines = [
  ["PAYMENT_LEGACY_COMPLETION_UNTIL", 60 * 60 * 1000],
  ["PAYMENT_LEGACY_CHECKOUT_UNTIL", 60 * 60 * 1000],
  ["LEGACY_UPGRADE_GET_UNTIL", 60 * 60 * 1000],
  ["PAYMENT_LEGACY_STATUS_GET_UNTIL", 25 * 60 * 60 * 1000],
];

for (const [key, maximumFutureMs] of compatibilityDeadlines) {
  const raw = String(process.env[key] || "").trim();
  if (!raw) continue;
  const deadline = new Date(raw).getTime();
  if (!Number.isFinite(deadline)) {
    providerConsistencyFailures.push(`${key} must be a valid ISO timestamp.`);
    continue;
  }
  if (deadline - Date.now() > maximumFutureMs) {
    providerConsistencyFailures.push(
      `${key} exceeds its allowed compatibility window.`
    );
  }
}

if (!!razorpayKeyId !== !!razorpayKeySecret) {
  providerConsistencyFailures.push(
    "Razorpay must be fully configured with both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."
  );
}

if ((razorpayKeyId || razorpayKeySecret) && razorpayWebhookSecret.length < 32) {
  providerConsistencyFailures.push(
    "Razorpay requires a nonempty webhook secret of at least 32 characters."
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

if (isDevelopmentBuild && livePaymentsEnabled) {
  providerConsistencyWarnings.push(
    "Development runtime detected: live payment override is enabled. Use this only for emergency debugging."
  );
}

if (isDevelopmentBuild && !livePaymentsEnabled) {
  if (razorpayKeyId.startsWith("rzp_live_")) {
    providerConsistencyWarnings.push(
      "Development runtime detected: live Razorpay keys will stay disabled unless ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT=1."
    );
  }

  if (explicitPayPalEnv === "live" || explicitPayPalEnv === "production") {
    providerConsistencyWarnings.push(
      "Development runtime detected: PayPal live mode will stay disabled unless ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT=1."
    );
  }
}

if (
  isPreviewBuild &&
  (razorpayKeyId || razorpayKeySecret || paypalClientId || paypalClientSecret)
) {
  if (livePaymentsEnabled) {
    providerConsistencyWarnings.push(
      "Preview runtime detected: live payment override is enabled. Use this only for emergency debugging."
    );
  } else if (!previewPaymentsEnabled) {
    providerConsistencyWarnings.push(
      "Preview build detected: payment providers stay disabled by default. Set ENABLE_PREVIEW_PAYMENTS=1 only when you intentionally want sandbox/test checkout on preview."
    );
  }

  if (!livePaymentsEnabled && razorpayKeyId.startsWith("rzp_live_")) {
    providerConsistencyWarnings.push(
      "Preview build detected: live Razorpay keys will stay disabled unless ALLOW_LIVE_PAYMENTS_IN_PREVIEW=1."
    );
  }

  if (
    !livePaymentsEnabled &&
    (explicitPayPalEnv === "live" || explicitPayPalEnv === "production")
  ) {
    providerConsistencyWarnings.push(
      "Preview build detected: PayPal live mode will stay disabled unless ALLOW_LIVE_PAYMENTS_IN_PREVIEW=1."
    );
  }
}

const primaryBackend = getFirstValue(["DATA_PRIMARY_BACKEND"]).toLowerCase() || "sanity";
const commercePrimaryBackend =
  getFirstValue(["COMMERCE_PRIMARY_BACKEND"]).toLowerCase() || primaryBackend;
const tourneyDatabaseMode =
  getFirstValue(["TOURNEY_DATABASE_MODE"]).toLowerCase() || "legacy";
const tourneyMirrorEnabled = isEnabled("TOURNEY_MIRROR_ENABLED");
const tourneyFailoverGeneration =
  getFirstValue(["TOURNEY_FAILOVER_GENERATION"]) || "0";
const contentCanaryPercent = numericPercent("SUPABASE_CONTENT_CANARY_PERCENT");
const commerceCanaryPercent = numericPercent("SUPABASE_COMMERCE_CANARY_PERCENT");
const authCanaryConfigured = Boolean(
  getFirstValue(["SUPABASE_AUTH_CANARY_ACCOUNTS"])
);
const shadowWritesEnabled = isEnabled("SUPABASE_SHADOW_WRITES");
const reverseMirrorEnabled = isEnabled("SANITY_REVERSE_MIRROR_WRITES");
const cutoverEnabled = isEnabled("SUPABASE_CUTOVER_ENABLED");
const commerceCutoverEnabled = isEnabled("COMMERCE_CUTOVER_ENABLED");
const commerceFailoverGeneration =
  getFirstValue(["COMMERCE_FAILOVER_GENERATION"]) || "0";
const licensingEnabled = isEnabled("SUPABASE_LICENSING_ENABLED");
const socialAuthEnabled = isEnabled("SUPABASE_SOCIAL_AUTH_ENABLED");
const publicSocialAuthEnabled = isEnabled(
  "NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED"
);
if (socialAuthEnabled) {
  for (const key of [
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_PARTICIPANT_ROLE_ID",
    "DISCORD_HOST_ROLE_ID",
  ]) {
    if (!hasAny([key])) missing.push(key);
  }
}
const migrationEndpointEnabled = isEnabled(
  "SUPABASE_MIGRATION_ENDPOINT_ENABLED"
);
const anySupabaseRuntimeEnabled =
  primaryBackend === "supabase" ||
  commercePrimaryBackend === "supabase" ||
  tourneyDatabaseMode === "supabase" ||
  contentCanaryPercent > 0 ||
  commerceCanaryPercent > 0 ||
  authCanaryConfigured ||
  shadowWritesEnabled ||
  socialAuthEnabled ||
  licensingEnabled ||
  migrationEndpointEnabled ||
  tourneyMirrorEnabled;
const tourneyNeedsSupabase = tourneyDatabaseMode === "supabase" || tourneyMirrorEnabled;

if (!["sanity", "supabase"].includes(primaryBackend)) {
  supabaseConsistencyFailures.push(
    "DATA_PRIMARY_BACKEND must be sanity or supabase."
  );
}
if (!["sanity", "supabase"].includes(commercePrimaryBackend)) {
  supabaseConsistencyFailures.push(
    "COMMERCE_PRIMARY_BACKEND must be sanity or supabase."
  );
}
if (!/^[0-9]+$/.test(commerceFailoverGeneration)) {
  supabaseConsistencyFailures.push(
    "COMMERCE_FAILOVER_GENERATION must be a non-negative integer."
  );
}
if (!["legacy", "supabase"].includes(tourneyDatabaseMode)) {
  supabaseConsistencyFailures.push(
    "TOURNEY_DATABASE_MODE must be legacy or supabase."
  );
}
if (!/^[0-9]+$/.test(tourneyFailoverGeneration)) {
  supabaseConsistencyFailures.push(
    "TOURNEY_FAILOVER_GENERATION must be a non-negative integer."
  );
}
if (tourneyDatabaseMode === "supabase" && !tourneyMirrorEnabled) {
  supabaseConsistencyFailures.push(
    "Supabase Tourney primary requires TOURNEY_MIRROR_ENABLED=1 while legacy fallback is retained."
  );
}
if (tourneyNeedsSupabase && !hasAny(["SUPABASE_DATABASE_URL"])) {
  missing.push("SUPABASE_DATABASE_URL");
}
if (tourneyMirrorEnabled && !hasAny(["TOURNEY_DATABASE_URL", "POSTGRES_URL"])) {
  missing.push("TOURNEY_DATABASE_URL");
}

if (anySupabaseRuntimeEnabled) {
  const url = getFirstValue(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
  const secret = getFirstValue([
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  const publishable = getFirstValue([
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  ]);
  let validSupabaseUrl = false;
  try {
    const parsed = new URL(url);
    validSupabaseUrl =
      parsed.protocol === "https:" &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      [
        "ntezmxzaibrrsgtujgxu.supabase.co",
        "authenticate.rooindustries.com",
      ].includes(parsed.hostname.toLowerCase());
  } catch {
    validSupabaseUrl = false;
  }
  if (!validSupabaseUrl) {
    supabaseConsistencyFailures.push(
      "Supabase runtime features require the Roo Industries Supabase or custom Auth URL."
    );
  }
  if (secret.length < 32) {
    supabaseConsistencyFailures.push(
      "Supabase runtime features require a nonempty server secret key."
    );
  }
  if (publishable.length < 20) {
    supabaseConsistencyFailures.push(
      "Supabase runtime features require a public publishable key."
    );
  }
}

const discordSnowflake = /^[0-9]{5,30}$/;
const discordGuildId = getFirstValue(["DISCORD_GUILD_ID"]);
const discordParticipantRoleId = getFirstValue(["DISCORD_PARTICIPANT_ROLE_ID"]);
const discordHostRoleId = getFirstValue(["DISCORD_HOST_ROLE_ID"]);
if (
  [discordGuildId, discordParticipantRoleId, discordHostRoleId].some(
    (value) => value && !discordSnowflake.test(value)
  )
) {
  providerConsistencyFailures.push(
    "Discord guild and managed role ids must be valid numeric snowflakes."
  );
}
if (
  discordParticipantRoleId &&
  discordHostRoleId &&
  discordParticipantRoleId === discordHostRoleId
) {
  providerConsistencyFailures.push(
    "Discord Participant and Host roles must use different role ids."
  );
}

if (primaryBackend === "supabase" && !cutoverEnabled) {
  supabaseConsistencyFailures.push(
    "Supabase primary mode requires SUPABASE_CUTOVER_ENABLED=1."
  );
}
if (commercePrimaryBackend === "supabase" && !commerceCutoverEnabled) {
  supabaseConsistencyFailures.push(
    "Supabase commerce primary mode requires COMMERCE_CUTOVER_ENABLED=1."
  );
}
if (commercePrimaryBackend === "supabase" && primaryBackend !== "sanity") {
  supabaseConsistencyFailures.push(
    "Commerce-only cutover requires DATA_PRIMARY_BACKEND=sanity."
  );
}
if (
  (commercePrimaryBackend === "supabase" || commerceCanaryPercent > 0) &&
  !reverseMirrorEnabled
) {
  supabaseConsistencyFailures.push(
    "Supabase commerce writes require SANITY_REVERSE_MIRROR_WRITES=1 during the rollback window."
  );
}
if (commerceCanaryPercent > 0 && !shadowWritesEnabled) {
  supabaseConsistencyFailures.push(
    "Supabase commerce canaries require SUPABASE_SHADOW_WRITES=1."
  );
}
if (
  tourneyDatabaseMode === "supabase" &&
  !hasAny(["SUPABASE_DATABASE_URL"])
) {
  supabaseConsistencyFailures.push(
    "Supabase Tourney mode requires SUPABASE_DATABASE_URL."
  );
}
if (tourneyDatabaseMode === "supabase" && hasAny(["SUPABASE_DATABASE_URL"])) {
  try {
    const databaseUrl = new URL(getFirstValue(["SUPABASE_DATABASE_URL"]));
    const apiUrl = new URL(
      getFirstValue(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"])
    );
    const projectRef = apiUrl.hostname.split(".")[0];
    const isSupabaseHost =
      databaseUrl.hostname === `db.${projectRef}.supabase.co` ||
      databaseUrl.hostname.endsWith(".pooler.supabase.com");
    const identifiesProject =
      databaseUrl.hostname === `db.${projectRef}.supabase.co` ||
      databaseUrl.username.endsWith(`.${projectRef}`);
    if (
      !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
      !isSupabaseHost ||
      !identifiesProject
    ) {
      throw new Error("wrong Supabase project database");
    }
  } catch {
    supabaseConsistencyFailures.push(
      "SUPABASE_DATABASE_URL must connect to the configured Supabase project, not the legacy Tourney database."
    );
  }
}
if (
  licensingEnabled &&
  getFirstValue(["APP_DEVICE_HASH_SECRET"]).length < 32
) {
  supabaseConsistencyFailures.push(
    "Supabase licensing requires APP_DEVICE_HASH_SECRET with at least 32 characters."
  );
}
if (migrationEndpointEnabled && isProdBuild) {
  supabaseConsistencyFailures.push(
    "SUPABASE_MIGRATION_ENDPOINT_ENABLED must remain disabled in production."
  );
}
if (socialAuthEnabled !== publicSocialAuthEnabled) {
  supabaseConsistencyFailures.push(
    "SUPABASE_SOCIAL_AUTH_ENABLED and NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED must match."
  );
}
if (
  socialAuthEnabled &&
  !isEnabled("SUPABASE_MANUAL_LINKING_ENABLED")
) {
  supabaseConsistencyFailures.push(
    "Supabase social Auth requires confirmed manual identity linking."
  );
}
if (
  socialAuthEnabled &&
  (!isEnabled("SUPABASE_GOOGLE_OAUTH_ENABLED") ||
    !isEnabled("SUPABASE_DISCORD_OAUTH_ENABLED"))
) {
  supabaseConsistencyFailures.push(
    "Supabase social Auth requires confirmed Google and Discord providers."
  );
}

if (missing.length === 0) {
  console.log("[env] Runtime secret validation passed.");
} else if (shouldFailClosed(missing)) {
  console.error(
    `[env] Release build blocked: missing required runtime secrets:\n- ${missing.join(
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
    console.error(`[env] Release build blocked:\n- ${rendered}`);
    process.exit(1);
  }

  console.warn(`[env] Local/non-release build warning:\n- ${rendered}`);
}

if (supabaseConsistencyFailures.length > 0) {
  const rendered = supabaseConsistencyFailures.join("\n- ");
  if (shouldFailClosed(supabaseConsistencyFailures)) {
    console.error(`[env] Release build blocked:\n- ${rendered}`);
    process.exit(1);
  }

  console.warn(`[env] Local/non-release build warning:\n- ${rendered}`);
}

if (providerConsistencyWarnings.length > 0) {
  console.warn(`[env] ${providerConsistencyWarnings.join("\n[env] ")}`);
}

console.log(
  `[env] Payment runtime: runtime=${paymentRuntimePolicy.runtime}, previewPaymentsEnabled=${previewPaymentsEnabled}, livePaymentsEnabled=${livePaymentsEnabled}, razorpayEnabled=${paymentProviders.razorpay.enabled}, paypalEnabled=${paymentProviders.paypal.enabled}`
);
process.exit(0);
