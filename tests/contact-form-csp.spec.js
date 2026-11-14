const { test, expect } = require("@playwright/test");
const fs = require("node:fs");

test.use({
  javaScriptEnabled: true,
  viewport: { width: 1440, height: 900 },
  serviceWorkers: "block",
  trace: "off",
  video: "off",
});

test.skip(process.env.TOOLING_API_ROUTES !== "1", "Run with npm run test:contact.");

const inbox = "serviroo@rooindustries.com";
const fields = {
  name: "Fixture Person",
  email: "person@fixture.invalid",
  message: "Synthetic contact submission.",
};
const thanks = "Thanks, your message is in. We'll reply by email.";
let apiFixture;
let restoreNetworkGuard;

test.beforeAll(async ({ baseURL }) => {
  const { installNetworkGuard } = await import("../scripts/lib/test-target-safety.mjs");
  apiFixture = await import("./fixtures/api-routes.mjs");
  restoreNetworkGuard = installNetworkGuard([baseURL, apiFixture.apiFixtureOrigin(baseURL)]);
});

test.afterAll(() => restoreNetworkGuard?.());

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  await guardBrowserContext(context, [baseURL]);
  await context.addInitScript(() => {
    window.__contactCspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      window.__contactCspViolations.push({
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective,
        disposition: event.disposition,
      });
    });
  });
  await apiFixture.configureApiFixture(baseURL, { reset: true });
});

const logFile = (testInfo) => `${testInfo.config.metadata.toolingDistDir}-server.log`;
const readLog = (testInfo) => fs.readFileSync(logFile(testInfo), "utf8");

const fixtureState = async (baseURL) => {
  const state = await apiFixture.readApiFixture(baseURL);
  return {
    rows: state.contactMessages,
    emails: state.emails.filter((email) => email.idempotencyKey.startsWith("contact-message-")),
  };
};

const submitForm = async (page, values = fields, company = "") => {
  await page.getByPlaceholder("Your name", { exact: true }).fill(values.name);
  await page.getByPlaceholder("your.email@example.com", { exact: true }).fill(values.email);
  await page
    .getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true })
    .fill(values.message);
  if (company) await page.locator("#contact-company").fill(company, { force: true });
  const response = page.waitForResponse(
    (entry) => new URL(entry.url()).pathname === "/api/contact" && entry.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Send Message", exact: true }).click();
  return response;
};

const finish = async (page, testInfo, baseURL) => {
  expect(await page.evaluate(() => window.__contactCspViolations)).toEqual([]);
  const evidencePath = testInfo.outputPath("contact-state.json");
  fs.writeFileSync(evidencePath, JSON.stringify(await fixtureState(baseURL), null, 2));
  await testInfo.attach("contact-state", { contentType: "application/json", path: evidencePath });
};

test("a valid message is recorded, sent to the inbox and confirmed", async ({ page, baseURL }, testInfo) => {
  await page.goto("/contact");
  const response = await submitForm(page);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByText(thanks, { exact: true })).toBeVisible();
  const { rows, emails } = await fixtureState(baseURL);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...fields, status: "sent", attempts: 1, provider_message_id: emails[0]?.id });
  expect(rows[0].client_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({
    idempotencyKey: `contact-message-${rows[0].id}`,
    to: [inbox],
    reply_to: fields.email,
    subject: `Contact form: ${fields.name}`,
  });
  expect(emails[0].text).toContain(fields.message);
  await finish(page, testInfo, baseURL);
});

test("an invalid message shows the field error and stores nothing", async ({ page, baseURL }, testInfo) => {
  await page.goto("/contact");
  const response = await submitForm(page, { ...fields, message: "Too short" });
  expect(response.status()).toBe(400);
  const message = page.getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true });
  await expect(page.getByText("Write a message between 10 and 5,000 characters.", { exact: true })).toBeVisible();
  await expect(message).toHaveAttribute("aria-invalid", "true");
  await expect(message).toHaveValue("Too short");
  await expect(page.getByRole("button", { name: "Send Message", exact: true })).toBeEnabled();
  expect(await fixtureState(baseURL)).toEqual({ rows: [], emails: [] });
  await finish(page, testInfo, baseURL);
});

test("the send button says Sending... while a message is on its way", async ({ page, baseURL }, testInfo) => {
  await page.goto("/contact");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/contact", async (route) => {
    await held;
    await route.continue();
  });
  const idle = await page.getByRole("button", { name: "Send Message", exact: true }).boundingBox();
  const response = submitForm(page, { ...fields, message: "Too short" });
  const busy = page.getByRole("button", { name: "Sending...", exact: true });
  await expect(busy).toBeDisabled();
  await expect(busy).toHaveAttribute("aria-busy", "true");
  const sending = await busy.boundingBox();
  expect({ width: sending.width, height: sending.height }).toEqual({ width: idle.width, height: idle.height });
  release();
  expect((await response).status()).toBe(400);
  const ready = page.getByRole("button", { name: "Send Message", exact: true });
  await expect(ready).toBeEnabled();
  await expect(ready).toHaveAttribute("aria-busy", "false");
  expect(await fixtureState(baseURL)).toEqual({ rows: [], emails: [] });
  await finish(page, testInfo, baseURL);
});

