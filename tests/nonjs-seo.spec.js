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

const stylesheetsReady = async (page) => {
  await page.waitForFunction(() => [...document.querySelectorAll('link[rel="stylesheet"]')].every(link => link.sheet));
  const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => ({
    href: link.getAttribute("href"),
    inHead: link.parentElement === document.head,
    media: link.media || "all",
    disabled: link.disabled,
  })));
  expect(stylesheets.length).toBeGreaterThan(0);
  expect(stylesheets.filter(sheet => !sheet.inHead || sheet.media !== "all" || sheet.disabled)).toEqual([]);
};

test.describe("Non-JS crawlability", () => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    for (const [route, selector] of [
      ["/payment", "section.booking-payment"],
      ["/booking", '[role="dialog"] section.ri-booking'],
      ["/payment-success", '[role="dialog"] h1'],
      ["/thank-you", '[role="dialog"] h1'],
    ]) {
      test(`${route}'s dialog content doesn't start hidden on the server at ${viewport.width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        await page.goto(route, { waitUntil: "domcontentloaded" });
        await stylesheetsReady(page);
        const content = page.locator(selector);
        await expect(content).toHaveCount(1);
        await expect(page.locator('[hidden][id^="S:"]')).toHaveCount(0);
        expect(await content.evaluate(element => Boolean(element.closest("[hidden]")))).toBe(false);
        const hidden = await content.evaluate(element => {
          const ancestors = [];
          for (let node = element; node; node = node.parentElement) ancestors.push(node);
          return [...ancestors, ...element.querySelectorAll("*")]
            .filter(node => {
              const style = getComputedStyle(node);
              const parentHidden = node.parentElement && getComputedStyle(node.parentElement).visibility === "hidden";
              return style.opacity === "0" || (style.visibility === "hidden" && !parentHidden);
            })
            .map(node => ({
              node: `${node.tagName.toLowerCase()}.${String(node.className).trim().split(/\s+/).join(".")}`,
              opacity: getComputedStyle(node).opacity,
              visibility: getComputedStyle(node).visibility,
            }));
        });
        await testInfo.attach("hidden-nodes", { body: JSON.stringify(hidden, null, 2), contentType: "application/json" });
        expect(hidden).toEqual([]);
        const box = await content.boundingBox();
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.y).toBeLessThan(viewport.height);
      });
    }
  }

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
        const fold = await card.evaluate(element => ({ top: element.getBoundingClientRect().top, innerHeight }));
        expect(fold.top).toBeGreaterThan(fold.innerHeight);
        const offscreen = await card.evaluate(element => getComputedStyle(element).opacity);
        expect(offscreen).toBe(reducedMotion === "reduce" ? "1" : "0");
        await expect(card).toHaveAttribute("data-reveal-wait", "");
        await page.emulateMedia({ media: "print" });
        const printed = await card.evaluate(element => getComputedStyle(element).opacity);
        await page.emulateMedia({ media: "screen" });
        expect(printed).toBe("1");
        expect(await card.evaluate(element => getComputedStyle(element).opacity)).toBe(offscreen);
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

  test("/ fades the proof card in when a visitor scrolls past it before JavaScript loads", async ({ browser, baseURL }, testInfo) => {
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    const context = await browser.newContext({ baseURL, javaScriptEnabled: true, viewport: { width: 390, height: 844 } });
    try {
      await guardBrowserContext(context, [baseURL]);
      const page = await context.newPage();
      let releaseScripts;
      const scriptsHeld = new Promise(resolve => { releaseScripts = resolve; });
      await page.route(/\/_next\/static\/chunks\/.*\.js(\?.*)?$/, async route => {
        await scriptsHeld;
        await route.continue();
      });
      await page.goto("/", { waitUntil: "commit" });
      await page.locator("main#main-content .ri-proof-card").waitFor({ state: "attached" });
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
      await expect.poll(() => page.evaluate(() => document.querySelector("main#main-content .ri-proof-card").getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
      releaseScripts();
      await page.waitForFunction(() => document.documentElement.classList.contains("low-performance-mode"));
      const card = page.locator("main#main-content .ri-proof-card");
      await page.waitForTimeout(1000);
      const above = await card.evaluate(element => element.getBoundingClientRect().bottom);
      expect(above).toBeLessThanOrEqual(0);
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
      await testInfo.attach("proof-card-js-from-below", { body: JSON.stringify({ above, animations }, null, 2), contentType: "application/json" });
      expect(animations).toEqual(["riReveal"]);
    } finally {
      await context.close();
    }
  });

  for (const route of routes) {
    test(`renders meaningful HTML for ${route}`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator('[hidden][id^="S:"]')).toHaveCount(0);

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
