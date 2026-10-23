const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true, timezoneId: "Asia/Kolkata" });

for (const width of [1280, 360, 390]) {
  test(`${width}px the smoke readiness signal follows client initialization`, async ({ page, flow }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const serverPages = await Promise.all(["/", "/booking", "/payment"].map(async pathname => {
      const response = await page.request.get(pathname);
      expect(response.ok()).toBe(true);
      return { pathname, html: await response.text() };
    }));
    await page.goto("/");
    const serverSignals = await page.evaluate(pages => pages.map(({ pathname, html }) => ({
      pathname,
      ready: Boolean(new DOMParser().parseFromString(html, "text/html").querySelector("[data-roo-flow-ready]")),
    })), serverPages);
    expect(serverSignals.every(signal => !signal.ready)).toBe(true);
    await expect(page.locator('[data-roo-flow-ready="home"]')).toBeVisible();
    await flow.review();
    await expect(page.locator('[data-roo-flow-ready="booking"]')).toBeVisible();
    await flow.payment();
    await expect(page.locator('[data-roo-flow-ready="payment"]')).toBeVisible();
    const signals = await page.locator("[data-roo-flow-ready]").evaluateAll(elements => elements.map(element => element.dataset.rooFlowReady));
    await testInfo.attach("client-readiness", { body: JSON.stringify({ width, serverSignals, signals }), contentType: "application/json" });
    expect(signals).toContain("payment");
  });
}

for (const width of [1280, 360, 390]) {
  for (const discovery of [
    { name: "failed", status: 503, body: JSON.stringify({ ok: false }) },
    { name: "invalid JSON", status: 200, body: "{invalid" },
    { name: "incomplete", status: 200, body: JSON.stringify({ ok: true, providers: {} }) },
    { name: "non-boolean", status: 200, body: JSON.stringify({ ok: true, providers: {
      dodo: { enabled: "true", mode: "test" },
      paypal: { enabled: false, mode: "missing" },
      razorpay: { enabled: false, mode: "missing" },
    } }) },
    { name: "valid", status: 200, body: JSON.stringify({ ok: true, providers: {
      dodo: { enabled: true, mode: "test" },
      paypal: { enabled: false, mode: "missing" },
      razorpay: { enabled: false, mode: "missing" },
    } }) },
  ]) {
    test(`${width}px direct payment readiness follows ${discovery.name} provider discovery`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/payment/providers", route => route.fulfill({
        status: discovery.status, contentType: "application/json", body: discovery.body,
      }));
      await Promise.all([
        page.waitForResponse("**/api/payment/providers").then(response => response.finished()),
        page.goto("/payment"),
      ]);
      await expect(page.getByRole("heading", { name: "Booking Summary", exact: true })).toBeVisible();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ready = page.locator('[data-roo-flow-ready="payment"]');
      if (discovery.name === "valid") await expect(ready).toBeVisible();
      else await expect(ready).toHaveCount(0);
      await testInfo.attach("provider-readiness", { body: JSON.stringify({
        width, discovery: discovery.name, ready: await ready.count(),
      }), contentType: "application/json" });
    });
  }
}
