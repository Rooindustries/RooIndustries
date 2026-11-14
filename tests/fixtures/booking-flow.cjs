const { createHash } = require("node:crypto");
const { test: base, expect } = require("@playwright/test");
const { fixturePort } = require("./fixture-ports.cjs");

const providers = {
  dodo: { enabled: true, mode: "test" },
  razorpay: { enabled: false, mode: "disabled" },
  paypal: { enabled: false, mode: "disabled" },
};

const overhaulPrice = 84.99;

const startedCheckout = (baseURL, checkouts, request) => {
  const holdId = request.postDataJSON()?.bookingPayload?.slotHoldId || "";
  const checkoutCreated = !checkouts.has(holdId);
  checkouts.add(holdId);
  return {
    ok: true, paymentAccessToken: "fixture-payment", status: "started", checkoutCreated,
    providerPayload: { checkoutUrl: `${baseURL}/__test/checkout-handoff`, orderId: `fixture-order-${holdId}` },
    sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  };
};

const test = base.extend({
  cpuThrottling: [async ({ page, browserName }, use, testInfo) => {
    const rate = Number(process.env.PW_CPU_THROTTLING_RATE || 1);
    if (!Number.isFinite(rate) || rate < 1) throw new Error("Invalid CPU throttling rate.");
    if (rate === 1) return use();
    if (browserName !== "chromium") throw new Error("CPU throttling requires Chromium.");
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate });
    await testInfo.attach("cpu-throttling", {
      body: JSON.stringify({ rate, browserName }), contentType: "application/json",
    });
    try {
      await use();
    } finally {
      await session.detach();
    }
  }, { auto: true }],
  flow: async ({ page, context, baseURL }, use, testInfo) => {
    const { guardBrowserContext } = await import("../../scripts/lib/test-target-safety.mjs");
    const contentURL = new URL(baseURL);
    contentURL.port = String(fixturePort("TOOLING_CONTENT_PORT"));
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
      checkouts: new Set(),
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
      if (failure === "non-json") return route.fulfill({ status: 502, contentType: "text/html", body: "Unavailable" });
      if (failure === "unknown") return json(route, { ok: false });
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
        const body = request.postDataJSON() || {};
        const couponCode = String(body.couponCode || "").toLowerCase();
        const referralCode = String(body.referralCode || "").toLowerCase();
        const cents = (value) => Math.round(value * 100) / 100;
        const couponDiscountAmount =
          couponCode === "save20" || (couponCode === "friend" && state.collision) ? cents(overhaulPrice * 0.2) : 0;
        const referralDiscountPercent =
          referralCode === "friend" || (referralCode === "save20" && state.collision) ? 10 : 0;
        const referralDiscountAmount = cents((overhaulPrice - couponDiscountAmount) * referralDiscountPercent / 100);
        const netAmount = cents(overhaulPrice - couponDiscountAmount - referralDiscountAmount);
        return json(route, { ok: true, quoteFingerprint: "fixture-quote", providers, quote: {
          grossAmount: overhaulPrice, netAmount, isFree: false,
          couponDiscountAmount, referralDiscountAmount, referralDiscountPercent,
        } });
      }
      if (path === "/api/payment/start") return json(route, startedCheckout(baseURL, state.checkouts, request));
      return route.fallback();
    });
    const booking = async (path = "/booking") => {
      await page.goto(path);
      await page.getByRole("button", { name: /^Earliest available:/ }).click();
    };
    const reserve = async (path) => {
      await booking(path);
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
    const review = async (path) => {
      await reserve(path);
      await details();
      await page.getByRole("button", { name: "Review before payment", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    };
    const startBodies = () => state.calls
      .filter((call) => call.path === "/api/payment/start")
      .map((call) => call.body);
    const payment = async () => {
      await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
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
      await use({ state, booking, reserve, details, review, payment, codeInput, upgrade, startBodies });
    } finally {
      await testInfo.attach("requests", { body: JSON.stringify({ calls: state.calls, aborted: state.aborted }, null, 2), contentType: "application/json" });
      if (!page.isClosed()) {
        await testInfo.attach("booking-flow", { body: await page.screenshot({ fullPage: true, timeout: 10000 }), contentType: "image/png" });
      }
      for (const route of state.pending) await route.abort().catch(() => {});
    }
  },
});

const cookieBanner = (page) => page.getByRole("region", { name: "Cookie choice", exact: true });

const declineCookies = (page) => cookieBanner(page).getByRole("button", { name: "Decline", exact: true }).click();

const settleIdle = (page) => page.evaluate(() => new Promise((resolve) => {
  window.requestIdleCallback(() => setTimeout(resolve, 400), { timeout: 5000 });
}));

const bookingEventId = (paymentRecordId) =>
  createHash("sha256").update(`booking-confirmed:${paymentRecordId}`).digest("hex").slice(0, 40);

