const { test: base, expect } = require("@playwright/test");
const fs = require("node:fs");
const { heldRouteFixtures, inspectChunks } = require("./fixtures/held-routes.cjs");

const test = base.extend(heldRouteFixtures);

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 }, serviceWorkers: "block", trace: "off", video: "off" });

const attachJson = async (testInfo, name, value) => {
  const file = testInfo.outputPath(`${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  await testInfo.attach(name, { path: file, contentType: "application/json" });
};

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await context.addInitScript(() => {
    window.__reactCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: () => { window.__reactCommits += 1; },
    };
    window.__failedScripts = [];
    window.addEventListener("error", (event) => {
      if (event.target instanceof HTMLScriptElement) window.__failedScripts.push(event.target.src);
    }, true);
    window.__debugObservers = [];
    const Original = window.PerformanceObserver;
    window.PerformanceObserver = class extends Original {
      observe(options) {
        window.__debugObservers.push({ type: options.type, disconnected: false, observer: this });
        return super.observe(options);
      }
      disconnect() {
        window.__debugObservers.filter(entry => entry.observer === this).forEach(entry => { entry.disconnected = true; });
        return super.disconnect();
      }
    };
  });
});

const trackDebugScripts = (page) => {
  const urls = [];
  const pending = [];
  page.on("response", response => {
    if (response.request().resourceType() === "script") {
      pending.push(response.text().then(body => { if (body.includes('"Perf Debug"')) urls.push(response.url()); }).catch(() => {}));
    }
  });
  return async () => { await Promise.all(pending); return urls; };
};

const failOverlayCode = async (page, baseURL, failures) => {
  const asks = [];
  await inspectChunks(page, { origin: new URL(baseURL).origin }, () => undefined, (route, response, body) => {
    if (!body.includes('"Perf Debug"')) return route.fulfill({ response, body });
    asks.push(route.request().url());
    return asks.length > failures ? route.fulfill({ response, body }) : route.abort("failed");
  });
  return asks;
};

const holdFirstOverlayLoad = async (page, baseURL) => {
  const hold = { asks: 0, failed: false };
  hold.gate = new Promise((resolve) => { hold.release = resolve; });
  const isOverlay = (body) => body.includes('"Perf Debug"');
  await inspectChunks(page, { origin: new URL(baseURL).origin },
    (body) => (isOverlay(body) && ++hold.asks === 1 ? hold.gate : undefined),
    (route, response, body) => {
      if (!isOverlay(body) || hold.failed) return route.fulfill({ response, body });
      hold.failed = true;
      return route.abort("failed");
    });
  return hold;
};

const failedLoads = async (page, count) => {
  await expect.poll(() => page.evaluate(() => window.__failedScripts.length)).toBe(count);
};

const turnDebug = (page, on) => page.evaluate((enabled) => {
  if (enabled === true) {
    localStorage.setItem("roo_perf_debug", "1");
  } else if (enabled === false) {
    history.replaceState(history.state, "", location.pathname);
    localStorage.removeItem("roo_perf_debug");
  }
  const added = new MutationObserver(() => {});
  added.observe(document, { childList: true, subtree: true });
  window.__commitsAtChange = window.__reactCommits;
  window.dispatchEvent(new CustomEvent("roo-perf-debug-change"));
  const scripts = added.takeRecords().flatMap(({ addedNodes }) => [...addedNodes])
    .filter((node) => node.nodeName === "SCRIPT").map((node) => node.src);
  added.disconnect();
  return scripts;
}, on);

const renderedAfterChange = async (page) => {
  await expect.poll(() => page.evaluate(() => window.__reactCommits > window.__commitsAtChange)).toBe(true);
};

const pageErrors = (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
};

const loadFailureReports = (page) => {
  const reports = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /ChunkLoadError/.test(message.text())) reports.push(message.text());
  });
  return reports;
};

test("ordinary loads exclude the debug overlay and its observers", async ({ page }, testInfo) => {
  const scripts = trackDebugScripts(page);
  await page.goto("/");
  await page.waitForTimeout(1000);
  expect(await scripts()).toEqual([]);
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__debugObservers.filter(entry => entry.type === "longtask" || entry.type === "layout-shift").length)).toBe(0);
  await attachJson(testInfo, "debug-scripts", await scripts());
});

for (const enabledBy of ["query", "storage", "event"]) {
  test(`debug enables through ${enabledBy}, preserves toggles and cleans up`, async ({ page, context }, testInfo) => {
    const scripts = trackDebugScripts(page);
    if (enabledBy === "storage") await context.addInitScript(() => localStorage.setItem("roo_perf_debug", "1"));
    await page.goto(enabledBy === "query" ? "/?perfdebug=1" : "/");
    if (enabledBy === "event") {
      await page.waitForTimeout(500);
      expect(await scripts()).toEqual([]);
      await page.evaluate(() => {
        localStorage.setItem("roo_perf_debug", "1");
        window.dispatchEvent(new CustomEvent("roo-perf-debug-change"));
      });
    }
    await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
    await expect.poll(async () => (await scripts()).length).toBeGreaterThan(0);
    for (const [label, className] of [
      ["Disable navbar blur", "perf-no-navbar-blur"],
      ["Disable reservation blur", "perf-no-banner-blur"],
      ["Pause reviews autoplay", "perf-pause-reviews"],
      ["Pause how-it-works videos", "perf-pause-howitworks"],
      ["Disable glow/shimmer animations", "perf-no-glow"],
    ]) {
      await page.getByLabel(label, { exact: true }).check();
      await expect(page.locator("html")).toHaveClass(new RegExp(className));
    }
    await page.getByRole("button", { name: "Reset toggles", exact: true }).click();
    await expect(page.locator("aside input:checked")).toHaveCount(0);
    await page.getByRole("button", { name: "Reset metrics", exact: true }).click();
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__debugObservers.filter(entry => (entry.type === "longtask" || entry.type === "layout-shift") && !entry.disconnected).length)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem("roo_perf_debug"))).toBeNull();
    await attachJson(testInfo, "debug-scripts", await scripts());
  });
}

test("a failed overlay load asks for its code again when debug is turned on again", async ({ page, baseURL }) => {
  const errors = pageErrors(page);
  const reports = loadFailureReports(page);
  const asks = await failOverlayCode(page, baseURL, 1);
  await page.goto("/?perfdebug=1");
  await failedLoads(page, 1);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(asks).toHaveLength(1);
  await turnDebug(page, true);
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  expect(asks).toHaveLength(2);
  await page.getByLabel("Disable navbar blur", { exact: true }).check();
  await expect(page.locator("html")).toHaveClass(/perf-no-navbar-blur/);
  await expect.poll(() => reports.length).toBe(1);
  expect(errors).toEqual([]);
});

test("the overlay asks again on every turn on until its code arrives and never while off", async ({ page, baseURL }) => {
  const errors = pageErrors(page);
  const reports = loadFailureReports(page);
  const asks = await failOverlayCode(page, baseURL, 2);
  await page.goto("/?perfdebug=1");
  await failedLoads(page, 1);
  await turnDebug(page, true);
  await expect.poll(() => asks.length).toBe(2);
  await failedLoads(page, 2);
  await expect.poll(() => reports.length).toBe(2);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(await turnDebug(page, false)).toEqual([]);
  expect(asks).toHaveLength(2);
  await turnDebug(page, true);
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  expect(asks).toHaveLength(3);
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(reports).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("debug turned on again after Hide shows the overlay", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/?perfdebug=1");
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  await turnDebug(page, null);
  await renderedAfterChange(page);
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("roo_perf_debug"))).toBeNull();
  await turnDebug(page, true);
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Hide keeps the overlay hidden when storage cannot be used", async ({ page, context }) => {
  const errors = pageErrors(page);
  await context.addInitScript(() => {
    for (const name of ["getItem", "setItem", "removeItem"]) {
      Storage.prototype[name] = () => { throw new DOMException("blocked", "SecurityError"); };
    }
  });
  await page.goto("/?perfdebug=1");
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hide", exact: true }).click();
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  await turnDebug(page, null);
  await renderedAfterChange(page);
  await expect(page.getByText("Perf Debug", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("turning debug on during a failing load asks once and reports the failure once", async ({ page, baseURL }) => {
  const errors = pageErrors(page);
  const reports = loadFailureReports(page);
  const hold = await holdFirstOverlayLoad(page, baseURL);
  await page.goto("/?perfdebug=1", { waitUntil: "domcontentloaded" });
  await expect.poll(() => hold.asks).toBe(1);
  for (let signal = 0; signal < 3; signal += 1) expect(await turnDebug(page, true)).toEqual([]);
  hold.release();
  await failedLoads(page, 1);
  expect(hold.asks).toBe(1);
  await turnDebug(page, true);
  await expect(page.getByText("Perf Debug", { exact: true })).toBeVisible();
  expect(hold.asks).toBe(2);
  expect(reports).toHaveLength(1);
  expect(errors).toEqual([]);
});
