import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  fixtureMail,
  postPayPalCaptureWebhook,
  recordProviderCalls,
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
const paddedRazorpay = {
  RAZORPAY_KEY_ID: "rzp_test_fixture\\n ",
  RAZORPAY_KEY_SECRET: " fixture-secret\\n",
  RAZORPAY_WEBHOOK_SECRET: "fixture-webhook-secret \\n",
};
const paddedDodo = {
  DODO_PAYMENTS_ENVIRONMENT: "test_mode\\n ",
  DODO_PAYMENTS_API_KEY: " fixture-dodo\\n",
  DODO_PAYMENTS_WEBHOOK_KEY: `whsec_${Buffer.from("fixture-dodo-secret").toString("base64")}\\n `,
  DODO_PAYMENTS_PRODUCT_ID: "pdt_fixture \\n",
  DODO_PAYMENTS_RETURN_URL: "https://example.invalid/checkout\\n",
};
const paddedBackend = { DATA_PRIMARY_BACKEND: " supabase\\n", COMMERCE_PRIMARY_BACKEND: "supabase\\n " };
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

const assertOneBooking = async (ctx, paymentId) => {
  const payment = (await ctx.row(paymentId)).payload;
  assert.equal(payment.status, "booked", JSON.stringify(payment));
  assert.ok(payment.bookingId, JSON.stringify(payment));
  const bookings = await ctx.sql`
    select b.legacy_sanity_id, b.status from commerce.bookings b
    join commerce.payment_records p on p.id = b.payment_record_id
    where p.legacy_sanity_id = ${payment._id}`;
  assert.equal(bookings.length, 1, JSON.stringify(bookings));
  assert.equal(bookings[0].legacy_sanity_id, payment.bookingId);
  assert.equal(bookings[0].status, "captured");
  return { payment, booking: { ...bookings[0] } };
};

const authorizations = (calls) => [...new Set(calls.map((call) => call.authorization))];

export async function registerEnvScenarios(ctx) {
  await ctx.run("ads-env-razorpay-padded-capture", () => withEnv({
    ...paddedRazorpay, ...paddedBackend, ...fixtureMail,
  }, async () => {
    const { result, calls } = await recordProviderCalls(async () => {
      const checkout = await ctx.a1Start("razorpay");
      const finalized = await ctx.requestFlow("finalize", {
        paymentAccessToken: checkout.started.body.paymentAccessToken,
        body: checkout.proof,
      });
      return { checkout, finalized, webhook: await ctx.a1Hook("razorpay") };
    }, ["razorpay.com"]);
    assert.equal(result.finalized.status, 200, JSON.stringify(result.finalized));
    assert.ok(result.finalized.body.analyticsReceipt, JSON.stringify(result.finalized.body));
    assert.equal(result.webhook.status, 200, JSON.stringify(result.webhook));
    const basic = `Basic ${Buffer.from("rzp_test_fixture:fixture-secret").toString("base64")}`;
    assert.ok(calls.some((call) => call.url.pathname === "/v1/orders"), JSON.stringify(calls));
    assert.deepEqual(authorizations(calls), [basic]);
    const { booking } = await assertOneBooking(ctx, result.checkout.id);
    return {
      finalizeStatus: result.finalized.status,
      webhookStatus: result.webhook.status,
      booking,
      razorpayCalls: calls.map((call) => `${call.url.origin}${call.url.pathname}`),
      exactBasicAuth: true,
    };
  }));

  await ctx.run("ads-env-dodo-padded-webhook", () => withEnv({
    ...paddedDodo, ...paddedBackend, ...fixtureMail,
  }, async () => {
    const { result, calls } = await recordProviderCalls(async () => {
      const checkout = await ctx.a1Start("dodo");
      return { checkout, webhook: await ctx.a1Hook("dodo") };
    }, ["dodopayments.com"]);
    assert.equal(result.webhook.status, 200, JSON.stringify(result.webhook));
    assert.deepEqual(authorizations(calls), ["Bearer fixture-dodo"]);
    const session = calls.find((call) => call.url.pathname === "/checkouts");
    assert.ok(session, JSON.stringify(calls.map((call) => call.url.href)));
    const returnUrl = new URL(JSON.parse(session.body).return_url);
    assert.equal(`${returnUrl.origin}${returnUrl.pathname}`, "https://example.invalid/checkout");
    const { payment, booking } = await assertOneBooking(ctx, result.checkout.id);
    assert.equal(payment.providerPublicData.environment, "test_mode");
    assert.equal(payment.providerPublicData.productId, "pdt_fixture");
    return {
      webhookStatus: result.webhook.status,
      booking,
      dodoCalls: calls.map((call) => `${call.url.origin}${call.url.pathname}`),
      environment: payment.providerPublicData.environment,
      returnUrl: returnUrl.href,
    };
  }));

  await ctx.run("ads-env-paypal-padded-webhook", async () => {
    const { result, calls } = await withEnv({ ...paddedPayPal, ...fixtureMail }, () => recordProviderCalls(async () => {
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
    const { booking } = await assertOneBooking(ctx, JSON.parse(order.body).purchase_units[0].custom_id);
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
    const paddedStore = runValidateRuntimeEnv({ ...paddedPayPal, ...paddedBackend });
    assert.equal(paddedStore.status, 0, JSON.stringify(paddedStore));
    const unsupportedStore = runValidateRuntimeEnv({ ...paddedPayPal, DATA_PRIMARY_BACKEND: "mysql\\n" });
    assert.equal(unsupportedStore.status, 1, JSON.stringify(unsupportedStore));
    const { resolveSupabaseRuntimePolicy } = await import("../../src/server/supabase/runtime.js");
    const runtimePolicy = resolveSupabaseRuntimePolicy(paddedBackend);
    assert.equal(runtimePolicy.primaryBackend, "supabase");
    assert.equal(runtimePolicy.commercePrimaryBackend, "supabase");
    assert.throws(() => resolveSupabaseRuntimePolicy({ DATA_PRIMARY_BACKEND: "mysql\\n" }),
      (error) => error.code === "UNSUPPORTED_STORE_BACKEND");
    return {
      sandbox: sandbox.runtimeLine,
      sandboxOverLive: sandboxOverLive.runtimeLine,
      live: live.runtimeLine,
      paddedStore: { prebuild: paddedStore.status, runtime: runtimePolicy.primaryBackend },
      unsupportedStore: unsupportedStore.status,
    };
  });
}
