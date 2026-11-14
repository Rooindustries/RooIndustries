import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  fixtureMail,
  postPayPalCaptureWebhook,
  recordPayPalCalls,
  sandboxOrigin,
  startPayPalCheckout,
  sweepRoot,
  withEnv,
} from "./payment-sweep-ads-fixtures.mjs";

const paddedPayPal = {
  PAYPAL_ENV: "sandbox\\n ",
  PAYPAL_WEBHOOK_ID: " fixture-webhook\\n",
  PAYPAL_CLIENT_ID: "fixture-client\\n",
  PAYPAL_CLIENT_SECRET: "fixture-secret\\n",
};
const releaseSecret = "x".repeat(40);
const pastCutoff = "2000-01-01T00:00:00.000Z";
const productionRelease = {
  CI: "true",
  VERCEL: "1",
  VERCEL_ENV: "production",
  NODE_ENV: "production",
  SUPABASE_URL: "https://ntezmxzaibrrsgtujgxu.supabase.co",
  SUPABASE_SECRET_KEY: "s".repeat(40),
  SUPABASE_PUBLISHABLE_KEY: "p".repeat(24),
  SUPABASE_CUTOVER_ENABLED: "1",
  COMMERCE_CUTOVER_ENABLED: "1",
  COMMERCE_FAILOVER_GENERATION: "1",
  COMMERCE_FAILOVER_LEASE: `eyJ2ZXJzaW9uIjoxfQ.${"a".repeat(43)}`,
  COMMERCE_FAILOVER_LEASE_SECRET: releaseSecret,
  COMMERCE_DEPLOYMENT_ID: "runtime-env-scenario",
  SUPABASE_CONTENT_CANARY_PERCENT: "0",
  SUPABASE_COMMERCE_CANARY_PERCENT: "0",
  ...Object.fromEntries([
    "REF_SESSION_SECRET", "PAYMENT_SESSION_SECRET", "HOLD_TOKEN_SECRET", "BOOKING_EMAIL_TOKEN_SECRET",
    "UPGRADE_INTENT_SECRET", "DOWNLOAD_TOKEN_SECRET", "REF_ADMIN_KEY", "CRON_SECRET", "RAZORPAY_WEBHOOK_SECRET",
    "RATE_LIMIT_HASH_SECRET",
  ].map((key) => [key, releaseSecret])),
  RESEND_API_KEY: "re_fixture",
  FROM_EMAIL: "Roo Industries <noreply@example.invalid>",
  PAYMENT_LEGACY_COMPLETION_UNTIL: pastCutoff,
  PAYMENT_LEGACY_CHECKOUT_UNTIL: pastCutoff,
  PAYMENT_LEGACY_STATUS_GET_UNTIL: pastCutoff,
  LEGACY_UPGRADE_GET_UNTIL: pastCutoff,
  CMS_WRITES_PAUSED: "0",
  SANITY_STUDIO_CMS_WRITES_PAUSED: "0",
  DOWNLOAD_STORAGE_BACKEND: "supabase",
  DOWNLOAD_CATALOG_JSON: JSON.stringify([{
    slug: "utilities",
    fileName: "utilities.zip",
    blobPath: "downloads/utilities.zip",
    storageBackend: "supabase",
    storageBucket: "optimization-builds-private",
    sizeBytes: 3_692_474_026,
    sha256: "5".repeat(64),
    blobEtag: '"verified-blob-etag"',
  }]),
};

const runValidateRuntimeEnv = (values) => {
  const result = spawnSync(process.execPath, ["scripts/validate-runtime-env.js"], {
    cwd: sweepRoot,
    env: { PATH: process.env.PATH, ...values },
    encoding: "utf8",
    timeout: 60_000,
  });
  const runtimeLine = String(result.stdout || "").match(/^\[env\] Payment runtime: .*$/m)?.[0] || "";
  return { status: result.status, runtimeLine, stderr: String(result.stderr || "").slice(-2000) };
};

