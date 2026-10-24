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
const screenshots = async (browser, baseURL, testInfo, prefix, content = expected) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const contentOrigin = new URL(controlUrl(baseURL)).origin;
  for (const width of [360, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: true, reducedMotion: "reduce", serviceWorkers: "block" });
    await guardBrowserContext(context, [baseURL, contentOrigin]);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      for (const route of Object.keys(content)) {
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(200);
        if (route === "/reviews") await expect.soft(page.getByAltText(content[route]).first()).toBeVisible();
        else await expect.soft(page.locator("body")).toContainText(content[route]);
        await page.screenshot({ path: testInfo.outputPath(`${prefix}-${route.replaceAll("/", "") || "home"}-${width}.png`), fullPage: true, animations: "disabled", timeout: 30000 });
        expect.soft(errors.splice(0), `${route} browser errors`).toEqual([]);
      }
    } finally { await context.close(); }
  }
};

test("an in-flight render keeps good content when a later publish invalidates its pending read", async ({ request, page, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  const outcomes = {};
  let firstVisit;
  try {
    await control(request, baseURL, { reset: true });
    await expect.poll(async () => (await request.get("/contact")).headers()["x-nextjs-cache"], { timeout: 30000 }).toBe("HIT");
    const { data } = await (await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders })).json();
    const command = { operation: "replace", type: "contact", documentId: data.document._id, expectedRevision: data.revision, document: { ...data.document, subtitle: "The first publication before the delayed render" } };
    const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
    expect((await publish(request, command)).ok()).toBe(true);
    await control(request, baseURL, { failure: "timeout" });
    const startedAt = Date.now();
    firstVisit = page.goto("/contact", { waitUntil: "domcontentloaded", timeout: 20000 });
    let pending;
    await expect.poll(async () => {
      const state = await (await request.get(controlUrl(baseURL))).json();
      pending = state.requests.find(call => call.receivedAt >= startedAt && call.body?.p_ids === null && call.body?.p_document_types?.includes("contact") && call.delayMs > 0 && !call.respondedAt);
      return Boolean(pending);
    }).toBe(true);
    outcomes.pendingRead = pending;
    await control(request, baseURL, { failure: "" });
    const current = await (await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders })).json();
    const marker = "Published while the previous render is waiting";
    const latest = { ...command, expectedRevision: current.data.revision, document: { ...current.data.document, subtitle: marker } };
    const result = await publish(request, latest);
    expect(result.ok(), await result.text()).toBe(true);
    outcomes.secondAcknowledgedAt = Date.now();
    const response = await firstVisit;
    outcomes.firstFinishedAt = Date.now();
    outcomes.firstStatus = response.status();
    await fs.writeFile(testInfo.outputPath("first-render.html"), await response.text());
    await page.screenshot({ path: testInfo.outputPath("first-render.png"), fullPage: true });
    expect.soft(response.status()).toBe(200);
    await expect.soft(page.locator("body")).toContainText("Get In Touch", { timeout: 1000 });
    const status = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: latest });
    expect(status.ok(), await status.text()).toBe(true);
    await page.goto("/contact");
    await expect(page.locator("body")).toContainText(marker);
    await page.screenshot({ path: testInfo.outputPath("latest-render.png"), fullPage: true });
    const state = await (await request.get(controlUrl(baseURL))).json();
    const mutations = state.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
    expect(mutations).toHaveLength(2);
    outcomes.currentVisible = true;
    outcomes.mutations = mutations.length;
    await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(state, null, 2));
  } finally {
    if (firstVisit) await firstVisit.catch(() => {});
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("in-flight-render.json"), JSON.stringify(outcomes, null, 2));
  }
});

