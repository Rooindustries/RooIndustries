const { test, expect } = require("@playwright/test");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  throw new Error("BASE_URL is required for footer tests.");
}

test.use({ javaScriptEnabled: true });

const PRIMARY_HREFS = ["/packages", "/faq", "/contact", "/BIOSGuide", "/tools", "/about"];

for (const [width, height, singleRow] of [
  [1440, 900, true],
  [1024, 768, true],
  [390, 844, false],
]) {
  test(`footer stays compact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${BASE_URL}/packages`, { waitUntil: "networkidle" });
    const footer = page.locator("footer").last();
    await footer.scrollIntoViewIfNeeded();

    const nav = footer.locator("nav");
    const hrefs = await nav.locator("a").evaluateAll((links) =>
      links.map((link) => link.getAttribute("href"))
    );
    expect(hrefs).toEqual(PRIMARY_HREFS);

    const tops = await nav.locator("a").evaluateAll((links) =>
      links.map((link) => Math.round(link.getBoundingClientRect().top))
    );
    if (singleRow) expect(new Set(tops).size).toBe(1);
    else expect(new Set(tops).size).toBeLessThanOrEqual(2);

    for (const href of ["/privacy", "/terms"]) {
      const link = footer.locator(`a[href="${href}"]`);
      await expect(link).toBeVisible();
      expect(await link.evaluate((el) => el.getClientRects().length)).toBe(1);
    }
    await expect(footer.getByRole("link", { name: "Review us on Trustpilot" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "Discord" })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await footer.screenshot({ path: `test-results/footer-${width}.png` });
  });
}
