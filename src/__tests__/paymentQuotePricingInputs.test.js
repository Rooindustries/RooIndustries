jest.mock("../server/data/documentClient.js", () => ({
  createDataClient: () => ({
    fetch: jest.fn(() => {
      throw new Error("unexpected pricing document fetch");
    }),
  }),
}));

const { resolvePaymentQuote } = require("../server/api/ref/pricing.js");

describe("payment quote pricing inputs", () => {
  test("uses the atomic targeted pricing result without another database read", async () => {
    const client = {
      fetch: jest.fn(() => {
        throw new Error("unexpected pricing document fetch");
      }),
    };

    await expect(
      resolvePaymentQuote({
        packageTitle: "Performance Vertex Overhaul",
        client,
        pricingInputs: {
          packageDoc: {
            _id: "package.vertex",
            title: "Performance Vertex Overhaul",
            price: "$54.95",
          },
          referralDoc: null,
          couponDoc: null,
        },
      })
    ).resolves.toMatchObject({
      effectiveGrossAmount: 54.95,
      effectiveNetAmount: 54.95,
      paymentProvider: "paid",
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  test("rejects a missing coupon returned by the targeted pricing lookup", async () => {
    await expect(
      resolvePaymentQuote({
        packageTitle: "Performance Vertex Overhaul",
        couponCode: "missing",
        pricingInputs: {
          packageDoc: {
            _id: "package.vertex",
            title: "Performance Vertex Overhaul",
            price: "$54.95",
          },
          referralDoc: null,
          couponDoc: null,
        },
      })
    ).rejects.toMatchObject({ status: 400, code: "coupon_invalid" });
  });
});
