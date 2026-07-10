/** @jest-environment node */

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

  beforeEach(() => {
    process.env.SANITY_PROJECT_ID = "test-project";
    process.env.SANITY_DATASET = "test-dataset";
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
});
