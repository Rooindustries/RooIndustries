const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

const routes = [
  "/", "/packages", "/reviews", "/tools", "/faq", "/benchmarks",
  "/booking", "/payment", "/upgrade-xoc", "/downloads/optimizer-pack-v1", "/tourney",
  "/referrals/login", "/referrals/register", "/referrals/forgot", "/referrals/reset",
];
const paymentSmokeData = {
  packageTitle: "Performance Vertex Overhaul",
  packagePrice: "$84.99",
  startTimeUTC: "2099-01-05T04:30:00.000Z",
  displayDate: "Monday, January 5, 2099",
  displayTime: "10:00 AM",
  localTimeZone: "Asia/Kolkata",
  slotHoldId: "hold_smoke_test",
  slotHoldToken: "hold_token_smoke_test",
  slotHoldExpiresAt: "2099-01-05T05:30:00.000Z",
};
const waitForPerformanceProfile = async (page) => {
  await page.waitForFunction(() => document.documentElement.classList.contains("low-performance-mode"), null, { timeout: 10000 });
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test.describe("Route smoke", () => {
  for (const route of routes) {
    test(`loads ${route}`, async ({ page }) => {
      const consoleErrors = [];
      page.on("console", msg => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
      if (route === "/payment") {
        await page.addInitScript(data => sessionStorage.setItem("checkout_booking_state", JSON.stringify(data)), paymentSmokeData);
        await page.route("**/api/payment/providers", request => request.fulfill({ json: { ok: true, providers: { dodo: { enabled: false, mode: "test" }, paypal: { enabled: false }, razorpay: { enabled: false } } } }));
      }
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBeLessThan(400);
      await expect(page.locator("main")).toBeVisible();
      expect((await page.title()).length).toBeGreaterThan(8);
      if (route === "/packages" || route === "/upgrade-xoc") await expect(page.locator("h1")).toHaveCount(1);
      if (route === "/") {
        await expect(page.getByRole("heading", { name: /More FPS\. Less Input Lag\./ })).toBeVisible();
        await expect(page.locator(".home-tourney-announcement")).toHaveCount(0);
        await expect(page.locator("#top").getByRole("link", { name: /tune my pc/i })).toHaveAttribute("href", "/#packages");
      }
      if (route === "/booking") await expect(page.getByText("Select a Date and Time for Your Session")).toBeVisible();
      if (route === "/payment") {
        await expect(page.getByRole("heading", { name: /complete payment/i })).toBeVisible();
        await expect(page.getByText("Performance Vertex Overhaul", { exact: true }).first()).toBeVisible();
        expect(new URL(page.url()).searchParams.has("data")).toBe(false);
      }
      if (route === "/tourney") {
        await expect(page.locator('main[data-tourney-state="results"]')).toBeVisible();
        await expect(page.getByRole("heading", { name: "6v6 Legacy Series", exact: true })).toBeVisible();
        await expect(page.getByRole("status")).toContainText("Event complete");
        await expect(page.getByRole("heading", { name: "Our winners" })).toBeVisible();
        const podium = page.getByRole("list", { name: "Tournament podium" });
        await expect(podium.getByRole("listitem")).toHaveCount(3);
        await expect(podium.getByRole("heading", { name: "GetSkii’d" })).toBeVisible();
        await expect(podium.getByRole("heading", { name: "Rents Due" })).toBeVisible();
        await expect(page.locator(".tourney-final-score")).toHaveAttribute("aria-label", "Grand final: GetSkii’d 4, Rents Due 1");
        await expect(page.getByRole("heading", { name: "Stay Tuned." })).toBeVisible();
        await expect(page.getByRole("link", { name: /sign in|register/i })).toHaveCount(0);
        await expect(page.getByRole("switch")).toBeVisible();
      }
      if (route === "/booking" || route === "/payment") {
        await page.waitForTimeout(750);
        expect(consoleErrors.filter(entry => /hydration|getServerSnapshot|react error #418/i.test(entry))).toEqual([]);
      }
    });
  }

  for (const route of ["login", "register", "forgot", "reset", "manage"]) {
    test(`retired tourney ${route} returns 404`, async ({ page }) => {
      const response = await page.goto(`/tourney/${route}`);
      expect(response?.status()).toBe(404);
      await expect(page.locator("body")).toContainText(/not found|404/i);
    });
  }
  for (const route of ["bracket", "roster"]) {
    test(`legacy tourney ${route} redirects to results`, async ({ page }) => {
      const response = await page.goto(`/tourney/${route}`);
      expect(response?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe("/tourney");
      await expect(page.locator('main[data-tourney-state="results"]')).toBeVisible();
    });
  }
  test("unknown route renders not found", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-real-route");
    expect(response?.status()).toBe(404);
    await expect(page.locator("body")).toContainText(/not found|404/i);
  });
  test("home desktop exposes the document scrollbar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await page.goto("/");
    const metrics = await page.evaluate(() => {
      const root = document.documentElement, body = document.body;
      return { height: root.scrollHeight, viewport: innerHeight, overflow: getComputedStyle(root).overflowY, bodyOverflow: getComputedStyle(body).overflowY, scrollbar: getComputedStyle(root).scrollbarWidth, bodyScrollbar: getComputedStyle(body).scrollbarWidth };
    });
    expect(metrics.height).toBeGreaterThan(metrics.viewport);
    for (const value of [metrics.overflow, metrics.bodyOverflow]) expect(value).not.toBe("hidden");
    for (const value of [metrics.scrollbar, metrics.bodyScrollbar]) expect(value).not.toBe("none");
  });
  test("completed tourney mobile conversion and podium fit", async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 }); await page.goto("/tourney"); await waitForPerformanceProfile(page);
      await expect(page.locator(".tourney-brand-copy")).toBeHidden();
      await expect(page.getByRole("link", { name: "Get your PC Optimized" })).toBeVisible();
      await expect(page.getByRole("switch")).toBeVisible();
      const metrics = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, boxes: [...document.querySelectorAll(".tourney-podium-finish,.tourney-nav .nav-cta,[role=switch]")].map(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }) }));
      expect(metrics.documentWidth, `${width}px document overflow`).toBeLessThanOrEqual(width + 1);
      expect(metrics.boxes).toHaveLength(5);
      for (const box of metrics.boxes) { expect(box.width).toBeGreaterThan(0); expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width + 1); }
    }
  });
  test("home mobile navbar tagline fits narrow phones", async ({ page }) => {
    for (const width of [320, 340, 360, 375, 390]) {
      await page.setViewportSize({ width, height: 844 }); await page.goto("/"); await waitForPerformanceProfile(page);
      const metrics = await page.evaluate(() => {
        const nav = document.querySelector(".site-nav");
        const tagline = [...(nav?.querySelectorAll("div") || [])].find(node => node.textContent?.trim() === "Precision Performance Engineering");
        const controls = nav?.querySelector(".nav-cta")?.parentElement;
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, overflow: tagline.scrollWidth > tagline.clientWidth + 1, taglineRight: tagline.getBoundingClientRect().right, controlsRight: controls.getBoundingClientRect().right };
      });
      expect(metrics.overflow, `${width}px tagline overflow`).toBe(false);
      expect(metrics.taglineRight).toBeLessThan(metrics.controlsRight);
      expect(metrics.controlsRight).toBeLessThanOrEqual(width + 1);
      expect(metrics.documentWidth).toBeLessThanOrEqual(width + 1);
    }
  });
  test("tourney theme switch persists both themes", async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem("smoke-theme-seeded")) { localStorage.setItem("roo-theme", "default"); sessionStorage.setItem("smoke-theme-seeded", "1"); } });
    await page.goto("/tourney");
    const toggle = page.getByRole("switch"); await expect(toggle).toHaveAttribute("aria-checked", "false");
    expect((await page.locator(".tourney-page").evaluate(node => getComputedStyle(node).getPropertyValue("--tourney-accent").trim())).toLowerCase()).toBe("#22d3ee");
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-checked", "true"); await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await page.locator(".tourney-page").evaluate(node => getComputedStyle(node).getPropertyValue("--tourney-accent").trim())).toLowerCase()).toBe("#d4af37");
    await page.reload(); await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click(); await expect(toggle).toHaveAttribute("aria-checked", "false"); await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
    expect((await page.locator(".tourney-page").evaluate(node => getComputedStyle(node).getPropertyValue("--tourney-accent").trim())).toLowerCase()).toBe("#22d3ee");
    await page.reload(); await expect(toggle).toHaveAttribute("aria-checked", "false"); await expect(page.locator("html")).toHaveAttribute("data-theme", "default");
  });
});
