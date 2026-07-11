const config = require("../../vercel.json");

const COMMERCE_PATTERNS = [
  "app/api/admin/commerce-readiness/route.js",
  "app/api/bookingAvailability/route.js",
  "app/api/holdSlot/route.js",
  "app/api/releaseHold/route.js",
  "app/api/payment/**/*",
  "app/api/razorpay/**/*",
  "app/api/ref/**/*",
];

describe("commerce route regions", () => {
  test.each(COMMERCE_PATTERNS)("pins %s near Supabase", (pattern) => {
    expect(config.functions[pattern]).toEqual({ regions: ["dub1"] });
  });

  test("does not move Tourney routes", () => {
    expect(
      Object.keys(config.functions).some((pattern) => pattern.includes("tourney"))
    ).toBe(false);
  });
});
