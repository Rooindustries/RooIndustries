const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");

test.use({ javaScriptEnabled: true, reducedMotion: "reduce" });

const footerLink = (page, href) => page.locator(`footer a[href="${href}"]`).first();
const pageLink = (page, href) => page.locator(`#main-content a[href="${href}"]`).first();
const hydrated = (page) => page.waitForFunction(() => window.history.state?.__rooLegacy === true);
const controlContent = async (request, baseURL, data) => {
  const origin = new URL(baseURL);
  origin.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  const response = await request.post(new URL("/__content", origin).href, { data });
  expect(response.status()).toBe(200);
};

const observeHero = (page) => page.evaluate(() => {
  window.__heroCopyStates = [];
  new MutationObserver(() => {
    const text = document.querySelector("#top h1")?.textContent;
    if (text) window.__heroCopyStates.push(text);
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
});

const finishHeroRefresh = async (page) => {
  await page.unroute("**/api/content/hero");
  await page.route("**/api/content/hero", route => route.fulfill({
    json: { ok: true, data: { headingLine1: "Final published heading" }, revision: 1000 },
  }));
  await returnHome(page);
  await expect(page.locator("#top h1")).toContainText("Final published heading");
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

for (const state of ["updated", "missing", "failed", "malformed"]) {
  test(`a stale homepage seed refreshes on mount with ${state} content`, async ({ page }) => {
    const errors = [];
    page.on("console", message => {
      if (message.type() === "error" && (message.text().includes("Synthetic homepage refresh failure") || message.text().includes("Public content could not be loaded"))) {
        errors.push(message.text());
      }
    });
    await page.clock.install({ time: new Date(Date.now() + 61_000) });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let refreshes = 0;
    await page.route("**/api/content/hero", async route => {
      refreshes += 1;
      await gate;
      const data = state === "missing" ? null : { headingLine1: "Updated stale heading" };
      await route.fulfill(state === "failed"
        ? { status: 503, json: { ok: false, error: "Synthetic homepage refresh failure" } }
        : { json: state === "malformed" ? { ok: true, revision: 999 } : { ok: true, data, revision: 999 } });
    });
    try {
      await page.goto("/");
      await hydrated(page);
      await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
      await expect.poll(() => refreshes).toBe(1);
      release();
      if (state === "failed" || state === "malformed") {
        await expect.poll(() => errors.length).toBe(1);
        await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
      } else {
        await expect(page.locator("#top h1")).not.toContainText("Fixture Hero Heading One");
        if (state === "updated") await expect(page.locator("#top h1")).toContainText("Updated stale heading");
        expect(errors).toEqual([]);
      }
    } finally {
      release();
    }
  });
}

for (const [label, data] of [["missing", null], ["wrong-shaped", []]]) {
  const outcome = data === null ? "removes deleted copy" : "keeps the published copy";
  test(`a ${label} refresh ${outcome}`, async ({ page }) => {
    await page.clock.install();
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await observeHero(page);
    const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
    await page.route("**/api/content/hero", route => route.fulfill({ json: { ok: true, data, revision: 999 } }));
    await returnHome(page);
    await finished;
    if (data === null) await expect(page.locator("#top h1")).not.toContainText("Fixture Hero Heading One");
    else await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
    const refreshedHeading = await page.locator("#top h1").textContent();
    await finishHeroRefresh(page);
    const states = await page.evaluate(() => window.__heroCopyStates);
    expect(states.length).toBeGreaterThan(0);
    expect(states.every(text =>
      /Fixture Hero Heading One|Final published heading/.test(text) || text === refreshedHeading
    )).toBe(true);
  });
}

test("an API copy older than the server copy cannot replace it", async ({ page }) => {
  await page.clock.install();
  await page.goto("/", { waitUntil: "networkidle" });
  await hydrated(page);
  await observeHero(page);
  await page.route("**/api/content/hero", route => route.fulfill({
    json: { ok: true, data: { headingLine1: "Older API heading" }, revision: 0 },
  }));
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
  await returnHome(page);
  await finished;
  await expect(page.locator("#top h1")).toContainText("Fixture Hero Heading One");
  await finishHeroRefresh(page);
  expect(await page.evaluate(() => window.__heroCopyStates.some(text => text.includes("Older API heading")))).toBe(false);
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
  await observeHero(page);
  revision = null;
  const finished = page.waitForEvent("requestfinished", request => request.url().endsWith("/api/content/hero"));
  await returnHome(page);
  await finished;
  await expect(page.locator("#top h1")).toContainText("Newer cached heading");
  await finishHeroRefresh(page);
  expect(await page.evaluate(() => window.__heroCopyStates.some(text => text.includes("Unlabelled heading")))).toBe(false);
});

test("a package response from an older revision never replaces copy refreshed before it", async ({ page, request, baseURL }) => {
  const publishedTag = "Offer tag published before the older response";
  const offers = page.locator("#packages");
  const isPackages = (url) => new URL(url).pathname === "/api/content/packages-list";
  const readPackages = async () => {
    const response = await request.get("/api/content/packages-list");
    expect(response.status()).toBe(200);
    return response.json();
  };
  const leaveAndReturnAfterWindow = async () => {
    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.clock.fastForward("01:01");
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
  };
  const held = [];
  let holdOlder = false;
  await page.clock.install();
  try {
    const older = await readPackages();
    expect(older.data.some((row) => row.tag === publishedTag)).toBe(false);
    await page.route("**/api/content/packages-list", async (route) => {
      if (!holdOlder) return route.fallback();
      held.push({ body: older, release: () => route.fulfill({ json: older }) });
    });

    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await page.evaluate(() => { window.__offerDocument = true; });

    await controlContent(request, baseURL, { patch: { _id: "tooling-package-0", tag: publishedTag } });
    const published = await readPackages();
    expect(published.revision).toBeGreaterThan(older.revision);
    await leaveAndReturnAfterWindow();
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();

    holdOlder = true;
    await page.evaluate(() => {
      window.__offerStates = [];
      new MutationObserver(() => {
        const text = document.querySelector("#packages")?.textContent || "";
        if (text.includes("$149.95")) window.__offerStates.push(text.includes("Offer tag published before the older response"));
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await leaveAndReturnAfterWindow();
    await expect.poll(() => held.length).toBe(1);
    holdOlder = false;
    expect(held[0].body.revision).toBeLessThan(published.revision);
    expect(held[0].body.data.some((row) => row.tag === publishedTag)).toBe(false);

    const consumed = page.waitForEvent("requestfinished", (finished) => isPackages(finished.url()));
    await held[0].release();
    const olderResponse = await (await consumed).response();
    expect(olderResponse.status()).toBe(200);
    expect(await olderResponse.json()).toEqual(older);

    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();
    await footerLink(page, "/about").click();
    await expect(page).toHaveURL(/\/about$/);
    await pageLink(page, "/packages").click();
    await expect(page).toHaveURL(/\/packages$/);
    await expect(page.getByText(publishedTag, { exact: true }).first()).toBeVisible();
    const states = await page.evaluate(() => window.__offerStates);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((shown) => !shown)).toEqual([]);
    expect(held).toHaveLength(1);
    expect(await page.evaluate(() => window.__offerDocument)).toBe(true);
  } finally {
    await controlContent(request, baseURL, { reset: true });
  }
});


test("a packages section remounted after the cache updated starts from the newer cached copy", async ({ page, request, baseURL }) => {
  const publishedTag = "Offer tag published after the first load";
  await page.clock.install();
  const offers = page.locator("#packages");
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText("$149.95").first()).toBeVisible();
    await expect(offers.getByText(publishedTag, { exact: true })).toHaveCount(0);
    await page.evaluate(() => { window.__remountDocument = true; });

    await controlContent(request, baseURL, { patch: { _id: "tooling-package-0", tag: publishedTag } });
    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.clock.fastForward("01:01");
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();

    await footerLink(page, "/terms").click();
    await expect(page).toHaveURL(/\/terms$/);
    await page.evaluate(() => {
      window.__offerStates = [];
      new MutationObserver(() => {
        const text = document.querySelector("#packages")?.textContent || "";
        if (text.includes("$149.95")) window.__offerStates.push(text.includes("Offer tag published after the first load"));
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await footerLink(page, "/").click();
    await expect(page).toHaveURL(/\/$/);
    await offers.scrollIntoViewIfNeeded();
    await expect(offers.getByText(publishedTag, { exact: true })).toBeVisible();
    const states = await page.evaluate(() => window.__offerStates);
    expect(states.length).toBeGreaterThan(0);
    expect(states.filter((published) => !published)).toEqual([]);
    expect(await page.evaluate(() => window.__remountDocument)).toBe(true);
  } finally {
    await controlContent(request, baseURL, { reset: true });
  }
});

for (const exit of ["close", "back"]) {
  test(`the retained home copy refreshes after booking ${exit}`, async ({ page, request, baseURL }) => {
    await page.clock.install();
    await page.goto("/", { waitUntil: "networkidle" });
    await hydrated(page);
    await page.locator('#packages a[href^="/booking"]').first().click();
    await expect(page).toHaveURL(/\/booking/);
    await expect(page.getByRole("dialog")).toBeVisible();
    await controlContent(request, baseURL, {
      patch: { _id: "tooling-hero", headingLine1: "Published during booking" },
    });
    await controlContent(request, baseURL, {
      patch: { _id: "tooling-about", recordTitle: "Result published during booking" },
    });
    await controlContent(request, baseURL, {
      patch: { _id: "tooling-package-0", tag: "Offer published during booking" },
    });
    await page.clock.fastForward("01:01");
    if (exit === "back") await page.goBack();
    else await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("#top h1")).toContainText("Published during booking");
    await expect(page.locator(".ri-proof-title").first()).toHaveText("Result published during booking");
    await page.locator("#packages").scrollIntoViewIfNeeded();
    await expect(page.locator("#packages").getByText("Offer published during booking", { exact: true })).toBeVisible();
  });
}
