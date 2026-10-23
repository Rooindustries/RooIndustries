const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { PREBUILT_ROUTES } = require("../src/lib/routes");
test.beforeEach(({}, testInfo) => {
  test.skip(!testInfo.config.configFile.endsWith("playwright.cms.config.js"), "Run with npm run test:cms-resilience against its isolated CMS fixture.");
});

const adminHeaders = { "x-admin-key": "synthetic-cms-resilience-key" };
const expected = {
  "/": "Fixture Hero Heading One",
  "/packages": "Performance Vertex Max",
  "/benchmarks": "Fixture Benchmark Alpha",
  "/reviews": "Fixture layout review 800 by 400",
  "/faq": "Synthetic local question 1",
  "/contact": "Synthetic local contact information.",
  "/about": "About Roo Industries",
  "/terms": "Synthetic local information",
  "/privacy": "Synthetic local information",
  "/meet-the-team": "Fixture Member Alpha",
  "/tools": "Fixture layout tool 1",
  "/tourney": "Event complete",
};

const controlUrl = baseURL => {
  const url = new URL(baseURL);
  url.port = process.env.TOOLING_CONTENT_PORT || String(Number(url.port) + 1);
  return new URL("/__content", url).href;
};
const control = async (request, baseURL, data) => {
  const response = await request.post(controlUrl(baseURL), { data });
  expect(response.ok(), await response.text()).toBe(true);
};
const publish = (request, data) => request.post("/api/admin/content/publish", { headers: adminHeaders, data });
const requestPage = async (request, url, headers) => {
  let response = await request.get(url, { headers, maxRedirects: 0 });
  if (response.status() === 307 && headers.rsc === "1") {
    const destination = new URL(response.headers().location, "http://fixture.invalid");
    expect(destination.origin).toBe("http://fixture.invalid");
    expect(destination.pathname).toBe(new URL(url, "http://fixture.invalid").pathname);
    response = await request.get(`${destination.pathname}${destination.search}`, { headers, maxRedirects: 0 });
  }
  return response;
};
const renew = async request => {
  const loaded = await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders });
  expect(loaded.ok(), await loaded.text()).toBe(true);
  const { data } = await loaded.json();
  const response = await publish(request, { operation: "replace", type: "contact", documentId: "tooling-contact", expectedRevision: data.revision, document: data.document });
  expect(response.ok(), await response.text()).toBe(true);
};
const read = async (request, route, timeline, stage) => {
  const start = Date.now();
  const response = await request.get(route, { headers: { accept: "text/html" }, timeout: 10000 });
  const html = await response.text();
  const result = { route, stage, status: response.status(), cache: response.headers()["x-nextjs-cache"], elapsedMs: Date.now() - start };
  timeline.push(result);
  expect.soft(result.status, `${stage}: ${route}`).toBe(200);
  if (expected[route]) expect.soft(html.includes(expected[route]), `${stage}: ${route} keeps its content`).toBe(true);
  expect.soft(html.includes("Application error"), `${stage}: ${route}`).toBe(false);
  return html;
};
const warm = async (request, timeline) => {
  for (const route of PREBUILT_ROUTES) {
    await expect.poll(async () => {
      await read(request, route, timeline, "warm");
      return timeline.at(-1).cache;
    }, { timeout: 30000, message: `${route} finishes warming its cache` }).toBe("HIT");
  }
};
const screenshots = async (browser, baseURL, testInfo, prefix) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const content = new URL(controlUrl(baseURL)).origin;
  for (const width of [360, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: true, reducedMotion: "reduce", serviceWorkers: "block" });
    await guardBrowserContext(context, [baseURL, content]);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const route of Object.keys(expected)) {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(200);
        if (route === "/reviews") await expect.soft(page.getByAltText(expected[route]).first()).toBeVisible();
        else await expect.soft(page.locator("body")).toContainText(expected[route]);
        await page.screenshot({ path: testInfo.outputPath(`${prefix}-${route.replaceAll("/", "") || "home"}-${width}.png`), fullPage: true, animations: "disabled", timeout: 30000 });
        expect.soft(errors.splice(0), `${route} browser errors`).toEqual([]);
      }
    } finally { await context.close(); }
  }
};

