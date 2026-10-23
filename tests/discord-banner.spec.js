const { test, expect } = require("@playwright/test");

test.use({ javaScriptEnabled: true });

for (const failure of ["navigation", "abort", "body-abort", "server"]) {
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
    } else {
      await pending.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "banner-fixture-unavailable" }) });
      await expect.poll(() => errors.some(message => message.includes("banner-fixture-unavailable"))).toBe(true);
    }
    await page.waitForTimeout(300);
    const bannerErrors = errors.filter(message => /discord-banner|AbortError|aborted|banner-fixture-unavailable|Public content could not be loaded/i.test(message));
    await testInfo.attach("banner-console", { body: JSON.stringify({ failure, bannerErrors, errors }, null, 2), contentType: "application/json" });
    if (failure !== "server") expect(bannerErrors).toEqual([]);
  });
}
