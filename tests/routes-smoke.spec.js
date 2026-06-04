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
  "/tourney",
  "/tourney/bracket",
  "/tourney/roster",
  "/tourney/register",
  "/tourney/login",
  "/tourney/forgot",
  "/tourney/reset",
  "/tourney/manage",
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

      if (route === "/tourney") {
        await expect(
          page.getByRole("heading", { name: /6v6 Legacy Series/i })
        ).toBeVisible();
        await expect(page.getByText("Tournament access locked")).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
        await expect(page.getByText("Match windows")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Bracket" })).toBeVisible();
        await expect(page.getByText("Bracket access", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("link", { name: "Sign in", exact: true })
        ).toBeVisible();
      }

      if (route === "/tourney/login") {
        await expect(page.getByRole("heading", { name: "Sign in." })).toBeVisible();
        await expect(
          page.getByLabel("Tournament Discord username or email")
        ).toBeVisible();
        await expect(page.getByLabel("Tournament password")).toBeVisible();
        await expect(page.getByLabel("Remember me")).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
      }

      if (route === "/tourney/register") {
        await expect(page.getByLabel("Discord Username")).toBeVisible();
        await expect(page.getByLabel("Display Name")).toBeVisible();
        await expect(page.getByLabel("Timezone")).toBeVisible();
        await expect(page.getByLabel("Extra notes")).toBeVisible();
        await expect(page.getByLabel("Twitch Username")).toBeVisible();
        await expect(page.getByText("twitch.tv/")).toBeVisible();
        await expect(page.getByLabel("Username", { exact: true })).toHaveCount(0);
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

  test("tourney mobile navbar uses dropdown", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto("/tourney", {
      waitUntil: "domcontentloaded",
    });

    expect(response?.status()).toBeLessThan(400);

    const nav = page.locator(".tourney-nav");
    await expect(nav.locator(".tourney-brand-copy")).toBeHidden();
    await expect(nav.locator(".tourney-links")).toBeHidden();
    await expect(nav.locator(".tourney-mobile-menu")).toBeVisible();
    await expect(
      nav.getByRole("link", { name: "Sign in", exact: true })
    ).toBeVisible();
    await expect(nav.locator(".tourney-mobile-panel")).toBeHidden();

    const signInBox = await nav
      .getByRole("link", { name: "Sign in", exact: true })
      .boundingBox();
    const triggerBox = await nav.locator(".tourney-mobile-trigger").boundingBox();
    expect(signInBox?.x ?? 0).toBeLessThan(triggerBox?.x ?? 0);

    await nav.locator(".tourney-mobile-trigger").click();
    await expect(
      nav.locator(".tourney-mobile-panel").getByRole("link", { name: "Register" })
    ).toBeVisible();
    await expect(
      nav
        .locator(".tourney-mobile-panel")
        .getByRole("link", { name: "Tourney Information" })
    ).toBeVisible();

    const navBox = await nav.boundingBox();
    const panelBox = await nav.locator(".tourney-mobile-panel").boundingBox();
    const navBottom = (navBox?.y ?? 0) + (navBox?.height ?? 0);
    expect(panelBox?.x ?? -1).toBeLessThanOrEqual(1);
    expect(panelBox?.width ?? 0).toBeGreaterThanOrEqual(390);
    expect(panelBox?.y ?? 0).toBeLessThanOrEqual(navBottom + 1);
    expect(panelBox?.y ?? 0).toBeGreaterThanOrEqual(navBottom - 6);

    const backdropFilter = await nav
      .locator(".tourney-mobile-panel")
      .evaluate(
        (element) =>
          getComputedStyle(element).backdropFilter ||
          getComputedStyle(element).webkitBackdropFilter
      );
    expect(backdropFilter).toContain("blur(34px)");
  });
});
