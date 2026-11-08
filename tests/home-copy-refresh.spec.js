const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

const footerLink = (page, href) => page.locator(`footer a[href="${href}"]`).first();
const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const controlContent = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const returnHome = async (page) => {
  await footerLink(page, "/terms").click();
  await expect(page).toHaveURL(/\/terms$/);
  await page.clock.fastForward("01:01");
  await footerLink(page, "/").click();
  await expect(page).toHaveURL(/\/$/);
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test.afterEach(async ({ page, request, baseURL }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await controlContent(request, baseURL, { reset: true });
});

test("returning home through site links refreshes copy edited in the CMS", async ({ page, request, baseURL }) => {
  await page.clock.install();
  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  await page.evaluate(() => { window.__copyDocument = true; });
  await controlContent(request, baseURL, {
    patch: { _id: "tooling-hero", headingLine1: "Published homepage heading" },
  });
  await controlContent(request, baseURL, {
    patch: { _id: "tooling-referralBox", heading: "Published referral heading" },
  });
  await returnHome(page);
  await expect(page.locator("#top h1")).toContainText("Published homepage heading");
  await page.locator("footer").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".ri-referral-heading")).toHaveText("Published referral heading");
  expect(await page.evaluate(() => window.__copyDocument)).toBe(true);
});

for (const [label, data] of [["missing", null], ["wrong-shaped", []]]) {
  test(`a ${label} refresh keeps the published copy`, async ({ page }) => {
    await page.clock.install();
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
    await page.route("**/api/content/hero", route => route.fulfill({ json: { ok: true, data, revision: 999 } }));
    await returnHome(page);
    await finished;
    await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  });
}

test("an API copy older than the server copy cannot replace it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await page.route("**/api/content/hero", route => route.fulfill({
    json: { ok: true, data: { headingLine1: "Older API heading" }, revision: 0 },
  }));
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
  await returnHome(page);
  await finished;
  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
});

test("an unlabelled API copy cannot replace a newer cached revision", async ({ page }) => {
  await page.clock.install();
  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  let revision = 999;
  await page.route("**/api/content/hero", route => route.fulfill({
    json: { ok: true, data: { headingLine1: revision ? "Newer cached heading" : "Unlabelled heading" }, revision },
  }));
  await returnHome(page);
  await expect(page.locator("#top h1")).toContainText("Newer cached heading");
  revision = null;
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
  await returnHome(page);
  await finished;
  await expect(page.locator("#top h1")).toContainText("Newer cached heading");
});
