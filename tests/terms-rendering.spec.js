const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, serviceWorkers: "block" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`/terms hydrates the server-rendered terms once at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const messages = [];
    page.on("console", message => messages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        window.__termsHeadingAtLoad = document.querySelector("main h1");
      });
    });
    const response = await page.goto("/terms", { waitUntil: "networkidle" });
    const main = page.locator("main#main-content");
    const state = await page.evaluate(() => ({
      headingAtLoad: window.__termsHeadingAtLoad?.textContent ?? null,
      sameHeading: window.__termsHeadingAtLoad === document.querySelector("main h1"),
    }));
    await testInfo.attach("terms-hydration", {
      body: JSON.stringify({ viewport, ...state, messages }, null, 2),
      contentType: "application/json",
    });
    expect(await response.text()).toContain("Terms of Service");
    expect(state.headingAtLoad).toBe("Terms of Service");
    expect(state.sameHeading).toBe(true);
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(main.locator("h1")).toHaveText("Terms of Service");
    await expect(main.getByRole("heading", { name: "Synthetic local information", exact: true })).toHaveCount(1);
    await expect(main).toContainText("This is synthetic privacy content for an isolated local Roo Industries application test.");
    expect(messages.filter(message => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(message))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("terms-hydrated.png"), fullPage: true, animations: "disabled" });
  });
}
