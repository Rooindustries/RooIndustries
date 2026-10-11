const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
]) {
  test.describe(name, () => {
    test.use({ viewport });

    test("package prices expose current and previous prices as text", async ({ page }, testInfo) => {
      await page.goto("/packages", { waitUntil: "networkidle" });
      const prices = page.locator(".ri-package-card .ri-price-current");
      await expect(prices).toHaveCount(2);

      for (const [index, text] of [
        [0, "Price $84.99"],
        [1, "Price $99.95, previous price $149.95"],
      ]) {
        const price = prices.nth(index).locator("..");
        await expect(price).not.toHaveAttribute("aria-label");
        await expect(price).toMatchAriaSnapshot(`- text: ${text}`);
        await expect(price.locator(".ri-price-current")).toHaveAttribute("aria-hidden", "true");
      }

      await page.screenshot({ path: testInfo.outputPath("package-prices.png"), fullPage: true });
    });

    test("the reviews region is reachable by keyboard", async ({ page }, testInfo) => {
      await page.goto("/", { waitUntil: "networkidle" });
      const reviews = page.getByRole("region", { name: "Player reviews", exact: true });
      await expect(reviews).toHaveAttribute("tabindex", "0");
      await reviews.scrollIntoViewIfNeeded();
      await reviews.focus();
      await expect(reviews).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(reviews).not.toBeFocused();
      await page.keyboard.press("Tab");
      await expect(reviews).toBeFocused();

      await reviews.screenshot({ path: testInfo.outputPath("keyboard-reviews.png") });
    });

  });
}
