const couponSchemaModule = require("../../rooindustries/schemaTypes/coupon");
const referralSchemaModule = require("../../rooindustries/schemaTypes/referral");
const { validateCouponCodeNamespace } = couponSchemaModule;
const { validateReferralCodeNamespace } = referralSchemaModule;
const couponSchema = couponSchemaModule.default;
const referralSchema = referralSchemaModule.default;

const createContext = (result) => {
  const fetch = jest.fn().mockResolvedValue(result);
  return {
    context: {
      getClient: jest.fn(() => ({ fetch })),
    },
    fetch,
  };
};

describe("checkout code CMS namespace validation", () => {
  test("attaches namespace checks to both code fields", () => {
    const createRule = () => {
      const rule = {
        required: jest.fn(() => rule),
        min: jest.fn(() => rule),
        max: jest.fn(() => rule),
        custom: jest.fn(() => rule),
      };
      return rule;
    };
    const couponRule = createRule();
    const referralRule = createRule();

    couponSchema.fields.find((field) => field.name === "code")
      .validation(couponRule);
    referralSchema.fields.find((field) => field.name === "slug")
      .validation(referralRule);

    expect(couponRule.custom).toHaveBeenCalledWith(
      validateCouponCodeNamespace
    );
    expect(referralRule.custom).toHaveBeenCalledWith(
      validateReferralCodeNamespace
    );
  });

  test("blocks a coupon code already owned by a referral", async () => {
    const { context, fetch } = createContext("referral.creator");

    await expect(
      validateCouponCodeNamespace("Creator", context)
    ).resolves.toMatch(/already used by a referral creator/i);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('_type == "referral"'),
      { code: "creator" }
    );
  });

  test("blocks a referral code already owned by a coupon", async () => {
    const { context, fetch } = createContext("coupon.creator");

    await expect(
      validateReferralCodeNamespace({ current: "Creator" }, context)
    ).resolves.toMatch(/already used by a coupon/i);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('_type == "coupon"'),
      { code: "creator" }
    );
  });

  test("allows a code when the other namespace has no match", async () => {
    const coupon = createContext(null);
    const referral = createContext(null);

    await expect(
      validateCouponCodeNamespace("SAVE10", coupon.context)
    ).resolves.toBe(true);
    await expect(
      validateReferralCodeNamespace(
        { current: "creator" },
        referral.context
      )
    ).resolves.toBe(true);
  });
});
