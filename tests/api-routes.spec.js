const { test, expect } = require("@playwright/test");
const { MARKDOWN_PATHS, MARKDOWN_VARY } = require("../src/lib/markdownContent");
let apiFixture;
let restoreNetworkGuard;

test.beforeAll(async ({ baseURL }) => {
  const { installNetworkGuard } = await import("../scripts/lib/test-target-safety.mjs");
  apiFixture = await import("./fixtures/api-routes.mjs");
  restoreNetworkGuard = installNetworkGuard([baseURL, apiFixture.apiFixtureOrigin(baseURL)]);
});

test.afterAll(() => restoreNetworkGuard?.());

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext, localOrigin, refuseEnvFiles } = await import("../scripts/lib/test-target-safety.mjs");
  refuseEnvFiles();
  localOrigin(baseURL);
  await guardBrowserContext(context, [baseURL]);
});

test.describe("referral reset acknowledgement", () => {
  const acknowledgement = { ok: true, message: "If email exists, link sent." };
  for (const delivery of ["completed", "pending", "queued", "failed", "dead_letter", "source_conflict", "token_conflict", "enqueue_failed", "requeue_failed"]) {
    test(`${delivery} is indistinguishable from an unknown email`, async ({ baseURL }, testInfo) => {
      await apiFixture.configureApiFixture(baseURL, { reset: true, delivery });
      const unknown = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: "unknown@fixture.invalid" } });
      const known = await apiFixture.requestRoute(baseURL, "/api/ref/forgot", { data: { email: ` ${apiFixture.referralEmail.toUpperCase()} ` } });
      const result = {
        unknown: { status: unknown.status, body: await unknown.text() },
        known: { status: known.status, body: await known.text() },
      };
      const state = await apiFixture.readApiFixture(baseURL);
      await testInfo.attach("reset-responses", { body: JSON.stringify({ delivery, ...result, requests: state.requests }, null, 2), contentType: "application/json" });
      expect(result.unknown).toEqual({ status: 200, body: JSON.stringify(acknowledgement) });
      expect(result.known).toEqual(result.unknown);
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
