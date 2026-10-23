const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, viewport: { width: 390, height: 844 }, serviceWorkers: "block", trace: process.env.CI ? "retain-on-failure" : "off", video: "off" });
test.setTimeout(45000);

test.beforeEach(async ({ page, flow }) => {
  void flow;
  page.__routeErrors = [];
  page.on("pageerror", error => page.__routeErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") page.__routeErrors.push(message.text());
  });
});

const holdChunk = async (page, marker) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const chunks = [];
  await page.route("**/_next/static/chunks/**", async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes(marker)) {
      chunks.push(route.request().url());
      await gate;
    }
    await route.fulfill({ response, body });
  });
  return { chunks, release };
};

const record = async (page, testInfo, value) => {
  const file = testInfo.outputPath("flow-background.json");
  await fs.writeFile(file, JSON.stringify({ ...value, errors: page.__routeErrors }, null, 2));
  await testInfo.attach("flow-background", { path: file, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("flow-background.png"), animations: "disabled" });
};

for (const [background, heading] of [["/reviews", "Community Reviews"], ["/benchmarks", "Performance Benchmarks"]]) {
  for (const [route, modalHeading] of [["/booking", "Schedule Your Session"], ["/payment", "Complete Payment"]]) {
    test(`${route} restores the cold ${background} background without losing its dialog`, async ({ page, context }, testInfo) => {
      await context.addInitScript(pathname => {
        sessionStorage.setItem("flow_background_location", JSON.stringify({ pathname, search: "", hash: "" }));
      }, background);
      const delayed = await holdChunk(page, heading);
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await expect.poll(() => delayed.chunks.length).toBeGreaterThan(0);
        await page.waitForTimeout(500);
        await page.screenshot({ path: testInfo.outputPath("background-pending.png"), animations: "disabled" });
        expect(page.__routeErrors).toEqual([]);
        await expect(page.getByRole("heading", { name: "We couldn’t load this page.", exact: true })).toHaveCount(0);
        await expect(page.getByRole("dialog", { name: "Schedule your session", exact: true })).toBeVisible({ timeout: 4000 });
        delayed.release();
        await expect(page.locator("#main-content").getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expect(page.getByRole("dialog").getByRole("heading", { name: modalHeading, exact: true })).toBeVisible();
        expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location")))).toMatchObject({ pathname: background });
        await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${background}$`));
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.locator("#main-content").getByRole("heading", { name: heading, exact: true })).toBeVisible();
        expect(page.__routeErrors).toEqual([]);
      } finally {
        delayed.release();
        await page.unrouteAll({ behavior: "wait" });
        await record(page, testInfo, { route, background, delayedChunks: delayed.chunks });
      }
    });
  }
}

for (const origin of ["/packages", "/reviews"]) {
  test(`${origin} entry opens booking and restores its background on history navigation`, async ({ page }, testInfo) => {
    await page.goto(origin);
    await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
    await page.evaluate(() => { window.__flowDocument = true; });
    if (origin === "/reviews") {
      await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await page.locator('#mobile-site-menu a[href="/#packages"]').click();
      await expect(page).toHaveURL(/\/#packages$/);
    }
    const background = origin === "/packages" ? "/packages" : "/";
    const delayed = await holdChunk(page, "Schedule Your Session");
    try {
      await page.locator('a[href="/booking"]').first().click();
      await expect.poll(() => delayed.chunks.length).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      expect(page.__routeErrors).toEqual([]);
      await expect(page.getByRole("heading", { name: "We couldn’t load this page.", exact: true })).toHaveCount(0);
      delayed.release();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("dialog").getByRole("heading", { name: "Schedule Your Session", exact: true })).toBeVisible();
      await expect(page.locator('#main-content a[href="/booking"]').first()).toBeAttached();
      expect(await page.evaluate(() => window.__flowDocument)).toBe(true);
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location")))).toMatchObject({ pathname: background });
      await page.goBack();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page).toHaveURL(background === "/" ? /\/#packages$/ : /\/packages$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("dialog").getByRole("heading", { name: "Schedule Your Session", exact: true })).toBeVisible();
      expect(await page.evaluate(() => window.__flowDocument)).toBe(true);
      expect(page.__routeErrors).toEqual([]);
    } finally {
      delayed.release();
      await page.unrouteAll({ behavior: "wait" });
      await record(page, testInfo, { origin, background, delayedChunks: delayed.chunks });
    }
  });
}

test.describe("payment step", () => {
  test.use({ timezoneId: "Asia/Kolkata" });

  test("an expired slot after reloading the payment step does not trap the customer in the booking dialog", async ({ page, flow }) => {
    flow.state.holdMs = 15000;
    await flow.review();
    await flow.payment();
    await page.evaluate(() => sessionStorage.setItem("flow_background_location", JSON.stringify({ pathname: "/reviews", search: "", hash: "" })));
    await page.reload();
    await expect(page.locator("#main-content").getByRole("heading", { name: "Community Reviews", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 25000 });
    await expect(page).toHaveURL(url => url.pathname === "/");
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location")).pathname)).toBe("/");
  });

  test("a payment step opened in a second tab does not trap the customer when its slot expires", async ({ page, context, flow }) => {
    flow.state.holdMs = 15000;
    await flow.review();
    await flow.payment();
    const checkout = await page.evaluate(() => Object.entries(sessionStorage));
    const other = await context.newPage();
    await other.goto("/__test/checkout-handoff");
    await other.evaluate(entries => entries.forEach(([key, value]) => sessionStorage.setItem(key, value)), checkout);
    await other.goto("/payment");
    await expect(other.getByRole("dialog").getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect(other.getByRole("dialog")).toHaveCount(0, { timeout: 25000 });
    await expect(other).toHaveURL(url => url.pathname === "/");
    await expect.poll(() => other.evaluate(() => JSON.parse(sessionStorage.getItem("flow_background_location")).pathname)).toBe("/");
  });
});
