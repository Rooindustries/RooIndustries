const { test, expect } = require("@playwright/test");
let requestRoute;
let restoreGuard;

test.beforeAll(async ({ baseURL }) => {
  const { installNetworkGuard, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  ({ requestRoute } = await import("./fixtures/api-routes.mjs"));
  restoreGuard = installNetworkGuard([baseURL]);
});

test.afterAll(() => restoreGuard?.());

test("read-only preview still refuses holds and reset requests with 503", async ({ baseURL }, testInfo) => {
  const results = [];
  for (const [pathname, data] of [
    ["/api/holdSlot", { startTimeUTC: "2099-01-05T04:30:00.000Z", packageTitle: "Performance Vertex Overhaul" }],
    ["/api/ref/forgot", { email: "creator@fixture.invalid" }],
    ["/api/ref/forgot", { email: "unknown@fixture.invalid" }],
  ]) {
    const response = await requestRoute(baseURL, pathname, { data });
    const body = await response.json();
    results.push({ pathname, status: response.status, body });
    expect(response.status).toBe(503);
    expect(body).toEqual({ ok: false, error: "This preview does not create bookings or accept payments." });
  }
  await testInfo.attach("preview-responses", { body: JSON.stringify(results), contentType: "application/json" });
  const availability = await requestRoute(baseURL, "/api/bookingAvailability");
  expect(availability.status).toBe(200);
});
