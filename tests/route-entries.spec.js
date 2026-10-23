const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { gzipSync } = require("node:zlib");

test.use({ javaScriptEnabled: true, viewport: { width: 390, height: 844 }, serviceWorkers: "block", trace: process.env.CI ? "retain-on-failure" : "off", video: "off" });

const attach = async (testInfo, name, value) => {
  const file = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const contentURL = new URL(baseURL);
  contentURL.port = String(Number(contentURL.port) + 1);
  await guardBrowserContext(context, [baseURL, contentURL.origin]);
});

for (const route of ["/reviews", "/tools", "/packages", "/about"]) {
  test(`${route} loads its own page graph`, async ({ page }, testInfo) => {
    const scripts = [];
    const pending = [];
    page.on("response", response => {
      if (response.request().resourceType() !== "script") return;
      pending.push(response.body().then(body => scripts.push({ url: response.url(), body })).catch(() => {}));
    });
    await page.goto(route);
    await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
    await page.waitForTimeout(700);
    await Promise.all(pending);
    await attach(testInfo, "initial-page-scripts", scripts.map(({ url, body }) => ({ url, rawBytes: body.length, gzipBytes: gzipSync(body).length })));
    for (const marker of ["deferred-section-content", "ri-faq-number", "package-details-modal-title", "formspree.io", "[@portabletext/react]"]) {
      expect(scripts.filter(({ body }) => body.includes(marker)).map(({ url }) => url), marker).toEqual([]);
    }
  });
}

const routes = ["/", "/reviews", "/benchmarks", "/tools", "/meet-the-team"];
const navigateFromMenu = async (page, route) => {
  if (route === "/") {
    await page.locator('header a[href="/"]:visible').first().click();
    return;
  }
  if (route === "/tools") {
    const menu = page.getByRole("button", { name: "Open menu", exact: true });
    if (await menu.getAttribute("aria-expanded") === "true") await menu.click();
    await page.locator('footer a[href="/tools"]').click();
    return;
  }
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  if (await menu.getAttribute("aria-expanded") !== "true") await menu.click();
  if (route === "/reviews" || route === "/benchmarks") {
    const proof = page.locator('#mobile-site-menu button[aria-controls="mobile-proof-menu"]');
    if (await proof.getAttribute("aria-expanded") !== "true") await proof.click();
  }
  await page.locator(`#mobile-site-menu a[href="${route}"]`).click();
};

const expectPage = async (page, route) => {
  if (route === "/") {
    await expect(page.locator("#top h1")).toBeVisible();
    await expect(page.locator("#services")).toBeAttached();
    return;
  }
  const headings = {
    "/reviews": "Community Reviews",
    "/benchmarks": "Performance Benchmarks",
    "/tools": "All Tools & Utilities",
    "/meet-the-team": "Meet the Team",
  };
  await expect(page.locator("#main-content").getByRole("heading", { name: headings[route], exact: true })).toBeVisible();
};

for (const origin of routes) {
  test(`${origin} can navigate to every other top-nav page and back`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && /hydration|didn't match|server rendered/i.test(message.text())) errors.push(message.text());
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
    await expectPage(page, origin);
    await page.evaluate(() => { window.__routeEntryDocument = true; });
    const transitions = [];
    for (const destination of routes.filter(route => route !== origin)) {
      await navigateFromMenu(page, destination);
      await expect(page).toHaveURL(new RegExp(`${destination === "/" ? "/" : destination}$`));
      await expectPage(page, destination);
      expect(await page.evaluate(() => window.__routeEntryDocument)).toBe(true);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${origin === "/" ? "/" : origin}$`));
      await expectPage(page, origin);
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`${destination === "/" ? "/" : destination}$`));
      await expectPage(page, destination);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${origin === "/" ? "/" : origin}$`));
      await expectPage(page, origin);
      expect(await page.evaluate(() => window.__routeEntryDocument)).toBe(true);
      transitions.push({ origin, destination, back: true, forward: true });
    }
    await attach(testInfo, "navigation-matrix", { transitions, errors });
    expect(errors).toEqual([]);
  });
}

test("a delayed home chunk preserves the current page until navigation is ready", async ({ page }, testInfo) => {
  await page.goto("/about");
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = [];
  await page.route("**/_next/static/chunks/**", async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("deferred-section-content")) {
      delayed.push(route.request().url());
      await gate;
    }
    await route.fulfill({ response, body });
  });
  try {
    await page.locator('header a[href="/"]:visible').first().click();
    await expect.poll(() => delayed.length).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "About Roo Industries", exact: true })).toBeVisible();
    release();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#services")).toBeAttached();
    await attach(testInfo, "delayed-home-chunks", delayed);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("package details load on first keyboard open and restore focus on close", async ({ page }, testInfo) => {
  await page.goto("/packages");
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  const button = page.locator(".ri-package-details-button").first();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("package-details.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("same-page hash history preserves an expanded FAQ answer", async ({ page }, testInfo) => {
  await page.goto("/#faq");
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  const question = page.locator('#faq button[aria-expanded]').first();
  await expect(question).toBeVisible();
  await question.click();
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => { window.location.hash = "packages"; });
  await expect(page).toHaveURL(/#packages$/);
  await page.goBack();
  await expect(page).toHaveURL(/#faq$/);
  await expect(question).toHaveAttribute("aria-expanded", "true");
  await attach(testInfo, "faq-history", { hash: "#faq", expanded: true });
});

test("a failed home import cannot replace a newer tools navigation", async ({ page }, testInfo) => {
  await page.goto("/about");
  await page.waitForFunction(() => window.history.state?.__rooLegacy === true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let intercepted = 0;
  let aborted = false;
  await page.route("**/_next/static/chunks/**", async route => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes("deferred-section-content")) {
      intercepted += 1;
      await gate;
      await route.abort("failed");
      aborted = true;
      return;
    }
    await route.fulfill({ response, body });
  });
  try {
    await page.locator('header a[href="/"]:visible').first().click();
    await expect.poll(() => intercepted).toBeGreaterThan(0);
    await page.locator('footer a[href="/tools"]').click();
    await expect(page).toHaveURL(/\/tools$/);
    await expect(page.getByRole("heading", { name: "All Tools & Utilities", exact: true })).toBeVisible();
    release();
    await expect.poll(() => aborted).toBe(true);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/tools$/);
    await expect(page.getByRole("heading", { name: "We couldn’t load this page." })).toHaveCount(0);
    await attach(testInfo, "superseded-home-import", { intercepted, aborted });
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});


for (const provider of ["discord", "google"]) {
  test(`shared referral login preserves the ${provider} account-choice flow`, async ({ page }, testInfo) => {
    await page.goto(`/referrals/login?oauth=unlinked&provider=${provider}`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("heading", { name: "No account linked yet", exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/referrals\/login$/);
    await page.getByRole("button", { name: "Log in and link", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Referral code or login email", { exact: true })).toBeFocused();
    const choice = await page.evaluate(() => JSON.parse(sessionStorage.getItem("refPendingDiscordChoice")));
    expect(choice).toMatchObject({ state: "link", provider });
    await attach(testInfo, "account-choice", { provider, choice });
  });
}
