const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

const missingPath = "/does-not-exist-probe";
const campaignPath = `${missingPath}?utm_source=x`;
const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const address = (page) => page.evaluate(() => `${window.location.pathname}${window.location.search}${window.location.hash}`);

test.use({ javaScriptEnabled: true, reducedMotion: "reduce", actionTimeout: 10000, navigationTimeout: 20000, trace: "off", video: "off" });

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
  })).catch(error => ({ address: page.url(), captureError: error.message }));
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
  await expect(page.locator("[data-route-key]")).toHaveAttribute("data-route-key", missingPath);
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
  const location = new URL(response.headers().location, response.url());
  expect(`${location.pathname}${location.search}`).toBe(campaignPath);
  const destination = await page.goto(`${location.pathname}${location.search}`);
  expect(destination.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect.poll(() => address(page)).toBe(campaignPath);
});

test("a relative sensitive-query redirect resolves to the requested missing page", async ({ page }) => {
  const requested = `${missingPath}?token=abc&utm_source=x`;
  await page.route(`**${requested}`, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(307);
    await route.fulfill({ response, headers: { ...response.headers(), location: campaignPath } });
  });
  const [redirect, destination] = await Promise.all([
    page.waitForResponse(response => response.status() === 307 && new URL(response.url()).searchParams.has("token")),
    page.goto(requested),
  ]);
  expect(destination.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  const locationHeader = (await redirect.allHeaders()).location;
  page.__missingPage.steps.push({ step: "relative sensitive redirect", status: redirect.status(), location: locationHeader, responseUrl: redirect.url() });
  const location = new URL(locationHeader, redirect.url());
  expect(`${location.pathname}${location.search}`).toBe(campaignPath);
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
        window.__reservationPage = document.querySelector("#main-content h1");
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
      const closed = await page.evaluate(() => ({
        step: "booking closed",
        same: document.querySelector("#main-content [data-route-key]") === window.__reservationBackground,
        connected: window.__reservationBackground.isConnected,
        samePage: document.querySelector("#main-content h1") === window.__reservationPage,
        pageConnected: window.__reservationPage.isConnected,
        address: `${window.location.pathname}${window.location.search}`,
      }));
      page.__missingPage.steps.push(closed);
      expect(background.same).toBe(true);
      expect(background.connected).toBe(true);
      expect(background.stored).toMatchObject({ pathname, search: "?utm_source=x" });
      expect(closed).toMatchObject({ same: true, connected: true, samePage: true, pageConnected: true });
    });
  }

  for (const prefix of ["/booking", "/payment", "/payment-success", "/thank-you"]) {
    test(`a missing ${prefix} subpath stays outside booking through history and reservation recovery`, async ({ page, flow }) => {
      await flow.reserve();
      const requested = `${prefix}/does-not-exist?utm_source=x`;
      const response = await page.goto(requested);
      expect(response.status()).toBe(404);
      await hydrated(page);
      await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => address(page)).toBe(requested);
      page.__missingPage.steps.push({ step: "missing subpath", address: await address(page) });
      await page.getByRole("link", { name: "Back to Home", exact: true }).click();
      await expect(page.locator("#top h1")).toBeVisible();
      await page.goBack();
      await expect.poll(() => address(page)).toBe(requested);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      page.__missingPage.steps.push({ step: "back to missing subpath", address: await address(page) });
      await page.getByRole("button", { name: "Continue booking", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Schedule your session", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => address(page)).toBe(requested);
      await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
      page.__missingPage.steps.push({ step: "closed on missing subpath", address: await address(page) });
    });
  }

  for (const requested of ["/?ref=friend&utm_source=discord", campaignPath]) {
    test(`closing a resumed payment after reload restores ${requested}`, async ({ page, flow }) => {
      await page.route("**/api/payment/status", route => route.fulfill({ json: { ok: true, status: "started", provider: "dodo" } }));
      await flow.review();
      await flow.payment();
      await page.getByRole("button", { name: "Pay your way", exact: true }).click();
      await expect(page).toHaveURL(/\/__test\/checkout-handoff$/);
      await page.evaluate(() => {
        const hold = JSON.parse(sessionStorage.getItem("my_slot_hold"));
        sessionStorage.setItem("my_slot_hold", JSON.stringify({ ...hold, phase: "payment_pending" }));
      });
      await page.goto(requested);
      await hydrated(page);
      await expect.poll(() => address(page)).toBe(requested);
      await page.getByRole("button", { name: "Return to payment", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      page.__missingPage.steps.push({ step: "payment resumed", background: await page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location"))) });
      await page.reload();
      await hydrated(page);
      await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      page.__missingPage.steps.push({ step: "payment closed after reload", address: await address(page) });
      await expect.poll(() => address(page)).toBe(requested);
      await expect(requested.startsWith("/?") ? page.locator("#top h1") : page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
    });
  }
});

test("a wrong-case page renders the server not-found page on its initial entry", async ({ page }) => {
  const response = await page.goto("/FAQ");
  expect(response.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect(page.locator("#main-content h1")).toHaveText("404");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => address(page)).toBe("/FAQ");
});

test("a missing page ignores supplied request-location headers", async ({ page }) => {
  await page.setExtraHTTPHeaders({ "x-roo-request-path": "/faq", "x-roo-request-search": "?utm_source=forged" });
  const response = await page.goto(campaignPath);
  expect(response.status()).toBe(404);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect(page.locator("[data-route-key]")).toHaveAttribute("data-route-key", missingPath);
  await expect.poll(() => address(page)).toBe(campaignPath);
});
