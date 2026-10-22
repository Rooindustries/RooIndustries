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
  const { left, top, width, height } = element.getBoundingClientRect();
  return { x: left + window.scrollX, y: top + window.scrollY, width, height };
});

const expectMethods = async (scope, width) => {
  const list = methodList(scope);
  await expect(list).toBeVisible();
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
  if (width === 1440) expect(rows).toHaveLength(1);
  else expect(rows.length).toBeGreaterThan(1);
  return list;
};

for (const [route, width, height] of [["/packages", 1440, 900], ["/packages", 390, 844], ["/packages", 360, 740], ["/", 390, 844]]) {
  test(`payment logos appear only in the footer on ${route} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.goto(route);
    const footer = page.locator("footer").last();
    await expectMethods(footer, width);
    await expect(methodList(page)).toHaveCount(1);
    await expect(page.locator('img[src^="/payment-methods/"]')).toHaveCount(await footer.locator('img[src^="/payment-methods/"]').count());
    for (const note of NOTES) await expect(page.getByText(note, { exact: true })).toHaveCount(0);
    const packages = page.locator("section.ri-packages-section");
    await expect(methodList(packages)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`footer-${width}.png`), fullPage: true, clip: await pageBox(footer), animations: "disabled" });
    if (route === "/packages") {
      await page.screenshot({ path: testInfo.outputPath(`packages-${width}.png`), fullPage: true, clip: await pageBox(packages), animations: "disabled" });
    }
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
