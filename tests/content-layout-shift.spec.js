const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

test.use({ javaScriptEnabled: true, serviceWorkers: "block", trace: "off", video: "off" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  await guardBrowserContext(context, [baseURL, contentURL.origin]);
  await context.addInitScript(() => {
    const selector = (node) => {
      if (!node) return null;
      if (!node.tagName) return selector(node.parentElement);
      if (node.id) return `${node.tagName.toLowerCase()}#${node.id}`;
      const parent = node.parentElement;
      const name = `${node.tagName.toLowerCase()}${[...node.classList].map((value) => `.${value}`).join("")}`;
      return parent ? `${selector(parent)} > ${name}` : name;
    };
    window.__layoutShifts = [];
    window.__layoutShiftSupported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    if (!window.__layoutShiftSupported) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__layoutShifts.push({
          value: entry.value,
          startTime: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          sources: entry.sources.map((source) => ({
            node: selector(source.node),
            previousRect: source.previousRect.toJSON(),
            currentRect: source.currentRect.toJSON(),
          })),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
});

for (const [route, resource, heading] of [
  ["/tools", "tools", "All Tools & Utilities"],
  ["/reviews", "reviews-gallery", "Community Reviews"],
]) {
  for (const [width, height, loads] of [[1440, 900, 5], [390, 844, 1]]) {
    for (let run = 1; run <= loads; run += 1) {
      test(`${route} stays stable at ${width}px, load ${run}`, async ({ page }, testInfo) => {
        const delay = run % 2 === 0 ? 600 : 0;
        let loadingLayout = null;
        await page.setViewportSize({ width, height });
        await page.route(`**/api/content/${resource}`, async (request) => {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          loadingLayout = await page.locator("#main-content").evaluate((main) => ({
            time: performance.now(),
            section: main.querySelector("section")?.getBoundingClientRect().toJSON(),
            footer: main.querySelector("footer")?.getBoundingClientRect().toJSON(),
            placeholders: main.querySelectorAll("section [aria-hidden='true']").length,
          }));
          await request.fallback();
        });
        const response = await page.goto(route, { waitUntil: "load" });
        expect(response.status()).toBe(200);
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expect(page.locator("#main-content section [aria-hidden='true']")).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        await page.waitForTimeout(4000);
        const measurement = await page.evaluate(() => ({
          supported: window.__layoutShiftSupported,
          shifts: window.__layoutShifts,
          cls: window.__layoutShifts.filter((entry) => !entry.hadRecentInput)
            .reduce((total, entry) => total + entry.value, 0),
          requests: performance.getEntriesByType("resource")
            .filter((entry) => entry.name.includes("/api/content/"))
            .map((entry) => ({ url: entry.name, startTime: entry.startTime, responseEnd: entry.responseEnd })),
          section: document.querySelector("#main-content section")?.getBoundingClientRect().toJSON(),
          footer: document.querySelector("#main-content footer")?.getBoundingClientRect().toJSON(),
        }));
        const artifact = testInfo.outputPath("layout-shift.json");
        await fs.writeFile(artifact, `${JSON.stringify({ route, width, height, run, delay, loadingLayout, ...measurement }, null, 2)}\n`);
        await testInfo.attach("layout-shift", { path: artifact, contentType: "application/json" });
        if (run === 1) await page.screenshot({ path: testInfo.outputPath("settled.png"), animations: "disabled" });
        expect(measurement.supported).toBe(true);
        expect(measurement.cls, JSON.stringify(measurement.shifts)).toBeLessThan(0.1);
        if (process.env.TOOLING_CLS_CONTENT === "1") {
          const html = await response.text();
          if (route === "/tools") {
            expect(html).toContain("Fixture layout tool 1");
            await expect(page.locator("main article")).toHaveCount(4);
            await page.getByRole("button", { name: "Download", exact: true }).first().click();
            await expect(page.getByRole("dialog")).toBeVisible();
          } else {
            expect(html).toContain("Fixture layout review 800 by 400");
            const images = page.locator("main section figure img");
            await expect(images).toHaveCount(2);
            const dimensions = await images.evaluateAll((items) => items.map((image) => ({
              width: Number(image.getAttribute("width")),
              height: Number(image.getAttribute("height")),
            })).sort((a, b) => a.width - b.width));
            expect(dimensions).toEqual([{ width: 600, height: 900 }, { width: 800, height: 400 }]);
            await expect.poll(() => images.evaluateAll((items) => items.every((image) => image.complete && image.naturalWidth > 0))).toBe(true);
            await page.getByRole("button", { name: /Open Fixture layout review/ }).first().click();
            await expect(page.getByRole("dialog")).toBeVisible();
          }
        }
      });
    }
  }
}
