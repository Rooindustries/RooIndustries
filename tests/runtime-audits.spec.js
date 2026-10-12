const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
let proxyFixture;
let restoreGuard;

test.skip(process.env.TOOLING_API_ROUTES !== "0", "Select the read-only fixture with npm run test:audit:runtime.");

test.beforeAll(async ({ baseURL }) => {
  const { installNetworkGuard, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  proxyFixture = await import("./fixtures/audit-provider-proxy.mjs");
  restoreGuard = installNetworkGuard([baseURL, proxyFixture.auditProviderProxyOrigin(baseURL)]);
});

test.afterAll(() => restoreGuard?.());

const runAudit = (baseURL, args, mode = "0", preload) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    ...(preload ? ["--require", require.resolve("./fixtures/runtime-firefox-unavailable.cjs")] : []),
    "scripts/phase1-runtime-audits.js",
    ...args,
  ], {
    env: { ...process.env, BASE_URL: baseURL, TOOLING_API_ROUTES: mode },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90000,
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.once("close", code => resolve({ code, output }));
});

test("runtime business checks accept the declared read-only provider contract", async ({ baseURL }, testInfo) => {
  const result = await runAudit(baseURL, ["--check", "business"]);
  await testInfo.attach("runtime-output", { body: result.output, contentType: "text/plain" });
  await testInfo.attach("business-smoke", { body: await fs.readFile("audit/phase1-business-smoke.md"), contentType: "text/markdown" });
  await testInfo.attach("booking-heading", { body: await fs.readFile("audit/phase1-booking-heading.json"), contentType: "application/json" });
  expect(result.code, result.output).toBe(0);
  const providerConfig = JSON.parse(await fs.readFile("audit/phase1-provider-config.json", "utf8"));
  await testInfo.attach("provider-response", { body: JSON.stringify(providerConfig), contentType: "application/json" });
  expect(providerConfig).toMatchObject({
    targetMode: "read-only",
    status: 503,
    body: { ok: false, error: "This preview does not create bookings or accept payments." },
  });
  expect(Object.keys(providerConfig.body).sort()).toEqual(["error", "ok"]);
});

test("runtime business checks reject a missing booking heading", async ({ baseURL }, testInfo) => {
  const proxy = await proxyFixture.startAuditProviderProxy(baseURL, {
    status: 503,
    body: { ok: false, error: "This preview does not create bookings or accept payments." },
    bookingHtml: "<!doctype html><html><body><main>Booking is unavailable.</main></body></html>",
  });
  try {
    const result = await runAudit(proxy.origin, ["--check", "business"]);
    const report = await fs.readFile("audit/phase1-business-smoke.md", "utf8");
    await testInfo.attach("business-smoke", { body: report, contentType: "text/markdown" });
    expect(result.code, result.output).toBe(1);
    expect(report).toContain("booking_renders_schedule_title: FAIL");
  } finally {
    await proxy.close();
  }
});

test("runtime business checks do not infer target mode from a 503 response", async ({ baseURL }, testInfo) => {
  const result = await runAudit(baseURL, ["--check", "business"], "1");
  await testInfo.attach("runtime-output", { body: result.output, contentType: "text/plain" });
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain("Business smoke checks failed");
});

test("runtime business checks reject a provider name leaked in read-only mode", async ({ baseURL }, testInfo) => {
  const proxy = await proxyFixture.startAuditProviderProxy(baseURL, {
    status: 503,
    body: { ok: false, error: "This preview does not create bookings or accept payments.", providerName: "paypal" },
  });
  try {
    const result = await runAudit(proxy.origin, ["--check", "business"]);
    await testInfo.attach("runtime-output", { body: result.output, contentType: "text/plain" });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Business smoke checks failed");
    const report = await fs.readFile("audit/phase1-business-smoke.md", "utf8");
    await testInfo.attach("business-smoke", { body: report, contentType: "text/markdown" });
    expect(report).toContain("payment_provider_details_withheld: FAIL");
  } finally {
    await proxy.close();
  }
});

test("runtime browser matrix fails when an unskipped browser cannot launch", async ({ baseURL }, testInfo) => {
  const result = await runAudit(baseURL, ["--check", "browser-matrix"], "0", true);
  await testInfo.attach("runtime-output", { body: result.output, contentType: "text/plain" });
  const matrix = await fs.readFile("audit/phase1-browser-device-matrix.csv", "utf8");
  await testInfo.attach("browser-matrix", { body: matrix, contentType: "text/csv" });
  expect(matrix).toContain("firefox,all,/,launch_failed,0,0,0,false");
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain("Browser matrix checks failed");
});

test("runtime browser matrix records an explicitly skipped browser", async ({ baseURL }, testInfo) => {
  const result = await runAudit(baseURL, ["--check", "browser-matrix", "--skip-browser", "firefox"], "0", true);
  await testInfo.attach("runtime-output", { body: result.output, contentType: "text/plain" });
  const matrix = await fs.readFile("audit/phase1-browser-device-matrix.csv", "utf8");
  await testInfo.attach("browser-matrix", { body: matrix, contentType: "text/csv" });
  expect(result.code, result.output).toBe(0);
  expect(matrix).toContain("firefox,all,/,skipped,");
  expect(matrix).not.toContain("launch_failed");
});
