const { test, expect } = require("./fixtures/booking-flow.cjs");
const { spawn } = require("node:child_process");
const path = require("node:path");

test.use({ javaScriptEnabled: true });

for (const quoteFails of [false, true]) {
  test(`the executable smoke ${quoteFails ? "rejects failed" : "requires successful"} quotes through the built payment page`, async ({ baseURL, flow }, testInfo) => {
    const { startSite } = await import("./fixtures/fake-site.mjs");
    const site = await startSite({
      upstream: baseURL,
      availability: { ok: true, settings: { dateSlots: flow.state.slots }, bookedSlots: [] },
      ...(quoteFails ? { quote: { status: 503, body: { ok: false, error: "Fixture quote unavailable." } } } : {}),
    });
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve("scripts/production-smoke.mjs"), "--base", site.base], {
          env: { PATH: process.env.PATH, HOME: process.env.HOME, ROO_TEST_HOST: "127.0.0.1", GITHUB_ACTIONS: "true",
            SMOKE_RETRY_MS: "20", SMOKE_MARKER_TIMEOUT_MS: "4000", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
        });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        child.on("error", reject);
        child.on("close", code => resolve({ code, output }));
      });
      const quotes = site.requests.filter(request => request.path === "/api/payment/quote");
      const mutations = site.requests.filter(request => request.method !== "GET" && request.path !== "/api/payment/quote");
      await testInfo.attach("executable-smoke", { body: JSON.stringify({ result, quotes, mutations }), contentType: "application/json" });
      expect(result.code, result.output).toBe(quoteFails ? 2 : 0);
      expect(quotes.length, result.output).toBeGreaterThan(0);
      expect(mutations).toEqual([]);
      for (const quote of quotes) {
        expect(quote.method).toBe("POST");
        expect(quote.body.packageTitle).toBeTruthy();
        expect(quote.body.email).toBe("");
        expect(quote.body.originalOrderId).toBe("");
      }
    } finally {
      await site.close();
    }
  });
}
