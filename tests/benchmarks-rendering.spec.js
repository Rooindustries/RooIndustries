const { test, expect } = require("@playwright/test");

const titles = ["Fixture Benchmark Alpha", "Fixture Benchmark Beta"];

test.use({ javaScriptEnabled: true, serviceWorkers: "block", reducedMotion: "reduce" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`/benchmarks hydrates the server-rendered results once at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const messages = [];
    page.on("console", message => messages.push(`${message.type()}: ${message.text()}`));
    page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      window.__benchmarkShifts = [];
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) window.__benchmarkShifts.push(entry.value);
        }
      }).observe({ type: "layout-shift", buffered: true });
      document.addEventListener("DOMContentLoaded", () => {
        window.__benchmarkHeadingsAtLoad = [...document.querySelectorAll("main h2")];
      });
    });
    const clientFetch = page.waitForResponse(response => new URL(response.url()).pathname === "/api/content/benchmarks");
    await page.goto("/benchmarks", { waitUntil: "networkidle" });
    const clientResponse = await clientFetch;
    const clientContent = await clientResponse.json();
    const main = page.locator("main#main-content");
    const beforeHydration = await page.evaluate(() => ({
      titles: window.__benchmarkHeadingsAtLoad.map(heading => heading.textContent),
      connected: window.__benchmarkHeadingsAtLoad.every(heading => heading.isConnected),
    }));
    await testInfo.attach("benchmarks-server-and-client", {
      body: JSON.stringify({ viewport, beforeHydration, clientStatus: clientResponse.status(), clientTitles: clientContent.data?.map(row => row.title), renderedTitles: await main.locator("h2").allTextContents() }, null, 2),
      contentType: "application/json",
    });
    expect(beforeHydration.titles).toEqual(titles);
    expect(beforeHydration.connected).toBe(true);
    await expect(main.locator("h2")).toHaveText(titles);
    await expect(main.locator("h1")).toHaveText("Performance Benchmarks");
    await expect(page.locator("h1")).toHaveCount(1);
    for (const title of titles) {
      await expect(main.getByRole("heading", { name: title, exact: true })).toHaveCount(1);
    }
    await page.evaluate(() => document.fonts.ready);
    const images = main.locator("figure img");
    for (let index = 0; index < await images.count(); index += 1) {
      await images.nth(index).scrollIntoViewIfNeeded();
    }
    await expect.poll(() => images.evaluateAll(items => items.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    const shifts = await page.evaluate(() => window.__benchmarkShifts);
    const cls = shifts.reduce((sum, value) => sum + value, 0);
    await testInfo.attach("benchmarks-hydration", {
      body: JSON.stringify({ viewport, beforeHydration, messages, cls, shifts }, null, 2),
      contentType: "application/json",
    });
    expect(messages.filter(message => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(message))).toEqual([]);
    expect(cls).toBeLessThan(0.1);
    await page.screenshot({ path: testInfo.outputPath("benchmarks-hydrated.png"), fullPage: true, animations: "disabled" });
  });
}

for (const state of ["failed", "malformed"]) {
  test(`/benchmarks keeps server results after a ${state} client refetch`, async ({ page }, testInfo) => {
    let intercepted = 0;
    await page.route("**/api/content/benchmarks", async route => {
      intercepted += 1;
      await route.fulfill({
        status: state === "failed" ? 500 : 200,
        json: state === "failed" ? { ok: false, error: "Synthetic benchmark outage" } : { ok: true, data: { unexpected: "Synthetic malformed content" } },
      });
    });
    await page.goto("/benchmarks", { waitUntil: "networkidle" });
    expect(intercepted).toBe(1);
    await expect(page.locator("main#main-content h2")).toHaveText(titles);
    await expect(page.locator("main#main-content figure img")).toHaveCount(4);
    await testInfo.attach("benchmarks-client-refetch", {
      body: JSON.stringify({ state, intercepted, titles: await page.locator("main h2").allTextContents() }, null, 2),
      contentType: "application/json",
    });
  });
}

test("/benchmarks keeps the image preview controls and restores focus and scrolling", async ({ page }, testInfo) => {
  await page.goto("/benchmarks", { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: `Open ${titles[0]} benchmark before optimization`, exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: `Image preview: ${titles[0]} benchmark before optimization`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close image preview", exact: true })).toBeFocused();
  await expect(page.locator("body")).toHaveClass(/is-modal-open/);
  const image = dialog.getByAltText(`${titles[0]} benchmark before optimization`, { exact: true });
  await dialog.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(image).toHaveAttribute("style", /scale\(1\.12\)/);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveClass(/is-modal-open/);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await testInfo.attach("benchmark-preview", {
    body: JSON.stringify({ opened: true, zoomed: true, closed: true, focusRestored: true, scrollUnlocked: true }, null, 2),
    contentType: "application/json",
  });
});
