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

const TOURNEY_PATTERNS = [
  "app/api/tourney/**/*",
  "app/api/admin/tourney-*/route.js",
  "app/api/supabase/tourney-shadow/route.js",
  "app/tourney/**/*",
];

describe("Supabase route regions", () => {
  test.each(COMMERCE_PATTERNS)("pins %s near Supabase", (pattern) => {
    expect(config.functions[pattern]).toEqual({ regions: ["dub1"] });
  });

  test.each(TOURNEY_PATTERNS)("pins %s near Supabase", (pattern) => {
    expect(config.functions[pattern]).toEqual({ regions: ["dub1"] });
  });
});
