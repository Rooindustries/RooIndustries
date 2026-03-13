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

const paymentSmokeData = encodeURIComponent(
  JSON.stringify({
    packageTitle: "Performance Vertex Overhaul",
    packagePrice: "$84.99",
    startTimeUTC: "2099-01-05T04:30:00.000Z",
    displayDate: "Monday, January 5, 2099",
    displayTime: "10:00 AM",
    localTimeZone: "Asia/Kolkata",
    slotHoldId: "hold_smoke_test",
    slotHoldToken: "hold_token_smoke_test",
    slotHoldExpiresAt: "2099-01-05T05:30:00.000Z",
  })
);

test.describe("Route smoke", () => {
  for (const route of routes) {
    test(`loads ${route}`, async ({ page }) => {
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          consoleErrors.push(msg.text());
        }
      });

      const routeUrl =
        route === "/payment" ? `/payment?data=${paymentSmokeData}` : route;
      const response = await page.goto(routeUrl, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.status()).toBeLessThan(400);

      await expect(page.locator("main")).toBeVisible();
      const title = await page.title();
      expect(title.length).toBeGreaterThan(8);

      if (route === "/packages" || route === "/upgrade-xoc") {
        await expect(page.locator("h1")).toHaveCount(1);
      }

      if (route === "/booking") {
        await expect(
          page.getByText("Select a Date and Time for Your Session")
        ).toBeVisible();
      }

      if (route === "/payment") {
        await expect(
          page.getByRole("heading", { name: /complete payment/i })
        ).toBeVisible();
      }

      if (route === "/booking" || route === "/payment") {
        await page.waitForTimeout(750);
        expect(
          consoleErrors.filter((entry) =>
            /hydration|getServerSnapshot|react error #418/i.test(entry)
          )
        ).toEqual([]);
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