test("a rejected publish preserves every cached public page during a CMS outage", async ({ request, browser, baseURL }, testInfo) => {
  const timeline = [];
  try {
    await control(request, baseURL, { reset: true });
    await renew(request);
    await warm(request, timeline);
    await control(request, baseURL, { outage: true });
    const rejected = await publish(request, { operation: "invalid" });
    expect(rejected.status()).toBe(400);
    const unavailable = await publish(request, { operation: "replace", type: "contact", documentId: "tooling-contact", expectedRevision: "tooling-fixture-v1", document: { title: "Must not publish" } });
    expect(unavailable.status()).toBe(503);
    for (const route of PREBUILT_ROUTES) {
      await read(request, route, timeline, "failed publish");
      expect.soft(timeline.at(-1).cache, `${route} keeps its cached page`).toBe("HIT");
    }
    await screenshots(browser, baseURL, testInfo, "failed-publish");
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("responses.json"), JSON.stringify(timeline, null, 2));
  }
});

test("a successful publish and its replay refresh public content", async ({ request, page, baseURL }, testInfo) => {
  await control(request, baseURL, { reset: true });
  const loaded = await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders });
  const { data } = await loaded.json();
  const marker = "Published contact resilience marker";
  const command = { operation: "replace", type: "contact", documentId: "tooling-contact", expectedRevision: data.revision, document: { ...data.document, subtitle: marker } };
  try {
    for (const replayed of [false, true]) {
      const result = await publish(request, command);
      expect(result.ok(), await result.text()).toBe(true);
      expect((await result.json()).data.replayed).toBe(replayed);
      const response = await request.get("/contact");
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(marker);
    }
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
    await page.goto("/contact");
    await expect(page.locator("body")).toContainText(marker);
    await page.screenshot({ path: testInfo.outputPath("published-contact.png"), animations: "disabled" });
  } finally { await control(request, baseURL, { reset: true }); }
});

for (const failure of ["5xx", "timeout", "invalid-receipt"]) {
  test(`confirmed publish recovery refreshes public pages after a ${failure} commit response`, async ({ request, page, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
    await page.route("**/api/admin/content/**", route => route.continue({ headers: { ...route.request().headers(), ...adminHeaders } }));
    const commands = [];
    page.on("request", req => {
      if (new URL(req.url()).pathname === "/api/admin/content/publish" && req.method() === "POST") commands.push(req.postDataJSON());
    });
    const results = [];
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await control(request, baseURL, { reset: true });
      await renew(request);
      const requestOffset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
      for (const operation of ["replace", "create"]) {
        const route = operation === "replace" ? "/" : "/benchmarks";
        const marker = `Recovered ${operation} after ${failure.replaceAll("-", " ")}`;
        await expect.poll(async () => (await request.get(route)).headers()["x-nextjs-cache"], { timeout: 30000 }).toBe("HIT");
        const before = await request.get(route);
        await fs.writeFile(testInfo.outputPath(`${operation}-before.html`), await before.text());
        await control(request, baseURL, { publishResponseFailure: failure });
        await page.goto("/admin/content");
        const navigation = page.getByRole("navigation", { name: "Content types" });
        await expect(navigation).toBeVisible();
        await navigation.getByRole("button", { name: operation === "replace" ? "Hero Section" : "Benchmark", exact: true }).click();
        if (operation === "replace") await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(marker);
        else {
          await page.getByRole("region", { name: "Benchmark list" }).getByRole("button", { name: "New", exact: true }).click();
          await page.getByLabel("Benchmark Name", { exact: true }).fill(marker);
        }
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible({ timeout: 35000 });
        expect(commands).toHaveLength(operation === "replace" ? 1 : 2);
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`${operation}-admin.png`), fullPage: true });
        const response = await request.get(route);
        const html = await response.text();
        await fs.writeFile(testInfo.outputPath(`${operation}-after.html`), html);
        results.push({ operation, route, marker, status: response.status(), cache: response.headers()["x-nextjs-cache"], updated: html.includes(marker) });
        expect.soft(response.status()).toBe(200);
        expect.soft(html, `${operation} is visible before the next ISR interval`).toContain(marker);
        await page.goto(route);
        await expect.soft(page.locator("body")).toContainText(marker);
        await page.screenshot({ path: testInfo.outputPath(`${operation}-public.png`), fullPage: true });
        expect.soft(errors.splice(0)).toEqual([]);
      }
      const state = await (await request.get(controlUrl(baseURL))).json();
      const applied = state.requests.slice(requestOffset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
      expect(applied).toHaveLength(2);
      expect(applied.every(call => call.committed)).toBe(true);
      await fs.writeFile(testInfo.outputPath("committed-requests.json"), JSON.stringify(applied, null, 2));
    } finally {
      await control(request, baseURL, { reset: true });
      await fs.writeFile(testInfo.outputPath("recovery.json"), JSON.stringify({ failure, commands, results }, null, 2));
    }
  });
}

