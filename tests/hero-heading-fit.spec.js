const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const viewports = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

test.use({ javaScriptEnabled: true, trace: "off", video: "off", screenshot: "off" });
test.describe.configure({ retries: 0 });

async function measureHeading(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return page.locator("#top .ri-hero-heading-line").evaluateAll(lines => lines.map(line => ({
    connected: line.isConnected,
    fontSize: parseFloat(getComputedStyle(line).fontSize),
    inlineFontSize: line.style.fontSize,
    width: line.clientWidth,
    scrollWidth: line.scrollWidth,
    text: line.textContent,
  })));
}

for (const route of ["/payment-success", "/thank-you"]) {
  test(`${route} return to Home refits the mounted heading on resize`, async ({ browser, baseURL }, testInfo) => {
    const { guardBrowserContext, localOrigin, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
    refuseEnvFiles(root);
    localOrigin(baseURL);
    const dist = process.env.NEXT_DIST_DIR || testInfo.config.metadata.toolingDistDir;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, dist, "tooling-build.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.baseURL).toBe(baseURL.replace(/\/$/, ""));
    localOrigin(manifest.contentURL);
    const context = await browser.newContext({ javaScriptEnabled: true, viewport: viewports[1], serviceWorkers: "block" });
    await guardBrowserContext(context, [baseURL, manifest.contentURL]);
    await context.addInitScript(() => history.replaceState({
      ...history.state,
      usr: { bookingConfirmation: { bookingId: "fixture-hero-return" } },
    }, ""));
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const comparisons = [];
    try {
      await page.goto(route, { waitUntil: "networkidle" });
      await expect(page.locator("#top h2 .ri-hero-heading-line")).toHaveCount(2);
      const beforeReturn = await measureHeading(page);
      await page.evaluate(() => {
        window.__heroReturnMarker = "client-navigation";
        window.__heroBeforeReturn = [...document.querySelectorAll("#top .ri-hero-heading-line")];
      });
      await page.getByRole("link", { name: "Back to Home", exact: true }).click();
      await expect(page).toHaveURL(new URL("/", baseURL).href);
      await expect(page.locator("#top h1 .ri-hero-heading-line")).toHaveCount(2);
      expect(await page.evaluate(() => window.__heroReturnMarker)).toBe("client-navigation");
      const remounted = await page.evaluate(() => window.__heroBeforeReturn.every(line => !line.isConnected));
      expect(remounted).toBe(true);

      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        const returned = await measureHeading(page);
        const freshContext = await browser.newContext({ javaScriptEnabled: true, viewport, serviceWorkers: "block" });
        try {
          await guardBrowserContext(freshContext, [baseURL, manifest.contentURL]);
          const freshPage = await freshContext.newPage();
          await freshPage.goto("/", { waitUntil: "networkidle" });
          await expect(freshPage.locator("#top h1 .ri-hero-heading-line")).toHaveCount(2);
          const fresh = await measureHeading(freshPage);
          comparisons.push({ viewport, returned, fresh });
          const screenshot = testInfo.outputPath(`returned-home-${viewport.width}.png`);
          await page.screenshot({ path: screenshot, timeout: 10000 });
          await testInfo.attach(`Returned Home at ${viewport.width}`, { path: screenshot, contentType: "image/png" });
        } finally {
          await freshContext.close();
        }
      }
      const measurements = testInfo.outputPath("heading-measurements.json");
      fs.writeFileSync(measurements, JSON.stringify({ route, beforeReturn, remounted, comparisons, pageErrors }, null, 2) + "\n");
      await testInfo.attach("Heading measurements", { path: measurements, contentType: "application/json" });
      expect(pageErrors).toEqual([]);
      for (const { viewport, returned, fresh } of comparisons) {
        expect(returned).toHaveLength(2);
        for (let index = 0; index < returned.length; index++) {
          const line = returned[index];
          expect.soft(line.connected, `${viewport.width}: line ${index + 1} is mounted`).toBe(true);
          expect.soft(line.text).toBe(fresh[index].text);
          expect.soft(Math.abs(line.fontSize - fresh[index].fontSize), `${viewport.width}: line ${index + 1} matches a fresh Home load`).toBeLessThan(0.05);
          expect.soft(line.scrollWidth, `${viewport.width}: line ${index + 1} fits its width`).toBeLessThanOrEqual(line.width + 1);
        }
      }
    } finally {
      await context.close();
    }
  });
}
