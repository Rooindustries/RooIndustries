const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

const missingPath = "/does-not-exist-probe";
const campaignPath = `${missingPath}?utm_source=x`;
const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const address = (page) => page.evaluate(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);

test.use({ javaScriptEnabled: true, reducedMotion: "reduce", trace: "off", video: "off" });

test.beforeEach(async ({ page, flow }) => {
  void flow;
  page.__missingPage = { responses: [], messages: [], steps: [] };
  page.on("response", response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      page.__missingPage.responses.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("pageerror", error => page.__missingPage.messages.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) {
      page.__missingPage.messages.push(`${message.type()}: ${message.text()}`);
    }
  });
});

test.afterEach(async ({ page }, testInfo) => {
  const state = await page.evaluate(() => ({
    address: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    background: JSON.parse(sessionStorage.getItem("flow_background_location")),
    routeKey: document.querySelector("[data-route-key]")?.getAttribute("data-route-key"),
  }));
  const artifact = testInfo.outputPath("missing-page.json");
  await fs.writeFile(artifact, JSON.stringify({ ...page.__missingPage, ...state }, null, 2));
  await testInfo.attach("missing-page", { path: artifact, contentType: "application/json" });
});

test("a missing page keeps its requested path and campaign after hydration", async ({ page }) => {
  const response = await page.goto(campaignPath);
  expect(response.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect.poll(() => address(page)).toBe(campaignPath);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location")))).toMatchObject({
    pathname: missingPath,
    search: "?utm_source=x",
  });
  await expect(page.locator("[data-route-key]")).toHaveAttribute("data-route-key", "/__missing__");
});

test("going home and back restores the requested missing page in the same document", async ({ page }) => {
  await page.goto(campaignPath);
  await hydrated(page);
  await page.evaluate(() => { window.__missingDocument = true; });
  page.__missingPage.steps.push({ step: "missing page", address: await address(page) });
  await page.getByRole("link", { name: "Back to Home", exact: true }).click();
  await expect(page.locator("#top h1")).toBeVisible();
  await expect.poll(() => address(page)).toBe("/");
  page.__missingPage.steps.push({ step: "home", address: await address(page) });
  await page.goBack();
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  page.__missingPage.steps.push({ step: "back", address: await address(page) });
  await expect.poll(() => address(page)).toBe(campaignPath);
  expect(await page.evaluate(() => window.__missingDocument)).toBe(true);
});

test("a missing page keeps its path when an unsupported hash is removed", async ({ page }) => {
  const response = await page.goto(`${missingPath}#x`);
  expect(response.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect.poll(() => address(page)).toBe(missingPath);
});

test("a missing page hydrates without warnings", async ({ page }) => {
  await page.goto(campaignPath);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await page.waitForTimeout(1000);
  expect(page.__missingPage.messages.filter(text => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(text))).toEqual([]);
});

test("a sensitive query redirects to the same missing path without its token", async ({ page, request }) => {
  const response = await request.get(`${missingPath}?token=abc&utm_source=x`, { headers: { accept: "text/html" }, maxRedirects: 0 });
  page.__missingPage.steps.push({ step: "sensitive redirect", status: response.status(), location: response.headers().location });
  expect(response.status()).toBe(307);
  const location = new URL(response.headers().location);
  expect(`${location.pathname}${location.search}`).toBe(campaignPath);
  const destination = await page.goto(`${location.pathname}${location.search}`);
  expect(destination.status()).toBe(404);
  await hydrated(page);
  await expect.poll(() => address(page)).toBe(campaignPath);
});

test("closing booking restores a saved missing page and its campaign", async ({ page }) => {
  await page.goto(campaignPath);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  page.__missingPage.steps.push({ step: "missing page", address: await address(page) });
  await page.goto("/booking");
  const dialog = page.getByRole("dialog", { name: "Schedule your session", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#main-content").getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect.poll(() => address(page)).toBe(campaignPath);
});

test.describe("reservation recovery", () => {
  test.use({ timezoneId: "Asia/Kolkata" });

  for (const [pathname, heading] of [["/benchmarks", "Performance Benchmarks"], [missingPath, "404"]]) {
    test(`continuing a reservation keeps the ${pathname} page mounted behind booking`, async ({ page, flow }) => {
      await flow.reserve();
      const requested = `${pathname}?utm_source=x`;
      await page.goto(requested);
      await hydrated(page);
      await expect(page.locator("#main-content").getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue booking", exact: true })).toBeVisible();
      page.__missingPage.steps.push(await page.evaluate(() => {
        window.__reservationBackground = document.querySelector("#main-content [data-route-key]");
        return {
          step: "before booking",
          address: `${window.location.pathname}${window.location.search}`,
          routeKey: window.__reservationBackground.getAttribute("data-route-key"),
        };
      }));
      await page.getByRole("button", { name: "Continue booking", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Schedule your session", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.locator("#main-content").getByRole("heading", { name: heading, exact: true })).toBeVisible();
      const background = await page.evaluate(() => ({
        step: "booking open",
        same: document.querySelector("#main-content [data-route-key]") === window.__reservationBackground,
        connected: window.__reservationBackground.isConnected,
        routeKey: document.querySelector("#main-content [data-route-key]").getAttribute("data-route-key"),
        stored: JSON.parse(sessionStorage.getItem("flow_background_location")),
      }));
      page.__missingPage.steps.push(background);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => address(page)).toBe(requested);
      await expect(page.locator("#main-content").getByRole("heading", { name: heading, exact: true })).toBeVisible();
      expect(background.same).toBe(true);
      expect(background.connected).toBe(true);
      expect(background.stored).toMatchObject({ pathname, search: "?utm_source=x" });
    });
  }
});
