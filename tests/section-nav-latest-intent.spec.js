const { test, expect } = require("@playwright/test");

const CPU_THROTTLE_RATE = Number(process.env.NAV_CPU_THROTTLE_RATE || 4);
const FINAL_OFFSET_MAX = 160;

const SECTIONS = {
  benefits: "#services",
  faq: "#faq",
  plans: "#packages",
};

const PAIRS = [
  ["benefits", "faq"],
  ["faq", "plans"],
  ["plans", "benefits"],
];

test.use({ javaScriptEnabled: true });
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, page, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  const session = await context.newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
});

const waitForHydrated = (page, selector) =>
  page.waitForFunction(
    (target) => {
      const element = document.querySelector(target);
      return Boolean(element && Object.keys(element).some((key) => key.startsWith("__reactProps$")));
    },
    selector,
    { timeout: 15000 }
  );

const openPage = async (page, route, surface) => {
  await page.goto(route, { waitUntil: "domcontentloaded" });
  const selector =
    surface === "mobile"
      ? 'button[aria-label="Open menu"]'
      : '[data-nav-surface="desktop"][data-nav-target="faq"]';
  await waitForHydrated(page, selector);
};

const clickSection = async (page, target, surface) => {
  const link = page.locator(`[data-nav-surface="${surface}"][data-nav-target="${target}"]`).first();
  if (surface !== "mobile") {
    await link.click();
    return;
  }
  const menuButton = page.locator('button[aria-label="Open menu"]');
  await expect(async () => {
    if ((await menuButton.getAttribute("aria-expanded")) !== "true") await menuButton.click();
    await link.click({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
};

const readLanding = (page) =>
  page.evaluate(
    ({ hashes, maxOffset }) => {
      const onTop = hashes.find((hash) => {
        const element = document.querySelector(hash);
        return element && Math.abs(element.getBoundingClientRect().top) <= maxOffset;
      });
      return { path: window.location.pathname, hash: window.location.hash, onTop: onTop || "none" };
    },
    { hashes: Object.values(SECTIONS), maxOffset: FINAL_OFFSET_MAX }
  );

const expectLanded = async (page, hash, label) => {
  const landed = { path: "/", hash, onTop: hash };
  await expect
    .poll(() => readLanding(page).catch(() => null), { message: `${label} lands on ${hash}`, timeout: 8000, intervals: [100] })
    .toEqual(landed);
  await page.waitForTimeout(1500);
  expect(await readLanding(page), `${label} stays on ${hash}`).toEqual(landed);
};

for (const surface of ["desktop", "mobile"]) {
  const viewport = surface === "mobile" ? { width: 390, height: 844 } : { width: 1536, height: 960 };

  for (const origin of ["/reviews", "/"]) {
    test(`latest section click wins from ${origin} on ${surface}`, async ({ page }) => {
      test.setTimeout(180000);
      await page.setViewportSize(viewport);
      for (const [first, second] of PAIRS) {
        const label = `${origin} ${surface} ${first} then ${second}`;
        await openPage(page, origin, surface);
        await clickSection(page, first, surface);
        await page.waitForTimeout(10);
        await clickSection(page, second, surface);
        await expectLanded(page, SECTIONS[second], label);

        if (origin !== "/") {
          await page.goBack();
          await expect.poll(() => new URL(page.url()).pathname, { message: `${label} back` }).toBe(origin);
          await page.goForward();
          await expectLanded(page, SECTIONS[second], `${label} forward`);
        }
      }
    });
  }
}
