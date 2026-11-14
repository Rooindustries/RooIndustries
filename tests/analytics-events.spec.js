const {
  test: bookingTest, expect, cookieBanner: banner, settleIdle: settle, bookingEventId, routePaidStart: routeStart,
} = require("./fixtures/booking-flow.cjs");

const safety = () => import("../scripts/lib/test-target-safety.mjs");
const overhaul = "Performance Vertex Overhaul";
const paidEventId = bookingEventId("fixture-analytics-paid-record");
const freeEventId = bookingEventId("fixture-analytics-free-record");
const journeyId = "8f0c6a52-7d1e-4b3a-9c2d-1e5f6a7b8c9d";
const touch = {
  capturedAt: "2026-11-01T10:00:00.000Z", landingPath: "/", source: "meta",
  fbclid: "FbRawClickId123", gclid: "GRawClickId456",
};
const paidReceipt = {
  eventId: paidEventId, paymentType: "paid", provider: "dodo", amount: 84.99, currency: "USD",
  packageTitle: overhaul, referralCode: "",
  attribution: { version: 2, journeyId, firstTouch: touch, lastTouch: touch },
};
const freeReceipt = { ...paidReceipt, eventId: freeEventId, paymentType: "free", provider: "free", amount: 0 };
const confirmed = (analyticsReceipt) => ({
  ok: true, status: "booked", provider: analyticsReceipt?.provider || "dodo", bookingId: "fixture-analytics-booking",
  emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } }, emailDispatchToken: "",
  analyticsReceipt,
});
const personalData = /visitor@example\.invalid|fixture_visitor|Ryzen|RTX 4070|FbRawClickId123|GRawClickId456/;
const insightsScript = "/_vercel/insights/script.js";
const productionOnlyScripts = ["https://scripts.seorce.com/api?**", "https://widget.intercom.io/widget/**"];

const test = bookingTest.extend({
  analyticsThrows: [false, { option: true }],
  productionHost: [async ({}, use, workerInfo) => {
    const { loopbackProductionHost } = await safety();
    const { baseURL, launchOptions } = workerInfo.project.use;
    await use(loopbackProductionHost(baseURL, launchOptions?.args));
  }, { scope: "worker" }],
  launchOptions: [async ({ launchOptions, productionHost }, use) =>
    use({ ...launchOptions, args: productionHost.args }), { scope: "worker" }],
  baseURL: async ({ productionHost }, use) => use(productionHost.origin),
  vercel: [async ({ page, flow, baseURL, analyticsThrows }, use) => {
    const vercel = { calls: [], scripts: [], served: [] };
    await page.exposeFunction("__recordVercel", (path, method, payload) =>
      vercel.calls.push({ path, method, payload }));
    await page.addInitScript((throws) => {
      window.va = (method, payload) => {
        if (method === "beforeSend") window.__vercelBeforeSend = payload;
        window.__recordVercel(location.pathname, method, method === "beforeSend" ? typeof payload : payload);
        if (throws && method === "event") throw new Error("Analytics script failure");
      };
    }, analyticsThrows);
    await page.route(`**${insightsScript}`, (route) => {
      vercel.scripts.push(route.request().url());
      return route.fulfill({
        contentType: "application/javascript",
        body: analyticsThrows ? 'throw new Error("Analytics script failure");' : "",
      });
    });
    for (const script of productionOnlyScripts) {
      await page.route(script, (route) => route.fulfill({ contentType: "application/javascript", body: "" }));
    }
    page.on("response", (response) => {
      const type = response.request().resourceType();
      if (!["document", "fetch", "xhr", "script"].includes(type)) return;
      const { pathname } = new URL(response.url());
      vercel.served.push(response.serverAddr().then((address) => ({ pathname, type, address })));
    });
    await use(vercel);
    const served = await Promise.all(vercel.served);
    const checked = served.filter(({ type, pathname, address }) =>
      address || (type === "document" && pathname !== "/__test/checkout-handoff"));
    expect(checked.map(({ pathname, address }) => [pathname, address?.ipAddress]))
      .toEqual(checked.map(({ pathname }) => [pathname, "127.0.0.1"]));
  }, { auto: true }],
});

test.use({
  javaScriptEnabled: true, timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce", actionTimeout: 10000,
});

const events = (vercel, name) =>
  vercel.calls.filter(({ method, payload }) => method === "event" && payload?.name === name);
const sentOnce = async (page, vercel, name) => {
  await expect.poll(() => events(vercel, name).length).toBe(1);
  await settle(page);
  expect(events(vercel, name)).toHaveLength(1);
  return events(vercel, name)[0];
};
const overhaulCard = (page) => page.locator(".ri-package-card")
  .filter({ has: page.getByRole("heading", { name: overhaul, exact: true }) });
