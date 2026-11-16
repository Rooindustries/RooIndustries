const { test: base, expect } = require("@playwright/test");
const { fixtureOrigin } = require("./fixture-ports.cjs");
const { createContentGate } = require("./content-store-gate.cjs");
const { PREBUILT_ROUTES } = require("../../src/lib/routes");

const PAGES = PREBUILT_ROUTES.filter(route => route !== "/tourney");

const test = base.extend({
  contentIsolation: [async ({ request, baseURL, browser }, use, testInfo) => {
    const existing = new Set(browser.contexts());
    try { await use(); } finally {
      const contexts = browser.contexts().filter(context => !existing.has(context));
      const closed = await Promise.allSettled(contexts.map(context => context.close()));
      const control = fixtureOrigin(baseURL, "TOOLING_ADMIN_CONTROL_PORT");
      const response = await request.post(`${control}/reset-isolation`);
      const body = await response.json();
      const started = Date.now();
      let rebuildFailure;
      try { await createContentGate(request, baseURL).rebuild(PAGES); }
      catch (error) { rebuildFailure = new Error(`reset: ${error.message}`, { cause: error }); }
      expect(response.ok(), body.error).toBe(true);
      if (rebuildFailure) throw rebuildFailure;
      const leftovers = [...body.leftovers, ...contexts.map(() => "open browser context")];
      console.log(`ISOLATION ${JSON.stringify({ test: testInfo.title, resetMs: body.durationMs, rebuildMs: Date.now() - started, leftovers })}`);
      for (const result of closed) if (result.status === "rejected") throw result.reason;
      expect(leftovers, `Leftover test controls: ${leftovers.join("; ")}`).toEqual([]);
    }
  }, { auto: true }],
});

module.exports = { test, expect };
