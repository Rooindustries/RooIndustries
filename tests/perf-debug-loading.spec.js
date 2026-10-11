const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

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