test("unconfirmed recovery keeps the draft and cached pages without another publish", async ({ request, page, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  let statusFailure = "outage";
  await page.route("**/api/admin/content/**", async route => {
    if (new URL(route.request().url()).pathname === "/api/admin/content/publish/status") await control(request, baseURL, { receiptFailure: statusFailure });
    await route.continue({ headers: { ...route.request().headers(), ...adminHeaders } });
  });
  const commands = [];
  page.on("request", req => {
    if (new URL(req.url()).pathname === "/api/admin/content/publish" && req.method() === "POST") commands.push(req.postDataJSON());
  });
  const outcomes = [];
  try {
    await control(request, baseURL, { reset: true });
    await renew(request);
    await warm(request, []);
    const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
    await control(request, baseURL, { publishResponseFailure: "5xx" });
    await page.goto("/admin/content");
    await page.getByRole("navigation", { name: "Content types" }).getByRole("button", { name: "Hero Section", exact: true }).click();
    const marker = "Confirmed only after the receipt returns";
    await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(marker);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not confirm publication" })).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("unconfirmed-admin.png"), fullPage: true });
    for (const failure of ["missing", "outage", "command", "operation", "document-id", "type", "revision", "replayed"]) {
      await control(request, baseURL, { receiptFailure: failure });
      const response = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: commands[0] });
      const payload = await response.json();
      outcomes.push({ failure, status: response.status(), payload });
      expect(response.status()).toBe(["missing", "replayed"].includes(failure) ? 404 : 503);
      for (const route of PREBUILT_ROUTES) {
        const cached = await request.get(route);
        expect(cached.status()).toBe(200);
        expect(cached.headers()["x-nextjs-cache"], `${failure} preserves ${route}`).toBe("HIT");
      }
    }
    statusFailure = "";
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
    const current = await request.get("/");
    expect(current.status()).toBe(200);
    expect(await current.text()).toContain(marker);
    const state = await (await request.get(controlUrl(baseURL))).json();
    expect(state.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"))).toHaveLength(1);
    await page.goto("/");
    await expect(page.locator("body")).toContainText(marker);
    await page.screenshot({ path: testInfo.outputPath("confirmed-public.png"), fullPage: true });
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("receipt-outcomes.json"), JSON.stringify({ commands, outcomes }, null, 2));
  }
});

test("missing optional homepage singletons allow updates while actual read failures keep good content", async ({ request, page, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  const results = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await control(request, baseURL, { reset: true });
    for (const missing of [["faqSettings"], ["packagesSettings"], ["supportedGames"], ["proReviewsCarousel", "about", "services", "packagesSettings", "howItWorks", "supportedGames", "faqSettings"]]) {
      const loaded = await request.get("/api/admin/content/documents/tooling-hero", { headers: adminHeaders });
      const { data } = await loaded.json();
      const marker = `Optional settings update ${results.length + 1}`;
      await control(request, baseURL, { missing });
      const response = await publish(request, { operation: "replace", type: "hero", documentId: data.document._id, expectedRevision: data.revision, document: { ...data.document, headingLine1: marker } });
      expect(response.ok(), await response.text()).toBe(true);
      const home = await request.get("/");
      const html = await home.text();
      await fs.writeFile(testInfo.outputPath(`optional-${results.length + 1}.html`), html);
      results.push({ missing, marker, status: home.status(), updated: html.includes(marker) });
      expect.soft(home.status()).toBe(200);
      expect.soft(html).toContain(marker);
      await page.goto("/");
      await expect.soft(page.locator("body")).toContainText(marker);
      await page.screenshot({ path: testInfo.outputPath(`optional-${results.length}.png`), fullPage: true });
      expect.soft(errors.splice(0)).toEqual([]);
    }
    const lastGood = results.at(-1).marker;
    await control(request, baseURL, { missing: [] });
    await renew(request);
    await expect.poll(async () => {
      const response = await request.get("/");
      return response.status() === 200 && response.headers()["x-nextjs-cache"] === "HIT" && (await response.text()).includes(lastGood);
    }, { timeout: 30000 }).toBe(true);
    const updated = "Valid update during an optional settings outage";
    await control(request, baseURL, { outage: ["faqSettings", "faqSection"], patch: { _id: "tooling-hero", headingLine1: updated } });
    await new Promise(resolve => setTimeout(resolve, 61000));
    expect((await request.get("/")).headers()["x-nextjs-cache"]).toBe("STALE");
    await page.waitForTimeout(2000);
    const retained = await request.get("/");
    const html = await retained.text();
    await fs.writeFile(testInfo.outputPath("optional-read-failure.html"), html);
    expect(retained.status()).toBe(200);
    expect(html.includes(lastGood) || html.includes(updated)).toBe(true);
    expect(html).toContain("Synthetic local question 1");
    expect(html).not.toContain("Application error");
    await page.goto("/");
    await expect(page.locator("body")).toContainText(/Optional settings update 4|Valid update during an optional settings outage/);
    await expect(page.locator("body")).toContainText("Synthetic local question 1");
    await page.screenshot({ path: testInfo.outputPath("optional-read-failure.png"), fullPage: true });
    expect(errors).toEqual([]);
    await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(await (await request.get(controlUrl(baseURL))).json(), null, 2));
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("optional-results.json"), JSON.stringify(results, null, 2));
  }
});

