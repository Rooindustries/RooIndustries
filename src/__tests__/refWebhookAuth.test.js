/** @jest-environment node */

const crypto = require("crypto");

const createResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

describe("referral webhook authentication", () => {
  const previousWebhookSecret = process.env.SANITY_WEBHOOK_SECRET;
  const previousCronSecret = process.env.CRON_SECRET;
  const previousProjectId = process.env.SANITY_PROJECT_ID;
  const previousDataset = process.env.SANITY_DATASET;
  const previousDataPrimary = process.env.DATA_PRIMARY_BACKEND;
  const previousCommercePrimary = process.env.COMMERCE_PRIMARY_BACKEND;

  beforeEach(() => {
    process.env.SANITY_PROJECT_ID = "test-project";
    process.env.SANITY_DATASET = "test-dataset";
    process.env.DATA_PRIMARY_BACKEND = "sanity";
    process.env.COMMERCE_PRIMARY_BACKEND = "sanity";
  });

  afterEach(() => {
    if (previousWebhookSecret === undefined) delete process.env.SANITY_WEBHOOK_SECRET;
    else process.env.SANITY_WEBHOOK_SECRET = previousWebhookSecret;
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCronSecret;
    if (previousProjectId === undefined) delete process.env.SANITY_PROJECT_ID;
    else process.env.SANITY_PROJECT_ID = previousProjectId;
    if (previousDataset === undefined) delete process.env.SANITY_DATASET;
    else process.env.SANITY_DATASET = previousDataset;
    if (previousDataPrimary === undefined) delete process.env.DATA_PRIMARY_BACKEND;
    else process.env.DATA_PRIMARY_BACKEND = previousDataPrimary;
    if (previousCommercePrimary === undefined) {
      delete process.env.COMMERCE_PRIMARY_BACKEND;
    } else {
      process.env.COMMERCE_PRIMARY_BACKEND = previousCommercePrimary;
    }
    jest.resetModules();
  });

  test("does not reuse CRON_SECRET as the webhook signing key", async () => {
    delete process.env.SANITY_WEBHOOK_SECRET;
    process.env.CRON_SECRET = "cron-only-secret";
    const handler = require("../server/api/ref/webhookSync").default;
    const response = createResponse();

    await handler(
      { method: "POST", headers: {}, body: { _id: "referral-1" } },
      response
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      ok: false,
      error: "Access is temporarily unavailable.",
    });
  });

  test("rejects an invalid signature when the dedicated secret exists", async () => {
    process.env.SANITY_WEBHOOK_SECRET = "dedicated-webhook-secret";
    const handler = require("../server/api/ref/webhookSync").default;
    const response = createResponse();

    await handler(
      {
        method: "POST",
        headers: { "sanity-webhook-signature": "invalid" },
        body: { _id: "referral-1" },
      },
      response
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Invalid signature" });
  });

  test("rejects a missing signature under Supabase primary before skipping", async () => {
    process.env.DATA_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.SANITY_WEBHOOK_SECRET = "dedicated-webhook-secret";
    const handler = require("../server/api/ref/webhookSync").default;
    const response = createResponse();

    await handler(
      { method: "POST", headers: {}, body: { _id: "referral-1" } },
      response
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({ ok: false, error: "Invalid signature" });
  });

  test("skips an authenticated Sanity webhook under Supabase primary", async () => {
    process.env.DATA_PRIMARY_BACKEND = "supabase";
    process.env.COMMERCE_PRIMARY_BACKEND = "supabase";
    process.env.SANITY_WEBHOOK_SECRET = "dedicated-webhook-secret";
    const body = { _id: "referral-1" };
    const signature = crypto
      .createHmac("sha256", process.env.SANITY_WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest("hex");
    const handler = require("../server/api/ref/webhookSync").default;
    const response = createResponse();

    await handler(
      {
        method: "POST",
        headers: { "sanity-webhook-signature": signature },
        body,
      },
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      skipped: true,
      reason: "sanity_non_authoritative",
    });
  });
});
