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

for (const [route, revalidate] of [
  ["/packages", 60],
  ["/faq", 60],
  ["/contact", 60],
  ["/privacy", 60],
  ["/terms", 60],
  ["/tools", 60],
  ["/meet-the-team", 60],
  ["/about", false],
]) {
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
    if (manifest) expect(manifest.routes[route]?.initialRevalidateSeconds).toBe(revalidate);
    expect(plain.status).toBe(200);
    expect(plain.prerender).toMatch(/^1(, 1)*$/);
    if (revalidate !== false) expect(plain.cache).toMatch(/^(HIT|STALE)$/);
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
  test(`${route} keeps a referral link's code after loading the prebuilt page`, async ({ page }, testInfo) => {
    const messages = watchConsole(page);
    await page.goto(`${route}?ref=friend&utm_source=discord`);
    await hydrated(page);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("referral_session"))).toBe("friend");
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
        referral: await page.evaluate(() => sessionStorage.getItem("referral_session")),
        search: await page.evaluate(() => window.location.search),
        content: await fixtureContent.textContent(),
        messages,
      }, null, 2),
      contentType: "application/json",
    });
    expect(hydrationWarnings(messages)).toEqual([]);
  });
}

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
