const crypto = require("crypto");

const loadProviderClients = () => {
  jest.resetModules();
  return require("../server/api/payment/providerClients.js");
};

const buildRazorpaySignature = ({ rawBody, secret }) =>
  crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

describe("payment webhook security", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.VERCEL_ENV;
    delete process.env.PAYPAL_ENV;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
    delete process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("verifies Razorpay webhook signatures with the configured secret", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_webhook_secret";

    const { verifyRazorpayWebhookSignature } = loadProviderClients();
    const rawBody = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_123" } } },
    });
    const signature = buildRazorpaySignature({
      rawBody,
      secret: process.env.RAZORPAY_WEBHOOK_SECRET,
    });

    expect(
      verifyRazorpayWebhookSignature({
        rawBody,
        signature,
      })
    ).toBe(true);
  });

  test("rejects Razorpay webhook signatures when the signature does not match", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_webhook_secret";

    const { verifyRazorpayWebhookSignature } = loadProviderClients();

    expect(
      verifyRazorpayWebhookSignature({
        rawBody: JSON.stringify({ event: "payment.captured" }),
        signature: "wrong_signature",
      })
    ).toBe(false);
  });

  test("rejects PayPal webhooks when required verification headers are missing", async () => {
    process.env.PAYPAL_WEBHOOK_ID = "webhook_id";
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";

    const { verifyPayPalWebhookSignature } = loadProviderClients();

    await expect(
      verifyPayPalWebhookSignature({
        rawBody: JSON.stringify({ event_type: "PAYMENT.CAPTURE.COMPLETED" }),
        headers: {},
      })
    ).resolves.toEqual({
      ok: false,
      reason: "paypal_webhook_headers_missing",
    });
  });

  test("verifies PayPal webhook signatures through the upstream verification API", async () => {
    process.env.PAYPAL_WEBHOOK_ID = "webhook_id";
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "paypal_access_token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verification_status: "SUCCESS" }),
      });

    const { verifyPayPalWebhookSignature } = loadProviderClients();
    const rawBody = JSON.stringify({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: "capture_1" },
    });
    const headers = {
      "paypal-transmission-id": "transmission_1",
      "paypal-transmission-time": "2026-03-13T09:57:59Z",
      "paypal-transmission-sig": "signature_1",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/test",
      "paypal-auth-algo": "SHA256withRSA",
    };

    await expect(
      verifyPayPalWebhookSignature({
        rawBody,
        headers,
      })
    ).resolves.toEqual({ ok: true });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toContain(
      "/v1/notifications/verify-webhook-signature"
    );
  });

  test("reports invalid PayPal webhook signatures when upstream verification fails", async () => {
    process.env.PAYPAL_WEBHOOK_ID = "webhook_id";
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "paypal_access_token" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ verification_status: "FAILURE" }),
      });

    const { verifyPayPalWebhookSignature } = loadProviderClients();

    await expect(
      verifyPayPalWebhookSignature({
        rawBody: JSON.stringify({
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: { id: "capture_1" },
        }),
        headers: {
          "paypal-transmission-id": "transmission_1",
          "paypal-transmission-time": "2026-03-13T09:57:59Z",
          "paypal-transmission-sig": "signature_1",
          "paypal-cert-url": "https://api-m.sandbox.paypal.com/certs/test",
          "paypal-auth-algo": "SHA256withRSA",
        },
      })
    ).resolves.toEqual({
      ok: false,
      reason: "paypal_webhook_signature_invalid",
    });
  });
});
