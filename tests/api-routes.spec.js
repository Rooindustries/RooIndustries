const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { MARKDOWN_PATHS, MARKDOWN_VARY } = require("../src/lib/markdownContent");
let apiFixture;
let proxyFixture;
let restoreNetworkGuard;

test.skip(process.env.TOOLING_API_ROUTES !== "1", "Select the writable fixture with npm run test:api:routes.");

test.beforeAll(async ({ baseURL }) => {
  const { installNetworkGuard } = await import("../scripts/lib/test-target-safety.mjs");
  apiFixture = await import("./fixtures/api-routes.mjs");
  proxyFixture = await import("./fixtures/audit-provider-proxy.mjs");
  restoreNetworkGuard = installNetworkGuard([baseURL, apiFixture.apiFixtureOrigin(baseURL), proxyFixture.auditProviderProxyOrigin(baseURL)]);
});

test.afterAll(() => restoreNetworkGuard?.());

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext, localOrigin, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  localOrigin(baseURL);
  await guardBrowserContext(context, [baseURL]);
});

const runApiAudit = baseURL => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["scripts/phase1-api-contract.js"], {
    env: { ...process.env, BASE_URL: baseURL },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90000,
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.once("error", reject);
  child.once("close", code => resolve({ code, output }));
});

test("API contract audit covers handler validation and retired endpoints", async ({ baseURL }, testInfo) => {
  await apiFixture.configureApiFixture(baseURL, { reset: true });
  const result = await runApiAudit(baseURL);
  await testInfo.attach("api-contract-output", { body: result.output, contentType: "text/plain" });
  await testInfo.attach("api-contract-responses", {
    body: await fs.readFile("audit/phase1-api-contract.csv"),
    contentType: "text/csv",
  });
  expect(result.code, result.output).toBe(0);
});

test("API contract audit rejects a null provider configuration", async ({ baseURL }, testInfo) => {
  await apiFixture.configureApiFixture(baseURL, { reset: true });
  const proxy = await proxyFixture.startAuditProviderProxy(baseURL, { status: 200, body: { ok: true, providers: null } });
  try {
    const result = await runApiAudit(proxy.origin);
    await testInfo.attach("api-contract-output", { body: result.output, contentType: "text/plain" });
    await testInfo.attach("api-contract-responses", { body: await fs.readFile("audit/phase1-api-contract.csv"), contentType: "text/csv" });
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("/api/payment/providers");
  } finally {
    await proxy.close();
  }
});

