import {
  calculateCheckoutDiscounts,
  getCouponDiscountAmount,
  resolveCheckoutCode,
  sanitizeCouponForCheckout,
  sanitizeReferralForCheckout,
  toMoney,
  validateReferralCode,
} from "../lib/checkoutCodes";

describe("shared checkout discount math", () => {
  const referral = {
    code: "creator",
    currentDiscountPercent: 10,
  };

  test("matches the payment-page coupon-first stacking and cent rounding", () => {
    const coupon = {
      code: "CLUB5",
      discountType: "percent",
      discountPercent: 5,
      canCombineWithReferral: true,
    };

    expect(getCouponDiscountAmount(coupon, 54.95)).toBe(2.75);
    expect(
      calculateCheckoutDiscounts({
        baseAmount: 54.95,
        referral,
        coupon,
      })
    ).toMatchObject({
      canApplyCouponWithReferral: true,
      couponDiscountAmount: 2.75,
      referralDiscountAmount: 5.22,
      totalDiscountAmount: 7.97,
      finalAmount: 46.98,
    });
  });

  test("does not add a non-clubbable coupon to a referral discount", () => {
    const coupon = {
      code: "NOCLUB",
      discountType: "percent",
      discountPercent: 5,
      canCombineWithReferral: false,
    };

    expect(
      calculateCheckoutDiscounts({
        baseAmount: 54.95,
        referral,
        coupon,
      })
    ).toMatchObject({
      canApplyCouponWithReferral: false,
      couponDiscountAmount: 2.75,
      referralDiscountAmount: 5.5,
      totalDiscountAmount: 5.5,
      finalAmount: 49.45,
    });
  });

  test("normalizes signed strings and clamps hostile discounts without raising the total", () => {
    expect(toMoney("-$12.50")).toBe(-12.5);
    expect(toMoney("$54.95")).toBe(54.95);
    expect(toMoney("54.95usd7")).toBe(0);

    const hostileCases = [
      {
        referral: { code: "negative-ref", currentDiscountPercent: "-25" },
        coupon: null,
      },
      {
        referral: null,
        coupon: {
          code: "negative-fixed",
          discountType: "fixed",
          discountAmount: "-$40.00",
          canCombineWithReferral: true,
        },
      },
      {
        referral: { code: "oversized-ref", currentDiscountPercent: "999" },
        coupon: {
          code: "oversized-coupon",
          discountType: "percent",
          discountPercent: "999",
          canCombineWithReferral: true,
        },
      },
    ];

    const outcomes = hostileCases.map(({ referral: nextReferral, coupon }) =>
      calculateCheckoutDiscounts({
        baseAmount: "$54.95",
        referral: nextReferral,
        coupon,
      })
    );

    expect(outcomes[0]).toMatchObject({
      totalDiscountAmount: 0,
      finalAmount: 54.95,
      isFree: false,
    });
    expect(outcomes[1]).toMatchObject({
      totalDiscountAmount: 0,
      finalAmount: 54.95,
      isFree: false,
    });
    expect(outcomes[2]).toMatchObject({
      totalDiscountAmount: 54.95,
      finalAmount: 0,
      isFree: true,
    });
    outcomes.forEach((outcome) => {
      expect(outcome.finalAmount).toBeGreaterThanOrEqual(0);
      expect(outcome.finalAmount).toBeLessThanOrEqual(54.95);
    });
  });

  test("treats a zero server quote and a 100 percent referral as free", () => {
    expect(
      calculateCheckoutDiscounts({
        baseAmount: 54.95,
        referral: { code: "free-ref", currentDiscountPercent: 100 },
      })
    ).toMatchObject({
      referralDiscountAmount: 54.95,
      finalAmount: 0,
      isFree: true,
    });

    expect(
      calculateCheckoutDiscounts({
        baseAmount: 54.95,
        referral,
        serverQuote: { netAmount: "0.00", isFree: false },
      })
    ).toMatchObject({ finalAmount: 0, isFree: true });
  });

  test("sanitizes checkout state to the fields used by display and math", () => {
    expect(
      sanitizeReferralForCheckout({
        _id: "referral.creator",
        name: "Private Creator Name",
        currentCommissionPercent: 25,
        code: "creator",
        currentDiscountPercent: "10",
      })
    ).toEqual({ code: "creator", currentDiscountPercent: 10 });
    expect(
      sanitizeCouponForCheckout({
        id: "coupon.save10",
        title: "Internal title",
        code: "SAVE10",
        discountType: "fixed",
        discountAmount: "10",
        discountPercent: 90,
        canCombineWithReferral: true,
        timesUsed: 4,
      })
    ).toEqual({
      code: "SAVE10",
      discountType: "fixed",
      discountAmount: 10,
      canCombineWithReferral: true,
    });
  });

  test("rejects a referral projection marked inactive or ineligible", async () => {
    const fetchImpl = jest.fn(async () => ({
      json: async () => ({
        ok: true,
        active: false,
        eligible: true,
        referral: { code: "paused", currentDiscountPercent: 10 },
      }),
    }));

    await expect(validateReferralCode("paused", fetchImpl)).resolves.toEqual({
      ok: false,
      error: "Invalid or inactive referral code.",
    });
  });

  test("resolves an existing cross-namespace collision referral-first and warns structurally", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = jest.fn(async (url) => ({
      json: async () =>
        String(url).includes("validateReferral")
          ? {
              ok: true,
              referral: {
                code: "samecode",
                currentDiscountPercent: 10,
                name: "Private Creator Name",
              },
            }
          : {
              ok: true,
              coupon: {
                code: "SAMECODE",
                discountType: "fixed",
                discountAmount: 10,
                canCombineWithReferral: true,
              },
            },
    }));

    await expect(
      resolveCheckoutCode("SAMECODE", "Performance Vertex Overhaul", fetchImpl)
    ).resolves.toEqual({
      ok: true,
      type: "referral",
      value: { code: "samecode", currentDiscountPercent: 10 },
    });
    expect(warn).toHaveBeenCalledWith("checkout_code_namespace_collision", {
      event: "checkout_code_namespace_collision",
      code: "samecode",
      precedence: "referral_first",
      resolvedType: "referral",
    });
    warn.mockRestore();
  });
});
