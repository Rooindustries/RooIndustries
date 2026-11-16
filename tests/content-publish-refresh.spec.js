const { randomUUID } = require("node:crypto");
const { get } = require("node:http");
const { test, expect } = require("@playwright/test");
const { login, choose, prepareAdminContext } = require("./fixtures/admin-content.cjs");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");

const PENDING_NOTICE = "Published. The live pages haven't updated yet. The site tries again in a few seconds and once more within a minute.";

test.beforeEach(prepareAdminContext);

test("a publish with an unconfirmed page refresh shows the pending notice", async ({ page, request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  const trace = randomUUID();
  const hanging = gate.traced(trace);
  const hero = await gate.document("tooling-hero");
  try {
  await login(page);
  await choose(page, "Hero Section");
  await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toBeVisible();
  await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill("Fixture heading with a pending page refresh");
  await page.route("**/api/admin/content/publish", (route) => route.continue({ headers: { ...route.request().headers(), "x-roo-test-trace": trace, "x-roo-test-hang-page-mark": "1" } }));
  const response = page.waitForResponse((item) => item.url().endsWith("/api/admin/content/publish") && item.request().method() === "POST");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  expect((await result.json()).data.refresh).toEqual({ content: "done", pages: "pending" });
  await expect(page.getByRole("status").filter({ hasText: PENDING_NOTICE })).toBeVisible();
  const query = new URLSearchParams({ kind: "refresh", trace, count: "3" });
  await new Promise((resolve, reject) => {
    get(`${gate.control}/await-test-event?${query}`, (reply) => {
      reply.resume();
      reply.on("end", () => reply.statusCode === 200 ? resolve() : reject(new Error("Refresh events were not recorded.")));
    }).on("error", reject);
  });
  const events = (await (await request.get(`${gate.control}/refresh-events?trace=${trace}`)).json()).map(({ event }) => event);
  expect(events).toEqual(["now", "5s", "60s"].map((round) => ({ event: "public_pages_refresh", round, pages: "failed", content: "purged" })));
  const errors = (await (await request.get(`${gate.control}/refresh-errors?trace=${trace}`)).json()).map(({ label }) => label);
  expect(errors).toEqual(["Public pages mark did not answer in time"]);
  console.log(`REFRESH_PENDING ${JSON.stringify({ events, errors })}`);
  } finally {
    await gate.cleanup(() => page.unroute("**/api/admin/content/publish"), () => hanging.reset(), () => gate.restore("tooling-hero", hero.document), () => gate.rebuild(["/"]), () => gate.clearRounds());
  }
});