test.describe("referral reset acknowledgement", () => {
  const acknowledgement = { ok: true, message: "If email exists, link sent." };
  for (const delivery of ["completed", "pending", "queued", "failed", "dead_letter", "source_conflict", "token_conflict", "enqueue_failed", "requeue_failed"]) {
    test(`${delivery} is indistinguishable from an unknown email`, async ({ baseURL }, testInfo) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, delivery });
      const unknown = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: "unknown@fixture.invalid" } });
      const knownStartedAt = performance.now();
      const known = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: ` ${apiFixture.referralEmail.toUpperCase()} ` } });
      const result = {
        unknown: { status: unknown.status, body: await unknown.text() },
        known: { status: known.status, body: await known.text() },
      };
      const knownMilliseconds = performance.now() - knownStartedAt;
      if (!["token_conflict", "enqueue_failed"].includes(delivery)) {
        const checkpoint = delivery === "failed" ? "/roo_complete_referral_email_dispatch"
          : ["dead_letter", "requeue_failed"].includes(delivery) ? "/roo_requeue_referral_email_dispatch"
          : "/roo_claim_referral_email_dispatch";
        await expect.poll(async () => (await apiFixture.readApiFixture(baseURL)).requests.some(call => call.path.endsWith(checkpoint))).toBe(true);
      }
      const state = await apiFixture.readApiFixture(baseURL);
      await testInfo.attach("reset-responses", { body: JSON.stringify({ delivery, ...result, requests: state.requests }, null, 2), contentType: "application/json" });
      expect(result.unknown).toEqual({ status: 200, body: JSON.stringify(acknowledgement) });
      expect(result.known).toEqual(result.unknown);
      if (delivery === "enqueue_failed") {
        const artifact = testInfo.outputPath("reset-enqueue-failure.json");
        await fs.writeFile(artifact, JSON.stringify({ ...result, knownMilliseconds }, null, 2));
        await testInfo.attach("reset-enqueue-failure", { path: artifact, contentType: "application/json" });
        expect(knownMilliseconds).toBeGreaterThanOrEqual(800);
      }
      const enqueues = state.requests.filter(call => call.path.endsWith("/roo_enqueue_referral_email_mutation"));
      expect(enqueues).toHaveLength(delivery === "token_conflict" ? 3 : 1);
      expect(enqueues[0].body.p_recipient_email).toBe(apiFixture.referralEmail);
      if (["token_conflict", "enqueue_failed"].includes(delivery)) {
        expect(state.requests.some(call => call.path.endsWith("/roo_claim_referral_email_dispatch"))).toBe(false);
        expect(state.documents.find(row => row._type === "referral").resetTokenHash).toBeUndefined();
      }
      if (delivery === "source_conflict") {
        expect(state.requests.some(call => call.path.endsWith("/roo_requeue_referral_email_dispatch"))).toBe(false);
      }
      if (delivery === "failed") {
        expect(state.requests.find(call => call.path.endsWith("/roo_complete_referral_email_dispatch")).body).toMatchObject({ p_success: false, p_error_code: "email_provider_unconfigured" });
      }
    });
  }

  test("applies one uniform response floor despite a delayed durable enqueue", async ({ baseURL }, testInfo) => {
    const samples = { unknown: [], known: [] };
    for (let index = 0; index < 10; index += 1) {
      await apiFixture.configureApiFixture(baseURL, { reset: true, enqueueDelayMs: 400 });
      for (const [kind, email] of [["unknown", "unknown@fixture.invalid"], ["known", apiFixture.referralEmail]]) {
        const startedAt = performance.now();
        const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email } });
        const body = await response.json();
        samples[kind].push({ milliseconds: performance.now() - startedAt, status: response.status, body });
      }
      await expect.poll(async () => (await apiFixture.readApiFixture(baseURL)).requests.some(call => call.path.endsWith("/roo_claim_referral_email_dispatch"))).toBe(true);
    }
    const median = values => {
      const ordered = values.map(sample => sample.milliseconds).sort((left, right) => left - right);
      return (ordered[4] + ordered[5]) / 2;
    };
    const medianDifference = Math.abs(median(samples.known) - median(samples.unknown));
    const artifact = testInfo.outputPath("reset-timing.json");
    await fs.writeFile(artifact, JSON.stringify({ samples, medianDifference }, null, 2));
    await testInfo.attach("reset-timing", { path: artifact, contentType: "application/json" });
    for (const sample of [...samples.known, ...samples.unknown]) {
      expect(sample).toMatchObject({ status: 200, body: acknowledgement });
      expect(sample.milliseconds).toBeGreaterThanOrEqual(800);
    }
    expect(medianDifference).toBeLessThan(50);
  });

  test("captures reset email delivery after the acknowledgement", async ({ baseURL }, testInfo) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true, delivery: "captured", enqueueDelayMs: 400, emailDelayMs: 1200 });
    const startedAt = performance.now();
    const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: apiFixture.referralEmail } });
    const body = await response.json();
    const milliseconds = performance.now() - startedAt;
    const responseReceivedAt = Date.now();
    const atResponse = await apiFixture.readApiFixture(baseURL);
    await expect.poll(async () => (await apiFixture.readApiFixture(baseURL)).requests.some(call => call.path.endsWith("/roo_complete_referral_email_dispatch"))).toBe(true);
    const delivered = await apiFixture.readApiFixture(baseURL);
    const artifact = testInfo.outputPath("reset-deferred-delivery.json");
    await fs.writeFile(artifact, JSON.stringify({ milliseconds, responseReceivedAt, atResponse, delivered }, null, 2));
    await testInfo.attach("reset-deferred-delivery", { path: artifact, contentType: "application/json" });
    expect(response.status).toBe(200);
    expect(body).toEqual(acknowledgement);
    expect(milliseconds).toBeGreaterThanOrEqual(800);
    expect(milliseconds).toBeLessThan(1100);
    expect(atResponse.emails).toEqual([]);
    expect(delivered.emails).toHaveLength(1);
    expect(delivered.emails[0]).toMatchObject({ to: [apiFixture.referralEmail], subject: "Reset your Roo Industries password" });
    expect(delivered.emails[0].html).toContain(`${baseURL}/referrals/reset#token=`);
    expect(delivered.emails[0].sentAt).toBeGreaterThan(responseReceivedAt);
    expect(delivered.requests.find(call => call.path.endsWith("/roo_complete_referral_email_dispatch")).body.p_success).toBe(true);
  });

  test("rejects malformed emails and preserves the admission limit", async ({ baseURL }) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true });
    for (const email of [undefined, "", "not-an-email", `${"a".repeat(250)}@fixture.invalid`]) {
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email } });
      expect(response.status).toBe(400);
    }
    const state = await apiFixture.readApiFixture(baseURL);
    expect(state.requests.some(call => call.path.startsWith("/rest/"))).toBe(false);
    for (let index = 0; index < 5; index += 1) {
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: "unknown@fixture.invalid" } });
      expect(response.status).toBe(200);
    }
    const limited = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: apiFixture.referralEmail } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("keeps account-independent lookup failures visible", async ({ baseURL }) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true, delivery: "lookup_failed" });
    for (const email of ["unknown@fixture.invalid", apiFixture.referralEmail]) {
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email } });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ ok: false, error: "Server error" });
    }
  });

  test("keeps account-independent limiter outages at 503", async ({ baseURL }) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true, failure: "limiter" });
    for (const email of ["unknown@fixture.invalid", apiFixture.referralEmail]) {
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email } });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false, error: "Request protection is temporarily unavailable." });
    }
    const state = await apiFixture.readApiFixture(baseURL);
    expect(state.requests.some(call => call.body.p_document_types?.includes("referral"))).toBe(false);
    expect(state.requests.some(call => call.path.endsWith("/roo_enqueue_referral_email_mutation"))).toBe(false);
  });

  test.describe("forgot page", () => {
    test.use({ javaScriptEnabled: true });
    test("shows the API acknowledgement after requesting a reset", async ({ page, baseURL }, testInfo) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, delivery: "pending" });
      await page.goto("/referrals/forgot");
      await page.getByPlaceholder("you@example.com").fill(apiFixture.referralEmail);
      const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/ref/forgot") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Send Reset Link", exact: true }).click();
      const response = await responsePromise;
      const body = await response.json();
      await testInfo.attach("reset-page-response", { body: JSON.stringify(body), contentType: "application/json" });
      await expect(page.getByText(body.message, { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder("you@example.com")).toHaveValue("");
      await expect(page.getByRole("button", { name: "Send Reset Link", exact: true })).toBeEnabled();
      await page.screenshot({ path: "test-results/api-routes/forgot-page.png" });
    });
  });
});

