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

  test("/terms renders the CMS terms without JavaScript", async ({ page }, testInfo) => {
    const response = await page.goto("/terms", { waitUntil: "networkidle" });
    const main = page.locator("main#main-content");
    await testInfo.attach("terms-server-content", {
      body: JSON.stringify({
        status: response.status(),
        headings: await main.locator("h1, h2").allTextContents(),
        text: await main.innerText(),
      }, null, 2),
      contentType: "application/json",
    });
    await expect(main.locator("h1")).toHaveText("Terms of Service");
    await expect(main.locator("h2")).toContainText(["Synthetic local information"]);
    await expect(main).toContainText("This is synthetic privacy content for an isolated local Roo Industries application test.");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator('section[aria-label="No-JS SEO fallback"]')).toHaveCount(0);
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

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`/ shows the proof card without JavaScript at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const card = page.locator("main#main-content .ri-proof-card");
      const opacity = () => card.evaluate(element => getComputedStyle(element).opacity);
      await expect(card).toHaveCount(1);
      await expect.poll(opacity, { timeout: 3000 }).toBe("1");
      const animation = await card.evaluate(element => getComputedStyle(element).animationName);
      await testInfo.attach("proof-card-nojs", {
        body: JSON.stringify({ viewport, opacity: await opacity(), animation, text: await card.innerText() }, null, 2),
        contentType: "application/json",
      });
      expect(animation).toBe("riReveal");
      await expect(card.locator(".ri-proof-cta")).toBeVisible();
    });
  }

  test("/ fades the proof card in when it scrolls into view once JavaScript loads", async ({ browser, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const context = await browser.newContext({ baseURL, javaScriptEnabled: true, reducedMotion, viewport: { width: 390, height: 844 } });
      try {
        await guardBrowserContext(context, [baseURL]);
        const page = await context.newPage();
        await page.goto("/", { waitUntil: "load" });
        await page.waitForFunction(() => document.documentElement.classList.contains("low-performance-mode"));
        const card = page.locator("main#main-content .ri-proof-card");
        await page.waitForTimeout(1000);
        const offscreen = await card.evaluate(element => getComputedStyle(element).opacity);
        expect(offscreen).toBe(reducedMotion === "reduce" ? "1" : "0");
        await expect(card).toHaveAttribute("data-reveal-wait", "");
        const animations = await card.evaluate(element => new Promise(resolve => {
          const observer = new MutationObserver(() => {
            if (element.hasAttribute("data-reveal-wait")) return;
            observer.disconnect();
            resolve(element.getAnimations().map(animation => animation.animationName));
          });
          observer.observe(element, { attributes: true });
          element.scrollIntoView({ block: "center" });
        }));
        await expect.poll(() => card.evaluate(element => getComputedStyle(element).opacity), { timeout: 3000 }).toBe("1");
        await page.waitForTimeout(1000);
        const settled = await card.evaluate(element => ({
          opacity: getComputedStyle(element).opacity,
          rootClasses: document.documentElement.className,
        }));
        await testInfo.attach(`proof-card-js-${reducedMotion}`, { body: JSON.stringify({ offscreen, animations, settled }, null, 2), contentType: "application/json" });
        expect(animations).toEqual(reducedMotion === "reduce" ? [] : ["riReveal"]);
        expect(settled.opacity).toBe("1");
        expect(settled.rootClasses).toContain("low-performance-mode");
      } finally {
        await context.close();
      }
    }
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
