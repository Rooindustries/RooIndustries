const { test, expect } = require("@playwright/test");
const { clickAtRouteCommit } = require("./fixtures/route-commit-click.cjs");
const { waitForRouteCommitted } = require("./fixtures/react-hydration.cjs");

const benefits = '[data-nav-surface="desktop"][data-nav-target="benefits"]';
const logo = 'header a[href="/"]';

test.use({
  javaScriptEnabled: true,
  viewport: { width: 1536, height: 480 },
  launchOptions: { args: ["--ozone-platform=x11", "--js-flags=--expose-gc"] },
});

test("the logo click at Home commit completes while browser promises are collected", async ({ context, page, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto("/reviews", { waitUntil: "domcontentloaded" });
  await waitForRouteCommitted(page);
  const startLength = await page.evaluate(() => history.length);
  await page.evaluate((selector) => {
    window.__logoDocument = true;
    window.__logoUnloads = 0;
    window.addEventListener("beforeunload", () => window.__logoUnloads++);
    document.querySelector(selector).addEventListener("click", () => {
      queueMicrotask(() => {
        window.gc();
        queueMicrotask(() => window.gc());
      });
    }, { once: true });
    window.scrollTo({ top: 700, behavior: "instant" });
  }, logo);
  await clickAtRouteCommit(page, benefits, logo, "/");
  await expect.poll(() => page.evaluate(() => ({
    path: location.pathname, hash: location.hash, y: scrollY,
  }))).toEqual({ path: "/", hash: "", y: 0 });
  expect(await page.evaluate(() => ({
    document: window.__logoDocument, unloads: window.__logoUnloads, length: history.length,
  }))).toEqual({ document: true, unloads: 0, length: startLength + 1 });
});
