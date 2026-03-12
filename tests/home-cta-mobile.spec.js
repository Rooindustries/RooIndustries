const { test, expect, devices } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for home CTA link tests.");
}

test.use({
  ...devices["iPhone 13"],
});

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
      return {
        ...state,
        elapsedMs: Date.now() - started,
      };
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

  return {
    ...state,
    elapsedMs: Date.now() - started,
  };
};

const clickAndMeasure = async (page, linkName, hash, selector) => {
  await page.getByRole("link", { name: linkName }).first().click();
  return waitForHashTarget(page, hash, selector);
};

test("hero CTAs settle promptly on phone layouts", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });

  let state = await clickAndMeasure(page, "Tune My Rig", "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
  expect(state.elapsedMs).toBeLessThanOrEqual(1600);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(200);

  state = await clickAndMeasure(
    page,
    "See How It Works",
    "#how-it-works",
    "#how-it-works"
  );
  expect(state.hash).toBe("#how-it-works");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
  expect(state.elapsedMs).toBeLessThanOrEqual(1800);
});
