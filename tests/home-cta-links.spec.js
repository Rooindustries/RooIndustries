const { test, expect } = require("@playwright/test");

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
      return state;
    }

    await page.waitForTimeout(100);
  }

  return page.evaluate((targetSelector) => ({
    hash: window.location.hash,
    top: Math.round(
      document.querySelector(targetSelector)?.getBoundingClientRect().top ?? 9999
    ),
    scrollY: Math.round(window.scrollY),
  }), selector);
};

test("hero CTAs still work after one has already been used", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });

  await page.getByRole("link", { name: "Tune My Rig" }).first().click();
  let state = await waitForHashTarget(page, "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(200);

  await page.getByRole("link", { name: "Tune My Rig" }).first().click();
  state = await waitForHashTarget(page, "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(200);

  await page.getByRole("link", { name: "See How It Works" }).click();
  state = await waitForHashTarget(page, "#how-it-works", "#how-it-works");
  expect(state.hash).toBe("#how-it-works");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
});
