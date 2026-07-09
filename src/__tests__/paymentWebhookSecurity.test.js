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
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
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

  test("creates PayPal orders with a stable provider idempotency header", async () => {
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
        json: async () => ({ id: "paypal_order_1" }),
      });

    const { createPayPalOrder } = loadProviderClients();
    await expect(
      createPayPalOrder({
        amount: 84.99,
        currency: "USD",
        requestId: "roo_stable_session_key",
      })
    ).resolves.toMatchObject({ orderId: "paypal_order_1" });

    expect(global.fetch.mock.calls[1][1].headers).toMatchObject({
      "PayPal-Request-Id": "roo_stable_session_key",
    });
  });

  test("recovers an ambiguous Razorpay create by its stable receipt", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "razorpay_secret";
    const recoveredOrder = {
      id: "order_recovered",
      amount: 8499,
      currency: "USD",
      receipt: "roo_stable_receipt",
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      })
      .mockRejectedValueOnce(new Error("connection reset after upstream accepted"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [recoveredOrder] }),
      });

    const { createRazorpayOrder } = loadProviderClients();
    await expect(
      createRazorpayOrder({
        amount: 84.99,
        currency: "USD",
        receipt: "roo_stable_receipt",
      })
    ).resolves.toMatchObject({
      orderId: "order_recovered",
      receipt: "roo_stable_receipt",
    });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({
      amount: 8499,
      currency: "USD",
      receipt: "roo_stable_receipt",
    });
  });

  test("lookup-only Razorpay retries never POST and recover when the ambiguous receipt appears", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "razorpay_secret";
    const recoveredOrder = {
      id: "order_eventually_visible",
      amount: 8499,
      currency: "USD",
      receipt: "roo_ambiguous_receipt",
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      })
      .mockRejectedValueOnce(new Error("connection reset after upstream accepted"))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [recoveredOrder] }),
      });

    const { createRazorpayOrder } = loadProviderClients();
    const orderInput = {
      amount: 84.99,
      currency: "USD",
      receipt: "roo_ambiguous_receipt",
    };

    await expect(createRazorpayOrder(orderInput)).rejects.toThrow(
      "connection reset after upstream accepted"
    );
    await expect(
      createRazorpayOrder({ ...orderInput, lookupOnly: true })
    ).rejects.toMatchObject({
      status: 503,
      code: "razorpay_receipt_lookup_failed_503",
    });

    expect(
      global.fetch.mock.calls.filter(([, options]) => options?.method === "POST")
    ).toHaveLength(1);

    await expect(
      createRazorpayOrder({ ...orderInput, lookupOnly: true })
    ).resolves.toMatchObject({
      orderId: "order_eventually_visible",
      receipt: "roo_ambiguous_receipt",
    });

    expect(
      global.fetch.mock.calls.filter(([, options]) => options?.method === "POST")
    ).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });
});
