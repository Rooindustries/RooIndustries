const { randomUUID } = require("node:crypto");
const { get } = require("node:http");
const { test, expect } = require("./fixtures/isolated-content-test.cjs");
const { cms, login, choose, prepareAdminContext } = require("./fixtures/admin-content.cjs");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");

const HERO_ID = "tooling-hero";
const hero = async page => {
  await choose(page, "Hero Section");
  await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
};

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
  expect(events).toEqual(["now", "5s", "60s"].map((round) => ({ event: "public_pages_refresh", round, pages: "pending", content: "purged" })));
  const errors = (await (await request.get(`${gate.control}/refresh-errors?trace=${trace}`)).json()).map(({ label }) => label);
  expect(errors).toEqual(["Public pages mark did not answer in time"]);
  console.log(`REFRESH_PENDING ${JSON.stringify({ events, errors })}`);
  } finally {
    await gate.cleanup(() => page.unroute("**/api/admin/content/publish"), () => hanging.reset(), () => gate.restore("tooling-hero", hero.document), () => gate.rebuild(["/"]), () => gate.clearRounds());
  }
});

test("a pending content purge is reported as pending", async ({ request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  const original = await gate.document("tooling-package-0");
  const hanging = gate.traced();
  try {
    const response = await request.post("/api/admin/content/publish", {
      headers: { ...hanging.headers, "x-admin-key": "synthetic-admin-key", "x-roo-test-hang-content-purge": "1" },
      data: gate.replaceCommand(original, { price: "$487.19" }),
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data.refresh).toEqual({ content: "pending", pages: "done" });
    const query = new URLSearchParams({ kind: "refresh", trace: hanging.trace, count: "1" });
    expect((await request.get(`${gate.control}/await-test-event?${query}`)).status()).toBe(200);
    const events = (await (await request.get(`${gate.control}/refresh-events?trace=${hanging.trace}`)).json()).map(({ event }) => event);
    expect(events).toEqual([{ event: "public_pages_refresh", round: "now", pages: "marked", content: "pending" }]);
  } finally {
    await gate.cleanup(() => hanging.reset(), () => gate.restore("tooling-package-0", original.document), () => gate.rebuild(["/packages"]), () => gate.clearRounds());
  }
});

test("a lost publish response followed by Retry shows the general notice", async ({ page, request }) => {
  await login(page); await hero(page);
  const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  const heading = `Lost response ${original.revision}`;
  await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(heading);
  const failedRead = route => route.fulfill({ status: 503, json: { ok: false, error: "Synthetic reconciliation outage" } });
  const lostResponse = async route => { await route.fetch(); await route.abort("failed"); };
  await page.route(`**/api/admin/content/documents/${HERO_ID}`, failedRead);
  await page.route("**/api/admin/content/publish", lostResponse);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: /could not confirm.*publication/i })).toBeVisible();
  await page.unroute(`**/api/admin/content/documents/${HERO_ID}`, failedRead);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published. The live site picks this up within a few minutes (page and CDN caches)." })).toBeVisible();
  expect((await cms(request, `/api/admin/content/documents/${HERO_ID}`)).document.headingLine1).toBe(heading);
});

test("a delete with unknown refresh status shows the general notice", async ({ page }) => {
  await login(page); await choose(page, "Benchmark");
  await page.getByRole("region", { name: "Benchmark list" }).getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Benchmark Name", { exact: true }).fill("Delete with unknown refresh");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published. The live site picks this up within a few minutes (page and CDN caches)." })).toBeVisible();
  await page.route("**/api/admin/content/publish", async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.data.refresh;
    await route.fulfill({ response, json: body });
  });
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Deleted. The live site picks this up within a few minutes." })).toBeVisible();
});
