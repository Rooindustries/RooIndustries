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

  test("quotes a 100 percent referral as free", async () => {
    await expect(
      resolvePaymentQuote({
        packageTitle: "Performance Vertex Overhaul",
        referralCode: "freecreator",
        pricingInputs: {
          packageDoc: {
            _id: "package.vertex",
            title: "Performance Vertex Overhaul",
            price: "$54.95",
          },
          referralDoc: {
            _id: "referral.freecreator",
            slug: { current: "freecreator" },
            currentCommissionPercent: 0,
            currentDiscountPercent: "100",
          },
          couponDoc: null,
        },
      })
    ).resolves.toMatchObject({
      effectiveGrossAmount: 54.95,
      referralDiscountAmount: 54.95,
      effectiveDiscountAmount: 54.95,
      effectiveNetAmount: 0,
      paymentProvider: "free",
    });
  });

  test("clamps hostile fixed coupon input so it cannot raise the quote", async () => {
    await expect(
      resolvePaymentQuote({
        packageTitle: "Performance Vertex Overhaul",
        couponCode: "HOSTILE",
        pricingInputs: {
          packageDoc: {
            _id: "package.vertex",
            title: "Performance Vertex Overhaul",
            price: "$54.95",
          },
          referralDoc: null,
          couponDoc: {
            _id: "coupon.hostile",
            code: "HOSTILE",
            isActive: true,
            discountType: "fixed",
            discountAmount: "-$10.00",
            canCombineWithReferral: true,
          },
        },
      })
    ).resolves.toMatchObject({
      effectiveGrossAmount: 54.95,
      couponDiscountAmount: 0,
      effectiveDiscountAmount: 0,
      effectiveNetAmount: 54.95,
      paymentProvider: "paid",
    });
  });

  test("clamps negative and malformed percent inputs so they cannot raise the quote", async () => {
    await expect(
      resolvePaymentQuote({
        packageTitle: "Performance Vertex Overhaul",
        referralCode: "negativecreator",
        couponCode: "HOSTILEPERCENT",
        pricingInputs: {
          packageDoc: {
            _id: "package.vertex",
            title: "Performance Vertex Overhaul",
            price: "$54.95",
          },
          referralDoc: {
            _id: "referral.negativecreator",
            slug: { current: "negativecreator" },
            currentCommissionPercent: 0,
            currentDiscountPercent: "-25",
          },
          couponDoc: {
            _id: "coupon.hostile-percent",
            code: "HOSTILEPERCENT",
            isActive: true,
            discountType: "percent",
            discountPercent: "54.95usd7",
            canCombineWithReferral: true,
          },
        },
      })
    ).resolves.toMatchObject({
      effectiveGrossAmount: 54.95,
      referralDiscountAmount: 0,
      couponDiscountAmount: 0,
      effectiveDiscountAmount: 0,
      effectiveNetAmount: 54.95,
      paymentProvider: "paid",
    });
  });
});
