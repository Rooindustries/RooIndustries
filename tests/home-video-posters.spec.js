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