for (const mode of ["5xx", "timeout", "malformed", "invalid-json", "missing"]) {
  for (const entry of ["publish", "replay", "status"]) {
    test(`${entry} keeps public pages available when ${mode} CMS reads begin after acknowledgement`, async ({ request, browser, page, baseURL }, testInfo) => {
      const timeline = [];
      const content = { ...expected, "/contact": "Get In Touch" };
      const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
      await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await control(request, baseURL, { reset: true });
        for (const route of PREBUILT_ROUTES) {
          await expect.poll(async () => {
            const response = await request.get(route);
            return response.status() === 200 && response.headers()["x-nextjs-cache"] === "HIT";
          }, { timeout: 30000 }).toBe(true);
        }
        const loaded = await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders });
        expect(loaded.ok(), await loaded.text()).toBe(true);
        const { data } = await loaded.json();
        const marker = `Acknowledged ${entry} before ${mode} reads fail`;
        const command = { operation: "replace", type: "contact", documentId: data.document._id, expectedRevision: data.revision, document: { ...data.document, subtitle: marker } };
        const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
        const committed = await publish(request, command);
        expect(committed.ok(), await committed.text()).toBe(true);
        if (entry === "replay") {
          const replay = await publish(request, command);
          expect(replay.ok(), await replay.text()).toBe(true);
          expect((await replay.json()).data.replayed).toBe(true);
        } else if (entry === "status") {
          const confirmed = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
          expect(confirmed.ok(), await confirmed.text()).toBe(true);
        }
        const failure = mode === "5xx" ? { outage: true }
          : mode === "missing" ? { missing: ["hero", "contact", "privacyPolicy", "terms", "meetTheTeam"] }
          : { failure: mode };
        await control(request, baseURL, failure);
        for (const route of PREBUILT_ROUTES) {
          const response = await request.get(route, { timeout: 15000 });
          const html = await response.text();
          timeline.push({ route, status: response.status(), cache: response.headers()["x-nextjs-cache"], meaningful: html.includes(content[route]) });
          expect.soft(response.status(), route).toBe(200);
          expect.soft(html, route).toContain(content[route]);
          expect.soft(html, route).not.toContain("Application error");
          await fs.writeFile(testInfo.outputPath(`${route.replaceAll("/", "") || "home"}.html`), html);
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await page.screenshot({ path: testInfo.outputPath(`${route.replaceAll("/", "") || "home"}-desktop.png`), fullPage: true });
        }
        expect(timeline.every(row => row.status === 200 && row.meaningful)).toBe(true);
        expect(errors).toEqual([]);
        if (entry === "publish") await screenshots(browser, baseURL, testInfo, `after-confirmed-${mode}`, content);
        await control(request, baseURL, { outage: false, failure: "", missing: [] });
        const recovered = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
        expect(recovered.ok(), await recovered.text()).toBe(true);
        const recovery = [];
        let recoveredHtml;
        try {
          await expect.poll(async () => {
            const response = await request.get("/contact");
            recoveredHtml = await response.text();
            const observation = { status: response.status(), cache: response.headers()["x-nextjs-cache"], visible: recoveredHtml.includes(marker), meaningful: recoveredHtml.includes("Get In Touch") && !recoveredHtml.includes("Application error") };
            recovery.push(observation);
            return observation.status === 200 && observation.cache === "HIT" && observation.visible;
          }, { timeout: 30000 }).toBe(true);
        } finally {
          await fs.writeFile(testInfo.outputPath("recovery-reads.json"), JSON.stringify({ marker, recovery }, null, 2));
          if (recoveredHtml) await fs.writeFile(testInfo.outputPath("recovered-contact.html"), recoveredHtml);
        }
        expect(recovery.every(row => row.status === 200 && row.meaningful)).toBe(true);
        const state = await (await request.get(controlUrl(baseURL))).json();
        const mutations = state.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
        expect(mutations).toHaveLength(1);
        await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(state, null, 2));
        await fs.writeFile(testInfo.outputPath("recovered-publication.json"), JSON.stringify({ marker, visible: true, mutations: mutations.length }, null, 2));
      } finally {
        await control(request, baseURL, { reset: true });
        await fs.writeFile(testInfo.outputPath("confirmed-outage.json"), JSON.stringify({ mode, entry, timeline, errors }, null, 2));
      }
    });
  }
}

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

for (const [type, route] of [["privacyPolicy", "/privacy"], ["terms", "/terms"]]) {
  test(`${type} rejects blank legal content before publishing and accepts corrected content`, async ({ request, browser, page, baseURL }, testInfo) => {
    const outcomes = [];
    const timeline = [];
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const cases = [
      { name: "blank-title", failure: "" },
      { name: "empty-sections", failure: "" },
      ...["", "5xx", "timeout", "invalid-receipt"].map(failure => ({ name: "blank-spans", failure })),
    ];
    try {
      for (const { name, failure } of cases) {
        await control(request, baseURL, { reset: true });
        await renew(request);
        await warm(request, timeline);
        const loaded = await request.get(`/api/admin/content/documents/tooling-${type}`, { headers: adminHeaders });
        expect(loaded.ok(), await loaded.text()).toBe(true);
        const { data } = await loaded.json();
        const invalid = structuredClone(data.document);
        if (name === "blank-title") invalid.title = " \n\t ";
        else if (name === "empty-sections") invalid.sections = [];
        else for (const section of invalid.sections) for (const block of section.content) for (const span of block.children) span.text = " \n\t ";
        const command = { operation: "replace", type, documentId: data.document._id, expectedRevision: data.revision, document: invalid };
        await control(request, baseURL, { publishResponseFailure: failure });
        const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
        const rejected = await publish(request, command);
        const rejection = await rejected.json();
        const status = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
        const saved = await (await request.get(`/api/admin/content/documents/${command.documentId}`, { headers: adminHeaders })).json();
        const calls = (await (await request.get(controlUrl(baseURL))).json()).requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
        outcomes.push({ name, failure, rejected: rejected.status(), rejection, status: status.status(), savedUnchanged: JSON.stringify(saved.data.document) === JSON.stringify(data.document), mutations: calls });
        expect.soft(rejected.status(), `${name}/${failure || "normal"} refuses the publish`).toBe(400);
        expect.soft(rejection).toMatchObject({ ok: false, code: "CMS_VALIDATION_FAILED" });
        expect.soft(status.status(), "Rejected legal content has no committed receipt").toBe(404);
        expect.soft(saved.data.document).toEqual(data.document);
        expect.soft(calls, "Invalid legal content never reaches the mutation").toEqual([]);
        for (const publicRoute of PREBUILT_ROUTES) {
          const html = await read(request, publicRoute, timeline, `${name}/${failure || "normal"}`);
          expect.soft(timeline.at(-1).cache, `${publicRoute} keeps its cached page`).toBe("HIT");
          if (publicRoute === route) await fs.writeFile(testInfo.outputPath(`${name}-${failure || "normal"}.html`), html);
        }
        if (failure === "invalid-receipt") await screenshots(browser, baseURL, testInfo, `rejected-${type}`);
        const marker = `Corrected ${type} ${name} ${failure || "normal"}`;
        const corrected = { ...command, expectedRevision: saved.data.revision, document: { ...data.document, title: marker } };
        const result = await publish(request, corrected);
        expect(result.status(), await result.text()).toBe(failure ? 503 : 200);
        const confirmed = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: corrected });
        expect(confirmed.ok(), await confirmed.text()).toBe(true);
        const response = await request.get(route);
        const html = await response.text();
        outcomes.at(-1).corrected = { status: result.status(), confirmation: confirmed.status(), publicStatus: response.status(), visible: html.includes(marker) };
        expect(response.status()).toBe(200);
        expect(html).toContain(marker);
        await page.goto(route);
        await expect(page.locator("body")).toContainText(marker);
        await page.screenshot({ path: testInfo.outputPath(`corrected-${name}-${failure || "normal"}.png`), fullPage: true });
        expect(errors.splice(0)).toEqual([]);
      }
    } finally {
      await control(request, baseURL, { reset: true });
      await fs.writeFile(testInfo.outputPath("legal-publish.json"), JSON.stringify({ type, route, outcomes, timeline }, null, 2));
    }
  });
}

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