for (const mode of ["5xx", "timeout", "malformed", "malformed-icon", "invalid-json", "missing"]) {
  test(`public pages retain good content through ${mode} CMS revalidation and hydration`, async ({ request, browser, baseURL }, testInfo) => {
    const timeline = [];
    try {
      await control(request, baseURL, { reset: true });
      await renew(request);
      await warm(request, timeline);
      if (mode === "malformed") {
        await control(request, baseURL, { failure: "timeout" });
        await new Promise(resolve => setTimeout(resolve, 61000));
        const recoveryStarted = Date.now();
        await read(request, "/tools", timeline, "before CMS recovery");
        expect(timeline.at(-1).cache).toBe("STALE");
        let pending;
        await expect.poll(async () => {
          const state = await (await request.get(controlUrl(baseURL))).json();
          pending = state.requests.find(call => call.receivedAt >= recoveryStarted && call.body?.p_document_types?.includes("tool") && call.delayMs > 0 && !call.respondedAt);
          return Boolean(pending);
        }).toBe(true);
        await fs.writeFile(testInfo.outputPath("pending-recovery.json"), JSON.stringify(pending, null, 2));
        await control(request, baseURL, { reset: true });
        await renew(request);
        await warm(request, timeline);
      }
      const failure = mode === "5xx" ? { outage: true }
        : mode === "missing" ? { missing: ["hero", "contact", "privacyPolicy", "terms", "meetTheTeam"] }
        : mode === "malformed-icon" ? { patch: { _id: "tooling-cls-tool-0", icon: { asset: { _ref: { broken: true } } } } }
        : { failure: mode };
      if (mode === "malformed-icon") await control(request, baseURL, failure);
      expect((await publish(request, { operation: "invalid" })).status()).toBe(400);
      for (const route of PREBUILT_ROUTES) {
        await read(request, route, timeline, "rejected publish");
        expect.soft(timeline.at(-1).cache, `${route} keeps its cached page`).toBe("HIT");
      }
      if (mode !== "malformed-icon") await control(request, baseURL, failure);
      await new Promise(resolve => setTimeout(resolve, 61000));
      for (const route of PREBUILT_ROUTES) await read(request, route, timeline, "stale");
      await new Promise(resolve => setTimeout(resolve, mode === "timeout" ? 32000 : 2000));
      for (const route of PREBUILT_ROUTES) await read(request, route, timeline, "after revalidation");
      if (mode === "malformed-icon") {
        const response = await request.get("/api/content/tools");
        const { data } = await response.json();
        expect.soft(response.status()).toBe(200);
        expect.soft(data.every(tool => tool.iconUrl == null || typeof tool.iconUrl === "string")).toBe(true);
        await fs.writeFile(testInfo.outputPath("projected-tools.json"), JSON.stringify(data, null, 2));
      }
      await screenshots(browser, baseURL, testInfo, mode);
      const evidence = await request.get(controlUrl(baseURL));
      await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(await evidence.json(), null, 2));
    } finally {
      await control(request, baseURL, { reset: true });
      await fs.writeFile(testInfo.outputPath("responses.json"), JSON.stringify(timeline, null, 2));
    }
  });
}

