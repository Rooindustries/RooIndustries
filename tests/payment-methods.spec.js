const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

const METHODS = ["Visa", "Mastercard", "American Express", "Discover", "Apple Pay", "Google Pay", "PayPal", "Amazon Pay", "Cash App Pay", "Klarna", "Afterpay"];
const NOTES = ["You can also pay by ACH bank debit, WeChat Pay or stablecoins.", "Klarna and Afterpay show up on US orders over $50. Cash App Pay and ACH are US only. In India, checkout skips Google Pay, Amazon Pay, WeChat Pay and stablecoins."];

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const methodList = scope => scope.getByRole("list", { name: "Payment methods", exact: true });
const loaded = list => list.getByRole("img").evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0));
const pageBox = locator => locator.evaluate(element => {
  const { top, bottom, width, height } = element.getBoundingClientRect();
  return { top: top + window.scrollY, bottom: bottom + window.scrollY, width, height };
});

const expectMethods = async scope => {
  const list = methodList(scope);
  await list.scrollIntoViewIfNeeded();
  expect(await list.getByRole("img").evaluateAll(images => images.map(image => image.alt))).toEqual(METHODS);
  await expect.poll(() => loaded(list)).toBe(true);
  const sizes = await list.getByRole("img").evaluateAll(images => images.map(image => {
    const { width, height } = image.getBoundingClientRect();
    return [width, height];
  }));
  expect(sizes).toEqual(METHODS.map(() => [48, 32]));
  const rows = await list.getByRole("img").evaluateAll(images => Object.values(images.reduce((count, image) => {
    const top = Math.round(image.getBoundingClientRect().top);
    return { ...count, [top]: (count[top] || 0) + 1 };
  }, {})));
  expect(Math.min(...rows)).toBeGreaterThan(1);
  for (const note of NOTES) await expect(scope.getByText(note, { exact: true })).toBeVisible();
  return list;
};

for (const [width, height] of [[1440, 900], [390, 844], [360, 740]]) {
  test(`payment methods show under the packages and in the footer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/packages");
    const packages = page.locator("section.ri-packages-section");
    const list = await expectMethods(packages);
    const book = await pageBox(packages.locator(".ri-package-book-button").last());
    const row = await pageBox(list);
    expect(row.top).toBeGreaterThan(book.bottom);
    expect(row.top - book.bottom).toBeLessThan(120);
    await packages.locator("div").filter({ has: list }).last().screenshot({ path: `test-results/payment-methods-packages-${width}.png` });

    const footer = page.locator("footer").last();
    await expectMethods(footer);
    await footer.screenshot({ path: `test-results/payment-methods-footer-${width}.png` });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
}

test("payment marks keep their space while they load", async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route("**/payment-methods/*.svg", async route => {
    await held;
    await route.continue();
  });
  await page.goto("/packages");
  const list = methodList(page.locator("footer").last());
  await list.scrollIntoViewIfNeeded();
  await expect(list.getByRole("img")).toHaveCount(METHODS.length);
  const before = await pageBox(list);
  expect(await list.getByRole("img").evaluateAll(images => images.some(image => image.naturalWidth > 0))).toBe(false);
  release();
  await expect.poll(() => loaded(list)).toBe(true);
  expect(await pageBox(list)).toEqual(before);
});
