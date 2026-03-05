const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

const routes = [
  "/",
  "/packages",
  "/reviews",
  "/tools",
  "/faq",
  "/benchmarks",
  "/booking",
  "/payment",
  "/upgrade-xoc",
  "/referrals/login",
  "/referrals/register",
  "/referrals/forgot",
  "/referrals/reset",
];

test.describe("Route smoke", () => {
  for (const route of routes) {
    test(`loads ${route}`, async ({ page }) => {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBeLessThan(400);

      await expect(page.locator("main")).toBeVisible();
      const title = await page.title();
      expect(title.length).toBeGreaterThan(8);

      if (route === "/packages" || route === "/upgrade-xoc") {
        await expect(page.locator("h1")).toHaveCount(1);
      }
    });
  }

  test("unknown route renders not found", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-real-route", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBe(404);
    await expect(page.locator("body")).toContainText(/not found|404/i);
  });
});
