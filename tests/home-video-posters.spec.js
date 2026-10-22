const { test, expect } = require("@playwright/test");

test.use({ serviceWorkers: "block", viewport: { width: 412, height: 823 } });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const javaScriptEnabled of [true, false]) {
  test.describe(javaScriptEnabled ? "with JavaScript" : "without JavaScript", () => {
    test.use({ javaScriptEnabled });

    test(javaScriptEnabled ? "/ loads the How It Works posters only when the section nears the viewport" : "/ shows every How It Works poster", async ({ page }, testInfo) => {
      const posterRequests = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname.startsWith("/posters/")) posterRequests.push(new URL(request.url()).pathname);
      });
      await page.goto("/", { waitUntil: "load" });
      await page.waitForLoadState("networkidle");
      const beforeScroll = [...posterRequests];
      const posters = page.locator(".ri-hiw-video img");
      await expect(posters).toHaveCount(4);
      const shown = [];
      for (const poster of await posters.all()) {
        await poster.scrollIntoViewIfNeeded();
        await expect(poster).toBeVisible();
        await expect.poll(() => poster.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
        shown.push(await poster.getAttribute("src"));
      }
      await testInfo.attach("home-video-posters", { body: JSON.stringify({ javaScriptEnabled, beforeScroll, afterScroll: posterRequests, shown }, null, 2), contentType: "application/json" });
      if (javaScriptEnabled) expect(beforeScroll).toEqual([]);
      expect(new Set(shown).size).toBe(4);
      for (const src of shown) expect(posterRequests).toContain(src);
    });
  });
}

test.describe("How It Works videos", () => {
  test.use({ javaScriptEnabled: true });

  test("a video that can't start playing leaves its poster showing", async ({ page }) => {
    await page.route("**/videos/**", route => route.abort());
    await page.goto("/");
    const cards = page.locator(".ri-hiw-video");
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) {
      await card.locator("img").scrollIntoViewIfNeeded();
      await expect.poll(() => card.locator("img").evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
      await expect(card.locator("video")).toHaveCSS("opacity", "0");
    }
  });

  test("a video shows once it plays", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator(".ri-hiw-video");
    await expect(cards).toHaveCount(4);
    const card = cards.first();
    await card.locator("img").scrollIntoViewIfNeeded();
    await expect.poll(() => card.locator("video").evaluate(video => !video.paused && video.readyState >= 3), { timeout: 15000 }).toBe(true);
    await expect(card.locator("video")).toHaveCSS("opacity", "1");
  });

  test("a re-render keeps the cards' posters and videos in place", async ({ page }) => {
    await page.goto("/");
    const cards = page.locator(".ri-hiw-video");
    await expect(cards).toHaveCount(4);
    const video = cards.first().locator("video");
    await cards.first().locator("img").scrollIntoViewIfNeeded();
    await expect.poll(() => video.evaluate(node => !node.paused && node.readyState >= 3), { timeout: 15000 }).toBe(true);
    await page.evaluate(() => document.querySelectorAll(".ri-hiw-video img, .ri-hiw-video video").forEach(node => { node.dataset.firstMount = "1"; }));
    await page.evaluate(() => {
      localStorage.setItem("roo_perf_debug_toggles", JSON.stringify({ pauseHowItWorksVideos: true }));
      window.dispatchEvent(new CustomEvent("roo-perf-debug-change"));
    });
    await expect.poll(() => video.evaluate(node => node.paused)).toBe(true);
    await expect(page.locator(".ri-hiw-video [data-first-mount]")).toHaveCount(8);
    await expect(video).toHaveCSS("opacity", "1");
  });
});