test("malformed external tool links retain good navigation and recover to valid CMS updates", async ({ request, page, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  const downloadUrl = new URL("/favicon-96x96.png", baseURL).href;
  const officialSite = new URL("/tools", baseURL).href;
  const title = "Tool with validated external links";
  const outcomes = [];
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const invalid = ["not a URL", "/relative-download", "//fixture.invalid/download", "javascript:alert('fixture')", "data:text/plain,fixture", "file:///fixture", "mailto:fixture@example.invalid", "https://fixture-user:fixture-password@example.invalid/download"];
  try {
    await control(request, baseURL, { reset: true, patch: { _id: "tooling-cls-tool-0", title, downloadUrl, officialSite } });
    await renew(request);
    const initial = await request.get("/api/content/tools");
    expect(initial.status()).toBe(200);
    const good = (await initial.json()).data.find(tool => tool._id === "tooling-cls-tool-0");
    expect(good).toMatchObject({ title, downloadUrl, officialSite });
    for (const field of ["downloadUrl", "officialSite"]) {
      for (const value of invalid) {
        const marker = `Malformed ${field} ${outcomes.length + 1}`;
        await control(request, baseURL, { patch: { _id: good._id, title: marker, downloadUrl, officialSite, [field]: value } });
        await renew(request);
        const response = await request.get("/api/content/tools");
        expect.soft(response.status()).toBe(200);
        const row = (await response.json()).data?.find(tool => tool._id === good._id);
        outcomes.push({ field, value, row, status: response.status() });
        expect.soft(row, `${field} rejects ${value}`).toMatchObject({ title, downloadUrl, officialSite });
        await page.goto("/tools");
        await expect.soft(page.getByRole("article").filter({ hasText: title })).toBeVisible({ timeout: 1000 });
        await expect.soft(page.getByRole("link", { name: "Official Site", exact: true }).first()).toHaveAttribute("href", officialSite, { timeout: 1000 });
        if (outcomes.length === 1) {
          const card = page.getByRole("article").filter({ hasText: title });
          const siteOpened = page.waitForEvent("popup");
          await card.getByRole("link", { name: "Official Site", exact: true }).click();
          const site = await siteOpened;
          await expect(site).toHaveURL(officialSite);
          await expect(site.getByRole("article").filter({ hasText: title })).toBeVisible();
          await site.close();
          await card.getByRole("button", { name: "Download", exact: true }).click();
          const downloadOpened = page.waitForEvent("popup");
          await page.getByRole("dialog").getByRole("button", { name: "Download", exact: true }).click();
          const download = await downloadOpened;
          await expect(download).toHaveURL(downloadUrl);
          await expect(download.locator("img")).toHaveAttribute("src", downloadUrl);
          await download.screenshot({ path: testInfo.outputPath("working-download.png") });
          await fs.writeFile(testInfo.outputPath("working-links.json"), JSON.stringify({ invalidDownloadUrl: value, officialSite: site.url(), downloadUrl: download.url(), opened: true }, null, 2));
          await download.close();
        }
        await page.screenshot({ path: testInfo.outputPath(`invalid-${outcomes.length}.png`), fullPage: true });
      }
    }
    const padded = { downloadUrl: `\t${downloadUrl} \n`, officialSite: ` ${officialSite} ` };
    for (const values of [{ downloadUrl: null, officialSite: null }, { downloadUrl: "", officialSite: "" }, { downloadUrl, officialSite }, { downloadUrl: "https://example.invalid/download", officialSite: "https://example.invalid" }, padded]) {
      const links = values === padded ? { downloadUrl, officialSite } : values;
      const marker = `Valid tool links recovered ${outcomes.length + 1}`;
      await control(request, baseURL, { patch: { _id: good._id, title: marker, ...values } });
      await renew(request);
      const response = await request.get("/api/content/tools");
      expect(response.status()).toBe(200);
      const row = (await response.json()).data.find(tool => tool._id === good._id);
      expect(row).toMatchObject({ title: marker, ...links });
      await page.goto("/tools");
      const card = page.getByRole("article").filter({ hasText: marker });
      await expect(card).toBeVisible();
      if (links.officialSite) await expect(card.getByRole("link", { name: "Official Site", exact: true })).toHaveAttribute("href", links.officialSite);
      else await expect(card.getByRole("link", { name: "Official Site", exact: true })).toHaveCount(0);
      if (!links.downloadUrl) await expect(card.getByRole("button", { name: "No Download Configured", exact: true })).toBeDisabled();
      if (values === padded) {
        await card.getByRole("button", { name: "Download", exact: true }).click();
        const opened = page.waitForEvent("popup");
        await page.getByRole("dialog").getByRole("button", { name: "Download", exact: true }).click();
        const download = await opened;
        await expect(download).toHaveURL(downloadUrl);
        await expect(download.locator("img")).toHaveAttribute("src", downloadUrl);
        await download.screenshot({ path: testInfo.outputPath("legacy-padded-download.png") });
        await fs.writeFile(testInfo.outputPath("legacy-padded-links.json"), JSON.stringify({ values, links: row, downloadUrl: download.url(), opened: true }, null, 2));
        await download.close();
      }
      outcomes.push({ values, row, status: response.status() });
      await page.screenshot({ path: testInfo.outputPath(`recovered-${outcomes.length}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally {
    await fs.writeFile(testInfo.outputPath("tool-links.json"), JSON.stringify({ outcomes, errors }, null, 2));
    await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(await (await request.get(controlUrl(baseURL))).json(), null, 2));
    await control(request, baseURL, { reset: true });
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
      const recoveredAt = Date.now();
      const marker = `${expected["/contact"]} CMS recovered from ${mode}.`;
      await control(request, baseURL, { reset: true, patch: { _id: "tooling-contact", subtitle: marker } });
      await new Promise(resolve => setTimeout(resolve, 61000));
      for (const route of PREBUILT_ROUTES) await read(request, route, timeline, "recovery trigger");
      await warm(request, timeline);
      const recovered = await request.get("/contact");
      const html = await recovered.text();
      expect(recovered.status()).toBe(200);
      expect(recovered.headers()["x-nextjs-cache"]).toBe("HIT");
      expect(html).toContain(marker);
      await fs.writeFile(testInfo.outputPath("recovered-contact.html"), html);
      await screenshots(browser, baseURL, testInfo, `${mode}-recovered`, { "/contact": marker });
      const evidence = await request.get(controlUrl(baseURL));
      const source = await evidence.json();
      const recoveredRead = source.requests.find(call => call.receivedAt >= recoveredAt && call.body?.p_ids === null && call.body?.p_document_types?.includes("contact") && call.status === 200 && call.rows > 0 && call.respondedAt);
      expect(recoveredRead).toBeTruthy();
      expect(source.requests.filter(call => call.receivedAt >= recoveredAt && call.path.endsWith("/roo_apply_cms_publish_command"))).toEqual([]);
      await fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(source, null, 2));
      await fs.writeFile(testInfo.outputPath("recovered-cache.json"), JSON.stringify({ mode, recoveredAt, marker, cache: recovered.headers()["x-nextjs-cache"], recoveredRead }, null, 2));
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

for (const mode of ["5xx", "timeout", "malformed"]) {
  test(`a committed receipt keeps cached pages while the saved document read has ${mode}`, async ({ request, browser, baseURL }, testInfo) => {
    const timeline = [];
    let status;
    try {
      await control(request, baseURL, { reset: true });
      await renew(request);
      await warm(request, timeline);
      const state = await (await request.get(controlUrl(baseURL))).json();
      const offset = state.requests.length;
      const loaded = await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders });
      const { data } = await loaded.json();
      const marker = `Recovered contact after ${mode} document read`;
      const command = { operation: "replace", type: "contact", documentId: data.document._id, expectedRevision: data.revision, document: { ...data.document, subtitle: marker } };
      await control(request, baseURL, { publishResponseFailure: "5xx" });
      expect((await publish(request, command)).status()).toBe(503);
      await control(request, baseURL, mode === "5xx" ? { outage: state.documentTypes } : { failure: mode });
      const response = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
      status = { code: response.status(), body: await response.json() };
      expect.soft(status.code, "A receipt alone cannot confirm unreadable content").toBe(503);
      expect.soft((await publish(request, command)).status(), "A replay also waits for readable saved content").toBe(503);
      for (const route of PREBUILT_ROUTES) {
        const html = await read(request, route, timeline, "saved read unavailable");
        await fs.writeFile(testInfo.outputPath(`${route.replaceAll("/", "") || "home"}.html`), html);
        expect.soft(timeline.at(-1).cache, `${route} is not invalidated`).toBe("HIT");
      }
      if (status.code === 503 && timeline.slice(-PREBUILT_ROUTES.length).every(row => row.status === 200 && row.cache === "HIT")) {
        await screenshots(browser, baseURL, testInfo, `saved-read-${mode}`);
      }
      await control(request, baseURL, { outage: false, failure: "", publishResponseFailure: "" });
      const recovered = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
      expect(recovered.ok(), await recovered.text()).toBe(true);
      const current = await request.get("/contact");
      expect(current.status()).toBe(200);
      expect(await current.text()).toContain(marker);
      const after = await (await request.get(controlUrl(baseURL))).json();
      const applied = after.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
      expect(applied).toHaveLength(1);
      expect(applied[0].committed).toBe(true);
      await fs.writeFile(testInfo.outputPath("committed-requests.json"), JSON.stringify(applied, null, 2));
    } finally {
      await control(request, baseURL, { reset: true });
      await fs.writeFile(testInfo.outputPath("saved-read.json"), JSON.stringify({ mode, status, timeline }, null, 2));
    }
  });
}

for (const failure of ["5xx", "timeout", "invalid-receipt"]) {
  test(`a deleted tool recovers after a ${failure} commit reply without deleting twice`, async ({ page, request, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
    await page.route("**/api/admin/content/**", route => route.continue({ headers: { ...route.request().headers(), ...adminHeaders } }));
    const commands = [];
    page.on("request", req => { if (new URL(req.url()).pathname === "/api/admin/content/publish" && req.method() === "POST") commands.push(req.postDataJSON()); });
    try {
      await control(request, baseURL, { reset: true });
      await renew(request);
      await expect.poll(async () => (await request.get("/tools")).headers()["x-nextjs-cache"], { timeout: 30000 }).toBe("HIT");
      const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
      await control(request, baseURL, { publishResponseFailure: failure });
      await page.goto("/admin/content");
      await page.getByRole("navigation", { name: "Content types" }).getByRole("button", { name: "Tool", exact: true }).click();
      await page.getByRole("region", { name: "Tool list" }).getByRole("button").filter({ hasText: "Fixture layout tool 1" }).click();
      await page.getByLabel(/^Tool Name/).fill("Local draft before deletion");
      page.once("dialog", dialog => dialog.accept());
      const response = page.waitForResponse(res => new URL(res.url()).pathname === "/api/admin/content/publish" && res.request().method() === "POST");
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await response;
      await expect(page.getByRole("status").filter({ hasText: "Deleted. The live site" })).toBeVisible({ timeout: 10000 });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({ operation: "delete", type: "tool", documentId: "tooling-cls-tool-0" });
      expect((await request.get("/api/admin/content/documents/tooling-cls-tool-0", { headers: adminHeaders })).status()).toBe(404);
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath("deleted-admin.png"), fullPage: true });
      const tools = await request.get("/tools");
      const html = await tools.text();
      expect(tools.status()).toBe(200);
      expect(html).not.toContain("Fixture layout tool 1");
      await fs.writeFile(testInfo.outputPath("deleted-tools.html"), html);
      await page.goto("/tools");
      await expect(page.locator("body")).not.toContainText("Fixture layout tool 1");
      await page.screenshot({ path: testInfo.outputPath("deleted-tools.png"), fullPage: true });
      const state = await (await request.get(controlUrl(baseURL))).json();
      const mutations = state.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"));
      expect(mutations).toHaveLength(1);
      expect(mutations[0].committed).toBe(true);
      await fs.writeFile(testInfo.outputPath("delete-recovery.json"), JSON.stringify({ failure, commands, mutations }, null, 2));
    } finally { await control(request, baseURL, { reset: true }); }
  });
}

test("an unconfirmed deletion keeps its draft and public pages until a read retry confirms absence", async ({ page, request, baseURL }, testInfo) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  let receiptFailure = "outage";
  await page.route("**/api/admin/content/**", async route => {
    if (new URL(route.request().url()).pathname === "/api/admin/content/publish/status") await control(request, baseURL, { receiptFailure });
    await route.continue({ headers: { ...route.request().headers(), ...adminHeaders } });
  });
  const commands = [];
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/admin/content/publish" && req.method() === "POST") commands.push(req.postDataJSON()); });
  const outcomes = [];
  try {
    await control(request, baseURL, { reset: true });
    await renew(request); await warm(request, []);
    const state = await (await request.get(controlUrl(baseURL))).json();
    const offset = state.requests.length;
    await control(request, baseURL, { publishResponseFailure: "5xx" });
    await page.goto("/admin/content");
    await page.getByRole("navigation", { name: "Content types" }).getByRole("button", { name: "Tool", exact: true }).click();
    await page.getByRole("region", { name: "Tool list" }).getByRole("button").filter({ hasText: "Fixture layout tool 1" }).click();
    await page.getByLabel(/^Tool Name/).fill("Keep this draft until deletion is confirmed");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Could not confirm deletion" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toHaveLength(1);
    for (const fault of ["deleted", "revision-mismatch", "type", "document-read"]) {
      await control(request, baseURL, { receiptFailure: fault === "document-read" ? "" : fault, outage: fault === "document-read" ? state.documentTypes : false });
      const response = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: commands[0] });
      outcomes.push({ fault, status: response.status(), body: await response.json() });
      expect(response.status()).toBe(503);
      for (const route of PREBUILT_ROUTES) {
        const cached = await request.get(route);
        expect(cached.status()).toBe(200);
        expect(cached.headers()["x-nextjs-cache"]).toBe("HIT");
      }
    }
    await page.screenshot({ path: testInfo.outputPath("delete-pending.png"), fullPage: true });
    receiptFailure = "";
    await control(request, baseURL, { outage: false });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Deleted. The live site" })).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
    expect(await (await request.get("/tools")).text()).not.toContain("Fixture layout tool 1");
    const after = await (await request.get(controlUrl(baseURL))).json();
    expect(after.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"))).toHaveLength(1);
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("delete-uncertain.json"), JSON.stringify({ commands, outcomes }, null, 2));
  }
});

test("a malformed publish receipt preserves cached pages until its command is confirmed", async ({ request, baseURL }, testInfo) => {
  const timeline = [];
  try {
    await control(request, baseURL, { reset: true }); await renew(request); await warm(request, timeline);
    const { data } = await (await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders })).json();
    const command = { operation: "replace", type: "contact", documentId: data.document._id, expectedRevision: data.revision, document: { ...data.document, subtitle: "Confirmed after a mismatched receipt identity" } };
    await control(request, baseURL, { publishResponseFailure: "wrong-id" });
    expect.soft((await publish(request, command)).status()).toBe(503);
    for (const route of PREBUILT_ROUTES) { await read(request, route, timeline, "malformed receipt"); expect.soft(timeline.at(-1).cache).toBe("HIT"); }
    const confirmed = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: command });
    expect(confirmed.ok(), await confirmed.text()).toBe(true);
    expect(await (await request.get("/contact")).text()).toContain(command.document.subtitle);
  } finally { await control(request, baseURL, { reset: true }); await fs.writeFile(testInfo.outputPath("malformed-receipt.json"), JSON.stringify(timeline, null, 2)); }
});

test("replaying an old deletion preserves the cache and the restored document", async ({ request, baseURL }, testInfo) => {
  try {
    await control(request, baseURL, { reset: true });
    const { data } = await (await request.get("/api/admin/content/documents/tooling-cls-tool-0", { headers: adminHeaders })).json();
    const command = { operation: "delete", type: "tool", documentId: data.document._id, expectedRevision: data.revision };
    expect((await publish(request, command)).ok()).toBe(true);
    const restored = await request.post(new URL("/__fixture", controlUrl(baseURL)).href, { data: { reset: true } });
    expect(restored.ok()).toBe(true);
    await control(request, baseURL, { patch: { _id: data.document._id, title: "Restored tool survives the old deletion" } });
    const contact = (await (await request.get("/api/admin/content/documents/tooling-contact", { headers: adminHeaders })).json()).data;
    expect((await publish(request, { operation: "replace", type: "contact", documentId: contact.document._id, expectedRevision: contact.revision, document: { ...contact.document, subtitle: "Refresh after restoration" } })).ok()).toBe(true);
    await expect.poll(async () => (await request.get("/tools")).headers()["x-nextjs-cache"], { timeout: 30000 }).toBe("HIT");
    const replay = await publish(request, command);
    expect(replay.ok(), await replay.text()).toBe(true);
    expect((await replay.json()).data.replayed).toBe(true);
    const tools = await request.get("/tools");
    const html = await tools.text();
    expect.soft(tools.headers()["x-nextjs-cache"]).toBe("HIT");
    expect(html).toContain("Restored tool survives the old deletion");
    const after = await (await request.get(controlUrl(baseURL))).json();
    expect(after.requests.filter(call => call.path.endsWith("/roo_apply_cms_publish_command") && call.body.p_mutations?.[0]?.operation === "delete")).toEqual([]);
    await fs.writeFile(testInfo.outputPath("restored-tool.html"), html);
  } finally { await control(request, baseURL, { reset: true }); }
});

test("deletion recovery keeps real retry actions at phone and desktop widths", async ({ page, request, baseURL }, testInfo) => {
  page.setDefaultTimeout(15000);
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(page.context(), [baseURL, new URL(controlUrl(baseURL)).origin]);
  let blockDelete = false;
  let hideReceipt = false;
  const remainingTools = page.getByRole("region", { name: "Tool list" }).getByRole("button").filter({ hasText: /^Fixture layout tool [1-4]$/ });
  await page.route("**/api/admin/content/**", async route => {
    const call = route.request();
    const path = new URL(call.url()).pathname;
    if (path === "/api/admin/content/publish" && call.method() === "POST" && blockDelete) return route.abort("failed");
    if (path === "/api/admin/content/publish/status" && hideReceipt) await control(request, baseURL, { receiptFailure: "outage" });
    await route.continue({ headers: { ...call.headers(), ...adminHeaders } });
  });
  const outcomes = [];
  try {
    for (const width of [360, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const state of ["never-arrived", "unconfirmed", "confirmed"]) {
        await control(request, baseURL, { reset: true });
        blockDelete = state === "never-arrived";
        hideReceipt = state === "unconfirmed";
        await control(request, baseURL, { publishResponseFailure: state === "never-arrived" ? "" : "5xx" });
        await page.goto("/admin/content");
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        const navigation = page.getByRole("navigation", { name: "Content types", includeHidden: true });
        await expect(navigation).toBeAttached();
        if (!await navigation.isVisible()) await page.getByRole("button", { name: "Types", exact: true }).click();
        await navigation.getByRole("button", { name: "Tool", exact: true }).click();
        await page.getByRole("region", { name: "Tool list" }).getByRole("button").filter({ hasText: "Fixture layout tool 1" }).click();
        await page.getByLabel(/^Tool Name/).fill("Keep this local draft until deletion is confirmed");
        const drafts = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")));
        await expect.poll(drafts).toHaveLength(1);
        const offset = (await (await request.get(controlUrl(baseURL))).json()).requests.length;
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        const deleted = page.getByRole("status").filter({ hasText: "Deleted. The live site" });
        await expect(page.getByRole("alert").filter({ hasText: /\S/ }).or(deleted).first()).toBeVisible({ timeout: 15000 });
        if (await deleted.isVisible()) await expect(remainingTools).toHaveText(["Fixture layout tool 2", "Fixture layout tool 3", "Fixture layout tool 4"]);
        const expected = state === "never-arrived" ? "Not deleted. Retry when you are ready; your changes are kept as a local draft."
          : state === "unconfirmed" ? "Could not confirm deletion. Your changes are kept as a local draft. Retry to check whether it was deleted before trying again."
          : "Deleted. The live site picks this up within a few minutes.";
        expect.soft(page.locator('[role="alert"], [role="status"]').filter({ hasText: expected }).first()).toBeVisible({ timeout: 1000 });
        const row = { state, width, text: await page.locator('[role="alert"], [role="status"]').allTextContents(), drafts: (await drafts()).length };
        await page.screenshot({ path: testInfo.outputPath(`${state}-${width}.png`), fullPage: true, animations: "disabled" });
        const beforeRetry = await (await request.get(controlUrl(baseURL))).json();
        row.beforeRetryMutations = beforeRetry.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command")).length;
        expect.soft(row.beforeRetryMutations).toBe(state === "never-arrived" ? 0 : 1);
        if (state !== "confirmed") {
          expect.soft(row.drafts).toBe(1);
          const retry = page.getByRole("button", { name: "Retry", exact: true });
          expect.soft(retry).toBeVisible({ timeout: 1000 });
          if (await retry.isVisible()) {
            blockDelete = false;
            hideReceipt = false;
            await control(request, baseURL, { publishResponseFailure: "", receiptFailure: "" });
            if (state === "never-arrived") page.once("dialog", dialog => dialog.accept());
            await retry.click();
            await expect(deleted).toBeVisible();
            await expect(remainingTools).toHaveText(["Fixture layout tool 2", "Fixture layout tool 3", "Fixture layout tool 4"]);
            await page.screenshot({ path: testInfo.outputPath(`${state}-recovered-${width}.png`), fullPage: true, animations: "disabled" });
          }
        }
        const after = await (await request.get(controlUrl(baseURL))).json();
        row.mutations = after.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command")).length;
        row.deleted = await deleted.isVisible();
        row.remainingTools = await remainingTools.allTextContents();
        expect.soft(row.deleted).toBe(true);
        expect.soft(await drafts()).toEqual([]);
        expect.soft(row.mutations).toBe(1);
        expect.soft((await request.get("/api/admin/content/documents/tooling-cls-tool-0", { headers: adminHeaders })).status()).toBe(404);
        outcomes.push(row);
      }
    }
  } finally {
    await control(request, baseURL, { reset: true });
    await fs.writeFile(testInfo.outputPath("deletion-visual-states.json"), JSON.stringify(outcomes, null, 2));
  }
});

test("confirmed publications and empty tool lists survive an eleven-minute CMS outage", async ({ request, browser, baseURL }, testInfo) => {
  const fixtureUrl = new URL("/__fixture", controlUrl(baseURL)).href;
  const marker = "Most recently confirmed headline through a prolonged outage";
  const recoveredMarker = "Fresh source after the prolonged outage";
  const timeline = [];
  const deleted = [];
  const setClock = async clockNow => {
    const response = await request.post(fixtureUrl, { data: { clockNow } });
    expect(response.status()).toBe(200);
  };
  const content = async (resource, stage) => {
    const response = await request.get(`/api/content/${resource}`);
    const body = await response.json();
    timeline.push({ stage, resource, status: response.status(), body });
    expect.soft(response.status(), `${stage}/${resource}`).toBe(200);
    return body.data;
  };
  const pages = async stage => {
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    for (const width of [360, 390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: true, reducedMotion: "reduce" });
      await guardBrowserContext(context, [baseURL, new URL(fixtureUrl).origin]);
      const errors = [];
      context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
      try {
        const page = await context.newPage();
        await page.goto("/");
        await expect.soft(page.locator("main")).toContainText(stage === "recovered" ? recoveredMarker : marker);
        await page.screenshot({ path: testInfo.outputPath(`${stage}-home-${width}.png`), fullPage: true });
        await page.goto("/tools");
        await expect.soft(page.getByRole("article")).toHaveCount(0);
        await expect.soft(page.locator("body")).not.toContainText("Application error");
        await page.screenshot({ path: testInfo.outputPath(`${stage}-tools-${width}.png`), fullPage: true });
        expect.soft(errors, `${stage}/${width} hydration`).toEqual([]);
      } finally { await context.close(); }
    }
  };
  const failures = [];
  try {
    await control(request, baseURL, { reset: true });
    await renew(request);
    const loaded = await request.get("/api/admin/content/documents/tooling-hero", { headers: adminHeaders });
    const hero = (await loaded.json()).data;
    expect(loaded.status()).toBe(200);
    const command = { operation: "replace", type: "hero", documentId: "tooling-hero", expectedRevision: hero.revision, document: { ...hero.document, headingLine1: marker } };
    expect((await publish(request, command)).status()).toBe(200);
    expect((await content("hero", "confirmed publish")).headingLine1).toBe(marker);
    const tools = await content("tools", "before deletion");
    expect(tools).toHaveLength(4);
    for (const tool of tools) {
      const response = await request.get(`/api/admin/content/documents/${tool._id}`, { headers: adminHeaders });
      const saved = (await response.json()).data;
      expect(response.status()).toBe(200);
      const deletion = { operation: "delete", type: "tool", documentId: tool._id, expectedRevision: saved.revision };
      const committed = await publish(request, deletion);
      expect(committed.status()).toBe(200);
      const confirmed = await request.post("/api/admin/content/publish/status", { headers: adminHeaders, data: deletion });
      expect(confirmed.status()).toBe(200);
      expect((await confirmed.json()).data).toMatchObject({ committed: true, deleted: true, documentId: tool._id });
      deleted.push(tool._id);
    }
    expect(await content("tools", "confirmed empty list")).toEqual([]);
    expect((await content("hero", "latest confirmed state")).headingLine1).toBe(marker);
    for (const route of ["/", "/tools"]) await expect.poll(async () => {
      const response = await request.get(route);
      return response.headers()["x-nextjs-cache"];
    }, { timeout: 30000 }).toBe("HIT");
    let clock = Date.now() + 11 * 60 * 1000;
    await control(request, baseURL, { outage: true });
    await setClock(clock);
    expect.soft((await content("hero", "eleven-minute outage"))?.headingLine1).toBe(marker);
    expect.soft(await content("tools", "eleven-minute outage")).toEqual([]);
    await pages("outage");
    await setClock(clock += 6000);
    expect.soft((await content("hero", "continued outage retry"))?.headingLine1).toBe(marker);
    expect.soft(await content("tools", "continued outage retry")).toEqual([]);
    await control(request, baseURL, { outage: false, patch: { _id: "tooling-hero", headingLine1: recoveredMarker } });
    await setClock(clock += 6000);
    expect((await content("hero", "source recovered")).headingLine1).toBe(recoveredMarker);
    expect(await content("tools", "source recovered")).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 61000));
    for (const route of ["/", "/tools"]) await expect.poll(async () => {
      const response = await request.get(route);
      const html = await response.text();
      return response.headers()["x-nextjs-cache"] === "HIT" && (route !== "/" || html.includes(recoveredMarker));
    }, { timeout: 30000 }).toBe(true);
    await pages("recovered");
  } finally {
    for (const cleanup of [
      () => setClock(null),
      () => fs.writeFile(testInfo.outputPath("prolonged-outage.json"), JSON.stringify({ deleted, timeline }, null, 2)),
      async () => fs.writeFile(testInfo.outputPath("cms-requests.json"), JSON.stringify(await (await request.get(controlUrl(baseURL))).json(), null, 2)),
      () => control(request, baseURL, { reset: true }),
      () => renew(request),
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
  }
  if (failures.length) throw failures[0];
});
