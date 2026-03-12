const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for home CTA link tests.");
}

const waitForHashTarget = async (
  page,
  hash,
  timeoutMs = 5000,
  predicate = (state) =>
    Math.abs(state.top) <= 160 && state.deferredCount > 0
) => {
  const started = Date.now();
  let top = null;

  while (Date.now() - started <= timeoutMs) {
    const state = await page.evaluate((targetHash) => ({
      hash: window.location.hash,
      top: Math.round(
        document.querySelector(targetHash)?.getBoundingClientRect().top ?? 9999
      ),
      deferredCount: document.querySelectorAll(".deferred-section-content")
        .length,
    }), hash);

    top = state.top;
    if (state.hash === hash && predicate(state)) {
      return state;
    }

    await page.waitForTimeout(50);
  }

  return { hash: new URL(page.url()).hash, top };
};

test("hero how it works CTA settles on the how-it-works section", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });
  await page.getByRole("link", { name: "See How It Works" }).click();

  const state = await waitForHashTarget(page, "#how-it-works");

  expect(state.hash).toBe("#how-it-works");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
});