const routePaidStart = async (page, baseURL, { lose = 0, hold = 0 } = {}) => {
  const checkouts = new Set();
  const gate = { held: [] };
  let losing = lose;
  let holding = hold;
  gate.release = () => Promise.all(gate.held.splice(0).map((answer) => answer()));
  await page.context().route("**/api/payment/start", (route) => {
    const json = {
      ...startedCheckout(baseURL, checkouts, route.request()),
      quote: { grossAmount: overhaulPrice, netAmount: overhaulPrice, isFree: false },
    };
    if (losing > 0) {
      losing -= 1;
      return route.abort("failed");
    }
    const answer = () => route.fulfill({ json });
    if (holding < 1) return answer();
    holding -= 1;
    gate.held.push(answer);
    return null;
  });
  return gate;
};

const routeStartedStatus = (context) =>
  context.route("**/api/payment/status", (route) => route.fulfill({ json: { ok: true, status: "started" } }));

const payButton = (tab) => tab.getByRole("button", { name: "Pay your way", exact: true });

const handedOff = (tab) => expect(tab).toHaveURL(/\/__test\/checkout-handoff$/);

const resumeCheckout = async (page) => {
  await page.goto("/payment");
  await page.getByRole("button", { name: "Resume checkout", exact: true }).click();
  await handedOff(page);
};

const openPayment = async (page, flow, baseURL, options) => {
  const gate = await routePaidStart(page, baseURL, options);
  await routeStartedStatus(page.context());
  await flow.review("/booking?package=overhaul");
  await flow.payment();
  return gate;
};

const secondPaymentTab = async (page) => {
  const opened = page.context().waitForEvent("page");
  await page.evaluate(() => { window.open("/payment"); });
  const second = await opened;
  await expect(second.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
  return second;
};

const inTwoTabs = (hold, order) => async (page, flow, baseURL) => {
  const gate = await openPayment(page, flow, baseURL, { hold });
  const tabs = [page, await secondPaymentTab(page)];
  await order(tabs, gate);
  for (const tab of tabs) await settleIdle(tab);
};

const inOneTab = (options, steps) => async (page, flow, baseURL) => {
  await openPayment(page, flow, baseURL, options);
  await steps(page);
  await settleIdle(page);
};

const heldStarts = (gate, count) => expect.poll(() => gate.held.length).toBe(count);

const reusedAnswerFirst = inTwoTabs(1, async ([first, second], gate) => {
  await payButton(first).click();
  await heldStarts(gate, 1);
  await payButton(second).click();
  await handedOff(second);
  await gate.release();
  await handedOff(first);
});

const blockLocalStorage = (page) => page.context().addInitScript(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true, get: () => { throw new DOMException("Storage is blocked.", "SecurityError"); },
  });
});

const withoutWebLocks = (page) => page.context().addInitScript(() => {
  Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined });
});

const checkoutStartCases = [
  ["created, then reused in another tab", null, inTwoTabs(0, async (tabs) => {
    for (const tab of tabs) {
      await payButton(tab).click();
      await handedOff(tab);
    }
  })],
  ["the reused answer arrives before the created one", null, reusedAnswerFirst],
  ["the created answer is lost, then a retry reuses it", null, inOneTab({ lose: 1 }, async (page) => {
    const lost = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/api/payment/start"));
    await payButton(page).click();
    await lost;
    await expect(payButton(page)).toBeEnabled();
    await payButton(page).click();
    await handedOff(page);
  })],
  ["two tabs race", null, inTwoTabs(2, async (tabs, gate) => {
    for (const tab of tabs) await payButton(tab).click();
    await heldStarts(gate, 2);
    await gate.release();
    for (const tab of tabs) await handedOff(tab);
  })],
  ["created, then reused after a reload", null, inOneTab({}, async (page) => {
    await payButton(page).click();
    await handedOff(page);
    await resumeCheckout(page);
  })],
  ["browser storage is blocked", blockLocalStorage, reusedAnswerFirst],
  ["the Web Locks API is missing", withoutWebLocks, reusedAnswerFirst],
].map(([name, prepare, run]) => ({ name, prepare: prepare || (() => null), run }));

const productionOnlyScripts = ["https://scripts.seorce.com/api?**", "https://widget.intercom.io/widget/**"];
const productionHostFixtures = {
  productionHost: [async ({}, use, workerInfo) => {
    const { loopbackProductionHost } = await import("../../scripts/lib/test-target-safety.mjs");
    const { baseURL, launchOptions } = workerInfo.project.use;
    await use(loopbackProductionHost(baseURL, launchOptions?.args));
  }, { scope: "worker" }],
  launchOptions: [async ({ launchOptions, productionHost }, use) =>
    use({ ...launchOptions, args: productionHost.args }), { scope: "worker" }],
  baseURL: async ({ productionHost }, use) => use(productionHost.origin),
  productionOnlyScriptStubs: [async ({ context, flow }, use) => {
    for (const script of productionOnlyScripts) {
      await context.route(script, (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    }
    await use(flow);
  }, { auto: true }],
};

module.exports = {
  test, expect, overhaulPrice, cookieBanner, declineCookies, settleIdle, bookingEventId, routePaidStart,
  checkoutStartCases, productionHostFixtures,
};