export async function registerEnvScenarios(ctx) {
  await ctx.run("ads-env-paypal-padded-webhook", async () => {
    const { result, calls } = await withEnv({ ...paddedPayPal, ...fixtureMail }, () => recordPayPalCalls(async () => {
      const started = await startPayPalCheckout(ctx);
      assert.equal(started.status, 200, JSON.stringify(started));
      const bookingsBefore = await ctx.sql`select legacy_sanity_id from commerce.bookings`;
      return { started, bookingsBefore, webhook: await postPayPalCaptureWebhook(ctx) };
    }));
    assert.equal(result.webhook.status, 200, JSON.stringify(result.webhook));
    assert.equal(result.bookingsBefore.length, 0);
    const token = calls.find((call) => call.url.pathname === "/v1/oauth2/token");
    const verify = calls.find((call) => call.url.pathname === "/v1/notifications/verify-webhook-signature");
    const callUrls = JSON.stringify(calls.map((call) => call.url.href));
    assert.ok(token && verify, callUrls);
    assert.ok(calls.every((call) => call.url.origin === sandboxOrigin), callUrls);
    assert.equal(token.authorization, `Basic ${Buffer.from("fixture-client:fixture-secret").toString("base64")}`);
    const verifyBody = JSON.parse(verify.body);
    assert.equal(verifyBody.webhook_id, "fixture-webhook");
    assert.equal(verifyBody.webhook_event.resource.id, "capture-fixture");
    const order = calls.find((call) => call.url.pathname === "/v2/checkout/orders");
    const paymentId = JSON.parse(order.body).purchase_units[0].custom_id;
    const payment = (await ctx.row(paymentId)).payload;
    assert.equal(payment.status, "booked", JSON.stringify(payment));
    assert.ok(payment.bookingId, JSON.stringify(payment));
    const [booking] = await ctx.sql`
      select b.legacy_sanity_id, b.status from commerce.bookings b
      join commerce.payment_records p on p.id = b.payment_record_id
      where p.legacy_sanity_id = ${payment._id} and b.legacy_sanity_id = ${payment.bookingId}`;
    assert.ok(booking, `No booking row is linked to ${payment._id}`);
    return {
      startStatus: result.started.status,
      webhookStatus: result.webhook.status,
      booking,
      paypalCalls: calls.map((call) => `${call.url.origin}${call.url.pathname}`),
      verifiedWebhookId: verifyBody.webhook_id,
      exactBasicAuth: true,
    };
  });

  await ctx.run("ads-env-runtime-script", async () => {
    const sandbox = runValidateRuntimeEnv(paddedPayPal);
    assert.equal(sandbox.status, 0, JSON.stringify(sandbox));
    assert.match(sandbox.runtimeLine, /paypalEnabled=true, paypalMode=sandbox$/, JSON.stringify(sandbox));
    const sandboxOverLive = runValidateRuntimeEnv({ ...paddedPayPal, ALLOW_LIVE_PAYMENTS_IN_DEVELOPMENT: "1" });
    assert.equal(sandboxOverLive.status, 0, JSON.stringify(sandboxOverLive));
    assert.match(sandboxOverLive.runtimeLine, /livePaymentsEnabled=true,/, JSON.stringify(sandboxOverLive));
    const sandboxOverLiveProof = JSON.stringify(sandboxOverLive);
    assert.match(sandboxOverLive.runtimeLine, /paypalEnabled=true, paypalMode=sandbox$/, sandboxOverLiveProof);
    const live = runValidateRuntimeEnv({ ...productionRelease, ...paddedPayPal, PAYPAL_ENV: "live\\n" });
    assert.equal(live.status, 0, JSON.stringify(live));
    assert.match(live.runtimeLine, /runtime=production,/, JSON.stringify(live));
    assert.match(live.runtimeLine, /paypalEnabled=true, paypalMode=live$/, JSON.stringify(live));
    return { sandbox: sandbox.runtimeLine, sandboxOverLive: sandboxOverLive.runtimeLine, live: live.runtimeLine };
  });
}
