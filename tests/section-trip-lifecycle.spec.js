const { evaluateBrowserTask } = require("./fixtures/browser-task.cjs");
const { test, expect } = require("@playwright/test");
const { waitForHydrated } = require("./fixtures/react-hydration.cjs");

test.use({ javaScriptEnabled: true });

test("Back consumes the trip before Forward and another route", async ({ page, context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await page.goto("/reviews", { waitUntil: "domcontentloaded" });
  const benefits = '[data-nav-surface="desktop"][data-nav-target="benefits"]';
  await waitForHydrated(page, benefits);
  const startLength = await page.evaluate(() => window.history.length);
  await evaluateBrowserTask(
    page,
    (selector) => new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#services")) return;
      observer.disconnect();
      window.history.back();
      resolve();
    });
    observer.observe(document.getElementById("main-content"), { childList: true, subtree: true });
    document.querySelector(selector).click();
  }), benefits);
  await expect(page.locator('#main-content [data-route-key="/reviews"]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/reviews");
  await page.goForward();
  await expect(page.locator("#services")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.history.state.__rooSectionTrip)).toBeUndefined();
  await page.locator('footer a[href="/tools"]').evaluate(link => link.click());
  await expect.poll(() => new URL(page.url()).pathname).toBe("/tools");
  expect(await page.evaluate(() => window.history.length)).toBe(startLength + 2);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).hash).toBe("#services");
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/reviews");
});
