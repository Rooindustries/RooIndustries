const { test: base, expect } = require("@playwright/test");

const providers = {
  dodo: { enabled: true, mode: "test" },
  razorpay: { enabled: false, mode: "disabled" },
  paypal: { enabled: false, mode: "disabled" },
};

const test = base.extend({
  flow: async ({ page, context, baseURL }, use, testInfo) => {
    const { guardBrowserContext } = await import("../../scripts/lib/test-target-safety.mjs");
    const contentURL = new URL(baseURL);
    contentURL.port = String(Number(contentURL.port) + 1);
    await guardBrowserContext(context, [baseURL, contentURL.origin]);
    const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const state = {
      calls: [],
      aborted: [],
      failures: {},
      pending: [],
      slots: [{ date, times: ["10:00", "11:00"] }],
      bookedSlots: [],
      holdMs: 20 * 60 * 1000,
      holdCount: 0,
      holds: new Map(),
      collision: false,
    };
    page.on("requestfailed", (request) => state.aborted.push(new URL(request.url()).pathname));
    const json = (route, data, status = 200) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(data),
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL).origin) return route.fallback();
      const path = url.pathname;
      if (path.startsWith("/api/")) {
        state.calls.push({ path, query: url.search, body: request.postDataJSON() });
      }
      const failure = state.failures[path];
      if (failure === "timeout") {
        state.pending.push(route);
        return;
      }
      if (failure === "network") return route.abort("failed");
      if (failure) return json(route, { ok: false, error: "Fixture request rejected." }, failure);
      if (path === "/__test/checkout-handoff") {
        return route.fulfill({ contentType: "text/html", body: "<h1>Checkout handoff</h1>" });
      }
      if (path === "/api/bookingAvailability") {
        return json(route, { settings: { dateSlots: state.slots }, bookedSlots: state.bookedSlots });
      }
      if (path === "/api/holdSlot") {
        const body = request.postDataJSON();
        const existing = state.holds.get(body.startTimeUTC);
        if (existing && (body.previousHoldId !== existing.holdId || body.previousHoldToken !== existing.holdToken)) {
          return json(route, { ok: false, message: "This slot is currently reserved by someone else." }, 409);
        }
        state.holdCount += 1;
        const nextHold = {
          ok: true, holdId: existing?.holdId || `fixture-hold-${state.holdCount}`, holdToken: `fixture-token-${state.holdCount}`,
          expiresAt: new Date(Date.now() + state.holdMs).toISOString(),
          startTimeUTC: body.startTimeUTC,
        };
        for (const [slot, previous] of state.holds) {
          if (previous.holdId === body.previousHoldId && previous.holdToken === body.previousHoldToken) {
            state.holds.delete(slot);
          }
        }
        state.holds.set(body.startTimeUTC, nextHold);
        return json(route, nextHold);
      }
      if (path === "/api/releaseHold") {
        const body = request.postDataJSON();
        for (const [slot, previous] of state.holds) {
          if (previous.holdId === body.holdId && previous.holdToken === body.holdToken) {
            state.holds.delete(slot);
          }
        }
        return json(route, { ok: true });
      }
      const code = (url.searchParams.get("code") || "").trim().toLowerCase();
      if (path === "/api/ref/validateReferral") {
        return json(route, code === "friend" || (code === "save20" && state.collision)
          ? { ok: true, active: true, eligible: true, referral: { code, currentDiscountPercent: 10 } }
          : { ok: false, error: "Invalid referral code.", reason: "not_found" });
      }
      if (path === "/api/ref/validateCoupon") {
        if (code === "expired") return json(route, { ok: false, error: "This coupon has expired." }, 400);
        return json(route, code === "save20" || (code === "friend" && state.collision)
          ? { ok: true, coupon: { code, discountType: "percent", discountPercent: 20, canCombineWithReferral: true } }
          : { ok: false, error: "Invalid referral or coupon code.", reason: "not_found" });
      }
      if (path === "/api/content/upgrade-link") {
        return json(route, { ok: true, data: {
          title: "Upgrade to Performance Vertex Max", intro: "Fixture upgrade",
          targetPackage: { title: "Performance Vertex Max", price: "$99.95" },
        } });
      }
      if (path === "/api/ref/getUpgradeInfo") {
        return json(route, {
          ok: true,
          booking: {
            _id: "fixture-order", packageTitle: "Performance Vertex Overhaul",
            startTimeUTC: `${date}T04:30:00.000Z`, email: "visitor@example.invalid",
            discord: "visitor", specs: "RTX 4070", mainGame: "CS2", localTimeZone: "Asia/Kolkata",
          },
          xoc: { title: "Performance Vertex Max", price: 99.95 },
          targetPackage: { title: "Performance Vertex Max", price: 99.95 },
          originalPaid: 54.95, upgradePrice: 45, upgradeIntentToken: "fixture-intent",
        });
      }
      if (path === "/api/payment/providers") return json(route, { ok: true, providers });
      if (path === "/api/payment/quote") {
        return json(route, { ok: true, quoteFingerprint: "fixture-quote", providers,
          quote: { grossAmount: 84.99, netAmount: 84.99, isFree: false } });
      }
      if (path === "/api/payment/start") {
        return json(route, {
          ok: true, paymentAccessToken: "fixture-payment", status: "started",
          providerPayload: { checkoutUrl: `${baseURL}/__test/checkout-handoff` },
          sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
        });
      }
      return route.fallback();
    });
    const booking = async () => {
      await page.goto("/booking");
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
    };
    const reserve = async () => {
      await booking();
      await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await page.getByRole("button", { name: "Next", exact: true }).last().click();
      await expect(page.getByRole("textbox", { name: "Booking email", exact: true })).toBeVisible();
    };
    const details = async (email = "visitor@example.invalid") => {
      await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
      await page.getByRole("textbox", { name: "Booking email", exact: true }).fill(email);
      await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
      await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
    };
    const review = async () => {
      await reserve();
      await details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    };
    const payment = async () => {
      await page.getByRole("button", { name: /^Pay \$/ }).click();
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    };
    const codeInput = async (code) => {
      const input = page.getByRole("textbox", { name: "Referral or coupon code", exact: true });
      if (!await input.isVisible()) {
        await page.getByRole("button", { name: "Have a referral or coupon code?", exact: true }).click();
      }
      await input.fill(code);
      await page.getByRole("button", { name: "Apply", exact: true }).click();
    };
    const upgrade = async (route = "/upgrade/max") => {
      await page.goto(route);
      await expect(page.getByRole("button", { name: "Check eligibility", exact: true })).toBeEnabled();
      await page.locator("input[type=email]").fill("visitor@example.invalid");
      await page.getByPlaceholder("e.g. 1a2b3c4d5e6f7g8h9i", { exact: true }).fill("fixture-order");
    };
    try {
      await use({ state, booking, reserve, details, review, payment, codeInput, upgrade });
    } finally {
      await testInfo.attach("requests", { body: JSON.stringify({ calls: state.calls, aborted: state.aborted }, null, 2), contentType: "application/json" });
      if (!page.isClosed()) {
        await testInfo.attach("booking-flow", { body: await page.screenshot({ fullPage: true, timeout: 10000 }), contentType: "image/png" });
      }
      for (const route of state.pending) await route.abort().catch(() => {});
    }
  },
});

module.exports = { test, expect };
