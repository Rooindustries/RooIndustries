const { test, expect } = require("./fixtures/booking-flow.cjs");

test.use({ javaScriptEnabled: true });

test("benchmark requests cancel during full navigation", async ({ page }, testInfo) => {
  const events = [];
  await page.exposeBinding("recordBenchmarkRequest", (_source, event) => events.push(event));
  await page.addInitScript(() => {
    let hidden = false;
    window.addEventListener("pagehide", () => { hidden = true; });
    const rejected = new WeakSet();
    const originalError = console.error;
    console.error = (...args) => {
      for (const error of args) {
        if (error && typeof error === "object" && rejected.has(error)) {
          window.recordBenchmarkRequest({ kind: "console", message: String(error) }).catch(() => {});
        }
      }
      originalError(...args);
    };
    const originalFetch = window.fetch;
    window.fetch = (input, options) => {
      const request = originalFetch(input, options);
      if (!String(input).includes("/api/content/benchmarks")) return request;
      return request.catch(error => {
        rejected.add(error);
        window.recordBenchmarkRequest({ kind: "rejected", hidden, aborted: options?.signal?.aborted === true, name: error.name }).catch(() => {});
        throw error;
      });
    };
  });
  let requests = 0;
  await page.route("**/api/content/benchmarks", () => { requests++; });
  for (let run = 0; run < 5; run++) {
    const before = requests;
    await page.goto("/benchmarks", { waitUntil: "domcontentloaded" });
    await expect.poll(() => requests).toBeGreaterThan(before);
    await page.goto("/privacy", { waitUntil: "domcontentloaded" });
  }
  await page.waitForTimeout(300);
  await testInfo.attach("benchmark-navigation", { body: JSON.stringify(events, null, 2), contentType: "application/json" });
  expect(events.filter(event => event.kind === "console")).toEqual([]);
  expect(events.filter(event => event.kind === "rejected")).toHaveLength(5);
  expect(events.filter(event => event.kind === "rejected").every(event => event.aborted)).toBe(true);
});

test("benchmark history restoration replaces its cancelled request", async ({ page }, testInfo) => {
  const errors = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  let requests = 0;
  await page.route("**/api/content/benchmarks", route => {
    requests++;
    if (requests > 1) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: [{ title: "Restored benchmark", subtitle: "Synthetic history fixture" }] }) });
  });
  await page.goto("/benchmarks", { waitUntil: "domcontentloaded" });
  await expect.poll(() => requests).toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  await expect(page.getByRole("heading", { name: "Restored benchmark" })).toBeVisible();
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
  await testInfo.attach("benchmark-restored", { body: JSON.stringify({ requests, errors }), contentType: "application/json" });
});

for (const failure of ["network", "server"]) {
  test(`benchmark ${failure} failures remain visible`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route("**/api/content/benchmarks", route => failure === "network" ? route.abort("failed") : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "benchmark-fixture-unavailable" }) }));
    await page.goto("/benchmarks", { waitUntil: "domcontentloaded" });
    await expect.poll(() => errors.some(message => message.includes(failure === "network" ? "Failed to fetch" : "benchmark-fixture-unavailable"))).toBe(true);
    await testInfo.attach("benchmark-error", { body: JSON.stringify({ failure, errors }), contentType: "application/json" });
  });
}
