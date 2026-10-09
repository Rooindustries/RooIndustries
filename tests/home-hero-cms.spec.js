const { test, expect } = require("@playwright/test");
const path = require("node:path");
const { HOME_COPY } = require("../src/lib/homeCopy");

const artifactDir = path.resolve("test-results/home-hero-cms");
const fixtureDescription =
  "Synthetic hero description served by the local content fixture.";
const fixtureSubtext = "Synthetic hero subtext with *literal* asterisks.";
const isHeroRequest = (request) =>
  new URL(request.url()).pathname === "/api/content/hero";

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const expectFixtureHero = async (page) => {
  const hero = page.locator("#top");
  await expect(hero.locator("h1")).toContainText("Fixture Hero Heading One");
  await expect(hero.locator("h1")).toContainText("Fixture Hero Heading Two");
  await expect(hero.getByText(fixtureDescription, { exact: true })).toBeVisible();
  await expect(hero.getByText(fixtureSubtext, { exact: true })).toBeVisible();
  await expect(hero.locator(".ri-hero-cta-note")).toContainText("Fixture note one");
  await expect(page.getByText("Legacy Field Must Not Render", { exact: true })).toHaveCount(0);
  await expect(hero.getByRole("link", { name: "Tune My PC", exact: true })).toHaveAttribute("href", "/#packages");
  await expect(hero.getByRole("link", { name: "How It Works", exact: true })).toHaveAttribute("href", "/#how-it-works");
};

test("renders CMS hero in server HTML without JavaScript", async ({ page }) => {
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectFixtureHero(page);
    await page.locator("#top").screenshot({
      path: path.join(artifactDir, `ssr-${name}.png`),
    });
  }
});

test("Markdown uses the same CMS hero copy", async ({ request }) => {
  const response = await request.get("/markdown?path=/");
  expect(response.status()).toBe(200);
  const body = await response.text();
  expect(body).toContain("# Fixture Hero Heading One Fixture Hero Heading Two");
  expect(body).toContain("Synthetic hero description served by the local content fixture\\.");
  expect(body).toContain("Synthetic hero subtext with \\*literal\\* asterisks\\.");
  expect(body).not.toContain("with *literal*");
});

test.describe("hydrated hero", () => {
  test.use({ javaScriptEnabled: true });

  const navigateHome = async (page) => {
    await page.goto("/packages", { waitUntil: "networkidle" });
    await page.evaluate(() => { window.__heroSpaDocument = true; });
    await page.locator('footer a[href="/"]').first().click();
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => window.__heroSpaDocument)).toBe(true);
  };

  test("keeps server hero copy without a client hero request", async ({ page }) => {
    const heroRequests = [];
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (isHeroRequest(request)) heroRequests.push(request.url());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("low-performance-mode")
    );
    await expectFixtureHero(page);
    expect(heroRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((message) =>
      /hydrat|did not match|server rendered HTML|text content does not match/i.test(message)
    )).toEqual([]);
  });

  test("fetches hero copy on SPA navigation home", async ({ page }) => {
    const heroRequest = page.waitForRequest(isHeroRequest);
    await navigateHome(page);
    await heroRequest;
    await expectFixtureHero(page);
    await page.locator("#top").screenshot({
      path: path.join(artifactDir, "spa-nav.png"),
    });
  });

  test("falls back per invalid field while preserving valid CMS copy", async ({ page }) => {
    await page.route("**/api/content/hero", (route) => route.fulfill({
      json: {
        ok: true,
        data: {
          headingLine1: " \t ",
          headingLine2: ["Invalid array heading"],
          description: fixtureDescription,
          subtext: null,
          ctaPrimaryText: 99,
          ctaSecondaryText: "",
          ctaNote: {},
          bullets: [null, "", " \t ", 42],
          headingData1: "Legacy Field Must Not Render",
          ctaNoteIcon: "X",
        },
      },
    }));
    await navigateHome(page);
    const hero = page.locator("#top");
    await expect(hero.getByText(fixtureDescription, { exact: true })).toBeVisible();
    await expect(hero.locator("h1")).toContainText(HOME_COPY.hero.headingLine1);
    await expect(hero.locator("h1")).toContainText(HOME_COPY.hero.headingLine2);
    await expect(hero.getByText(HOME_COPY.hero.subtext, { exact: true })).toBeVisible();
    await expect(hero.locator(".ri-hero-cta-note")).toContainText(HOME_COPY.hero.ctaNote);
    await expect(hero.getByRole("link", { name: "Tune My PC", exact: true })).toHaveAttribute("href", "/#packages");
    await expect(hero.getByRole("link", { name: "How It Works", exact: true })).toHaveAttribute("href", "/#how-it-works");
    await expect(page.getByText("Legacy Field Must Not Render", { exact: true })).toHaveCount(0);
  });

  test("keeps fallback copy when the SPA hero request fails", async ({ page }) => {
    await page.route("**/api/content/hero", (route) => route.fulfill({
      status: 503,
      json: { ok: false, error: "Synthetic hero outage" },
    }));
    const heroResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/content/hero"
    );
    await navigateHome(page);
    expect((await heroResponse).status()).toBe(503);
    await page.waitForLoadState("networkidle");
    const hero = page.locator("#top");
    await expect(hero.locator("h1")).toContainText(HOME_COPY.hero.headingLine1);
    await expect(hero.locator("h1")).toContainText(HOME_COPY.hero.headingLine2);
    await expect(hero.getByText(HOME_COPY.hero.description, { exact: true })).toBeVisible();
    await expect(hero.getByText(HOME_COPY.hero.subtext, { exact: true })).toBeVisible();
  });
});
