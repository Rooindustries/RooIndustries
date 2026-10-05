const { test, expect } = require("@playwright/test");
const evidence = require("./fixtures/home-cta-evidence.cjs");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for home CTA link tests.");
}

const waitForHashTarget = async (
  page,
  hash,
  selector,
  maxOffsetPx = 160,
  timeoutMs = 10000
) => {
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    const state = await page.evaluate((targetSelector) => ({
      hash: window.location.hash,
      top: Math.round(
        document.querySelector(targetSelector)?.getBoundingClientRect().top ??
          9999
      ),
      scrollY: Math.round(window.scrollY),
    }), selector);

    if (state.hash === hash && Math.abs(state.top) <= maxOffsetPx) {
      const result = {
        ...state,
        elapsedMs: Date.now() - started,
      };
      await evidence.record(page, result, selector);
      return result;
    }

    await page.waitForTimeout(100);
  }

  const state = await page.evaluate((targetSelector) => ({
    hash: window.location.hash,
    top: Math.round(
      document.querySelector(targetSelector)?.getBoundingClientRect().top ?? 9999
    ),
    scrollY: Math.round(window.scrollY),
  }), selector);

  const result = {
    ...state,
    elapsedMs: Date.now() - started,
  };
  await evidence.record(page, result, selector);
  return result;
};

test("hero CTAs still work after one has already been used", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });

  await page.getByRole("link", { name: "Tune My PC" }).first().click();
  let state = await waitForHashTarget(page, "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(200);

  await page.getByRole("link", { name: "Tune My PC" }).first().click();
  state = await waitForHashTarget(page, "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(200);

  await page.getByRole("link", { name: "How It Works" }).click();
  state = await waitForHashTarget(page, "#how-it-works", "#how-it-works");
  expect(state.hash).toBe("#how-it-works");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
});


test.beforeEach(async ({ context, page, baseURL, javaScriptEnabled, hasTouch, isMobile, userAgent, browserName }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await evidence.begin(page, testInfo, { baseURL, javaScriptEnabled, hasTouch, isMobile, userAgent, browserName, browserVersion: context.browser().version() });
});

test.afterEach(async ({ page }, testInfo) => evidence.finish(page, testInfo));
