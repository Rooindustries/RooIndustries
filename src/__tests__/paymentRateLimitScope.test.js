const mockRequireRateLimit = jest.fn().mockResolvedValue(false);

jest.mock("../server/api/ref/rateLimit.js", () => ({
  getClientAddress: () => "203.0.113.42",
  requireRateLimit: (...args) => mockRequireRateLimit(...args),
}));
jest.mock("../server/api/payment/flow.js", () => ({
  startPaymentSession: jest.fn(),
}));
jest.mock("../server/api/ref/pricing.js", () => ({
  resolvePaymentQuote: jest.fn(),
}));
jest.mock("../server/api/payment/providerConfig.js", () => ({
  resolvePaymentProviders: jest.fn(),
}));
jest.mock("../server/api/payment/paymentRecord.js", () => ({
  buildQuoteFingerprint: jest.fn(),
}));
jest.mock("../server/api/ref/upgradeIntentToken.js", () => ({
  verifyUpgradeIntentToken: jest.fn(),
}));

const createRes = () => ({
  setHeader: jest.fn(),
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe("payment rate-limit scope", () => {
  beforeEach(() => {
    mockRequireRateLimit.mockClear();
  });

  test("different holds share the same 12-start IP bucket", async () => {
    const module = require("../server/api/payment/start");
    const handler = module.default || module;

    await handler(
      { method: "POST", body: { holdId: "hold-a" }, headers: {} },
      createRes()
    );
    await handler(
      { method: "POST", body: { holdId: "hold-b" }, headers: {} },
      createRes()
    );

    expect(mockRequireRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRequireRateLimit.mock.calls.map(([, options]) => options.key)).toEqual([
      "payment-start:203.0.113.42",
      "payment-start:203.0.113.42",
    ]);
    expect(mockRequireRateLimit.mock.calls[0][1]).toMatchObject({
      max: 12,
      windowMs: 15 * 60 * 1000,
    });
  });

  test("different packages share the same 30-quote IP bucket", async () => {
    const module = require("../server/api/payment/quote");
    const handler = module.default || module;

    await handler(
      { method: "POST", body: { packageTitle: "Package A" }, headers: {} },
      createRes()
    );
    await handler(
      { method: "POST", body: { packageTitle: "Package B" }, headers: {} },
      createRes()
    );

    expect(mockRequireRateLimit).toHaveBeenCalledTimes(2);
    expect(mockRequireRateLimit.mock.calls.map(([, options]) => options.key)).toEqual([
      "payment-quote:203.0.113.42",
      "payment-quote:203.0.113.42",
    ]);
    expect(mockRequireRateLimit.mock.calls[0][1]).toMatchObject({
      max: 30,
      windowMs: 15 * 60 * 1000,
    });
  });
});