test("the sixth post inside the window is rate limited", async ({ page, baseURL }, testInfo) => {
  await page.goto("/contact");
  const statuses = await page.evaluate(async () => {
    const results = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Fixture Person", email: "person@fixture.invalid", message: "short" }),
      });
      results.push(response.status);
    }
    return results;
  });
  expect(statuses).toEqual([400, 400, 400, 400, 400]);
  const response = await submitForm(page);
  expect(response.status()).toBe(429);
  const alert = page.locator("form").getByRole("alert");
  await expect(alert).toContainText("Too many messages right now.");
  await expect(alert).toContainText(inbox);
  await expect(page.getByRole("button", { name: "Send Message", exact: true })).toBeEnabled();
  expect(await fixtureState(baseURL)).toEqual({ rows: [], emails: [] });
  await finish(page, testInfo, baseURL);
});

test("a failed send stays queued for retry and is logged", async ({ page, baseURL }, testInfo) => {
  await apiFixture.configureApiFixture(baseURL, { contactDelivery: "failed" });
  const logStart = readLog(testInfo).length;
  await page.goto("/contact");
  const response = await submitForm(page);
  expect(response.status()).toBe(202);
  expect(await response.json()).toEqual({ ok: true, queued: true });
  await expect(page.getByText(thanks, { exact: true })).toBeVisible();
  const { rows, emails } = await fixtureState(baseURL);
  expect(emails).toEqual([]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ...fields,
    status: "failed",
    attempts: 1,
    last_error_code: "email_provider_unavailable",
  });
  expect(rows[0].next_attempt_at).toBeGreaterThan(Date.now());
  await expect.poll(() => readLog(testInfo).slice(logStart)).toContain("contact_message_send_failed");
  const lines = readLog(testInfo).slice(logStart).split("\n").filter((line) => line.includes("contact_message_"));
  expect(lines.join("\n")).toContain("email_provider_unavailable");
  expect(lines.join("\n")).not.toContain("@");
  await finish(page, testInfo, baseURL);
});

test("a slow email provider is queued and the retry delivers once", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const runCron = async () => {
    const response = await apiFixture.requestRoute(baseURL, "/api/payment/reconcile", {
      method: "POST",
      headers: { authorization: "Bearer fixture-only-tooling-cron-secret" },
    });
    return (await response.json()).summary.contactMessages;
  };
  await apiFixture.configureApiFixture(baseURL, { contactDelivery: "slow" });
  await page.goto("/contact");
  const submittedAt = Date.now();
  const response = await submitForm(page);
  expect(Date.now() - submittedAt).toBeLessThan(15_000);
  expect(response.status()).toBe(202);
  expect(await response.json()).toEqual({ ok: true, queued: true });
  await expect(page.getByText(thanks, { exact: true })).toBeVisible();
  const queued = await fixtureState(baseURL);
  expect(queued.emails).toEqual([]);
  expect(queued.rows).toHaveLength(1);
  expect(queued.rows[0]).toMatchObject({
    ...fields,
    status: "failed",
    attempts: 1,
    last_error_code: "email_send_timeout",
  });
  await apiFixture.configureApiFixture(baseURL, { contactDelivery: "captured", contactDue: true });
  expect(await runCron()).toEqual({ claimed: 1, sent: 1, failed: 0 });
  expect(await runCron()).toEqual({ claimed: 0, sent: 0, failed: 0 });
  const { rows, emails } = await fixtureState(baseURL);
  expect(rows).toHaveLength(1);
  expect(emails).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "sent", attempts: 2, provider_message_id: emails[0].id });
  expect(emails[0]).toMatchObject({ idempotencyKey: `contact-message-${rows[0].id}`, to: [inbox] });
  await finish(page, testInfo, baseURL);
});

test("a filled honeypot is recorded as spam and never sent", async ({ page, baseURL }, testInfo) => {
  await page.goto("/contact");
  const response = await submitForm(page, fields, "Fixture Company");
  expect(response.status()).toBe(200);
  await expect(page.getByText(thanks, { exact: true })).toBeVisible();
  const { rows, emails } = await fixtureState(baseURL);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ ...fields, status: "spam", attempts: 0 });
  expect(emails).toEqual([]);
  await finish(page, testInfo, baseURL);
});

test("a missing message store shows the email address instead of success", async ({ page, baseURL }, testInfo) => {
  await apiFixture.configureApiFixture(baseURL, { contactRecord: "missing" });
  const logStart = readLog(testInfo).length;
  await page.goto("/contact");
  const response = await submitForm(page);
  expect(response.status()).toBe(503);
  const alert = page.locator("form").getByRole("alert");
  await expect(alert).toContainText("Your message didn't send.");
  await expect(alert).toContainText(inbox);
  await expect(page.getByText(thanks, { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Tell me about your PC and what you'd like to optimize...", { exact: true }))
    .toHaveValue(fields.message);
  expect(await fixtureState(baseURL)).toEqual({ rows: [], emails: [] });
  await expect.poll(() => readLog(testInfo).slice(logStart)).toContain("contact_message_record_failed");
  await finish(page, testInfo, baseURL);
});
