const { test, expect } = require("@playwright/test");

const LINE = "No gains? 3-day money-back guarantee.";

const textLineCount = (node) => {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const tops = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) tops.push(rect.top);
  }
  tops.sort((a, b) => a - b);
  return tops.filter((top, index) => index === 0 || top - tops[index - 1] > 4).length;
};

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

for (const route of ["/packages", "/"]) {
  test(`${route} lines up every package row and centers the packages at 1440px`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route);
    const cards = page.locator(".ri-package-card");
    const count = await cards.count();
    expect(count).toBe(3);
    const edges = async (selector, edge) => {
      const values = [];
      for (let index = 0; index < count; index += 1) {
        const box = await cards.nth(index).locator(selector).first().boundingBox();
        values.push(edge === "bottom" ? box.y + box.height : box.y);
      }
      return values;
    };
    const rows = [
      ["h3", "bottom"],
      [".ri-price-current", "top"],
      [".ri-package-divider", "top"],
      [".ri-package-bullets", "top"],
      [".ri-package-book-button", "top"],
      [".ri-package-details-button", "bottom"],
      [".ri-package-guarantee", "top"],
    ];
    for (const [selector, edge] of rows) {
      const values = await edges(selector, edge);
      expect(Math.max(...values) - Math.min(...values), `${selector} ${edge}`).toBeLessThanOrEqual(1);
    }
    const first = await cards.first().boundingBox();
    const last = await cards.last().boundingBox();
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(Math.abs(first.x - (clientWidth - (last.x + last.width)))).toBeLessThanOrEqual(2);
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const box = await card.boundingBox();
      const overflow = await card.evaluate((node) => node.scrollWidth - node.clientWidth);
      const book = await card.locator(".ri-package-book-button").boundingBox();
      const details = await card.locator(".ri-package-details-button").boundingBox();
      expect(box.width).toBeLessThanOrEqual(420);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(book.y + book.height).toBeLessThanOrEqual(details.y);
      for (const button of [".ri-package-book-button", ".ri-package-details-button"]) {
        expect(await card.locator(button).evaluate(textLineCount), `${button} label lines`).toBe(1);
      }
    }
  });

  for (const width of [768, 1440]) {
    test(`${route} keeps excluded features listed at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      const excluded = page.locator(".ri-package-card .ri-package-bullet-excluded");
      expect(await excluded.count()).toBeGreaterThan(0);
      for (const row of await excluded.all()) {
        await expect(row).toBeVisible();
      }
    });
  }

  for (const width of [360, 390]) {
    test(`${route} shows Book above the feature list and hides excluded features at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto(route);
      const cards = page.locator(".ri-package-card");
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const card = cards.nth(index);
        const book = await card.locator(".ri-package-book-button").boundingBox();
        const list = await card.locator(".ri-package-bullets").boundingBox();
        expect(book.y + book.height).toBeLessThanOrEqual(list.y);
        for (const excluded of await card.locator(".ri-package-bullet-excluded").all()) {
          await expect(excluded).toBeHidden();
        }
      }
    });
  }
}
