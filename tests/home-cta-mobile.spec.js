const { test, expect, devices } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for home CTA link tests.");
}

test.use({
  ...devices["iPhone 13"],
  javaScriptEnabled: true,
});

const installAlignmentProbe = async (page, selector) => {
  await page.evaluate((targetSelector) => {
    window.__heroCtaScrollProbe = {
      startedAt: performance.now(),
      settled: null,
    };

    const handleSettled = (event) => {
      window.__heroCtaScrollProbe.settled = {
        hash: event?.detail?.hash || "",
        top: Math.round(
          document.querySelector(targetSelector)?.getBoundingClientRect().top ??
            9999
        ),
        scrollY: Math.round(window.scrollY),
        settledAt: performance.now(),
      };
      window.removeEventListener("roo:section-align-settled", handleSettled);
    };

    window.addEventListener("roo:section-align-settled", handleSettled);
  }, selector);
};

const clickAndMeasure = async (page, linkName, hash, selector) => {
  await installAlignmentProbe(page, selector);
  await page.getByRole("link", { name: linkName }).first().click();
  await page.waitForFunction(
    (expectedHash) =>
      window.__heroCtaScrollProbe?.settled?.hash === expectedHash,
    hash,
    { timeout: 10000 }
  );

  return page.evaluate(() => ({
    ...window.__heroCtaScrollProbe.settled,
    elapsedMs: Math.round(
      window.__heroCtaScrollProbe.settled.settledAt -
        window.__heroCtaScrollProbe.startedAt
    ),
  }));
};

const scrollToTopInstant = async (page) => {
  await page.evaluate(() => {
    const root = document.documentElement;
    const previous = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo({ top: 0, behavior: "auto" });
    if (previous) {
      root.style.scrollBehavior = previous;
      return;
    }
    root.style.removeProperty("scroll-behavior");
  });

  await page.waitForFunction(() => Math.round(window.scrollY) === 0, {
    timeout: 5000,
  });
};

test("hero CTAs settle promptly on phone layouts", async ({ page }) => {
  await page.goto(`${BASE_URL}/`, { waitUntil: "load" });

  let state = await clickAndMeasure(page, "Tune My Rig", "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
  expect(state.elapsedMs).toBeLessThanOrEqual(600);

  await scrollToTopInstant(page);

  state = await clickAndMeasure(page, "Tune My Rig", "#packages", "#packages");
  expect(state.hash).toBe("#packages");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
  expect(state.elapsedMs).toBeLessThanOrEqual(600);

  await scrollToTopInstant(page);

  state = await clickAndMeasure(
    page,
    "See How It Works",
    "#how-it-works",
    "#how-it-works"
  );
  expect(state.hash).toBe("#how-it-works");
  expect(Math.abs(state.top)).toBeLessThanOrEqual(160);
  expect(state.elapsedMs).toBeLessThanOrEqual(600);
});
