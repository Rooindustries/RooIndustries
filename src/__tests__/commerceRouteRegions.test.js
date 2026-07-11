const fs = require("node:fs");
const path = require("node:path");

const COMMERCE_ROUTES = [
  "app/api/admin/commerce-readiness/route.js",
  "app/api/bookingAvailability/route.js",
  "app/api/holdSlot/route.js",
  "app/api/releaseHold/route.js",
  "app/api/payment/[action]/route.js",
  "app/api/payment/webhook/paypal/route.js",
  "app/api/payment/webhook/razorpay/route.js",
  "app/api/razorpay/[action]/route.js",
  "app/api/ref/[action]/route.js",
];

describe("commerce route regions", () => {
  test.each(COMMERCE_ROUTES)("pins %s near Supabase", (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source).toContain('export const preferredRegion = "dub1";');
  });

  test("does not move Tourney routes", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/tourney/players/route.js"),
      "utf8"
    );
    expect(source).not.toContain("preferredRegion");
  });
});
