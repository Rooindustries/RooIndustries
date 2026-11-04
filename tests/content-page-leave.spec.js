const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true, viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

for (const route of ["/", "/benchmarks", "/reviews", "/tools", "/meet-the-team", "/terms", "/privacy"]) {
  test(`leaving ${route} while its content is loading reports no error`, async ({ page }) => {
    const held = [];
    let holding = true;
    await page.route("**/api/content/**", async (request) => {
      if (!holding) return request.fallback();
      held.push(request);
    });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`${message.text()} @ ${page.url()}`);
    });
    page.on("pageerror", (error) => errors.push(`${error.message} @ ${page.url()}`));

    await page.goto(route);
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await page.goto("/contact");
    await expect(page.locator("main h1").first()).toBeVisible();
    holding = false;
    await Promise.all(held.map((request) => request.fallback().catch(() => {})));

    expect(errors).toEqual([]);
  });
}

test("a content failure while the visitor stays on the page is still reported", async ({ page }) => {
  await page.route("**/api/content/terms", (request) => request.abort("failed"));
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/terms");

  await expect.poll(() => errors.some((text) => text.startsWith("TypeError: Failed to fetch"))).toBe(true);
});