test.describe("canonical Markdown", () => {
  for (const pathname of MARKDOWN_PATHS) {
    test(`${pathname} matches the direct endpoint and ignores a conflicting path`, async ({ baseURL }, testInfo) => {
      const direct = await apiFixture.requestRoute(baseURL, `/markdown?path=${encodeURIComponent(pathname)}`);
      const expected = await direct.text();
      expect(direct.status).toBe(200);
      const conflictingPath = pathname === "/about" ? "/contact" : "/about";
      for (const url of [pathname, `${pathname}?path=${encodeURIComponent(conflictingPath)}`]) {
        const response = await apiFixture.requestRoute(baseURL, url, { headers: { Accept: "text/markdown" } });
        const body = await response.text();
        await testInfo.attach(`markdown-${encodeURIComponent(url)}`, {
          body: JSON.stringify({ url, status: response.status, headers: Object.fromEntries(response.headers), body }, null, 2),
          contentType: "application/json",
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/markdown");
        expect(response.headers.get("vary")).toBe(direct.headers.get("vary"));
        expect(response.headers.get("vary")).toContain(MARKDOWN_VARY);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("cdn-cache-control")).toBe("no-store");
        expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
        expect(body).toBe(expected);
      }
      const head = await apiFixture.requestRoute(baseURL, pathname, { method: "HEAD", headers: { Accept: "text/markdown" } });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
    });
  }

  test("preserves missing-page and unacceptable-format responses", async ({ baseURL }) => {
    const direct = await apiFixture.requestRoute(baseURL, "/markdown?path=/unpublished-page");
    const missing = await apiFixture.requestRoute(baseURL, "/unpublished-page", { headers: { Accept: "text/markdown" } });
    expect(direct.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(await direct.text());
    for (const pathname of MARKDOWN_PATHS) {
      const response = await apiFixture.requestRoute(baseURL, pathname, { headers: { Accept: "application/xml" } });
      expect(response.status).toBe(406);
      expect(response.headers.get("vary")).toBe(MARKDOWN_VARY);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
  });
});

test.describe("referral session status", () => {
  for (const session of ["unavailable", "network_error", "malformed_response"]) {
    test(`${session} preserves the account-verification outage response`, async ({ baseURL }, testInfo) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, session });
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/sessionStatus", {
        headers: { Cookie: `ref_session=${apiFixture.referralSessionCookie()}` },
      });
      const body = await response.json();
      await testInfo.attach("session-status", { body: JSON.stringify({ session, status: response.status, body }), contentType: "application/json" });
      expect(response.status).toBe(503);
      expect(body).toEqual({ ok: false, error: "Account verification is temporarily unavailable." });
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }

  test("absent, expired, malformed and bad-signature cookies stay anonymous during an outage", async ({ baseURL }) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true, session: "unavailable" });
    for (const cookie of ["", "ref_session=malformed", "ref_session=%GG", `ref_session=${apiFixture.referralSessionCookie({ exp: 1 })}`, `ref_session=${apiFixture.referralSessionCookie()}invalid`]) {
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/sessionStatus", { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, authenticated: false });
    }
    const state = await apiFixture.readApiFixture(baseURL);
    expect(state.requests.some(call => call.path.endsWith("/roo_validate_referral_session"))).toBe(false);
  });

  for (const session of ["valid", "inactive", "deleted", "revoked", "no_role", "principal_mismatch", "code_mismatch", "referral_mismatch"]) {
    test(`${session} keeps the existing authentication result`, async ({ baseURL }) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, session });
      const response = await apiFixture.requestRoute(baseURL, "/api/ref/sessionStatus", {
        headers: { Cookie: `ref_session=${apiFixture.referralSessionCookie()}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, authenticated: session === "valid" });
    });
  }

  test("a revoked session version stays anonymous", async ({ baseURL }) => {
    await apiFixture.configureApiFixture(baseURL, { reset: true });
    const response = await apiFixture.requestRoute(baseURL, "/api/ref/sessionStatus", {
      headers: { Cookie: `ref_session=${apiFixture.referralSessionCookie({ sv: 2 })}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, authenticated: false });
  });

  test.describe("login page", () => {
    test.use({ javaScriptEnabled: true });
    test("a remembered identifier alone does not select remember me", async ({ page, baseURL }) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, session: "unavailable" });
      await page.addInitScript(() => sessionStorage.setItem("refLoginCode", "fixture-creator"));
      await page.goto("/referrals/login");
      await expect(page.locator("#ref-login-identifier")).toHaveValue("fixture-creator");
      await expect(page.locator("#ref-login-remember")).not.toBeChecked();
    });
    test("keeps remembered login state and the cookie when verification is unavailable", async ({ page, context, baseURL }, testInfo) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, session: "unavailable" });
      const cookie = apiFixture.referralSessionCookie();
      await context.addCookies([{ name: "ref_session", value: cookie, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
      await page.addInitScript(() => {
        sessionStorage.setItem("refLoginCode", "fixture-creator");
        sessionStorage.setItem("refLoginRememberMe", "true");
      });
      const requests = [];
      page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
      const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/ref/sessionStatus"));
      await page.goto("/referrals/login");
      const response = await responsePromise;
      expect(response.status()).toBe(503);
      await expect(page.locator("#ref-login-identifier")).toHaveValue("fixture-creator");
      await expect(page.locator("#ref-login-remember")).toBeChecked();
      await page.locator("#ref-login-password").fill("Synthetic-password1!");
      await expect(page.getByRole("button", { name: "Login", exact: true })).toBeEnabled();
      await expect(page).toHaveURL(`${baseURL}/referrals/login`);
      expect((await context.cookies()).find(row => row.name === "ref_session")?.value).toBe(cookie);
      expect(requests.some(row => row.url.includes("/api/ref/logout"))).toBe(false);
      await testInfo.attach("login-session-state", {
        body: JSON.stringify({ status: response.status(), url: page.url(), rememberedCode: await page.locator("#ref-login-identifier").inputValue(), cookiePreserved: true, requests }),
        contentType: "application/json",
      });
      await page.screenshot({ path: "test-results/api-routes/login-outage.png" });
    });
  });
});
