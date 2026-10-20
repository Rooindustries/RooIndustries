const { test, expect } = require("@playwright/test");

const LINE = "No gains? 3-day money-back guarantee.";

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test("the guarantee under the Book buttons is the one the FAQ promises", async ({ page }) => {
  await page.goto("/faq");
  await expect(page.getByText(/We offer a 3-day Money-Back Guarantee\. If a completed optimization produces no repeatable synthetic performance gains, you will be refunded\./).first()).toBeVisible();
});

for (const route of ["/packages", "/"]) {
  for (const [width, height] of [[360, 740], [1440, 900]]) {
    test(`${route} shows the guarantee under every Book button at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(route);
      const cards = page.locator(".ri-package-card");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const guarantee = card.locator(".ri-package-guarantee");
        await expect(guarantee).toHaveText(LINE);
        const book = await card.locator(".ri-package-book-button").boundingBox();
        const line = await guarantee.boundingBox();
        expect(line.y).toBeGreaterThanOrEqual(book.y + book.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    });
  }
}
