const { test, expect } = require("@playwright/test");

const routes = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/tools",
  "/faq",
  "/contact",
  "/terms",
  "/privacy",
  "/meet-the-team",
  "/referrals/login",
  "/referrals/register",
];

test.describe("Non-JS crawlability", () => {
  for (const route of routes) {
    test(`renders meaningful HTML for ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const heading = page.locator("h1, h2, h3");
      await expect(heading.first()).toBeVisible();

      const title = await page.title();
      expect(title.length).toBeGreaterThan(10);

      const desc = await page
        .locator('meta[name="description"]')
        .first()
        .getAttribute("content");
      expect((desc || "").length).toBeGreaterThan(40);

      const bodyText = (await page.locator("body").innerText()).replace(
        /\s+/g,
        " "
      );
      expect(bodyText.length).toBeGreaterThan(120);
    });
  }
});
