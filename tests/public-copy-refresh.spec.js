const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

const footerLink = (page, href) => page.locator(`footer a[href="${href}"]`).first();
const controlContent = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const reviewId = process.env.TOOLING_CLS_CONTENT === "1" ? "review-cls-wide" : "tooling-review";

const cases = [
  ["/contact", "contact", "tooling-contact", "subtitle", "Published contact information"],
  ["/privacy", "privacy-policy", "tooling-privacyPolicy", "title", "Published privacy title"],
  ["/terms", "terms", "tooling-terms", "title", "Published terms title"],
  ["/benchmarks", "benchmarks", "tooling-benchmark-z-alpha", "title", "Published benchmark title"],
  ["/tools", "tools", "tooling-cls-tool-0", "title", "Published tool title"],
  ["/meet-the-team", "team", "tooling-meetTheTeam", "heroTitle", "Published team title"],
  ["/reviews", "reviews-gallery", reviewId, "alt", "Published review caption"],
];

const shownCopy = (page, field, text) => field === "alt"
  ? page.locator(`#main-content img[alt="${text}"]`).first()
  : page.locator("#main-content").getByText(text, { exact: true }).first();

const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

test.afterEach(async ({ page, request, baseURL }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await controlContent(request, baseURL, { reset: true });
});

for (const [path, resource, id, field, text] of cases) {
  test(`${path} shows a CMS edit after returning through browser history`, async ({ page, request, baseURL }) => {
    await page.clock.install();
    let requests = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname === `/api/content/${resource}`) requests += 1;
    });
    await page.goto(path, { waitUntil: "networkidle" });
    await hydrated(page);
    await page.evaluate(() => { window.__publicCopyDocument = true; });
    await controlContent(request, baseURL, { patch: { _id: id, [field]: text } });
    await footerLink(page, "/about").click();
    await expect(page).toHaveURL(/\/about$/);
    await page.clock.fastForward("01:01");
    await page.goBack();
    await expect(shownCopy(page, field, text)).toBeVisible();
    const refreshedRequests = requests;
    await page.goForward();
    await expect(page).toHaveURL(/\/about$/);
    await page.goBack();
    await expect(shownCopy(page, field, text)).toBeVisible();
    expect(requests).toBe(refreshedRequests);
    expect(await page.evaluate(() => window.__publicCopyDocument)).toBe(true);
  });

  for (const exit of ["close", "back"]) {
    test(`${path} refreshes its retained copy after booking ${exit}`, async ({ page, request, baseURL }) => {
      await page.clock.install();
      await page.goto(path, { waitUntil: "networkidle" });
      await hydrated(page);
      await page.evaluate(() => {
        const backgroundLocation = {
          pathname: window.location.pathname, search: "", hash: "", state: null, key: "public-copy",
        };
        const state = { ...window.history.state, usr: { backgroundLocation } };
        window.history.pushState(state, "", "/booking");
        window.dispatchEvent(new PopStateEvent("popstate", { state }));
      });
      await expect(page).toHaveURL(/\/booking$/);
      await expect(page.getByRole("dialog")).toBeVisible();
      await controlContent(request, baseURL, { patch: { _id: id, [field]: text } });
      await page.clock.fastForward("01:01");
      if (exit === "back") await page.goBack();
      else await page.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(shownCopy(page, field, text)).toBeVisible();
    });
  }
}

test("failed contact refreshes keep the configured form and last copy", async ({ page }) => {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Synthetic public refresh failure")) {
      errors.push(message.text());
    }
  });
  await page.clock.install();
  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  await page.route("**/api/content/contact", route => route.fulfill({
    status: 503, json: { ok: false, error: "Synthetic public refresh failure" },
  }));
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await page.clock.fastForward("01:01");
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/contact"));
  await page.goBack();
  await finished;
  await expect(page.getByText("Synthetic local contact information.")).toBeVisible();
  await expect(page.locator('form button[type="submit"]')).toBeEnabled();
  await expect(page.getByText("The contact form is temporarily unavailable.", { exact: false })).toHaveCount(0);
  await expect.poll(() => errors.length).toBe(1);
});

test("an unchanged public page stays fresh for the next visit", async ({ page }) => {
  await page.clock.install();
  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  let requests = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/content/contact") requests += 1;
  });
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await page.clock.fastForward("01:01");
  const confirmed = page.waitForResponse(response => response.url().endsWith("/api/content/contact"));
  await page.goBack();
  expect((await confirmed).status()).toBe(200);
  await expect(page.getByText("Synthetic local contact information.")).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
  await page.clock.fastForward("00:30");
  await page.goBack();
  await expect(page.getByText("Synthetic local contact information.")).toBeVisible();
  expect(requests).toBe(1);
});

