/** @jest-environment node */

import { spawnSync } from "node:child_process";

const validReleaseEnv = () => ({
  ...process.env,
  CI: "true",
  VERCEL: "1",
  VERCEL_ENV: "preview",
  NODE_ENV: "production",
  SANITY_PROJECT_ID: "project",
  SANITY_DATASET: "production",
  SANITY_WRITE_TOKEN: "write-token-placeholder",
  SANITY_READ_TOKEN: "read-token-placeholder",
  REF_SESSION_SECRET: "ref-session-secret-placeholder",
  PAYMENT_SESSION_SECRET: "payment-session-secret-placeholder",
  HOLD_TOKEN_SECRET: "hold-token-secret-placeholder",
  BOOKING_EMAIL_TOKEN_SECRET: "booking-email-token-secret-placeholder",
  UPGRADE_INTENT_SECRET: "upgrade-intent-secret-placeholder",
  DOWNLOAD_TOKEN_SECRET: "download-token-secret-placeholder",
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
});

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

describe("release runtime environment validation", () => {
  test("accepts a complete preview environment without provider keys", () => {
    const result = validate();
    expect(result.status).toBe(0);
    expect(result.output).toContain("Runtime secret validation passed");
  });

  test("requires a dedicated Sanity webhook secret", () => {
    const result = validate({ SANITY_WEBHOOK_SECRET: "   " });
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
      TOURNEY_DATABASE_MODE: "supabase",
      TOURNEY_MIRROR_ENABLED: "1",
      TOURNEY_DATABASE_URL:
        "postgresql://owner:placeholder@ep-example.neon.tech/neondb?sslmode=require",
      SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
      SUPABASE_SECRET_KEY: "s".repeat(40),
      SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
      SUPABASE_DATABASE_URL:
        "postgresql://postgres.ntezmxzaibrrsgtujgxu:placeholder@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
    });
    expect(result.status).toBe(0);
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
});
