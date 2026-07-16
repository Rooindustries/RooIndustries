/** @jest-environment node */

import { spawnSync } from "node:child_process";
import migrationTargetSafety from "../server/supabase/migrationTargetSafety.cjs";

const testPostgresUrl = ({ host, password = "placeholder" }) => {
  const url = new URL(`postgresql://${host}/postgres`);
  url.username = "postgres";
  url.password = password;
  return url.toString();
};

const {
  assertTourneyCutoverDiscordTarget,
  assertTourneyCutoverLegacyTarget,
  assertTourneyCutoverSanityTarget,
  assertTourneyCutoverSupabaseApiTarget,
  assertTourneyCutoverSupabaseDatabaseTarget,
  computeTourneyCutoverDiscordTargetFingerprint,
  computeLegacyMigrationTargetFingerprint,
  computeMigrationTargetFingerprints,
  computeTourneyCutoverLegacyTargetFingerprint,
  computeTourneyCutoverSanityTargetFingerprint,
  computeTourneyCutoverSupabaseApiTargetFingerprint,
  computeTourneyCutoverSupabaseDatabaseTargetFingerprint,
} = migrationTargetSafety;

const validReleaseEnv = () => ({
  ...process.env,
  CI: "true",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  NODE_ENV: "production",
  SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
  SUPABASE_SECRET_KEY: "s".repeat(40),
  SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
  SUPABASE_CUTOVER_ENABLED: "1",
  COMMERCE_CUTOVER_ENABLED: "1",
  COMMERCE_FAILOVER_GENERATION: "1",
  SUPABASE_CONTENT_CANARY_PERCENT: "0",
  SUPABASE_COMMERCE_CANARY_PERCENT: "0",
  SANITY_PROJECT_ID: "project",
  SANITY_DATASET: "production",
  SANITY_WRITE_TOKEN: "write-token-placeholder",
  SANITY_READ_TOKEN: "read-token-placeholder",
  SANITY_API_VERSION: "2023-10-01",
  SANITY_PRIVATE_PROJECT_ID: "",
  SANITY_PRIVATE_DATASET: "",
  SANITY_PRIVATE_WRITE_TOKEN: "",
  SANITY_PRIVATE_READ_TOKEN: "",
  SANITY_PRIVATE_API_VERSION: "",
  REF_SESSION_SECRET: "ref-session-secret-placeholder",
  PAYMENT_SESSION_SECRET: "payment-session-secret-placeholder",
  HOLD_TOKEN_SECRET: "hold-token-secret-placeholder",
  BOOKING_EMAIL_TOKEN_SECRET: "booking-email-token-secret-placeholder",
  UPGRADE_INTENT_SECRET: "upgrade-intent-secret-placeholder",
  DOWNLOAD_TOKEN_SECRET: "download-token-secret-placeholder",
  DOWNLOAD_CATALOG_JSON: "",
  DOWNLOAD_STORAGE_BACKEND: "",
  BLOB_READ_WRITE_TOKEN: "",
  BLOB_STORE_ID: "",
  VERCEL_OIDC_TOKEN: "",
  REF_ADMIN_KEY: "ref-admin-secret-placeholder",
  CRON_SECRET: "cron-secret-placeholder",
  SANITY_WEBHOOK_SECRET: "sanity-webhook-secret-placeholder",
  RAZORPAY_WEBHOOK_SECRET: "razorpay-webhook-secret-placeholder-123456",
  RATE_LIMIT_HASH_SECRET: "rate-limit-secret-placeholder",
  TOURNEY_SESSION_SECRET: "tourney-session-secret-placeholder",
  TOURNEY_DATABASE_URL: "postgresql://placeholder.invalid/test",
  RESEND_API_KEY: "resend-placeholder",
  FROM_EMAIL: "Roo Industries <test@example.com>",
  RAZORPAY_KEY_ID: "",
  RAZORPAY_KEY_SECRET: "",
  PAYPAL_CLIENT_ID: "",
  REACT_APP_PAYPAL_CLIENT_ID: "",
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: "",
  PAYPAL_CLIENT_SECRET: "",
  PAYPAL_ENV: "",
  NEXT_PUBLIC_PAYPAL_ENV: "",
  PAYMENT_LEGACY_COMPLETION_UNTIL: "2000-01-01T00:00:00.000Z",
  PAYMENT_LEGACY_CHECKOUT_UNTIL: "2000-01-01T00:00:00.000Z",
  PAYMENT_LEGACY_STATUS_GET_UNTIL: "2000-01-01T00:00:00.000Z",
  LEGACY_UPGRADE_GET_UNTIL: "2000-01-01T00:00:00.000Z",
  TOURNEY_DATABASE_MODE: "legacy",
  TOURNEY_MIRROR_ENABLED: "0",
  TOURNEY_WRITES_PAUSED: "0",
  CMS_WRITES_PAUSED: "0",
  SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
  TOURNEY_FAILOVER_GENERATION: "0",
  TOURNEY_HARDENING_V4_ENABLED: "0",
  TOURNEY_V4_ACTIVATION_ENABLED: "0",
  SUPABASE_MIGRATION_ENDPOINT_ENABLED: "0",
  SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "",
  SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT: "",
  SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT: "",
  SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "0",
  TOURNEY_PREVIEW_DATABASE_URL: "",
  SUPABASE_PREVIEW_DATABASE_URL: "",
  SUPABASE_PREVIEW_URL: "",
  SUPABASE_PREVIEW_SECRET_KEY: "",
  SUPABASE_PREVIEW_SERVICE_ROLE_KEY: "",
});

