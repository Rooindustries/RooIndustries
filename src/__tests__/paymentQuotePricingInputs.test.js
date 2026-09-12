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

  test.each([
    [{ discountType: "percent", discountPercent: 100 }, 0, 0, "free"],
    [{ discountType: "fixed", discountAmount: 29.95 }, 0, 0, "free"],
    [{ discountType: "percent", discountPercent: 10 }, 25.6, 2.7, "paid"],
  ])("freezes commission against the payable quote for %j", async (discount, netAmount, commissionAmount, paymentProvider) => {
    await expect(resolvePaymentQuote({
      packageTitle: "Vertex Essentials",
      referralCode: "creator",
      couponCode: "PROMOTION",
      pricingInputs: {
        packageDoc: { _id: "package.essentials", title: "Vertex Essentials", price: "$29.95" },
        referralDoc: { _id: "referral.creator", slug: { current: "creator" }, maxCommissionPercent: 15, currentCommissionPercent: 10, currentDiscountPercent: 5 },
        couponDoc: { _id: "coupon.promotion", code: "PROMOTION", isActive: true, canCombineWithReferral: true, ...discount },
      },
    })).resolves.toMatchObject({
      effectiveNetAmount: netAmount,
      effectiveCommissionPercent: paymentProvider === "free" ? 0 : 10,
      commissionAmount,
      paymentProvider,
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
