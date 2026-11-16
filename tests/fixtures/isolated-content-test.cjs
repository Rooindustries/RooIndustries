const { test: base, expect } = require("@playwright/test");
const { fixtureOrigin } = require("./fixture-ports.cjs");

const test = base.extend({
  contentIsolation: [async ({ request, baseURL, browser }, use, testInfo) => {
    const existing = new Set(browser.contexts());
    try { await use(); } finally {
      const closed = await Promise.allSettled(browser.contexts().filter(context => !existing.has(context)).map(context => context.close()));
      const control = fixtureOrigin(baseURL, "TOOLING_ADMIN_CONTROL_PORT");
      const response = await request.post(`${control}/reset-isolation`);
      expect(response.ok(), await response.text()).toBe(true);
      const state = await response.json();
      expect(state).toEqual({ database: 0, rules: 0, holds: 0, waiters: 0, closed: 0, failures: 0, active: 0, timers: 0, storeDelayMs: 0 });
      const contexts = browser.contexts().filter(context => !existing.has(context)).length;
      expect(contexts).toBe(0);
      console.log(`ISOLATION ${JSON.stringify({ test: testInfo.title, ...state, contexts })}`);
      for (const result of closed) if (result.status === "rejected") throw result.reason;
    }
  }, { auto: true }],
});

module.exports = { test, expect };