const routeFinalize = async (page, receipt) => {
  const finalize = { calls: 0 };
  await page.route("**/api/payment/finalize", (route) => {
    finalize.calls += 1;
    return route.fulfill({ json: confirmed(receipt) });
  });
  return finalize;
};
const startCheckout = async (page, flow) => {
  await flow.review("/booking?package=overhaul");
  await flow.payment();
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
};
const payAndReturn = async (page, flow) => {
  await startCheckout(page, flow);
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  await page.goto("/payment?dodo_return=1");
  await expect(page).toHaveURL(/\/payment-success$/);
  await expect(page.getByRole("heading", { name: "Payment Successful", exact: true })).toBeVisible();
};
const completions = (vercel) => [...events(vercel, "booking_completed"), ...events(vercel, "free_booking_completed")];

test("the analytics script and its page cleanup load only on the production host", async ({
  page, vercel, baseURL, productionHost,
}) => {
  await page.goto(`${productionHost.loopback}/packages`);
  await overhaulCard(page).locator(".ri-package-details-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await settle(page);
  expect(vercel.calls).toEqual([]);
  expect(vercel.scripts).toEqual([]);

  await page.goto("/packages");
  await expect.poll(() => vercel.scripts).toEqual([`${baseURL}${insightsScript}`]);
  await expect.poll(() => vercel.calls.some(({ method }) => method === "beforeSend")).toBe(true);
  expect(vercel.calls.filter(({ method }) => method === "beforeSend").map(({ payload }) => payload))
    .toEqual(expect.arrayContaining(["function"]));
  const paths = [
    "/payment-success?payment=fixture-token&email=visitor%40example.invalid#receipt",
    "/packages?utm_source=meta&fbclid=FbRawClickId123", "/upgrade/max?email=visitor@example.invalid",
    "/upgrade-xoc", "/meet-the-team?ref=friend", "/downloads/utilities?file=fixture",
    "/referrals/dashboard?token=fixture-token", "/admin/bookings", "/booking/secret",
  ];
  const cleaned = await page.evaluate(({ origin, list }) => [
    ...list.map((path) => window.__vercelBeforeSend({ type: "pageview", url: `${origin}${path}` })),
    window.__vercelBeforeSend({ type: "pageview", url: "not a url" }),
  ], { origin: baseURL, list: paths });
  expect(cleaned).toEqual([
    ...["/payment-success", "/packages", "/upgrade", "/upgrade", "/meet-the-team", "/downloads/utilities"]
      .map((path) => ({ type: "pageview", url: `${baseURL}${path}` })),
    null, null, null, null,
  ]);
});

test("view_item fires once per package view on the packages page and the booking page", async ({ page, vercel }) => {
  await page.goto("/packages?utm_source=meta&fbclid=FbRawClickId123&gclid=GRawClickId456");
  await expect(banner(page)).toBeVisible();
  const cardPrice = Number((await overhaulCard(page).locator(".ri-price-current").first().textContent())
    .replace(/[^0-9.]/g, ""));
  await overhaulCard(page).locator(".ri-package-details-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const details = await sentOnce(page, vercel, "view_item");
  expect(details.path).toBe("/packages");
  expect(details.payload.data).toMatchObject({
    package: overhaul, package_slug: "overhaul", value: cardPrice, currency: "USD", surface: "packages",
    campaign_source: "meta", has_fbclid: true, has_gclid: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.goto("/booking?package=overhaul");
  await expect(page.locator(".ri-booking-package-title")).toHaveText(overhaul);
  await expect.poll(() => events(vercel, "view_item").length).toBe(2);
  await settle(page);
  const booking = events(vercel, "view_item");
  expect(booking).toHaveLength(2);
  expect(booking[1].path).toBe("/booking");
  expect(booking[1].payload.data).toMatchObject({
    package: overhaul, package_slug: "overhaul", currency: "USD", surface: "booking", has_fbclid: true,
  });
  await expect(page.locator(".ri-booking-package-title").locator(".."))
    .toContainText(`$${booking[1].payload.data.value.toFixed(2)}`);
  expect(JSON.stringify(vercel.calls)).not.toMatch(personalData);
});

test("checkout_started fires once, only after the payment start succeeds", async ({ page, flow, vercel, baseURL }) => {
  await page.goto("/packages");
  await banner(page).getByRole("button", { name: "Decline", exact: true }).click();
  await routeStart(page, baseURL);
  await flow.review("/booking?package=overhaul");
  await flow.payment();
  await settle(page);
  expect(events(vercel, "checkout_started")).toEqual([]);
  await page.getByRole("button", { name: "Pay your way", exact: true }).click();
  await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
  const started = events(vercel, "checkout_started");
  expect(started).toHaveLength(1);
  expect(started[0].payload.data).toMatchObject({
    package: overhaul, package_slug: "overhaul", provider: "dodo", value: 84.99, currency: "USD",
  });
  expect(JSON.stringify(vercel.calls)).not.toMatch(personalData);
});

for (const failure of [500, "unknown", "network"]) {
  test(`checkout_started stays unsent when the payment start fails (${failure})`, async ({ page, flow, vercel }) => {
    flow.state.failures["/api/payment/start"] = failure;
    await startCheckout(page, flow);
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect.poll(() => flow.startBodies().length).toBe(1);
    await settle(page);
    expect(events(vercel, "view_item")).toHaveLength(1);
    expect(events(vercel, "checkout_started")).toEqual([]);
  });
}

test("booking_completed fires once for a paid receipt, with no personal data", async ({
  page, flow, vercel, baseURL,
}) => {
  await routeStart(page, baseURL);
  const finalize = await routeFinalize(page, paidReceipt);
  await payAndReturn(page, flow);
  const completed = await sentOnce(page, vercel, "booking_completed");
  expect(completed.payload.data).toEqual({
    event_id: paidEventId, package: overhaul, payment_type: "paid", payment_provider: "dodo", amount: 84.99,
    currency: "USD", referral_code: "", journey_id: journeyId, landing_path: "/", campaign_source: "meta",
    first_source: "meta", has_fbclid: true, has_gclid: true,
  });
  await page.reload();
  await settle(page);
  flow.state.holds.clear();
  await payAndReturn(page, flow);
  await settle(page);
  expect(finalize.calls).toBe(2);
  expect(events(vercel, "booking_completed")).toHaveLength(1);
  expect(events(vercel, "free_booking_completed")).toEqual([]);
  expect(JSON.stringify(vercel.calls)).not.toMatch(personalData);
});

test("a free receipt sends free_booking_completed and no booking_completed", async ({ page, flow, vercel }) => {
  await page.route("**/api/payment/quote", (route) => route.fulfill({ json: {
    ok: true, quoteFingerprint: "fixture-free-quote",
    providers: { dodo: { enabled: true, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } },
    quote: { grossAmount: 84.99, netAmount: 0, isFree: true },
  } }));
  await page.route("**/api/payment/start", (route) => route.fulfill({ json: {
    ...confirmed(freeReceipt), quote: { grossAmount: 84.99, netAmount: 0, isFree: true },
  } }));
  await flow.review("/booking?package=overhaul");
  await flow.payment();
  await page.getByRole("button", { name: "Confirm Free Booking", exact: true }).click();
  await expect(page).toHaveURL(/\/thank-you$/);
  await expect(page.getByRole("heading", { level: 1, name: "Thank You!", exact: true })).toBeVisible();
  const free = await sentOnce(page, vercel, "free_booking_completed");
  expect(free.payload.data).toMatchObject({
    event_id: freeEventId, payment_type: "free", payment_provider: "free", amount: 0, has_fbclid: true,
  });
  expect(events(vercel, "booking_completed")).toEqual([]);
  expect(events(vercel, "checkout_started")).toEqual([]);
  expect(JSON.stringify(vercel.calls)).not.toMatch(personalData);
});

const malformed = {
  "a forged event id": { ...paidReceipt, eventId: paidEventId.toUpperCase() },
  "a short event id": { ...paidReceipt, eventId: paidEventId.slice(1) },
  "an unknown payment type": { ...paidReceipt, paymentType: "gift" },
  "a negative amount": { ...paidReceipt, amount: -84.99 },
  "a text amount": { ...paidReceipt, amount: "84.99" },
  "no receipt": null,
};
for (const [name, receipt] of Object.entries(malformed)) {
  test(`${name} sends no completion event and still shows the booking`, async ({ page, flow, vercel, baseURL }) => {
    await routeStart(page, baseURL);
    await routeFinalize(page, receipt);
    await payAndReturn(page, flow);
    await settle(page);
    expect(events(vercel, "checkout_started")).toHaveLength(1);
    expect(completions(vercel)).toEqual([]);
  });
}

test.describe("with an analytics script that throws", () => {
  test.use({ analyticsThrows: true });

  test("the page and the booking still work", async ({ page, flow, vercel, baseURL }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await routeStart(page, baseURL);
    const finalize = await routeFinalize(page, paidReceipt);
    await page.goto("/packages");
    await expect.poll(() => vercel.scripts.length).toBe(1);
    await overhaulCard(page).locator(".ri-package-details-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect.poll(() => events(vercel, "view_item").length).toBe(1);
    await page.keyboard.press("Escape");
    await payAndReturn(page, flow);
    await sentOnce(page, vercel, "booking_completed");
    expect(finalize.calls).toBe(1);
    expect(events(vercel, "checkout_started")).toHaveLength(1);
    expect(vercel.scripts.length).toBeGreaterThan(1);
    expect(errors).toEqual(vercel.scripts.map(() => "Analytics script failure"));
  });
});

test("the guard refuses the production host without the loopback mapping", async ({ playwright, baseURL }) => {
  const { guardBrowserContext } = await safety();
  for (const args of [[], ["--host-resolver-rules=MAP www.rooindustries.com 10.0.0.1"]]) {
    const browser = await playwright.chromium.launch({ args });
    try {
      const context = await browser.newContext();
      await expect(guardBrowserContext(context, [baseURL])).rejects.toThrow("needs the loopback mapping");
    } finally {
      await browser.close();
    }
  }
});
