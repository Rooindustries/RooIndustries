const { test, expect, devices } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const productionOrigin = "https://www.rooindustries.com";
const homeSectionPaths = new Set([
  "/api/content/reviews",
  "/api/content/about",
  "/api/content/services",
  "/api/content/packages-list",
  "/api/content/packages-settings",
  "/api/content/how-it-works",
  "/api/content/supported-games",
  "/api/content/faq-settings",
  "/api/content/faq-questions",
]);
const artifactDir = path.resolve("test-results/home-performance");
const summary = { baseUrl: null, scenarios: [] };
const persistSummary = () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const filename = path.join(artifactDir, "summary.json");
  const persisted = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, "utf8")) : { baseUrl: summary.baseUrl, scenarios: [] };
  persisted.baseUrl = summary.baseUrl;
  for (const scenario of summary.scenarios) {
    const index = persisted.scenarios.findIndex((entry) => entry.name === scenario.name);
    if (index === -1) persisted.scenarios.push(scenario);
    else persisted.scenarios[index] = scenario;
  }
  fs.writeFileSync(filename, `${JSON.stringify(persisted, null, 2)}\n`);
};

test.use({ javaScriptEnabled: true });
test.beforeAll(({}, testInfo) => {
  if (testInfo.workerIndex === 0) {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
});

const withScenario = async (browser, testInfo, baseURL, options, run) => {
  const target = new URL(baseURL);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", process.env.ROO_TEST_HOST].includes(target.hostname)) {
    throw new Error("Home performance tests require a local fixture server.");
  }
  summary.baseUrl = baseURL;
  const context = await browser.newContext({
    javaScriptEnabled: true,
    serviceWorkers: "block",
    ...options,
  });
  const scenario = { name: testInfo.title, requests: [], status: "running", interacted: false };
  summary.scenarios.push(scenario);
  let navigationStart = performance.now();
  await context.addInitScript(() => {
    window.__homePerformanceInteractions = [];
    for (const type of ["pointerdown", "pointermove", "keydown", "touchstart", "scroll", "wheel", "click"]) {
      window.addEventListener(type, (event) => {
        window.__homePerformanceInteractions.push({ type, ms: performance.now(), trusted: event.isTrusted, scrollX: window.scrollX, scrollY: window.scrollY });
      }, { capture: true, passive: true });
    }
  });
  context.on("request", (request) => {
    scenario.requests.push({
      url: request.url(),
      msSinceNavigation: Math.round(performance.now() - navigationStart),
      phase: scenario.interacted ? "after interaction" : "before interaction",
    });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "widget.intercom.io") {
      await route.fulfill({
        contentType: "application/javascript",
        body: "window.__fixtureIntercomLoaded = true;",
      });
    } else if (
      ["js.intercomcdn.com", "api-iam.intercom.io"].includes(url.hostname) ||
      url.hostname.endsWith(".seorce.com") ||
      url.pathname.startsWith("/_vercel/")
    ) {
      await route.fulfill({ status: 204, body: "" });
    } else if (url.origin === target.origin) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  await context.route(`${productionOrigin}/**`, async (route) => {
    const original = new URL(route.request().url());
    if (original.pathname.startsWith("/_vercel/")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    const local = new URL(target.origin);
    local.pathname = original.pathname;
    local.search = original.search;
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  await page.mouse.move(-100, -100);
  const navigate = async (pathname = "/") => {
    navigationStart = performance.now();
    await page.goto(`${productionOrigin}${pathname}`, { waitUntil: "load" });
  };
  const interact = async () => {
    scenario.interacted = true;
    if (options.isMobile) {
      await page.locator("#top h1").tap();
    } else {
      await page.mouse.move(500, 350);
    }
  };
  try {
    await run({ page, scenario, navigate, interact });
    scenario.status = testInfo.errors.length ? "failed" : "passed";
    if (testInfo.errors.length) scenario.errors = testInfo.errors.map((error) => error.message);
  } catch (error) {
    scenario.status = "failed";
    scenario.error = error.message;
    await page.screenshot({ path: path.join(artifactDir, `${testInfo.title.replace(/\W+/g, "-")}.png`) }).catch(() => {});
    throw error;
  } finally {
    scenario.interactions = await page.evaluate(() => window.__homePerformanceInteractions).catch(() => []);
    persistSummary();
    await context.close();
  }
};

const widgetRequests = (scenario) => scenario.requests.filter(({ url }) => new URL(url).hostname === "widget.intercom.io");
const videoRequests = (scenario) => scenario.requests.filter(({ url }) => new URL(url).pathname.startsWith("/videos/"));

for (const [name, options] of [
  ["desktop", { viewport: { width: 1366, height: 768 } }],
  ["mobile", devices["Pixel 7"]],
]) {
  test(`${name} home waits for interaction and loads the logo after load`, async ({ browser, baseURL }, testInfo) => {
    await withScenario(browser, testInfo, baseURL, options, async ({ page, scenario, navigate, interact }) => {
      await navigate();
      await page.waitForTimeout(4000);
      scenario.quietScrollY = await page.evaluate(() => window.scrollY);
      expect(scenario.quietScrollY).toBe(0);
      expect(widgetRequests(scenario)).toHaveLength(0);
      expect(scenario.requests.filter(({ url, phase }) =>
        phase === "before interaction" && homeSectionPaths.has(new URL(url).pathname)
      )).toHaveLength(0);
      expect(videoRequests(scenario)).toHaveLength(0);
      expect(scenario.requests.filter(({ url }) => new URL(url).pathname.endsWith(".apng"))).toHaveLength(0);
      expect(scenario.requests.some(({ url }) => new URL(url).pathname === "/logo-animated-small.webp")).toBe(true);
      scenario.logoTiming = await page.evaluate(() => ({
        startTime: performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === "/logo-animated-small.webp")?.startTime,
        loadEventEnd: performance.getEntriesByType("navigation")[0].loadEventEnd,
      }));
      expect(scenario.logoTiming.loadEventEnd).toBeGreaterThan(0);
      expect(scenario.logoTiming.startTime).toBeGreaterThanOrEqual(scenario.logoTiming.loadEventEnd);
      await page.screenshot({ path: path.join(artifactDir, `${name}-home.png`) });
      await interact();
      await expect.poll(() => widgetRequests(scenario).length, { timeout: 6000 }).toBeGreaterThan(0);
      await expect(page.locator("#intercom-embed-script")).toBeAttached({ timeout: 6000 });
    });
  });
}

test("click-only activation loads Intercom", async ({ browser, baseURL }, testInfo) => {
  await withScenario(browser, testInfo, baseURL, { viewport: { width: 1366, height: 768 } }, async ({ page, scenario, navigate }) => {
    await navigate();
    await page.waitForTimeout(4000);
    expect(widgetRequests(scenario)).toHaveLength(0);
    scenario.interacted = true;
    await page.evaluate(() => document.querySelector("#top h1").click());
    await expect.poll(() => widgetRequests(scenario).length, { timeout: 6000 }).toBeGreaterThan(0);
    await expect(page.locator("#intercom-embed-script")).toBeAttached({ timeout: 6000 });
  });
});

test("checkout entered before idle injection keeps Intercom unloaded", async ({ browser, baseURL }, testInfo) => {
  await withScenario(browser, testInfo, baseURL, { viewport: { width: 1366, height: 768 } }, async ({ page, scenario, navigate }) => {
    await navigate();
    await page.waitForTimeout(4000);
    expect(widgetRequests(scenario)).toHaveLength(0);
    const bookingLink = page.locator('a[href="/booking"]').first();
    await bookingLink.scrollIntoViewIfNeeded();
    scenario.interacted = true;
    await bookingLink.click();
    await expect(page).toHaveURL((url) => url.pathname === "/booking");
    await page.waitForTimeout(5000);
    expect(widgetRequests(scenario)).toHaveLength(0);
    await expect(page.locator("#intercom-embed-script")).toHaveCount(0);
  });
});

test("booking keeps Intercom disabled after interaction", async ({ browser, baseURL }, testInfo) => {
  await withScenario(browser, testInfo, baseURL, { viewport: { width: 1366, height: 768 } }, async ({ page, scenario, navigate, interact }) => {
    await navigate("/booking");
    await interact();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(5000);
    expect(widgetRequests(scenario)).toHaveLength(0);
    await expect(page.locator("#intercom-embed-script")).toHaveCount(0);
  });
});

test("reduced motion keeps the animated logo unloaded", async ({ browser, baseURL }, testInfo) => {
  await withScenario(browser, testInfo, baseURL, { reducedMotion: "reduce" }, async ({ page, scenario, navigate }) => {
    await navigate();
    await page.waitForTimeout(4000);
    expect(scenario.requests.filter(({ url }) => new URL(url).pathname === "/logo-animated-small.webp")).toHaveLength(0);
  });
});

test("How It Works videos load and play near the viewport and pause away", async ({ browser, baseURL }, testInfo) => {
  await withScenario(browser, testInfo, baseURL, devices["Pixel 7"], async ({ page, scenario, navigate, interact }) => {
    await navigate();
    await interact();
    await page.locator("#how-it-works").scrollIntoViewIfNeeded();
    await expect.poll(() => videoRequests(scenario).length, { timeout: 8000 }).toBeGreaterThan(0);
    await expect.poll(() => page.locator("#how-it-works video").evaluateAll((videos) => videos.some((video) => video.currentTime > 0.25)), { timeout: 8000 }).toBe(true);
    await page.screenshot({ path: path.join(artifactDir, "mobile-videos.png") });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect.poll(() => page.locator("#how-it-works video").evaluateAll((videos) => videos.length > 0 && videos.every((video) => video.paused)), { timeout: 3000 }).toBe(true);
  });
});
