const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

test.beforeEach(({}, testInfo) => {
  test.skip(!testInfo.config.configFile.endsWith("playwright.cms-build.config.js"), "Run with npm run test:cms-snapshot-build.");
});

test("release snapshots distinguish optional outages from empty content and recover without stale legal content", async ({ browser }, testInfo) => {
  const { createToolingContentFixture } = await import("./fixtures/tooling-content.mjs");
  const { localOrigin, refuseEnvFiles, validateDistDir, installNetworkGuard, guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  const host = process.env.ROO_TEST_HOST || "127.0.0.1";
  const port = Number(process.env.PW_PORT || 3271);
  const baseURL = localOrigin(`http://${host}:${port}`);
  const contentURL = localOrigin(`http://${host}:${Number(process.env.TOOLING_CONTENT_PORT || port + 1)}`);
  expect(contentURL).not.toBe(baseURL);
  const dist = validateDistDir(testInfo.config.metadata.toolingDistDir, { isolated: true });
  expect(await fs.stat(dist).catch(() => null), "fresh owned build directory").toBeNull();
  const snapshotFile = path.resolve("src/generated/public-content.json");
  const originalSnapshot = await fs.readFile(snapshotFile).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  const restoreGuard = installNetworkGuard([baseURL, contentURL]);
  const send = async (url, { data, timeout = 15000, headers = {} } = {}) => {
    const response = await fetch(url, {
      method: data === undefined ? "GET" : "POST", signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(data === undefined ? {} : { "content-type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const text = await response.text();
    return { ok: () => response.ok, status: () => response.status, headers: () => Object.fromEntries(response.headers), text: async () => text, json: async () => JSON.parse(text) };
  };
  const request = { get: send, post: send };
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    CI: "true", NODE_ENV: "production", VERCEL_ENV: "development", TZ: "UTC",
    NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_SENTRY_DSN: "", NEXT_DIST_DIR: dist,
    TOURNEY_DATABASE_MODE: "memory", DATA_PRIMARY_BACKEND: "supabase", COMMERCE_PRIMARY_BACKEND: "supabase",
    SUPABASE_CUTOVER_ENABLED: "1", COMMERCE_CUTOVER_ENABLED: "1",
    SUPABASE_URL: contentURL, NEXT_PUBLIC_SUPABASE_URL: contentURL, NEXT_PUBLIC_SUPABASE_ASSET_URL: contentURL,
    SUPABASE_SECRET_KEY: "fixture-only-tooling-server-secret-key",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "fixture-only-tooling-browser-publishable-key",
    ALLOW_LIVE_PAYMENTS: "0", SALES_PREVIEW_READ_ONLY: "0", CMS_WRITES_PAUSED: "0",
    REF_ADMIN_KEY: "synthetic-cms-resilience-key", __NEXT_TEST_MODE: "cms-resilience",
    ROO_TEST_HOST: host, BASE_URL: baseURL, TOOLING_NETWORK_GUARD: "1",
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([baseURL, contentURL]),
    NODE_OPTIONS: `--import=${path.resolve("scripts/lib/test-target-safety.mjs")}`,
  };
  const next = require.resolve("next/dist/bin/next");
  const outcomes = { source: process.env.CMS_PROOF_SOURCE || null, builds: [], runtime: [], children: [] };
  const children = new Set();
  let fixture;
  let server;
  const stop = async child => {
    if (!child) return;
    const exited = child.exitCode !== null || child.signalCode !== null;
    const done = exited ? Promise.resolve() : new Promise(resolve => child.once("exit", resolve));
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }, 5000);
    try { await done; } finally { clearTimeout(timer); children.delete(child); }
  };
  const launch = async (args, name) => {
    const log = await fs.open(testInfo.outputPath(`${name}.log`), "w");
    try {
      const child = spawn(process.execPath, args, { env, detached: true, stdio: ["ignore", log.fd, log.fd] });
      children.add(child);
      outcomes.children.push({ name, pid: child.pid, args, stopped: false });
      child.once("exit", (code, signal) => Object.assign(outcomes.children.find(row => row.pid === child.pid), { code, signal, stopped: true }));
      return child;
    } finally { await log.close(); }
  };
  const control = async (_request, _baseURL, data) => {
    const response = await request.post(`${contentURL}/__content`, { data });
    expect(response.ok(), await response.text()).toBe(true);
  };
  const build = async (name, state, succeeds, failedResource) => {
    await stop(server); server = null;
    await control(request, baseURL, { reset: true, ...state });
    const before = fixture.evidence.requests.length;
    const started = Date.now();
    const child = await launch([next, "build"], `build-${name}`);
    const timer = setTimeout(() => { void stop(child); }, 300000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timer); await stop(child); }
    const reads = fixture.evidence.requests.slice(before).filter(call => call.path.endsWith("/roo_fetch_shadow_documents_targeted"));
    outcomes.builds.push({ name, ...result, elapsedMs: Date.now() - started, reads });
    await fs.writeFile(testInfo.outputPath("snapshot-results.json"), JSON.stringify(outcomes, null, 2));
    expect(reads.length, `${name}: real CMS reads`).toBeGreaterThan(0);
    expect(result.signal, `${name}: build finishes within its bound`).toBeNull();
    expect(result.code === 0, `${name}: build acceptance`).toBe(succeeds);
    if (failedResource) expect(await fs.readFile(testInfo.outputPath(`build-${name}.log`), "utf8")).toContain(`Public content snapshot could not be built for ${failedResource}.`);
    const snapshot = await fs.readFile(snapshotFile);
    await fs.writeFile(testInfo.outputPath(`snapshot-${name}.json`), snapshot);
    return { resources: JSON.parse(snapshot).resources, reads, snapshot };
  };
  const start = async name => {
    server = await launch([next, "start", "--hostname", host, "--port", String(port)], `server-${name}`);
    await expect.poll(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Owned ${name} server exited.`);
      if (!(await fs.readFile(testInfo.outputPath(`server-${name}.log`), "utf8")).includes("Ready in")) return null;
      return (await request.get(`${baseURL}/privacy`, { timeout: 2000 }).catch(() => null))?.status();
    }, { timeout: 30000 }).toBe(200);
  };
  const capture = async (stage, routes) => {
    for (const width of [360, 390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
      await guardBrowserContext(context, [baseURL, contentURL]);
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        for (const [route, text] of Object.entries(routes)) {
          const response = await page.goto(`${baseURL}${route}`, { waitUntil: "networkidle" });
          expect(response.status()).toBe(200);
          if (route === "/reviews") await expect(page.getByAltText(text).first()).toBeVisible();
          else await expect(page.locator("body")).toContainText(text);
          await page.screenshot({ path: testInfo.outputPath(`${stage}-${route.slice(1)}-${width}.png`), fullPage: true, animations: "disabled" });
          expect(errors.splice(0), `${stage}: ${route} browser errors`).toEqual([]);
        }
      } finally { await context.close(); }
    }
  };
  const runtime = async (stage, empty) => {
    await control(request, baseURL, { outage: ["tool", "review", "proReviewsCarousel"] });
    await start(stage);
    for (const resource of ["tools", "reviews-gallery", "reviews"]) {
      const response = await request.get(`${baseURL}/api/content/${resource}`);
      const payload = await response.json();
      outcomes.runtime.push({ stage, resource, status: response.status(), payload });
      expect(response.status()).toBe(empty ? 200 : 503);
      expect(payload.ok).toBe(empty);
      if (empty) expect(payload.data).toEqual(resource === "reviews" ? null : []);
      else { expect(payload).not.toHaveProperty("data"); expect(response.headers()["cache-control"]).toContain("no-store"); }
    }
    await capture(`${stage}-unavailable`, { "/privacy": "Synthetic local information", "/terms": "Synthetic local information", "/tools": "Tools" });
    const marker = `Recovered ${stage} tool`;
    const review = `Recovered ${stage} review`;
    await control(request, baseURL, { reset: true, patch: { _id: "review-cls-wide", alt: review } });
    await expect.poll(async () => {
      const response = await request.get(`${baseURL}/api/content/tools`);
      expect(response.status()).toBe(200);
      const payload = await response.json();
      return payload.data?.length;
    }, { timeout: 15000 }).toBe(4);
    const headers = { "x-admin-key": env.REF_ADMIN_KEY };
    const loaded = await request.get(`${baseURL}/api/admin/content/documents/tooling-cls-tool-0`, { headers });
    expect(loaded.ok(), await loaded.text()).toBe(true);
    const { data } = await loaded.json();
    const offset = fixture.evidence.requests.length;
    const published = await request.post(`${baseURL}/api/admin/content/publish`, { headers, data: {
      operation: "replace", type: "tool", documentId: "tooling-cls-tool-0", expectedRevision: data.revision,
      document: { ...data.document, title: marker },
    } });
    expect(published.ok(), await published.text()).toBe(true);
    for (const [resource, freshMarker] of [["tools", marker], ["reviews-gallery", review]]) {
      const response = await request.get(`${baseURL}/api/content/${resource}`);
      expect(response.status()).toBe(200);
      expect(await response.text()).toContain(freshMarker);
    }
    for (const [route, freshMarker] of [["/tools", marker], ["/reviews", review]]) {
      await expect.poll(async () => {
        const response = await request.get(`${baseURL}${route}`);
        expect(response.status()).toBe(200);
        const html = await response.text();
        outcomes.runtime.push({ stage: `${stage}-recovery`, route, status: response.status(), cache: response.headers()["x-nextjs-cache"], fresh: html.includes(freshMarker) });
        return html.includes(freshMarker) && response.headers()["x-nextjs-cache"] === "HIT";
      }, { timeout: 30000 }).toBe(true);
    }
    expect(fixture.evidence.requests.slice(offset).filter(call => call.path.endsWith("/roo_apply_cms_publish_command"))).toHaveLength(1);
    await capture(`${stage}-recovered`, { "/tools": marker, "/reviews": review, "/privacy": "Synthetic local information", "/terms": "Synthetic local information" });
    await stop(server); server = null;
  };
  try {
    process.env.TOOLING_CLS_CONTENT = "1";
    fixture = await createToolingContentFixture({ origin: contentURL, artifact: testInfo.outputPath("cms-requests.json"), cms: true, apiRoutes: true });
    const healthy = await build("healthy", {}, true);
    expect(healthy.resources.tools).toHaveLength(4);
    expect(healthy.resources["reviews-gallery"]).toHaveLength(2);
    const optional = await build("optional-outage", { outage: ["tool", "review", "proReviewsCarousel"] }, true);
    for (const resource of ["tools", "reviews-gallery", "reviews"]) expect(optional.resources).not.toHaveProperty(resource);
    for (const type of ["tool", "review", "proReviewsCarousel"]) expect(optional.reads.some(call => call.body.p_document_types.includes(type) && call.status === 503)).toBe(true);
    await runtime("optional-outage", false);
    for (const [resource, type] of [["privacy-policy", "privacyPolicy"], ["terms", "terms"]]) {
      for (const [failure, state] of [
        ["missing", { missing: [type] }],
        ["empty", { patch: { _id: `tooling-${type}`, sections: [] } }],
        ["unavailable", { outage: [type] }],
      ]) {
        const rejected = await build(`${failure}-${resource}`, state, false, resource);
        expect(rejected.snapshot, "failed legal read never reuses or replaces the prior valid snapshot").toEqual(optional.snapshot);
      }
    }
    const empty = await build("healthy-empty", { missing: ["tool", "review", "proReviewsCarousel"] }, true);
    expect(empty.resources.tools).toEqual([]);
    expect(empty.resources["reviews-gallery"]).toEqual([]);
    expect(empty.resources.reviews).toBeNull();
    for (const [type, rows] of [["tool", 2], ["review", 2], ["proReviewsCarousel", 0]]) expect(empty.reads.some(call => call.body.p_document_types.includes(type) && call.status === 200 && call.rows === rows)).toBe(true);
    await runtime("healthy-empty", true);
    await control(request, baseURL, { reset: true });
    await start("legal-neighbors");
    await require("./fixtures/cms-build.cjs")({ request, baseURL, control, testInfo, expect });
  } finally {
    for (const child of children) await stop(child);
    if (fixture) await fixture.close();
    if (originalSnapshot) await fs.writeFile(snapshotFile, originalSnapshot);
    else await fs.rm(snapshotFile, { force: true });
    await fs.rm(dist, { recursive: true, force: true });
    restoreGuard();
    await fs.writeFile(testInfo.outputPath("snapshot-results.json"), JSON.stringify({ ...outcomes, fixtureStopped: fixture?.evidence.stopped }, null, 2));
  }
});
