const { test, expect } = require("@playwright/test");

const routes = [
  "/",
  "/packages",
  "/benchmarks",
  "/reviews",
  "/tools",
  "/tourney",
  "/contact",
  "/terms",
  "/privacy",
  "/meet-the-team",
  "/referrals/login",
  "/referrals/register",
];

test.describe("Non-JS crawlability", () => {
  test("/packages keeps its h1 inside main without JavaScript", async ({ page }, testInfo) => {
    await page.goto("/packages", { waitUntil: "domcontentloaded" });
    await testInfo.attach("packages-headings", {
      body: JSON.stringify(await page.locator("h1").evaluateAll(elements => elements.map(element => ({
        text: element.textContent,
        insideMain: Boolean(element.closest("main#main-content")),
      }))), null, 2),
      contentType: "application/json",
    });
    await expect(page.locator("main#main-content h1")).toHaveText("PC Game Optimization Packages", { timeout: 1000 });
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("/benchmarks renders benchmark results without JavaScript", async ({ page }, testInfo) => {
    await page.goto("/benchmarks", { waitUntil: "networkidle" });
    const main = page.locator("main#main-content");
    const titles = ["Fixture Benchmark Alpha", "Fixture Benchmark Beta"];
    const images = await main.locator("figure img").evaluateAll(items => items.map(image => ({
      alt: image.alt,
      src: image.getAttribute("src"),
      width: image.getAttribute("width"),
      height: image.getAttribute("height"),
    })));
    await testInfo.attach("benchmarks-server-content", {
      body: JSON.stringify({ headings: await main.locator("h2").allTextContents(), images }, null, 2),
      contentType: "application/json",
    });
    await expect(main.locator("h2")).toHaveText(titles);
    for (const title of titles) {
      for (const phase of ["before", "after"]) {
        const image = main.getByAltText(`${title} benchmark ${phase} optimization`, { exact: true });
        await expect(image).toHaveCount(1);
        await expect(image).toHaveAttribute("src", /.+/);
        await expect(image).toHaveAttribute("width", /^[1-9]\d*$/);
        await expect(image).toHaveAttribute("height", /^[1-9]\d*$/);
      }
    }
    await expect(page.locator('section[aria-label="No-JS SEO fallback"]')).toHaveCount(0);
  });

  for (const route of routes) {
    test(`renders meaningful HTML for ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });

      const heading = page.locator("h1, h2, h3");
      await expect(heading.first()).toBeVisible();

      const title = await page.title();
      expect(title.length).toBeGreaterThan(10);

      const desc = await page
        .locator('meta[name="description"]')
        .first()
        .getAttribute("content");
      expect((desc || "").length).toBeGreaterThan(40);

      const bodyText = (await page.locator("body").innerText()).replace(
        /\s+/g,
        " "
      );
      expect(bodyText.length).toBeGreaterThan(120);
    });
  }
});


test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});
