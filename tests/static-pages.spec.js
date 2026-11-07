const { waitForRouteCommitted: hydrated } = require("./fixtures/react-hydration.cjs");
const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PREBUILT_ROUTES } = require("../src/lib/routes");
const { withoutCanonicalUrl } = require("../scripts/lib/rsc-canonical-url.cjs");

test.use({ javaScriptEnabled: true, serviceWorkers: "block", reducedMotion: "reduce" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});


const watchConsole = page => {
  const messages = [];
  page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) messages.push(`${message.type()}: ${message.text()}`);
  });
  return messages;
};

const hydrationWarnings = messages => messages.filter(text => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(text));

const HEADING_ROUTES = [...PREBUILT_ROUTES.filter((route) => route !== "/tourney"), "/payment", "/thank-you", "/referrals/login", "/referrals/reset"];

for (const [theme, viewport] of [["dark", { width: 1440, height: 900 }], ["default", { width: 390, height: 844 }]]) {
  for (const route of HEADING_ROUTES) {
    test(`${route} headings and intros share one flat style in the ${theme} theme at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript((value) => localStorage.setItem("roo-theme", value), theme);
      await page.goto(route);
      await hydrated(page);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(".section-title").first()).toBeVisible();
      const styles = await page.locator(".section-title, .section-lede").evaluateAll((nodes) => nodes.map((node) => {
        const style = getComputedStyle(node);
        const probe = document.createElement("span");
        const isTitle = node.classList.contains("section-title");
        const danger = node.classList.contains("section-title-danger");
        const token = danger ? "--color-danger-text" : isTitle ? "--color-text-primary" : "--color-text-secondary";
        probe.style.color = `var(${token})`;
        node.append(probe);
        const expectedColor = getComputedStyle(probe).color;
        probe.remove();
        const lines = [];
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let text = walker.nextNode(); text; text = walker.nextNode()) {
          range.selectNodeContents(text);
          for (const box of range.getClientRects()) {
            const line = lines.find((entry) => Math.abs(entry.bottom - box.bottom) < parseFloat(style.fontSize) / 2);
            if (line) {
              line.left = Math.min(line.left, box.left);
              line.right = Math.max(line.right, box.right);
            } else if (box.width > 0) {
              lines.push({ bottom: box.bottom, left: box.left, right: box.right });
            }
          }
        }
        const widths = lines.sort((a, b) => a.bottom - b.bottom).map((line) => line.right - line.left);
        return {
          isTitle,
          text: node.textContent.trim().slice(0, 40),
          weight: isTitle ? style.fontWeight : "lede",
          withinScale: !isTitle || parseFloat(style.fontSize) <= (node.classList.contains("section-title-compact") ? 36 : 44),
          shadow: style.textShadow,
          filter: style.filter,
          matchesToken: style.color === expectedColor,
          shortLastLine: !isTitle && widths.length > 1 && widths.at(-1) < Math.max(...widths) * 0.4,
        };
      }));
      for (const { isTitle, text, ...style } of styles) {
        expect(style, `${route} ${text}`).toEqual({
          weight: isTitle ? "800" : "lede",
          withinScale: true,
          shadow: "none",
          filter: "none",
          matchesToken: true,
          shortLastLine: false,
        });
      }
    });
  }
}

const readPrerenderManifest = async testInfo => {
  const ownsServer = testInfo.config.metadata.ownsToolingServer === true;
  return ownsServer || process.env.NEXT_DIST_DIR ? JSON.parse(await fs.readFile(path.join(testInfo.config.metadata.toolingDistDir, "prerender-manifest.json"), "utf8")) : null;
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const readRebuiltPage = async (request, route, revalidateSeconds) => {
  const deadline = Date.now() + 30000;
  for (;;) {
    const response = await request.get(route, { headers: { accept: "text/html" } });
    const html = await response.text();
    const cacheControl = response.headers()["cache-control"] ?? null;
    const fresh = response.headers()["x-nextjs-cache"] === "HIT";
    if (fresh || Date.now() > deadline) {
      const rsc = await (await request.get(route, { headers: { accept: "text/html", rsc: "1" } })).text();
      const rebuilt = fresh && new RegExp(`^s-maxage=${revalidateSeconds}(,|$)`).test(cacheControl ?? "");
      return { rebuilt, cacheControl, htmlLeaked: withoutCanonicalUrl(html).includes("leakprobe"), rscLeaked: withoutCanonicalUrl(rsc).includes("leakprobe") };
    }
    await wait(1000);
  }
};

test("the middleware query strip covers exactly the prebuilt pages", async ({}, testInfo) => {
  const manifest = await readPrerenderManifest(testInfo);
  test.skip(!manifest, "Needs the build's prerender manifest: run with the test-owned server or NEXT_DIST_DIR.");
  expect(Object.keys(manifest.routes).sort()).toEqual([...PREBUILT_ROUTES].sort());
});

for (const route of ["/packages", "/faq", "/about", "/contact", "/privacy", "/terms", "/tools", "/meet-the-team", "/benchmarks", "/reviews"]) {
  test(`${route} is a prebuilt page that ignores the query string`, async ({ request }, testInfo) => {
    const manifest = await readPrerenderManifest(testInfo);
    const read = async url => {
      const response = await request.get(url, { headers: { accept: "text/html" }, maxRedirects: 0 });
      return {
        url,
        status: response.status(),
        cache: response.headers()["x-nextjs-cache"] ?? null,
        prerender: response.headers()["x-nextjs-prerender"] ?? null,
        cacheControl: response.headers()["cache-control"] ?? null,
        body: await response.text(),
      };
    };
    const plain = await read(route);
    const first = await read(`${route}?ref=leakprobe-alpha`);
    const second = await read(`${route}?ref=leakprobe-beta`);
    await testInfo.attach("prebuilt-page", {
      body: JSON.stringify({
        manifestRoute: manifest?.routes[route] ?? null,
        responses: [plain, first, second].map(({ body, ...rest }) => ({ ...rest, bytes: body.length })),
      }, null, 2),
      contentType: "application/json",
    });
    if (manifest) expect(manifest.routes[route]?.initialRevalidateSeconds).toBe(60);
    expect(plain.status).toBe(200);
    expect(plain.prerender).toMatch(/^1(, 1)*$/);
    expect(plain.cache).toMatch(/^(HIT|STALE)$/);
    expect(plain.cacheControl).not.toMatch(/private|no-store/);
    expect(first.status).toBe(200);
    expect(withoutCanonicalUrl(first.body)).not.toContain("leakprobe");
    expect(withoutCanonicalUrl(second.body)).not.toContain("leakprobe");
  });
}

for (const [route, content] of [
  ["/benchmarks", "Fixture Benchmark Alpha"],
  ["/about", "About Roo Industries"],
  ["/contact", "Get In Touch"],
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Service"],
  ["/tools", "Fixture layout tool 1"],
  ["/meet-the-team", "Fixture Member Alpha"],
  ["/reviews", "Community Reviews"],
]) {
  test(`${route} hydrates the prebuilt page with its query string`, async ({ page }, testInfo) => {
    const messages = watchConsole(page);
    await page.goto(`${route}?ref=friend&utm_source=discord`);
    await hydrated(page);
    await expect.poll(() => page.evaluate(() => window.location.search)).toBe("?ref=friend&utm_source=discord");
    const main = page.locator("main#main-content");
    const fixtureContent = route === "/meet-the-team"
      ? main.getByText(content, { exact: true })
      : main.getByRole("heading", { name: content, exact: true });
    await expect(fixtureContent).toBeVisible();
    await page.waitForTimeout(1000);
    await testInfo.attach("public-page-query", {
      body: JSON.stringify({
        route,
        search: await page.evaluate(() => window.location.search),
        content: await fixtureContent.textContent(),
        messages,
      }, null, 2),
      contentType: "application/json",
    });
    expect(hydrationWarnings(messages)).toEqual([]);
  });
}

test("/tourney hydrates the prebuilt page with its query string", async ({ page }, testInfo) => {
  const messages = watchConsole(page);
  await page.goto("/tourney?ref=friend&utm_source=discord", { waitUntil: "networkidle" });
  const toggle = page.getByRole("switch");
  const before = await toggle.getAttribute("aria-checked");
  await toggle.click();
  await expect(toggle).not.toHaveAttribute("aria-checked", before);
  await expect(page.locator("#tourney-title")).toBeVisible();
  await page.waitForTimeout(1000);
  const search = await page.evaluate(() => window.location.search);
  await testInfo.attach("tourney-query", { body: JSON.stringify({ search, messages }, null, 2), contentType: "application/json" });
  expect(search).toBe("?ref=friend&utm_source=discord");
  expect(hydrationWarnings(messages)).toEqual([]);
});

test("a background rebuild triggered by a query keeps that query out of every revalidating page", async ({ request }, testInfo) => {
  test.setTimeout(240000);
  const manifest = await readPrerenderManifest(testInfo);
  test.skip(!manifest, "Needs the build's prerender manifest: run with the test-owned server or NEXT_DIST_DIR.");
  const routes = PREBUILT_ROUTES.filter(route => manifest.routes[route]?.initialRevalidateSeconds);
  const results = [];
  for (const [visit, triggerFor] of [
    ["page", () => ["GET", {}]],
    ["next-action header", index => [index % 2 ? "HEAD" : "GET", { "next-action": "x" }]],
  ]) {
    results.push(...await Promise.all(routes.map(async (route, index) => {
      const [method, headers] = triggerFor(index);
      const probe = `leakprobe${route.replace(/\W/g, "") || "home"}${Date.now()}`;
      const deadline = Date.now() + 75000;
      let trigger = null;
      while (!trigger && Date.now() < deadline) {
        const response = await request.fetch(`${route}?ref=${probe}&gclid=${probe}&p=${probe}&c=${probe}&c=${probe}`, { method, headers: { accept: "text/html", ...headers }, maxRedirects: 0 });
        await response.body();
        if (response.headers()["x-nextjs-cache"] === "STALE") trigger = { status: response.status(), at: Date.now() };
        else await wait(1000);
      }
      return { visit, route, method, trigger, ...(await readRebuiltPage(request, route, manifest.routes[route].initialRevalidateSeconds)) };
    })));
  }
  await testInfo.attach("query-rebuild-leak", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  expect(routes.length).toBeGreaterThan(0);
  for (const result of results) {
    const label = `${result.visit} ${result.method} ${result.route}`;
    expect(result.trigger, label).not.toBeNull();
    expect(result.rebuilt, label).toBe(true);
    expect(result.htmlLeaked, label).toBe(false);
    expect(result.rscLeaked, label).toBe(false);
  }
});

test("/packages keeps a referral link's code after loading the prebuilt page", async ({ page }, testInfo) => {
  const messages = watchConsole(page);
  await page.goto("/packages?ref=friend&utm_source=discord");
  await hydrated(page);
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("friend");
  await expect.poll(() => page.evaluate(() => window.location.search)).toBe("?ref=friend&utm_source=discord");
  await expect(page.locator(".ri-package-card .ri-price-current").first()).toBeVisible();
  await page.waitForTimeout(1000);
  await testInfo.attach("packages-query-console", { body: JSON.stringify(messages, null, 2), contentType: "application/json" });
  expect(hydrationWarnings(messages)).toEqual([]);
});

test("/faq hydrates the prebuilt page without warnings", async ({ page }, testInfo) => {
  const messages = watchConsole(page);
  await page.goto("/faq?utm_source=discord");
  await hydrated(page);
  await expect(page.getByRole("button", { name: /Synthetic local question 1$/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.search)).toBe("?utm_source=discord");
  await page.waitForTimeout(1000);
  await testInfo.attach("faq-query-console", { body: JSON.stringify(messages, null, 2), contentType: "application/json" });
  expect(hydrationWarnings(messages)).toEqual([]);
});

const PAGE_TOP_ROUTES = ["/about", "/benchmarks", "/contact", "/faq", "/meet-the-team", "/reviews", "/tools", "/privacy", "/terms"];

for (const [width, expected] of [[390, 24], [1440, 80]]) {
  test(`standalone pages share one page top at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const tops = [];
    for (const route of PAGE_TOP_ROUTES) {
      await page.goto(route);
      await hydrated(page);
      const top = page.locator("main .page-top").first();
      await expect(top, route).toBeVisible();
      tops.push({
        route,
        ...(await top.evaluate((node) => {
          const main = node.closest("main");
          const mainTop = main.getBoundingClientRect().top + parseFloat(getComputedStyle(main).paddingTop);
          const content = [...node.querySelectorAll("*")].find((element) =>
            [...element.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent.trim()));
          return {
            fromMain: Math.round(node.getBoundingClientRect().top - mainTop),
            contentOffset: Math.round(content.getBoundingClientRect().top - mainTop),
          };
        })),
      });
    }
    for (const { route, fromMain, contentOffset } of tops) {
      expect(fromMain, route).toBe(0);
      expect(contentOffset, route).toBe(expected);
    }
  });
}