for (const state of ["failed", "missing", "empty"]) {
  test(`a stale policy seed refreshes on mount with ${state} content`, async ({ page }) => {
    const errors = [];
    page.on("console", message => {
      if (message.type() === "error" && message.text().includes("Synthetic policy refresh failure")) {
        errors.push(message.text());
      }
    });
    await page.clock.install({ time: new Date(Date.now() + 61_000) });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let refreshes = 0;
    await page.route("**/api/content/privacy-policy", async entry => {
      refreshes += 1;
      await gate;
      await entry.fulfill(state === "failed"
        ? { status: 503, json: { ok: false, error: "Synthetic policy refresh failure" } }
        : { json: { ok: true, data: state === "missing" ? null : {}, revision: 999 } });
    });
    try {
      await page.goto("/privacy");
      await hydrated(page);
      await expect(page.locator("main")).toContainText("Synthetic local information");
      await expect.poll(() => refreshes).toBe(1);
      release();
      if (state === "failed") {
        await expect.poll(() => errors.length).toBe(1);
        await expect(page.locator("main")).toContainText("Synthetic local information");
        await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toBeVisible();
      } else {
        await expect(page.locator("main")).not.toContainText("Synthetic local information");
        await expect(page.getByRole("heading", { name: "Privacy Policy", exact: true })).toHaveCount(0);
        expect(errors).toEqual([]);
      }
    } finally {
      release();
    }
  });
}

test("a published empty tools list replaces the old list", async ({ page }) => {
  await page.clock.install();
  await page.goto("/tools", { waitUntil: "networkidle" });
  await hydrated(page);
  await expect(page.locator("#main-content article").first()).toBeVisible();
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await page.route("**/api/content/tools", route => route.fulfill({
    json: { ok: true, data: [], revision: 999 },
  }));
  await page.clock.fastForward("01:01");
  await page.goBack();
  await expect(page.getByText("No tools are listed right now.", { exact: true })).toBeVisible();
  await expect(page.locator("#main-content article")).toHaveCount(0);
});

test("tools normalize icon sizes once before a cached list is rendered", async ({ page }) => {
  await page.route("**/api/content/tools", route => route.fulfill({
    json: { ok: true, revision: 999, data: [{
      _id: "sized-tool", title: "Sized tool", iconUrl: "/favicon-96x96.png?source=fixture",
    }] },
  }));
  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  await footerLink(page, "/tools").click();
  const icon = page.locator("#main-content article img").first();
  const sized = "/favicon-96x96.png?source=fixture&auto=format&fit=max&w=64&h=64";
  await expect(icon).toHaveAttribute("src", sized);
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await page.goBack();
  await expect(icon).toHaveAttribute("src", sized);
});

test("the persistent Discord banner refreshes its CMS link on navigation", async ({ page, request, baseURL }) => {
  await page.clock.install();
  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  await controlContent(request, baseURL, {
    patch: { _id: "tooling-discordBanner", link: "https://discord.com/invite/published" },
  });
  await page.clock.fastForward("01:01");
  await footerLink(page, "/about").click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator(".ri-discord-guide-link")).toHaveAttribute("href", "https://discord.com/invite/published");
});

test("a deleted contact document shows the unavailable state", async ({ page }) => {
  await page.clock.install();
  await page.goto("/contact", { waitUntil: "networkidle" });
  await hydrated(page);
  await page.route("**/api/content/contact", route => route.fulfill({
    json: { ok: true, data: null, revision: 999 },
  }));
  await footerLink(page, "/about").click();
  await page.clock.fastForward("01:01");
  await page.goBack();
  await expect(page.getByText("The contact form is temporarily unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByText("Loading the contact form...")).toHaveCount(0);
});

test("a failed first privacy request is reported once", async ({ page }) => {
  const errors = [];
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Synthetic first privacy failure")) errors.push(message.text());
  });
  await page.goto("/about", { waitUntil: "networkidle" });
  await hydrated(page);
  await page.route("**/api/content/privacy-policy", route => route.fulfill({
    status: 503, json: { ok: false, error: "Synthetic first privacy failure" },
  }));
  await footerLink(page, "/privacy").click();
  await expect.poll(() => errors.length).toBe(1);
  await expect(page).toHaveURL(/\/privacy$/);
  await page.waitForLoadState("networkidle");
  expect(errors).toHaveLength(1);
});