test("rebuilding every prebuilt route cannot cache visitor or RSC query markers", async ({ request, baseURL }, testInfo) => {
  const timeline = [];
  const rscHeaders = { rsc: "1", "next-url": "/" };
  try {
    await control(request, baseURL, { reset: true });
    for (const route of PREBUILT_ROUTES) {
      for (const rsc of [false, true]) {
        await renew(request);
        const marker = `cmsquery${route.replaceAll("/", "") || "home"}${rsc ? "rsc" : "html"}`;
        const target = new URL(route, baseURL);
        target.search = new URLSearchParams({ ref: marker, gclid: marker, _rsc: marker }).toString();
        let rscCorrection;
        if (rsc) {
          const correction = await request.get(`${route}?_rsc=${marker}`, { headers: rscHeaders, maxRedirects: 0 });
          expect(correction.status(), `${route} checks the RSC hash`).toBe(307);
          const destination = new URL(correction.headers().location, baseURL);
          expect(destination.origin).toBe(new URL(baseURL).origin);
          expect(destination.pathname).toBe(route);
          expect([...destination.searchParams.keys()]).toEqual(["_rsc"]);
          rscCorrection = destination.searchParams.get("_rsc");
          expect(rscCorrection).not.toBe(marker);
          expect(rscCorrection).not.toBe("");
          target.searchParams.set("_rsc", rscCorrection);
        }
        const trigger = await requestPage(request, `${target.pathname}${target.search}`, rsc ? rscHeaders : { accept: "text/html" });
        expect.soft(trigger.status(), `${route} trigger`).toBe(200);
        await trigger.body();
        for (const headers of [{ accept: "text/html" }, rscHeaders]) {
          const response = await requestPage(request, route, headers);
          const body = await response.text();
          await fs.writeFile(testInfo.outputPath(`${route.replaceAll("/", "") || "home"}-${rsc ? "rsc" : "html"}-trigger.${headers.rsc ? "rsc" : "html"}`), body);
          timeline.push({ route, rsc, type: response.headers()["content-type"], marker, rscCorrection, trigger: `${target.pathname}${target.search}`, leaked: body.includes(marker) });
          expect.soft(response.status(), route).toBe(200);
          expect.soft(response.headers()["content-type"], route).toContain(headers.rsc ? "text/x-component" : "text/html");
          expect.soft(body.includes(marker), `${route} ${JSON.stringify(headers)} is free of the marker`).toBe(false);
          expect.soft(body.includes("?_rsc="), `${route} has no internal query in its initial URL`).toBe(false);
        }
      }
    }
  } finally { await fs.writeFile(testInfo.outputPath("queries.json"), JSON.stringify(timeline, null, 2)); }
});

test("release generation refuses missing, empty or unavailable legal content", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(600000);
  const checkLegalBuilds = require("./fixtures/cms-build.cjs");
  await checkLegalBuilds({ request, baseURL, control, testInfo, expect });
});

test("public navigation keeps referral capture, history and new tabs usable", async ({ page, context, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL, new URL(controlUrl(baseURL)).origin]);
  await page.goto("/?ref=cms-creator-a");
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toContain("cms-creator-a");
  await page.locator('footer a[href="/about"]').first().click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: "About Roo Industries", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?ref=cms-creator-a$/);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toContain("cms-creator-a");
  await page.goForward();
  await expect(page).toHaveURL(/\/about$/);
  const otherTab = await context.newPage();
  try {
    await otherTab.goto("/?ref=cms-creator-b");
    await expect.poll(() => otherTab.evaluate(() => sessionStorage.getItem("referral_session"))).toContain("cms-creator-b");
    expect(await page.evaluate(() => sessionStorage.getItem("referral_session"))).toContain("cms-creator-a");
    await page.screenshot({ path: testInfo.outputPath("navigation.png"), animations: "disabled" });
  } finally { await otherTab.close(); }
});

test("HEAD and GET action headers cannot seed cached query strings", async ({ request, baseURL }, testInfo) => {
  await control(request, baseURL, { reset: true });
  const results = [];
  for (const route of PREBUILT_ROUTES) {
    for (const method of ["HEAD", "GET"]) {
      await renew(request);
      const marker = `cms${method}${route.replaceAll("/", "") || "home"}`;
      const trigger = await request.fetch(`${route}?ref=${marker}&_rsc=${marker}`, {
        method,
        headers: { accept: "text/html", "next-action": "fixture-action" },
        maxRedirects: 0,
      });
      expect.soft(trigger.status(), `${route} ${method}`).toBe(200);
      if (method === "HEAD") expect.soft((await trigger.body()).length).toBe(0);
      const response = await requestPage(request, route, { accept: "text/html" });
      const html = await response.text();
      const leaked = html.includes(marker);
      results.push({ route, method, leaked });
      expect.soft(leaked, `${route} ${method}`).toBe(false);
      await fs.writeFile(testInfo.outputPath(`${route.replaceAll("/", "") || "home"}-${method}.html`), html);
    }
  }
  await fs.writeFile(testInfo.outputPath("head-and-action-queries.json"), JSON.stringify(results, null, 2));
});