const validUtilitiesCatalog = (patch = {}) => JSON.stringify([
  {
    slug: "utilities",
    fileName: "utilities.zip",
    blobPath: "downloads/utilities.zip",
    storageBackend: "blob",
    sizeBytes: 3_692_474_026,
    sha256: "5".repeat(64),
    blobEtag: '"verified-blob-etag"',
    ...patch,
  },
]);

const validate = (overrides = {}) => {
  const result = spawnSync(process.execPath, ["scripts/validate-runtime-env.js"], {
    cwd: process.cwd(),
    env: { ...validReleaseEnv(), ...overrides },
    encoding: "utf8",
  });
  return {
    ...result,
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
};

const supabaseTourneyEnv = {
  TOURNEY_DATABASE_MODE: "supabase",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_DATABASE_URL:
    "postgresql://legacy_owner:placeholder@legacy.example.com/tourney?sslmode=require",
  SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
  SUPABASE_SECRET_KEY: "s".repeat(40),
  SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
  SUPABASE_DATABASE_URL:
    "postgresql://postgres.ntezmxzaibrrsgtujgxu:placeholder@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require",
  SUPABASE_SOCIAL_AUTH_ENABLED: "1",
  NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED: "1",
  SUPABASE_MANUAL_LINKING_ENABLED: "1",
  SUPABASE_GOOGLE_OAUTH_ENABLED: "1",
  SUPABASE_DISCORD_OAUTH_ENABLED: "1",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_GUILD_ID: "111111111111111111",
  DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
  DISCORD_HOST_ROLE_ID: "333333333333333333",
};

const supabaseDocumentEnv = {
  SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
  SUPABASE_SECRET_KEY: "s".repeat(40),
  SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
};

const absentSanityEnv = {
  SANITY_PROJECT_ID: "",
  SANITY_DATASET: "",
  SANITY_READ_TOKEN: "",
  SANITY_WRITE_TOKEN: "",
  SANITY_API_VERSION: "",
  SANITY_PRIVATE_PROJECT_ID: "",
  SANITY_PRIVATE_DATASET: "",
  SANITY_PRIVATE_READ_TOKEN: "",
  SANITY_PRIVATE_WRITE_TOKEN: "",
  SANITY_PRIVATE_API_VERSION: "",
  SANITY_WEBHOOK_SECRET: "",
};

const previewMigrationEnv = (overrides = {}) => {
  const selected = {
    DATA_PRIMARY_BACKEND: "sanity",
    COMMERCE_PRIMARY_BACKEND: "sanity",
    SUPABASE_MIGRATION_ENDPOINT_ENABLED: "1",
    SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "preview",
    TOURNEY_PREVIEW_DATABASE_URL:
      "postgresql://preview_owner:placeholder@preview-legacy.example.com/tourney",
    SUPABASE_PREVIEW_DATABASE_URL:
      "postgresql://postgres.previewproject:placeholder@preview.pooler.supabase.com:6543/postgres",
    SUPABASE_PREVIEW_URL: "https://previewproject.supabase.co",
    SUPABASE_PREVIEW_SECRET_KEY: "preview-secret-placeholder-1234567890",
    ...overrides,
  };
  const fingerprints = computeMigrationTargetFingerprints({
    ...validReleaseEnv(),
    ...selected,
  });
  return {
    ...selected,
    SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT: fingerprints.legacy,
    SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT: fingerprints.supabase,
  };
};

describe("release runtime environment validation", () => {
  test("accepts a complete preview environment without provider keys", () => {
    const result = validate();
    expect(result.status).toBe(0);
    expect(result.output).toContain("Runtime secret validation passed");
  });

  test("defaults both selectors to Supabase with no Sanity configuration", () => {
    const result = validate({
      ...absentSanityEnv,
      DATA_PRIMARY_BACKEND: "",
      COMMERCE_PRIMARY_BACKEND: "",
      COMMERCE_FAILOVER_GENERATION: "1",
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain("SANITY_");
  });

  test("rejects generation zero when the legacy Sanity read target is absent", () => {
    const result = validate({
      ...absentSanityEnv,
      DATA_PRIMARY_BACKEND: "",
      COMMERCE_PRIMARY_BACKEND: "",
      COMMERCE_FAILOVER_GENERATION: "0",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "COMMERCE_FAILOVER_GENERATION=0 requires a complete legacy Sanity read target"
    );
  });

  test.each([
    "SUPABASE_CONTENT_CANARY_PERCENT",
    "SUPABASE_COMMERCE_CANARY_PERCENT",
  ])("rejects retired nonzero %s", (variable) => {
    const result = validate({ [variable]: "1" });

    expect(result.status).toBe(1);
    expect(result.output).toContain(variable);
    expect(result.output).toContain("Delete");
  });

  test.each([
    [
      "Sanity globally and for commerce",
      {
        DATA_PRIMARY_BACKEND: "sanity",
        COMMERCE_PRIMARY_BACKEND: "sanity",
      },
    ],
    [
      "Sanity globally with Supabase commerce",
      {
        ...supabaseDocumentEnv,
        DATA_PRIMARY_BACKEND: "sanity",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
      },
    ],
    [
      "Supabase globally with Sanity commerce",
      {
        ...supabaseDocumentEnv,
        DATA_PRIMARY_BACKEND: "supabase",
        COMMERCE_PRIMARY_BACKEND: "sanity",
        SUPABASE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
      },
    ],
    [
      "Supabase globally and for commerce",
      {
        ...supabaseDocumentEnv,
        DATA_PRIMARY_BACKEND: "supabase",
        COMMERCE_PRIMARY_BACKEND: "supabase",
        SUPABASE_CUTOVER_ENABLED: "1",
        COMMERCE_CUTOVER_ENABLED: "1",
        SANITY_REVERSE_MIRROR_WRITES: "1",
      },
    ],
  ])("accepts the %s backend matrix", (_label, backendEnv) => {
    const result = validate({
      VERCEL_ENV: "production",
      DOWNLOAD_STORAGE_BACKEND: "local",
      ...backendEnv,
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain("Commerce-only cutover");
  });

  test.each([
    ["writes enabled", "0"],
    ["rollback pause enabled", "1"],
  ])("accepts matching CMS controls with %s", (_label, value) => {
    const result = validate({
      CMS_WRITES_PAUSED: value,
      SANITY_STUDIO_CMS_WRITES_PAUSED: value,
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain(
      `apiPaused=${value === "1"}, studioConfigured=true, studioPaused=${
        value === "1"
      }, matches=true`,
    );
  });

  test("rejects mismatched CMS API and Studio pause controls", () => {
    const result = validate({
      CMS_WRITES_PAUSED: "1",
      SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "CMS_WRITES_PAUSED and SANITY_STUDIO_CMS_WRITES_PAUSED must match",
    );
  });

  test.each([
    ["CMS_WRITES_PAUSED", { CMS_WRITES_PAUSED: "" }],
    [
      "SANITY_STUDIO_CMS_WRITES_PAUSED",
      { SANITY_STUDIO_CMS_WRITES_PAUSED: "sometimes" },
    ],
  ])("rejects an invalid %s control", (key, override) => {
    const result = validate(override);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      `${key} must be an explicit boolean value`,
    );
  });

  test("does not require Sanity read or webhook credentials for full Supabase", () => {
    const result = validate({
      ...supabaseDocumentEnv,
      VERCEL_ENV: "production",
      DOWNLOAD_STORAGE_BACKEND: "local",
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_READ_TOKEN: "",
      SANITY_PRIVATE_READ_TOKEN: "",
      SANITY_WEBHOOK_SECRET: "",
    });

    expect(result.status).toBe(0);
    expect(result.output).not.toContain("SANITY_READ_TOKEN");
    expect(result.output).not.toContain("SANITY_WEBHOOK_SECRET");
  });

  test("accepts the private Sanity rollback target for full Supabase", () => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_PROJECT_ID: "",
      SANITY_DATASET: "",
      SANITY_WRITE_TOKEN: "",
      SANITY_READ_TOKEN: "",
      SANITY_WEBHOOK_SECRET: "",
      SANITY_PRIVATE_PROJECT_ID: "private-project",
      SANITY_PRIVATE_DATASET: "private-dataset",
      SANITY_PRIVATE_WRITE_TOKEN: "private-write-token",
    });

    expect(result.status).toBe(0);
  });

  test("rejects a partial private Sanity target instead of mixing public fields", () => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_PRIVATE_PROJECT_ID: "private-project",
      SANITY_PRIVATE_DATASET: "",
      SANITY_PRIVATE_WRITE_TOKEN: "",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("Sanity configuration is incomplete");
    expect(result.output).toContain("SANITY_PRIVATE_DATASET");
    expect(result.output).toContain("SANITY_PRIVATE_WRITE_TOKEN");
  });

  test.each([
    ["SANITY_PROJECT_ID", { SANITY_PROJECT_ID: "", SANITY_PRIVATE_PROJECT_ID: "" }],
    ["SANITY_DATASET", { SANITY_DATASET: "", SANITY_PRIVATE_DATASET: "" }],
    ["SANITY_WRITE_TOKEN", { SANITY_WRITE_TOKEN: "", SANITY_PRIVATE_WRITE_TOKEN: "" }],
  ])("rejects a partial Sanity backup missing %s", (label, missingTarget) => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_READ_TOKEN: "",
      SANITY_WEBHOOK_SECRET: "",
      ...missingTarget,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(label);
  });

  test("requires a writable Sanity target and webhook while commerce uses Sanity", () => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "sanity",
      SUPABASE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      SANITY_READ_TOKEN: "",
      SANITY_WEBHOOK_SECRET: "",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("SANITY_WEBHOOK_SECRET");
  });

  test("accepts Supabase-primary when the retired mirror flag is absent", () => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "",
    });

    expect(result.status).toBe(0);
  });

  test.each([
    ["SUPABASE_CUTOVER_ENABLED", { SUPABASE_CUTOVER_ENABLED: "" }],
    ["COMMERCE_CUTOVER_ENABLED", { COMMERCE_CUTOVER_ENABLED: "" }],
  ])("rejects full Supabase without %s", (gate, disabledGate) => {
    const result = validate({
      ...supabaseDocumentEnv,
      DATA_PRIMARY_BACKEND: "supabase",
      COMMERCE_PRIMARY_BACKEND: "supabase",
      SUPABASE_CUTOVER_ENABLED: "1",
      COMMERCE_CUTOVER_ENABLED: "1",
      SANITY_REVERSE_MIRROR_WRITES: "1",
      ...disabledGate,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(gate);
  });

  test("accepts a production Blob download with a fully pinned utilities catalog", () => {
    const result = validate({
      VERCEL_ENV: "production",
      BLOB_READ_WRITE_TOKEN: "blob-token-placeholder",
      DOWNLOAD_CATALOG_JSON: validUtilitiesCatalog(),
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain("Runtime secret validation passed");
  });

  test.each([
    ["missing", "", "require DOWNLOAD_CATALOG_JSON"],
    ["malformed", "{not-json", "must contain valid JSON"],
    [
      "without utilities",
      JSON.stringify([{ slug: "other" }]),
      "exactly one utilities entry",
    ],
    [
      "with an invalid utilities path",
      validUtilitiesCatalog({ blobPath: "downloads/other.zip" }),
      "invalid fileName or blobPath",
    ],
  ])(
    "blocks production Blob downloads when the catalog is %s",
    (_case, catalog, error) => {
      const result = validate({
        VERCEL_ENV: "production",
        BLOB_READ_WRITE_TOKEN: "blob-token-placeholder",
        DOWNLOAD_CATALOG_JSON: catalog,
      });

      expect(result.status).toBe(1);
      expect(result.output).toContain(error);
    }
  );

  test.each([
    ["sizeBytes", { sizeBytes: 0 }],
    ["sha256", { sha256: "not-a-sha" }],
    ["blobEtag", { blobEtag: "" }],
  ])(
    "blocks a production utilities catalog without a valid %s pin",
    (pin, patch) => {
      const result = validate({
        VERCEL_ENV: "production",
        BLOB_READ_WRITE_TOKEN: "blob-token-placeholder",
        DOWNLOAD_CATALOG_JSON: validUtilitiesCatalog(patch),
      });

      expect(result.status).toBe(1);
      expect(result.output).toContain(`valid ${pin}`);
    }
  );

  test("treats an explicit production Blob backend as configured without a local token", () => {
    const result = validate({
      VERCEL_ENV: "production",
      DOWNLOAD_STORAGE_BACKEND: "blob",
      DOWNLOAD_CATALOG_JSON: "",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("require DOWNLOAD_CATALOG_JSON");
  });

  test.each([
    [
      "preview",
      { VERCEL_ENV: "preview", BLOB_READ_WRITE_TOKEN: "blob-token-placeholder" },
    ],
    [
      "local storage",
      { VERCEL_ENV: "production", DOWNLOAD_STORAGE_BACKEND: "local" },
    ],
  ])("preserves %s builds without a utilities catalog", (_case, environment) => {
    const result = validate({
      ...environment,
      DOWNLOAD_CATALOG_JSON: "",
    });

    expect(result.status).toBe(0);
  });

  test("requires a dedicated Sanity webhook secret", () => {
    const result = validate({
      COMMERCE_PRIMARY_BACKEND: "sanity",
      SANITY_WEBHOOK_SECRET: "   ",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("SANITY_WEBHOOK_SECRET");
    expect(result.output).not.toContain("cron-secret-placeholder");
  });

  test("does not allow CRON_SECRET to replace the admin key", () => {
    const result = validate({ REF_ADMIN_KEY: "", REFERRAL_ADMIN_KEY: "  " });
    expect(result.status).toBe(1);
    expect(result.output).toContain("REF_ADMIN_KEY");
    expect(result.output).not.toContain("cron-secret-placeholder");
  });

  test("does not accept the retired referral admin-key alias", () => {
    const result = validate({
      REF_ADMIN_KEY: "",
      REFERRAL_ADMIN_KEY: "retired-admin-key-must-not-count",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("REF_ADMIN_KEY");
    expect(result.output).not.toContain("retired-admin-key-must-not-count");
  });

  test("does not accept public-prefixed aliases for server secrets", () => {
    const result = validate({
      DATA_PRIMARY_BACKEND: "sanity",
      COMMERCE_PRIMARY_BACKEND: "sanity",
      SANITY_WRITE_TOKEN: "",
      REACT_APP_SANITY_WRITE_TOKEN: "public-prefixed-token-must-not-count",
      PAYPAL_CLIENT_ID: "public-client-id",
      PAYPAL_CLIENT_SECRET: "",
      REACT_APP_PAYPAL_CLIENT_SECRET: "public-prefixed-secret-must-not-count",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("SANITY_WRITE_TOKEN");
    expect(result.output).not.toContain("public-prefixed-token-must-not-count");
    expect(result.output).not.toContain("public-prefixed-secret-must-not-count");
  });

  test("does not accept a public-prefixed PayPal server secret", () => {
    const result = validate({
      PAYPAL_CLIENT_ID: "public-client-id",
      PAYPAL_CLIENT_SECRET: "",
      REACT_APP_PAYPAL_CLIENT_SECRET: "public-prefixed-secret-must-not-count",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("PayPal must be fully configured");
    expect(result.output).not.toContain("public-prefixed-secret-must-not-count");
  });

  test("rejects compatibility deadlines that can stay open indefinitely", () => {
    const result = validate({
      PAYMENT_LEGACY_COMPLETION_UNTIL: "2099-01-01T00:00:00.000Z",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "PAYMENT_LEGACY_COMPLETION_UNTIL exceeds its allowed compatibility window"
    );
  });

  test("rejects a legacy Neon URL masquerading as the Supabase database", () => {
    const result = validate({
      TOURNEY_DATABASE_MODE: "supabase",
      SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
      SUPABASE_SECRET_KEY: "s".repeat(40),
      SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
      SUPABASE_DATABASE_URL: "postgresql://owner:secret@ep-example.neon.tech/neondb",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "SUPABASE_DATABASE_URL must connect to the configured Supabase project"
    );
    expect(result.output).not.toContain("ep-example.neon.tech");
  });

  test("accepts configured Supabase primary with its required legacy mirror", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_DATABASE_URL:
        "postgresql://owner:placeholder@ep-example.neon.tech/neondb?sslmode=require",
    });
    expect(result.status).toBe(0);
  });

  test("blocks Supabase Tourney releases when social Auth is hidden", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      SUPABASE_SOCIAL_AUTH_ENABLED: "0",
      NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED: "0",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "Supabase Tourney mode requires Google and Discord social Auth to remain enabled"
    );
  });

  test("requires confirmed providers, manual linking, and both managed Discord roles", () => {
    const socialEnv = {
      SUPABASE_SOCIAL_AUTH_ENABLED: "1",
      NEXT_PUBLIC_SUPABASE_SOCIAL_AUTH_ENABLED: "1",
      SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
      SUPABASE_SECRET_KEY: "s".repeat(40),
      SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
      SUPABASE_MANUAL_LINKING_ENABLED: "0",
      SUPABASE_GOOGLE_OAUTH_ENABLED: "1",
      SUPABASE_DISCORD_OAUTH_ENABLED: "1",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "111111111111111111",
      DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
      DISCORD_HOST_ROLE_ID: "",
    };
    const result = validate(socialEnv);

    expect(result.status).toBe(1);
    expect(result.output).toContain("DISCORD_HOST_ROLE_ID");

    const linkingResult = validate({
      ...socialEnv,
      DISCORD_HOST_ROLE_ID: "333333333333333333",
    });
    expect(linkingResult.status).toBe(1);
    expect(linkingResult.output).toContain("confirmed manual identity linking");
  });

  test("accepts a hardened post-activation release without a staging marker", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "1",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "111111111111111111",
      DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
      DISCORD_HOST_ROLE_ID: "333333333333333333",
    });

    expect(result.status).toBe(0);
  });

  test("rejects an invalid activation intent marker", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "enabled",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "TOURNEY_V4_ACTIVATION_ENABLED must be an explicit boolean value"
    );
  });

  test("rejects an activation-staged tuple when its explicit marker is missing", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "The activation-ready v4 control tuple requires TOURNEY_V4_ACTIVATION_ENABLED=1"
    );
  });

  test("does not classify legacy generation-zero maintenance as activation", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_DATABASE_MODE: "legacy",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "0",
      TOURNEY_HARDENING_V4_ENABLED: "0",
    });

    expect(result.status).toBe(0);
  });

  test.each([
    ["Supabase primary", { TOURNEY_DATABASE_MODE: "legacy" }],
    ["mirroring", { TOURNEY_MIRROR_ENABLED: "0" }],
    ["paused writes", { TOURNEY_WRITES_PAUSED: "0" }],
    ["generation one", { TOURNEY_FAILOVER_GENERATION: "2" }],
    ["canonical generation one", { TOURNEY_FAILOVER_GENERATION: "01" }],
    ["v4 hardening remains disabled", { TOURNEY_HARDENING_V4_ENABLED: "1" }],
  ])("requires %s for an activation-staged release", (_control, override) => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "1",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "111111111111111111",
      DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
      DISCORD_HOST_ROLE_ID: "333333333333333333",
      ...override,
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "Supabase primary, mirroring enabled, writes paused, failover generation 1"
    );
  });

  test("requires Discord inventory credentials for an activation release", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "1",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
      DISCORD_BOT_TOKEN: "",
      DISCORD_GUILD_ID: "",
      DISCORD_PARTICIPANT_ROLE_ID: "",
      DISCORD_HOST_ROLE_ID: "",
    });

    expect(result.status).toBe(1);
    for (const key of [
      "DISCORD_BOT_TOKEN",
      "DISCORD_GUILD_ID",
      "DISCORD_PARTICIPANT_ROLE_ID",
      "DISCORD_HOST_ROLE_ID",
    ]) {
      expect(result.output).toContain(key);
    }
  });

  test("requires valid distinct Discord inventory role ids for activation", () => {
    const result = validate({
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "1",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "not-a-snowflake",
      DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
      DISCORD_HOST_ROLE_ID: "222222222222222222",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain("valid numeric snowflakes");
    expect(result.output).toContain("must use different role ids");
  });

  test("accepts the exact activation tuple and keeps post-activation releases valid", () => {
    const activationEnv = {
      ...supabaseTourneyEnv,
      TOURNEY_V4_ACTIVATION_ENABLED: "1",
      TOURNEY_WRITES_PAUSED: "1",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: "0",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "111111111111111111",
      DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
      DISCORD_HOST_ROLE_ID: "333333333333333333",
    };
    expect(validate(activationEnv).status).toBe(0);
    expect(validate({
      ...supabaseTourneyEnv,
      TOURNEY_HARDENING_V4_ENABLED: "1",
      TOURNEY_WRITES_PAUSED: "0",
      TOURNEY_FAILOVER_GENERATION: "1",
    }).status).toBe(0);
  });

  test("includes the Supabase project reference in custom-auth fingerprints", () => {
    const target = {
      SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "preview",
      TOURNEY_PREVIEW_DATABASE_URL:
        "postgresql://legacy:placeholder@preview-legacy.example.com/tourney",
      SUPABASE_PREVIEW_URL: "https://authenticate.preview.example.com",
    };
    const first = computeMigrationTargetFingerprints({
      ...target,
      SUPABASE_PREVIEW_DATABASE_URL:
        "postgresql://postgres.projectone:placeholder@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    });
    const second = computeMigrationTargetFingerprints({
      ...target,
      SUPABASE_PREVIEW_DATABASE_URL:
        "postgresql://postgres.projecttwo:placeholder@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    });

    expect(first.supabase).not.toBe(second.supabase);
  });

  test("computes stable credential-free legacy target fingerprints", () => {
    const first = computeLegacyMigrationTargetFingerprint(
      "postgresql://first:secret@legacy.example.com:5432/tourney"
    );
    const sameTarget = computeLegacyMigrationTargetFingerprint(
      "postgresql://first:different@legacy.example.com/tourney"
    );
    const differentUser = computeLegacyMigrationTargetFingerprint(
      "postgresql://second:secret@legacy.example.com/tourney"
    );
    const differentTarget = computeLegacyMigrationTargetFingerprint(
      "postgresql://first:secret@legacy.example.com:5432/tourney_other"
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sameTarget).toBe(first);
    expect(differentUser).toBe(first);
    expect(differentTarget).not.toBe(first);
    const cutoverFingerprint = computeTourneyCutoverLegacyTargetFingerprint(
      "postgresql://first:secret@legacy.example.com/tourney"
    );
    expect(computeTourneyCutoverLegacyTargetFingerprint(
      "postgresql://second:secret@legacy.example.com/tourney"
    )).not.toBe(cutoverFingerprint);
    expect(assertTourneyCutoverLegacyTarget({
      databaseUrl: "postgresql://first:new@legacy.example.com/tourney",
      expectedFingerprint: cutoverFingerprint,
    })).toEqual({
      fingerprint: cutoverFingerprint,
      database: "tourney",
      username: "first",
    });
    expect(() => assertTourneyCutoverLegacyTarget({
      databaseUrl: "postgresql://first:secret@legacy.example.com/tourney_other",
      expectedFingerprint: cutoverFingerprint,
    })).toThrow("Migration target configuration is invalid.");
    expect(() => assertTourneyCutoverLegacyTarget({
      databaseUrl: "postgresql://postgres:secret@db.project.supabase.co/postgres",
      expectedFingerprint: computeTourneyCutoverLegacyTargetFingerprint(
        "postgresql://postgres:secret@db.project.supabase.co/postgres"
      ),
    })).toThrow("Migration target configuration is invalid.");
    expect(() => assertTourneyCutoverLegacyTarget({
      databaseUrl: "postgresql://postgres:secret@db.project.supabase.co./postgres",
      expectedFingerprint: computeTourneyCutoverLegacyTargetFingerprint(
        "postgresql://postgres:secret@db.project.supabase.co./postgres"
      ),
    })).toThrow("Migration target configuration is invalid.");
    const apiUrl = "https://ntezmxzaibrrsgtujgxu.supabase.co";
    const apiFingerprint = computeTourneyCutoverSupabaseApiTargetFingerprint(apiUrl);
    expect(assertTourneyCutoverSupabaseApiTarget({
      supabaseUrl: apiUrl,
      expectedFingerprint: apiFingerprint,
    })).toEqual({
      fingerprint: apiFingerprint,
      hostname: "ntezmxzaibrrsgtujgxu.supabase.co",
      port: "443",
      pathname: "/",
    });
    expect(() => assertTourneyCutoverSupabaseApiTarget({
      supabaseUrl: "https://wrong.supabase.co",
      expectedFingerprint: apiFingerprint,
    })).toThrow("Migration target configuration is invalid.");
    const sanityTarget = { projectId: "roo-project", dataset: "production" };
    const sanityFingerprint = computeTourneyCutoverSanityTargetFingerprint(sanityTarget);
    expect(assertTourneyCutoverSanityTarget({
      projectId: "ROO-PROJECT",
      dataset: "production",
      expectedFingerprint: sanityFingerprint,
    })).toEqual({ fingerprint: sanityFingerprint, ...sanityTarget });
    expect(() => assertTourneyCutoverSanityTarget({
      ...sanityTarget,
      expectedFingerprint: "",
    })).toThrow("Migration target configuration is invalid.");
    expect(() => assertTourneyCutoverSanityTarget({
      projectId: "another-project",
      dataset: "production",
      expectedFingerprint: sanityFingerprint,
    })).toThrow("Migration target configuration is invalid.");
    expect(() => assertTourneyCutoverSanityTarget({
      projectId: "roo-project",
      dataset: "staging",
      expectedFingerprint: sanityFingerprint,
    })).toThrow("Migration target configuration is invalid.");
    const databaseApiUrl = "https://projectref.supabase.co";
    const databaseTarget = {
      databaseUrl: testPostgresUrl({ host: "db.projectref.supabase.co" }),
      supabaseUrl: databaseApiUrl,
    };
    const databaseFingerprint =
      computeTourneyCutoverSupabaseDatabaseTargetFingerprint(databaseTarget);
    expect(assertTourneyCutoverSupabaseDatabaseTarget({
      ...databaseTarget,
      databaseUrl: testPostgresUrl({
        host: "db.projectref.supabase.co",
        password: "replacement",
      }),
      expectedFingerprint: databaseFingerprint,
    })).toMatchObject({
      fingerprint: databaseFingerprint,
      projectRef: "projectref",
      database: "postgres",
      username: "postgres",
    });
    expect(() => assertTourneyCutoverSupabaseDatabaseTarget({
      databaseUrl: testPostgresUrl({ host: "db.wrongproject.supabase.co" }),
      supabaseUrl: databaseApiUrl,
      expectedFingerprint: databaseFingerprint,
    })).toThrow("Migration target configuration is invalid.");
    const discordTarget = {
      apiBaseUrl: "https://discord.com/api/v10",
      guildId: "111111111111111111",
      participantRoleId: "222222222222222222",
      hostRoleId: "333333333333333333",
    };
    const discordFingerprint = computeTourneyCutoverDiscordTargetFingerprint(discordTarget);
    expect(assertTourneyCutoverDiscordTarget({
      ...discordTarget,
      expectedFingerprint: discordFingerprint,
    })).toEqual({ fingerprint: discordFingerprint, ...discordTarget });
    for (const apiBaseUrl of [
      "https://wrong.example/api/v10",
      "https://discord.com:444/api/v10",
    ]) {
      expect(() => assertTourneyCutoverDiscordTarget({
        ...discordTarget,
        apiBaseUrl,
        expectedFingerprint: discordFingerprint,
      })).toThrow("Migration target configuration is invalid.");
    }
  });

  test("requires explicit fingerprints for preview migration targets", () => {
    const missingTargets = validate({
      SUPABASE_MIGRATION_ENDPOINT_ENABLED: "1",
    });
    expect(missingTargets.status).toBe(1);
    expect(missingTargets.output).toContain(
      "SUPABASE_MIGRATION_TARGET_ENVIRONMENT must be preview or production"
    );

    const configured = validate(previewMigrationEnv());
    expect(configured.status).toBe(0);
    expect(validate(previewMigrationEnv({
      SUPABASE_PREVIEW_SECRET_KEY: "   ",
      SUPABASE_PREVIEW_SERVICE_ROLE_KEY: "preview-service-role-placeholder-1234567890",
    })).status).toBe(0);
  });

  test("requires a separate flag for inherited preview targets", () => {
    const configured = previewMigrationEnv();
    const inherited = {
      ...configured,
      TOURNEY_DATABASE_URL: configured.TOURNEY_PREVIEW_DATABASE_URL.replace(
        "preview_owner",
        "generic_role"
      ),
      SUPABASE_DATABASE_URL: configured.SUPABASE_PREVIEW_DATABASE_URL.replace(
        "postgres.previewproject",
        "generic.previewproject"
      ),
      SUPABASE_URL: configured.SUPABASE_PREVIEW_URL,
    };
    const result = validate(inherited);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "Preview migration targets that match inherited generic targets require SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1"
    );
    expect(result.output).not.toContain("preview-secret-placeholder");
    const allowed = validate({
      ...inherited,
      SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "1",
    });
    expect(allowed.status).toBe(0);
  });

  test("detects inherited targets through whitespace-only primary variables", () => {
    const configured = previewMigrationEnv();
    const result = validate({
      ...configured,
      TOURNEY_DATABASE_URL: "   ",
      POSTGRES_URL: configured.TOURNEY_PREVIEW_DATABASE_URL.replace(
        "preview_owner",
        "generic_role"
      ),
      SUPABASE_DATABASE_URL: "not-a-postgres-url",
      SUPABASE_URL: "   ",
      NEXT_PUBLIC_SUPABASE_URL: "https://unrelated.example.com",
    });

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1"
    );
  });

  test("requires a separate flag for intentional production mutations", () => {
    const productionTargets = {
      DATA_PRIMARY_BACKEND: "sanity",
      COMMERCE_PRIMARY_BACKEND: "sanity",
      SUPABASE_MIGRATION_ENDPOINT_ENABLED: "1",
      SUPABASE_MIGRATION_TARGET_ENVIRONMENT: "production",
      TOURNEY_DATABASE_URL:
        "postgresql://prod_owner:placeholder@prod-legacy.example.com/tourney",
      SUPABASE_DATABASE_URL:
        "postgresql://postgres.prodproject:placeholder@prod.pooler.supabase.com:6543/postgres",
      SUPABASE_URL: "https://prodproject.supabase.co",
      SUPABASE_SECRET_KEY: "production-secret-placeholder-1234567890",
    };
    const fingerprints = computeMigrationTargetFingerprints({
      ...validReleaseEnv(),
      ...productionTargets,
    });
    const configured = {
      ...productionTargets,
      SUPABASE_MIGRATION_EXPECTED_LEGACY_FINGERPRINT: fingerprints.legacy,
      SUPABASE_MIGRATION_EXPECTED_SUPABASE_FINGERPRINT: fingerprints.supabase,
    };

    const blocked = validate(configured);
    expect(blocked.status).toBe(1);
    expect(blocked.output).toContain(
      "SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS=1"
    );
    const allowed = validate({
      ...configured,
      SUPABASE_MIGRATION_ALLOW_PRODUCTION_MUTATIONS: "1",
    });
    expect(allowed.status).toBe(0);
  });
});
