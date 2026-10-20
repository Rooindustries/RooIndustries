const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");

test.use({ javaScriptEnabled: true, serviceWorkers: "block", reducedMotion: "reduce" });

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
});

const hydrated = page => page.waitForFunction(() => window.history.state?.__rooLegacy === true);

const watchConsole = page => {
  const messages = [];
  page.on("pageerror", error => messages.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) messages.push(`${message.type()}: ${message.text()}`);
  });
  return messages;
};

const hydrationWarnings = messages => messages.filter(text => /hydrat|did not match|server rendered|server HTML|#418|#423|#425/i.test(text));

for (const route of ["/packages", "/faq", "/about", "/contact", "/privacy", "/terms", "/tools", "/meet-the-team"]) {
  test(`${route} is a prebuilt page that ignores the query string`, async ({ request }, testInfo) => {
    const ownsServer = testInfo.config.metadata.ownsToolingServer === true;
    const manifest = ownsServer || process.env.NEXT_DIST_DIR ? JSON.parse(await fs.readFile(path.join(testInfo.config.metadata.toolingDistDir, "prerender-manifest.json"), "utf8")) : null;
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
    expect(first.body).not.toContain("leakprobe");
    expect(second.body).not.toContain("leakprobe");
  });
}

for (const [route, content] of [
  ["/about", "About Roo Industries"],
  ["/contact", "Get In Touch"],
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Service"],
  ["/tools", "Fixture layout tool 1"],
  ["/meet-the-team", "Fixture Member Alpha"],
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

test("a rebuild triggered by a query keeps that query out of /about, /contact and /privacy", async ({ request }, testInfo) => {
  test.setTimeout(240000);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const results = [];
  for (const [visit, triggers] of [
    ["page", { "/about": ["GET", {}], "/contact": ["GET", {}], "/privacy": ["GET", {}] }],
    ["next-action header", { "/about": ["GET", { "next-action": "x" }], "/contact": ["HEAD", { "next-action": "x" }], "/privacy": ["GET", { "next-action": "x" }] }],
  ]) {
    results.push(...await Promise.all(Object.entries(triggers).map(async ([route, [method, headers]]) => {
      const probe = `leakprobe${route.slice(1)}${Date.now()}`;
      const deadline = Date.now() + 75000;
      let trigger = null;
      while (!trigger && Date.now() < deadline) {
        const response = await request.fetch(`${route}?ref=${probe}&gclid=${probe}`, { method, headers: { accept: "text/html", ...headers }, maxRedirects: 0 });
        await response.body();
        if (response.headers()["x-nextjs-cache"] === "STALE") trigger = { status: response.status(), at: Date.now() };
        else await wait(1000);
      }
      await wait(3000);
      const html = await (await request.get(route, { headers: { accept: "text/html" } })).text();
      const rsc = await (await request.get(route, { headers: { accept: "text/html", rsc: "1" } })).text();
      return { visit, route, method, trigger, htmlLeaked: html.includes(probe), rscLeaked: rsc.includes(probe) };
    })));
  }
  await testInfo.attach("query-rebuild-leak", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
  for (const result of results) {
    const label = `${result.visit} ${result.method} ${result.route}`;
    expect(result.trigger, label).not.toBeNull();
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
