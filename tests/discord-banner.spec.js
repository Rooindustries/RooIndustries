const { test, expect } = require("./fixtures/booking-flow.cjs");
const http = require("node:http");

test.use({ javaScriptEnabled: true });

test("Discord suite refuses API requests outside the fixture", async ({ page }, testInfo) => {
  let hits = 0;
  const server = http.createServer((_request, response) => { hits++; response.end("outside fixture"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(page.request.get(`http://127.0.0.1:${server.address().port}/`)).rejects.toThrow(/outside the local fixture/);
    expect(hits).toBe(0);
    await testInfo.attach("guarded-banner-suite", { body: JSON.stringify({ refused: true, hits }), contentType: "application/json" });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("Discord banner stays quiet during full page navigation", async ({ page }, testInfo) => {
  const events = [];
  await page.exposeBinding("recordBannerNavigation", (_source, event) => events.push(event));
  await page.addInitScript(() => {
    let pageHidden = false;
    window.addEventListener("pagehide", () => { pageHidden = true; });
    const errors = new WeakSet();
    const originalError = console.error;
    console.error = (...args) => {
      for (const error of args) {
        if (error && typeof error === "object" && errors.has(error)) {
          window.recordBannerNavigation({ kind: "console", name: error.name, message: error.message, pageHidden }).catch(() => {});
        }
      }
      originalError(...args);
    };
    const originalFetch = window.fetch;
    window.fetch = async (input, options) => {
      if (!String(input).includes("/api/content/discord-banner")) return originalFetch(input, options);
      try {
        return await originalFetch(input, options);
      } catch (error) {
        errors.add(error);
        window.recordBannerNavigation({ kind: "rejected", name: error.name, message: error.message, aborted: options?.signal?.aborted, pageHidden }).catch(() => {});
        throw error;
      }
    };
  });
  let requested = 0;
  await page.route("**/api/content/discord-banner", () => { requested++; });
  for (let run = 0; run < 5; run++) {
    const count = requested;
    await page.goto("/tools", { waitUntil: "domcontentloaded" });
    await expect.poll(() => requested).toBeGreaterThan(count);
    await page.goto("/privacy", { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(300);
  await testInfo.attach("banner-navigation-events", { body: JSON.stringify(events, null, 2), contentType: "application/json" });
  expect(events.filter(event => event.kind === "console")).toEqual([]);
});

test("Discord banner cancels a hidden page request and reloads on history restore", async ({ page }, testInfo) => {
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    window.bannerRequestSignals = [];
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).includes("/api/content/discord-banner")) window.bannerRequestSignals.push(options.signal);
      return originalFetch(input, options);
    };
  });
  let requests = 0;
  await page.route("**/api/content/discord-banner", route => {
    requests++;
    if (requests > 1) return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { link: "https://discord.gg/history-fixture" } }),
    });
  });
  await page.goto("/tools", { waitUntil: "domcontentloaded" });
  await expect.poll(() => requests).toBe(1);
  const hidden = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    return window.bannerRequestSignals.map(signal => signal.aborted);
  });
  await testInfo.attach("hidden-page-request", { body: JSON.stringify({ aborted: hidden }), contentType: "application/json" });
  expect(hidden).toEqual([true]);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expect(page.locator(".ri-discord-guide-link")).toHaveAttribute("href", "https://discord.gg/history-fixture");
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
  await testInfo.attach("restored-page-request", { body: JSON.stringify({ requests, errors }), contentType: "application/json" });
});

for (const failure of ["navigation", "abort", "body-abort", "network", "server"]) {
  test(`Discord banner reports only real failures: ${failure}`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    if (failure === "abort" || failure === "body-abort") {
      await page.addInitScript(({ bodyAbort }) => {
        const controllers = new WeakMap();
        const Controller = window.AbortController;
        window.AbortController = class extends Controller {
          constructor() { super(); controllers.set(this.signal, this); }
        };
        const originalFetch = window.fetch;
        window.fetch = (input, options) => {
          if (!String(input).includes("/api/content/discord-banner")) return originalFetch(input, options);
          if (bodyAbort) {
            window.abortBannerFetch = () => controllers.get(options.signal).abort();
            return Promise.resolve(new Response(new ReadableStream({
              start(stream) {
                options.signal.addEventListener("abort", () => {
                  stream.error(options.signal.reason);
                  window.bannerFetchRejected = true;
                });
              },
            })));
          }
          const controller = new AbortController();
          window.abortBannerFetch = () => controller.abort();
          return originalFetch(input, { ...options, signal: controller.signal }).catch(error => {
            window.bannerFetchRejected = true;
            throw error;
          });
        };
      }, { bodyAbort: failure === "body-abort" });
    }
    let pending;
    await page.route("**/api/content/discord-banner", route => { pending = route; });
    await page.goto("/tools", { waitUntil: "domcontentloaded" });
    if (failure === "body-abort") await page.waitForFunction(() => Boolean(window.abortBannerFetch));
    else await expect.poll(() => Boolean(pending)).toBe(true);
    if (failure === "navigation") {
      await page.goto("/privacy", { waitUntil: "domcontentloaded" });
    } else if (failure === "abort" || failure === "body-abort") {
      await page.evaluate(() => window.abortBannerFetch());
      await page.waitForFunction(() => window.bannerFetchRejected);
    } else if (failure === "network") {
      await pending.abort("failed");
      await expect.poll(() => errors.some(message => message.includes("Failed to fetch"))).toBe(true);
    } else {
      await pending.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "banner-fixture-unavailable" }) });
      await expect.poll(() => errors.some(message => message.includes("banner-fixture-unavailable"))).toBe(true);
    }
    await page.waitForTimeout(300);
    await testInfo.attach("banner-console", { body: JSON.stringify({ failure, errors }, null, 2), contentType: "application/json" });
    if (failure !== "server" && failure !== "network") expect(errors).toEqual([]);
  });
}
