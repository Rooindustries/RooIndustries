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
