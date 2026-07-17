const loadProviderClients = () => {
  jest.resetModules();
  return require("../server/api/payment/providerClients.js");
};

const response = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const buildPayPalOrder = ({ captureStatus = "COMPLETED", capture = true } = {}) => ({
  id: "paypal_order_status_check",
  status: "COMPLETED",
  payer: {
    email_address: "customer@example.invalid",
    payer_id: "payer_status_check",
  },
  purchase_units: [
    {
      amount: { value: "54.95", currency_code: "USD" },
      payments: {
        captures: capture
          ? [
              {
                id: "paypal_capture_status_check",
                status: captureStatus,
                amount: { value: "54.95", currency_code: "USD" },
              },
            ]
          : [],
      },
    },
  ],
});

const mockPayPalLookup = (details) => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(response({ access_token: "paypal_access_token" }))
    .mockResolvedValueOnce(response(details));
};

describe("PayPal capture settlement verification", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VERCEL_ENV;
    process.env.PAYPAL_ENV = "sandbox";
    process.env.PAYPAL_CLIENT_ID = "paypal_client";
    process.env.PAYPAL_CLIENT_SECRET = "paypal_secret";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PAYPAL_ENV;
    delete process.env.PAYPAL_CLIENT_ID;
    delete process.env.PAYPAL_CLIENT_SECRET;
  });

  test.each(["PENDING", "DECLINED"])(
    "does not verify an order whose capture is %s",
    async (captureStatus) => {
      mockPayPalLookup(buildPayPalOrder({ captureStatus }));
      const { verifyPayPalOrder } = loadProviderClients();

      await expect(
        verifyPayPalOrder({
          orderId: "paypal_order_status_check",
          expectedAmount: 54.95,
          expectedCurrency: "USD",
        })
      ).resolves.toEqual({
        ok: false,
        captured: true,
        reason: `paypal_capture_status_${captureStatus.toLowerCase()}`,
      });
    }
  );

  test("parks an unsettled capture during provider inspection", async () => {
    const details = buildPayPalOrder({ captureStatus: "PENDING" });
    mockPayPalLookup(details);
    const { inspectPayPalOrder } = loadProviderClients();

    await expect(
      inspectPayPalOrder({ orderId: "paypal_order_status_check" })
    ).resolves.toMatchObject({
      state: "pending",
      reason: "paypal_capture_status_pending",
      providerOrderId: "paypal_order_status_check",
      providerPaymentId: "paypal_capture_status_check",
      details,
    });
  });

  test("requires a capture object even when the order is completed", async () => {
    mockPayPalLookup(buildPayPalOrder({ capture: false }));
    const { verifyPayPalOrder } = loadProviderClients();

    await expect(
      verifyPayPalOrder({
        orderId: "paypal_order_status_check",
        expectedAmount: 54.95,
        expectedCurrency: "USD",
      })
    ).resolves.toEqual({ ok: false, reason: "paypal_capture_missing" });
  });

  test("verifies a completed capture using the capture amount", async () => {
    mockPayPalLookup(buildPayPalOrder());
    const { verifyPayPalOrder } = loadProviderClients();

    await expect(
      verifyPayPalOrder({
        orderId: "paypal_order_status_check",
        expectedAmount: 54.95,
        expectedCurrency: "USD",
      })
    ).resolves.toEqual({
      ok: true,
      payerEmail: "customer@example.invalid",
      payerId: "payer_status_check",
      providerPaymentId: "paypal_capture_status_check",
    });
  });
});
