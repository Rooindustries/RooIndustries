const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

const ADMIN_KEY = "synthetic-admin-key";
const EMAIL = "content-admin@example.invalid";
const PASSWORD = "Synthetic-Content-Password-123";
const HERO_ID = "tooling-hero";
const FAQ_ID = "tooling-faqSettings";

const cms = async (request, path, body) => {
  const response = await request.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-admin-key": ADMIN_KEY },
    ...(body === undefined ? {} : { data: body }),
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data;
};
const contentCounts = async (request, control) => {
  const response = await request.get(`${control}/content-counts`);
  expect(response.ok()).toBe(true);
  return response.json();
};
const login = async page => {
  await page.goto("/admin/content");
  await page.getByLabel("Email", { exact: true }).fill(EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
};
const choose = async (page, title) => {
  const navigation = page.getByRole("navigation", { name: "Content types" });
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Types", exact: true }).first().click();
  await navigation.getByRole("button", { name: title, exact: true }).click();
};
const hero = async page => {
  await choose(page, "Hero Section");
  await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
};
const faq = async page => {
  await choose(page, "FAQ Settings");
  await expect(page.getByLabel("Heading", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
};
const openReferrals = async page => {
  await page.goto("/admin/referrals");
  await page.getByLabel("Admin key", { exact: true }).fill(ADMIN_KEY);
  await page.getByRole("button", { name: "Open editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load more creators", exact: true })).toBeVisible();
};
const creators = request => request.get("/api/admin/referral-creators?limit=100", { headers: { "x-admin-key": ADMIN_KEY } }).then(async response => {
  expect(response.ok()).toBe(true);
  return (await response.json()).creators;
});
const selectCreator = async (page, creator) => {
  await page.locator("aside").getByRole("button").filter({ hasText: creator.referral_code }).click();
  await expect(page.getByRole("heading", { name: creator.name, exact: true })).toBeVisible();
};
const hold = async (page, pattern, { forward = true, method } = {}) => {
  let release, seen, finished;
  const blocked = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { seen = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    if (method && route.request().method() !== method) return route.fallback();
    const response = forward ? await route.fetch() : null;
    seen(response);
    await blocked;
    try {
      if (response) await route.fulfill({ response });
      else await route.abort("timedout");
    } catch { /* The client deadline can abort an intentionally held response. */ }
    finished();
  };
  await page.route(pattern, handler);
  return { arrived, release: async () => { release(); await completed; await page.unroute(pattern, handler); } };
};
const evidence = async (page, testInfo, details) => {
  const json = testInfo.outputPath("result.json");
  await fs.writeFile(json, JSON.stringify(details, null, 2));
  await testInfo.attach("result", { path: json, contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("result.png"), fullPage: true });
};

test.beforeEach(async ({ context, page, request, baseURL }) => {
  page.setDefaultTimeout(10000);
  const { guardBrowserContext, localOrigin } = await import("../scripts/lib/test-target-safety.mjs");
  const origin = localOrigin(baseURL);
  const control = localOrigin(`http://127.0.0.1:${Number(new URL(origin).port) + 6}`);
  const markerResponse = await request.get(`${control}/fixture`);
  expect(markerResponse.ok(), "The native fixture must attest before admin I/O").toBe(true);
  const marker = await markerResponse.json();
  expect(marker).toMatchObject({ version: 1, isolated: true, baseURL: origin });
  expect(marker.versions.postgres).toContain("17.");
  await guardBrowserContext(context, marker.origins);
  expect((await request.post(`${control}/reset-rate-limits`)).ok()).toBe(true);
  // Secure cookies are preserved in the product. Synthetic fixture HTTP needs this on private-IP hosts.
  await context.route("**/api/admin/content/session", async route => {
    const response = await route.fetch();
    const headers = response.headers();
    if (headers["set-cookie"]) headers["set-cookie"] = headers["set-cookie"].replace(/; Secure(?=;|$)/gi, "");
    await route.fulfill({ response, headers });
  });
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    for (const source of ["list", "document", "publish", "history"]) {
      test(`#1 late ${source} cannot change the selected editor`, async ({ page, request }, testInfo) => {
        const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
        if (source === "history") await cms(request, "/api/admin/content/publish", { operation: "replace", type: "hero", documentId: HERO_ID, expectedRevision: original.revision, document: { ...original.document, description: `History seed ${viewport.width}` } });
        await login(page);
        let pending;
        if (["list", "document"].includes(source)) {
          pending = await hold(page, source === "list" ? "**/api/admin/content/documents?type=hero" : `**/api/admin/content/documents/${HERO_ID}`);
          await choose(page, "Hero Section");
        } else {
          await hero(page);
          if (source === "publish") {
            await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(`Delayed publish ${viewport.width} ${original.revision}`);
            pending = await hold(page, "**/api/admin/content/publish");
            await page.getByRole("button", { name: "Publish", exact: true }).click();
          } else {
            await page.getByRole("button", { name: "History", exact: true }).click();
            await expect(page.getByRole("button", { name: "Load this version", exact: true }).first()).toBeVisible();
            pending = await hold(page, `**/api/admin/content/documents/${HERO_ID}/revisions/*`);
            await page.getByRole("button", { name: "Load this version", exact: true }).first().click();
          }
        }
        await pending.arrived;
        try {
          page.on("dialog", dialog => dialog.accept());
          await faq(page);
          const field = page.getByLabel("Heading", { exact: true });
          if (source === "history") await field.fill("Other document work that must survive café 日本語");
          const expected = await field.inputValue();
          const revision = (await cms(request, `/api/admin/content/documents/${FAQ_ID}`)).revision;
          await pending.release();
          await page.waitForLoadState("networkidle");
          await expect(field).toHaveValue(expected);
          expect((await cms(request, `/api/admin/content/documents/${FAQ_ID}`)).revision).toBe(revision);
          const drafts = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("roo-content-draft:"))));
          if (drafts[`roo-content-draft:v1:doc:${FAQ_ID}`]) expect(JSON.parse(drafts[`roo-content-draft:v1:doc:${FAQ_ID}`]).document._id).toBe(FAQ_ID);
          await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
          await evidence(page, testInfo, { source, expected, actual: await field.inputValue(), revision, drafts });
        } finally { await pending.release(); }
      });
    }

    test("#2 immediate Unicode type switch keeps the exact draft", async ({ page }, testInfo) => {
      await login(page); await hero(page);
      page.on("dialog", dialog => dialog.accept());
      const field = page.getByLabel("Main Heading (Line 1)", { exact: true });
      const text = `Unpublished café 日本語 🦘 ${viewport.width}`;
      await field.fill(text);
      const started = Date.now();
      await choose(page, "FAQ Settings");
      const elapsed = Date.now() - started;
      expect(elapsed, "The switch must beat the 500ms autosave debounce").toBeLessThan(500);
      await expect(page.getByLabel("Heading", { exact: true })).toBeVisible();
      await hero(page);
      await page.getByRole("button", { name: "Restore my changes", exact: true }).click();
      await expect(field).toHaveValue(text);
      await evidence(page, testInfo, { text, elapsedMs: elapsed });
    });

    test("#2 immediate Unicode document switch keeps the exact draft", async ({ page, request }, testInfo) => {
      const list = await cms(request, "/api/admin/content/documents?type=package");
      const [first, second] = list.documents;
      expect(first && second).toBeTruthy();
      await login(page); await choose(page, "Packages");
      const panel = page.getByRole("region", { name: "Packages list" });
      await panel.getByRole("button").filter({ hasText: first.preview.title }).click();
      const field = page.getByLabel(/^Package Title/);
      await expect(field).toBeEditable();
      const text = `Document café 日本語 🦘 ${viewport.width}`;
      await field.fill(text);
      page.on("dialog", dialog => dialog.accept());
      const started = Date.now();
      if (!await panel.isVisible()) await page.getByRole("region", { name: "Editor" }).getByRole("button", { name: "Packages", exact: true }).click();
      await panel.getByRole("button").filter({ hasText: second.preview.title }).click();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(500);
      await expect(field).toHaveValue(second.preview.title);
      if (!await panel.isVisible()) await page.getByRole("region", { name: "Editor" }).getByRole("button", { name: "Packages", exact: true }).click();
      await panel.getByRole("button").filter({ hasText: first.preview.title }).click();
      await expect(page.getByRole("button", { name: "Restore my changes", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Restore my changes", exact: true }).click();
      await expect(field).toHaveValue(text);
      await evidence(page, testInfo, { first: first._id, second: second._id, text, elapsedMs: elapsed });
    });

    test("#2 pagehide, reload and logout flush the latest draft", async ({ page }, testInfo) => {
      await login(page); await hero(page);
      const field = page.getByLabel("Main Heading (Line 1)", { exact: true });
      const text = `Lifecycle café 日本語 🦘 ${viewport.width}`;
      await field.fill(text);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`))?.document.headingLine1, HERO_ID)).toBe(text);
      const dialogs = [];
      page.on("dialog", dialog => { dialogs.push(dialog.type()); return dialog.accept(); });
      await field.fill(`${text} reload`);
      await page.reload();
      await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
      await hero(page); await page.getByRole("button", { name: "Restore my changes", exact: true }).click();
      await expect(field).toHaveValue(`${text} reload`);
      expect(dialogs).toContain("beforeunload");
      await field.fill(`${text} logout`);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
      await page.getByLabel("Email", { exact: true }).fill(EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
      await hero(page); await page.getByRole("button", { name: "Restore my changes", exact: true }).click();
      await expect(field).toHaveValue(`${text} logout`);
      await evidence(page, testInfo, { text, dialogs });
    });

    for (const source of ["list", "document", "signout"]) {
      test(`#3 ${source} errors stay visible and Retry restores a working pane`, async ({ page }, testInfo) => {
        await login(page);
        const pattern = source === "list" ? "**/api/admin/content/documents?type=hero" : source === "document" ? `**/api/admin/content/documents/${HERO_ID}` : "**/api/admin/content/session";
        const handler = route => route.fulfill({ status: 503, json: { ok: false, error: `Synthetic ${source} outage`, code: "FIXTURE_FAILURE" } });
        await page.route(pattern, handler);
        if (source === "signout") await page.getByRole("button", { name: "Sign out", exact: true }).click();
        else await choose(page, "Hero Section");
        await expect(page.getByRole("alert").filter({ hasText: `Synthetic ${source} outage` })).toBeVisible();
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
        if (source === "signout") {
          expect((await page.request.get("/api/admin/content/session").then(response => response.json())).data.signedIn).toBe(true);
          await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
        }
        await evidence(page, testInfo, { source, serverSessionStillActive: source === "signout" });
        await page.unroute(pattern, handler);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        if (source === "signout") {
          await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
          expect((await page.request.get("/api/admin/content/session").then(response => response.json())).data.signedIn).toBe(false);
        } else await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toBeEditable();
      });
    }

    test("#6 pinned creator pagination includes every server row", async ({ page, request }, testInfo) => {
      const server = await creators(request);
      expect(server).toHaveLength(55);
      await openReferrals(page);
      await page.getByRole("button", { name: "Load more creators", exact: true }).click();
      await selectCreator(page, server[54]);
      await page.getByLabel("Reason for change").fill("Unsaved pinned creator draft");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("button", { name: "Load more creators", exact: true })).toBeEnabled();
      const next = page.waitForRequest(request => new URL(request.url()).pathname === "/api/admin/referral-creators" && new URL(request.url()).searchParams.get("offset") !== "0" && !new URL(request.url()).searchParams.has("creatorId"));
      await page.getByRole("button", { name: "Load more creators", exact: true }).click();
      const offset = new URL((await next).url()).searchParams.get("offset");
      await expect(page.locator("aside button")).toHaveCount(55);
      await expect(page.getByRole("button", { name: "Load more creators", exact: true })).toHaveCount(0);
      const displayed = await page.locator("aside button").allTextContents();
      expect(server.filter(creator => !displayed.some(text => text.includes(creator.referral_code)))).toEqual([]);
      expect(displayed).toHaveLength(55);
      expect(offset).toBe("50");
      await expect(page.getByLabel("Reason for change")).toHaveValue("Unsaved pinned creator draft");
      await evidence(page, testInfo, { offset, serverCount: server.length, displayedCount: displayed.length });
    });

    test("#7 referral drafts survive reload and clear only on save or discard", async ({ page, request }, testInfo) => {
      const creator = (await creators(request))[0];
      await openReferrals(page); await selectCreator(page, creator);
      const reason = `Unsaved terms café 日本語 🦘 ${viewport.width}`;
      await page.getByLabel("Reason for change").fill(reason);
      await page.getByLabel("Creator commission percentage").fill("9.75");
      await page.getByLabel("Customer discount percentage").fill("5.25");
      const dialogs = [];
      page.on("dialog", dialog => { dialogs.push(dialog.type()); return dialog.accept(); });
      await page.reload(); await page.getByLabel("Admin key").fill(ADMIN_KEY); await page.getByRole("button", { name: "Open editor", exact: true }).click();
      await selectCreator(page, creator);
      await expect(page.getByLabel("Creator commission percentage")).toHaveValue("9.75");
      await expect(page.getByLabel("Reason for change")).toHaveValue(reason);
      expect(dialogs).toContain("beforeunload");
      await page.getByRole("button", { name: "Save creator settings", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Saved in Supabase");
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-referral-draft:")))).toEqual([]);
      await page.getByLabel("Reason for change").fill("Explicit discard");
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      await expect(page.getByLabel("Reason for change")).toHaveValue("");
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-referral-draft:")))).toEqual([]);
      await evidence(page, testInfo, { creatorId: creator.creator_id, reason, dialogs });
    });

    test("#7 stale referral draft is a conflict and never silently applied", async ({ page, request }, testInfo) => {
      const creator = (await creators(request))[1];
      await openReferrals(page); await selectCreator(page, creator);
      await page.getByLabel("Reason for change").fill("Older local draft café 日本語");
      await page.getByLabel("Creator commission percentage").fill("8.75");
      const response = await request.patch("/api/admin/referral-creators", { headers: { "x-admin-key": ADMIN_KEY }, data: { creatorId: creator.creator_id, expectedVersion: creator.terms_version, operationId: require("node:crypto").randomUUID(), totalPercent: "15", commissionPercent: "10", discountPercent: "5", bypassUnlock: false, reason: "Another session advanced the version" } });
      expect(response.ok(), await response.text()).toBe(true);
      page.on("dialog", dialog => dialog.accept());
      await page.reload(); await page.getByLabel("Admin key").fill(ADMIN_KEY); await page.getByRole("button", { name: "Open editor", exact: true }).click();
      await selectCreator(page, creator);
      await expect(page.getByRole("alert").filter({ hasText: /draft.*conflict|conflict.*draft/i })).toBeVisible();
      await expect(page.getByLabel("Creator commission percentage")).toHaveValue("10");
      await expect(page.getByRole("button", { name: "Save creator settings", exact: true })).toBeDisabled();
      await evidence(page, testInfo, { creatorId: creator.creator_id, baseVersion: creator.terms_version, serverVersion: (await response.json()).creator.terms_version });
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-referral-draft:")))).toEqual([]);
    });

    test("Bugbot publication response lost accepts server defaults", async ({ page, request }, testInfo) => {
      await login(page); await choose(page, "Benchmark");
      await page.getByRole("region", { name: "Benchmark list" }).getByRole("button", { name: "New", exact: true }).click();
      const title = `  Defaulted benchmark café 日本語 ${viewport.width}  `;
      await page.getByLabel("Benchmark Name", { exact: true }).fill(title);
      await page.getByLabel("Sort Order", { exact: true }).fill("");
      await page.clock.install();
      const pending = await hold(page, "**/api/admin/content/publish", { method: "POST" });
      const submitted = [];
      page.on("request", request => {
        if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") submitted.push(request.postDataJSON());
      });
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      const response = await pending.arrived;
      try {
        const receipt = (await response.json()).data;
        expect(submitted).toHaveLength(1);
        expect(submitted[0].document.title).toBe(title);
        expect(submitted[0].document).not.toHaveProperty("sortOrder");
        const stored = await cms(request, `/api/admin/content/documents/${receipt.documentId}`);
        expect(stored.document).toMatchObject({ title, sortOrder: 0 });
        await page.clock.fastForward(31000);
        await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
        await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toHaveCount(0);
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
        expect(submitted).toHaveLength(1);
        await evidence(page, testInfo, { submitted, stored, receipt });
      } finally { await pending.release(); }
    });

    test("Bugbot newer referral edits rebase after an in-flight save", async ({ page, request }, testInfo) => {
      const creator = (await creators(request))[2];
      await openReferrals(page); await selectCreator(page, creator);
      await page.getByLabel("Creator commission percentage").fill("9.75");
      await page.getByLabel("Customer discount percentage").fill("5.25");
      await page.getByLabel("Reason for change").fill("First save snapshot");
      const pending = await hold(page, "**/api/admin/referral-creators", { method: "PATCH" });
      await page.getByRole("button", { name: "Save creator settings", exact: true }).click();
      const response = await pending.arrived;
      try {
        const saved = (await response.json()).creator;
        const reason = `Newer edits café 日本語 🦘 ${viewport.width}`;
        await page.getByLabel("Creator commission percentage").fill("8.75");
        await page.getByLabel("Customer discount percentage").fill("6.25");
        await page.getByLabel("Reason for change").fill(reason);
        await pending.release();
        await expect(page.getByRole("status")).toContainText("Saved in Supabase");
        await expect(page.getByLabel("Creator commission percentage")).toBeEnabled();
        await expect(page.getByLabel("Creator commission percentage")).toHaveValue("8.75");
        await expect(page.getByLabel("Reason for change")).toHaveValue(reason);
        await expect(page.getByRole("alert").filter({ hasText: /draft.*conflict|conflict.*draft/i })).toHaveCount(0);
        const drafts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("roo-referral-draft:")).map(([key, value]) => ({ key, ...JSON.parse(value) })));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ baseVersion: saved.terms_version, draft: { commissionPercent: "8.75", discountPercent: "6.25", reason } });
        page.on("dialog", dialog => dialog.accept());
        await page.reload();
        await page.getByLabel("Admin key", { exact: true }).fill(ADMIN_KEY);
        await page.getByRole("button", { name: "Open editor", exact: true }).click();
        await selectCreator(page, creator);
        await expect(page.getByRole("status")).toContainText("Recovered your unpublished creator draft");
        await expect(page.getByLabel("Creator commission percentage")).toBeEnabled();
        await expect(page.getByLabel("Creator commission percentage")).toHaveValue("8.75");
        await expect(page.getByLabel("Reason for change")).toHaveValue(reason);
        await page.getByLabel("Reason for change").fill(`${reason} still editable`);
        await page.getByRole("button", { name: "Save creator settings", exact: true }).click();
        await expect(page.getByLabel("Reason for change")).toHaveValue("");
        const stored = (await creators(request)).find(item => item.creator_id === creator.creator_id);
        expect(stored).toMatchObject({ terms_version: saved.terms_version + 1, commission_basis_points: 875, discount_basis_points: 625 });
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-referral-draft:")))).toEqual([]);
        await evidence(page, testInfo, { creatorId: creator.creator_id, savedVersion: saved.terms_version, drafts, stored });
      } finally { await pending.release(); }
    });

    test("#11 validation errors describe the actual input with stable ids", async ({ page }, testInfo) => {
      await login(page); await choose(page, "Tool");
      await page.getByRole("region", { name: "Tool list" }).getByRole("button", { name: "New", exact: true }).click();
      await page.getByLabel("External Download URL", { exact: true }).fill("https://example.invalid/fixture-download");
      const field = page.getByLabel(/^Tool Name/);
      await field.fill("");
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      const ids = await field.getAttribute("aria-describedby");
      expect(ids).toBeTruthy();
      const messages = await field.evaluate(input => input.getAttribute("aria-describedby").split(/\s+/).map(id => ({ id, count: document.querySelectorAll(`[id="${id}"]`).length, text: document.getElementById(id)?.textContent })));
      expect(messages.every(message => message.count === 1)).toBe(true);
      expect(messages.some(message => /required/i.test(message.text))).toBe(true);
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      expect(await field.getAttribute("aria-describedby")).toBe(ids);
      await evidence(page, testInfo, { ids, messages });
    });
  });
}

for (const committed of [true, false]) {
  test(`#10 publish deadline reconciles ${committed ? "committed response lost" : "request never sent"} without retrying`, async ({ page, request }, testInfo) => {
    await login(page); await hero(page);
    const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
    const heading = `Timeout café 日本語 ${committed} ${original.revision}`;
    await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(heading);
    await page.clock.install();
    const pending = await hold(page, "**/api/admin/content/publish", { forward: committed });
    let calls = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") calls += 1; });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await pending.arrived;
    try {
      await page.clock.fastForward(31000);
      await expect(page.getByRole("button", { name: "Publishing…", exact: true })).toHaveCount(0);
      const stored = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
      if (committed) {
        await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
        expect(stored.revision).not.toBe(original.revision);
        expect(stored.document.headingLine1).toBe(heading);
        expect(await page.evaluate(id => localStorage.getItem(`roo-content-draft:v1:doc:${id}`), HERO_ID)).toBeNull();
      } else {
        await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
        expect(stored.revision).toBe(original.revision);
        expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`))?.document.headingLine1, HERO_ID)).toBe(heading);
        await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toHaveValue(heading);
      }
      expect(calls).toBe(1);
      await evidence(page, testInfo, { committed, originalRevision: original.revision, storedRevision: stored.revision, calls });
    } finally { await pending.release(); }
  });
}

for (const committed of [true, false]) {
  test(`#10 create deadline reconciles ${committed ? "committed response lost" : "request never sent"} with the same create intent`, async ({ page, request }, testInfo) => {
    await login(page); await choose(page, "Tool");
    await page.getByRole("region", { name: "Tool list" }).getByRole("button", { name: "New", exact: true }).click();
    const title = `Deadline tool café 日本語 ${committed}`;
    await page.getByLabel(/^Tool Name/).fill(title);
    await page.getByLabel("External Download URL", { exact: true }).fill("https://example.invalid/fixture-download");
    await page.clock.install();
    const pending = await hold(page, "**/api/admin/content/publish", { forward: committed });
    let calls = 0, submitted;
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") { calls += 1; submitted = request.postDataJSON(); } });
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const response = await pending.arrived;
    try {
      await page.clock.fastForward(31000);
      await expect(page.getByRole("button", { name: "Publishing…", exact: true })).toHaveCount(0);
      expect(submitted.createIntentId).toBeTruthy();
      if (committed) {
        const receipt = (await response.json()).data;
        await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
        expect((await cms(request, `/api/admin/content/documents/${receipt.documentId}`)).document.title).toBe(title);
        expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
        await evidence(page, testInfo, { committed, title, documentId: receipt.documentId, createIntentId: submitted.createIntentId, calls });
      } else {
        await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
        const drafts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("roo-content-draft:")));
        expect(drafts).toHaveLength(1);
        const draft = JSON.parse(drafts[0][1]);
        expect(draft).toMatchObject({ createIntentId: submitted.createIntentId, document: { title } });
        await evidence(page, testInfo, { committed, title, createIntentId: submitted.createIntentId, calls });
      }
      expect(calls).toBe(1);
    } finally { await pending.release(); }
  });
}

test("create receipts keep a failed singleton draft after another create commits", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  expect((await request.post(`${control}/booking-create-fixture/legacy`)).ok()).toBe(true);
  await page.route("**/api/admin/content/documents?type=bookingSettings", route => route.fulfill({ json: { ok: true, data: { documents: [] } } }));
  await login(page); await choose(page, "Booking Settings");
  await page.getByLabel("Maximum Days Ahead Booking", { exact: true }).fill("11");
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish", { method: "POST" });
  let submitted, writes = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") { submitted = request.postDataJSON(); writes += 1; }
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await pending.arrived;
  try {
    expect(response.status()).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, code: "CMS_SINGLETON_EXISTS" });
    expect((await request.post(`${control}/booking-create-fixture/empty`)).ok()).toBe(true);
    const otherIntent = require("node:crypto").randomUUID();
    const otherReceipt = await cms(request, "/api/admin/content/publish", { ...submitted, createIntentId: otherIntent });
    expect(otherReceipt).toMatchObject({ committed: true, documentId: "6d8a3646-0ed2-44b5-ad45-c5c9d578126a" });
    expect(otherIntent).not.toBe(submitted.createIntentId);
    const beforeLookup = await contentCounts(request, control);
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    const drafts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("roo-content-draft:")));
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0][1])).toMatchObject({ createIntentId: submitted.createIntentId, document: { maxDaysAheadBooking: 11 } });
    expect(writes).toBe(1);
    const afterLookup = await contentCounts(request, control);
    expect(afterLookup).toEqual(beforeLookup);
    await evidence(page, testInfo, { failure: "CMS_SINGLETON_EXISTS", failedIntent: submitted.createIntentId, otherIntent, otherReceipt, retainedDraft: JSON.parse(drafts[0][1]), writes, beforeLookup, afterLookup });
  } finally {
    await pending.release();
    expect((await request.post(`${control}/reset-content`)).ok()).toBe(true);
  }
});

test("create receipts reconcile a committed fixed-ID singleton after its response is lost", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  expect((await request.post(`${control}/booking-create-fixture/empty`)).ok()).toBe(true);
  await login(page); await choose(page, "Booking Settings");
  await page.getByLabel("Maximum Days Ahead Booking", { exact: true }).fill("13");
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish", { method: "POST" });
  let submitted, writes = 0;
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") { submitted = request.postDataJSON(); writes += 1; }
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await pending.arrived;
  try {
    expect(response.ok(), await response.text()).toBe(true);
    const receipt = (await response.json()).data;
    expect(receipt).toMatchObject({ committed: true, documentId: "6d8a3646-0ed2-44b5-ad45-c5c9d578126a" });
    const beforeLookup = await contentCounts(request, control);
    await page.clock.fastForward(31000);
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
    expect((await cms(request, `/api/admin/content/documents/${receipt.documentId}`)).document.maxDaysAheadBooking).toBe(13);
    expect(writes).toBe(1);
    const afterLookup = await contentCounts(request, control);
    expect(afterLookup).toEqual(beforeLookup);
    await evidence(page, testInfo, { receipt, createIntentId: submitted.createIntentId, writes, beforeLookup, afterLookup });
  } finally {
    await pending.release();
    expect((await request.post(`${control}/reset-content`)).ok()).toBe(true);
  }
});

test("create receipts refuse matching content without an intent receipt", async ({ page, request }, testInfo) => {
  await login(page); await choose(page, "Tool");
  await page.getByRole("region", { name: "Tool list" }).getByRole("button", { name: "New", exact: true }).click();
  const title = "Receipt required café 日本語";
  await page.getByLabel(/^Tool Name/).fill(title);
  await page.getByLabel("External Download URL", { exact: true }).fill("https://example.invalid/fixture-download");
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish", { method: "POST" });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await pending.arrived;
  try {
    expect(response.ok(), await response.text()).toBe(true);
    const receipt = (await response.json()).data;
    const content = await cms(request, `/api/admin/content/documents/${receipt.documentId}`);
    await page.route("**/api/admin/content/publish**", route => route.fulfill({ json: { ok: true, data: { ...content, documentId: receipt.documentId } } }));
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    const drafts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("roo-content-draft:")));
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0][1]).document.title).toBe(title);
    await evidence(page, testInfo, { committedDocumentId: receipt.documentId, receiptOmittedFromStatus: true, draftKept: true });
  } finally { await pending.release(); }
});

test("create receipts keep a draft while its receipt is processing", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  await login(page); await choose(page, "Benchmark");
  await page.getByRole("region", { name: "Benchmark list" }).getByRole("button", { name: "New", exact: true }).click();
  const title = "Processing receipt café 日本語";
  await page.getByLabel("Benchmark Name", { exact: true }).fill(title);
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish", { method: "POST" });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await pending.arrived;
  try {
    expect(response.ok(), await response.text()).toBe(true);
    const receipt = (await response.json()).data;
    expect((await request.post(`${control}/create-receipt-processing/${receipt.documentId}`)).ok()).toBe(true);
    const beforeLookup = await contentCounts(request, control);
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    const drafts = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("roo-content-draft:")));
    expect(drafts).toHaveLength(1);
    expect(JSON.parse(drafts[0][1]).document.title).toBe(title);
    const afterLookup = await contentCounts(request, control);
    expect(afterLookup).toEqual(beforeLookup);
    await evidence(page, testInfo, { receiptState: "processing", documentId: receipt.documentId, draftKept: true, beforeLookup, afterLookup });
  } finally { await pending.release(); }
});

test("create receipts bind a read-only lookup to the original validated request", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  const path = "/api/admin/content/publish/status";
  const command = { operation: "create", type: "benchmark", createIntentId: require("node:crypto").randomUUID(), document: { title: "Read-only receipt café 日本語" } };
  const receipt = await cms(request, "/api/admin/content/publish", command);
  const beforeLookup = await contentCounts(request, control);
  const status = await cms(request, path, command);
  expect(status).toEqual({ committed: true, createIntentId: command.createIntentId, type: command.type, documentId: receipt.documentId, revision: receipt.revision });
  expect(await cms(request, path, { ...command, createIntentId: command.createIntentId.toUpperCase(), document: { ...command.document, sortOrder: 0, _rev: "ignored-system-field" } })).toEqual(status);
  const missing = [
    { ...command, createIntentId: require("node:crypto").randomUUID() },
    { ...command, document: { title: "Different request content" } },
    { ...command, type: "tool", document: { title: command.document.title, downloadUrl: "https://example.invalid/fixture-download" } },
  ];
  for (const body of missing) {
    const response = await request.post(path, { headers: { "x-admin-key": ADMIN_KEY }, data: body });
    expect(response.status(), await response.text()).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "CMS_NOT_FOUND" });
    expect(await contentCounts(request, control)).toEqual(beforeLookup);
  }
  const invalid = [
    { ...command, createIntentId: "invalid" },
    { ...command, expectedRevision: "create-has-no-loaded-revision" },
    { ...command, action: "publish" },
    { ...command, document: { title: 7 } },
    { ...command, document: { ...command.document, _supabaseRuntime: true } },
  ];
  for (const body of invalid) {
    for (const endpoint of [path, "/api/admin/content/publish"]) {
      const response = await request.post(endpoint, { headers: { "x-admin-key": ADMIN_KEY }, data: body });
      expect(response.status(), await response.text()).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, code: "CMS_VALIDATION_FAILED" });
    }
  }
  for (const endpoint of [path, "/api/admin/content/publish"]) {
    const response = await request.post(endpoint, { headers: { "x-admin-key": ADMIN_KEY, "Content-Type": "application/json" }, data: JSON.stringify({ ...command, document: { title: "x".repeat(1024 * 1024) } }) });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CMS_VALIDATION_FAILED", details: [{ message: "JSON content exceeds 1 MiB." }] });
  }
  const replacement = await request.post(path, { headers: { "x-admin-key": ADMIN_KEY }, data: { operation: "replace", type: command.type, documentId: receipt.documentId, expectedRevision: receipt.revision, document: { title: "Must not write" } } });
  expect(replacement.status()).toBe(400);
  expect((await request.get(`/api/admin/content/publish?type=${command.type}&createIntentId=${command.createIntentId}`, { headers: { "x-admin-key": ADMIN_KEY } })).status()).toBe(405);
  expect((await request.post(path, { data: command })).status()).toBe(401);
  await login(page);
  const otherActor = await page.evaluate(async ({ path, command }) => {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  }, { path, command });
  expect(otherActor).toMatchObject({ status: 404, body: { ok: false, code: "CMS_NOT_FOUND" } });
  const afterLookup = await contentCounts(request, control);
  expect(afterLookup).toEqual(beforeLookup);
  expect((await cms(request, `/api/admin/content/documents/${receipt.documentId}`)).document.title).toBe(command.document.title);
  await evidence(page, testInfo, { status, missingRequests: missing.length, invalidRequests: invalid.length, otherActor, beforeLookup, afterLookup, legacyGetStatus: 405 });
});

test("#10 a concurrent subtitle prevents reconciling a missing deletion", async ({ page, request }, testInfo) => {
  const documentId = "tooling-contact";
  const initial = await cms(request, `/api/admin/content/documents/${documentId}`);
  await cms(request, "/api/admin/content/publish", {
    operation: "replace", type: "contact", documentId, expectedRevision: initial.revision,
    document: { ...initial.document, subtitle: "Old subtitle" },
  });
  await login(page); await choose(page, "Contact Section");
  const subtitle = page.getByLabel("Subtitle", { exact: true });
  await expect(subtitle).toHaveValue("Old subtitle");
  const original = await cms(request, `/api/admin/content/documents/${documentId}`);
  await subtitle.fill("");
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish", { forward: false });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await pending.arrived;
  try {
    await cms(request, "/api/admin/content/publish", {
      operation: "replace", type: "contact", documentId, expectedRevision: original.revision,
      document: { ...original.document, subtitle: "Concurrent editor subtitle" },
    });
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    await expect(subtitle).toHaveValue("");
    const draft = await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`)), documentId);
    expect(draft.baseRevision).toBe(original.revision);
    expect(draft.document).not.toHaveProperty("subtitle");
    const stored = await cms(request, `/api/admin/content/documents/${documentId}`);
    expect(stored.document.subtitle).toBe("Concurrent editor subtitle");
    await evidence(page, testInfo, { originalRevision: original.revision, stored, draft });
  } finally { await pending.release(); }
});

test("#10 uncertain publication keeps its draft and Retry only reads", async ({ page, request }, testInfo) => {
  await login(page); await hero(page);
  const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  const text = `Uncertain café 日本語 ${original.revision}`;
  await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(text);
  const failedRead = route => route.fulfill({ status: 503, json: { ok: false, error: "Synthetic reconciliation outage" } });
  await page.route(`**/api/admin/content/documents/${HERO_ID}`, failedRead);
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish");
  let calls = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") calls += 1; });
  await page.getByRole("button", { name: "Publish", exact: true }).click(); await pending.arrived;
  try {
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /could not confirm.*publication/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`))?.document.headingLine1, HERO_ID)).toBe(text);
    await page.unroute(`**/api/admin/content/documents/${HERO_ID}`, failedRead);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    expect(calls).toBe(1);
    await evidence(page, testInfo, { originalRevision: original.revision, calls, text });
  } finally { await pending.release(); }
});

test("#10 a superseded publication keeps the draft and its revision guard", async ({ page, request }, testInfo) => {
  await login(page); await hero(page);
  const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  const text = `Superseded café 日本語 ${original.revision}`;
  const otherText = `Different work published by another editor ${original.revision}`;
  await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(text);
  await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/publish");
  const submitted = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/admin/content/publish" && request.method() === "POST") submitted.push(request.postDataJSON());
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click(); await pending.arrived;
  try {
    const ours = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
    await cms(request, "/api/admin/content/publish", { operation: "replace", type: "hero", documentId: HERO_ID, expectedRevision: ours.revision, document: { ...ours.document, description: otherText } });
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    expect(submitted).toHaveLength(1);
    const draft = await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`)), HERO_ID);
    expect(draft.baseRevision).toBe(original.revision);
    expect(draft.document.headingLine1).toBe(text);
    await pending.release();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: "Publishing…", exact: true })).toHaveCount(0);
    await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
    expect(submitted[1].expectedRevision).toBe(original.revision);
    expect((await cms(request, `/api/admin/content/documents/${HERO_ID}`)).document.description).toBe(otherText);
    await evidence(page, testInfo, { submitted, baseRevision: draft.baseRevision, text });
  } finally { await pending.release(); }
});

test("#10 signout deadline preserves the server session and permits an explicit retry", async ({ page }, testInfo) => {
  await login(page); await page.clock.install();
  const pending = await hold(page, "**/api/admin/content/session", { forward: false, method: "DELETE" });
  let calls = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/content/session" && request.method() === "DELETE") calls += 1; });
  await page.getByRole("button", { name: "Sign out", exact: true }).click(); await pending.arrived;
  try {
    await page.clock.fastForward(31000);
    await expect(page.getByRole("alert").filter({ hasText: /timed out/i })).toBeVisible();
    expect((await page.request.get("/api/admin/content/session").then(response => response.json())).data.signedIn).toBe(true);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    expect(calls).toBe(1);
    await evidence(page, testInfo, { calls, signedIn: true });
  } finally { await pending.release(); }
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect(calls).toBe(2);
});

test("referral drafts in two tabs preserve both terms versions", async ({ page, context, request }, testInfo) => {
  const creator = (await creators(request))[4];
  await openReferrals(page); await selectCreator(page, creator);
  const response = await request.patch("/api/admin/referral-creators", {
    headers: { "x-admin-key": ADMIN_KEY },
    data: { creatorId: creator.creator_id, expectedVersion: creator.terms_version, operationId: require("node:crypto").randomUUID(), totalPercent: "15", commissionPercent: "10", discountPercent: "5", bypassUnlock: false, reason: "A newer tab advances the terms version" },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const newer = (await response.json()).creator;
  const other = await context.newPage();
  await openReferrals(other); await selectCreator(other, creator);
  await other.getByLabel("Reason for change").fill("Newer terms version draft");
  const prefix = `roo-referral-draft:v1:${encodeURIComponent(creator.creator_id)}:`;
  const oldKey = `${prefix}${creator.terms_version}`;
  const newKey = `${prefix}${newer.terms_version}`;
  await page.evaluate(prefix => localStorage.setItem(`${prefix}corrupt`, "{broken"), prefix);
  await page.getByLabel("Reason for change").fill("Older tab saves last");
  const stored = await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).sort(), prefix);
  expect(stored).toEqual([oldKey, newKey].sort());
  other.on("dialog", dialog => dialog.accept());
  await other.reload();
  await other.getByLabel("Admin key").fill(ADMIN_KEY);
  await other.getByRole("button", { name: "Open editor", exact: true }).click();
  await selectCreator(other, creator);
  await expect(other.getByLabel("Reason for change")).toHaveValue("Newer terms version draft");
  await other.getByRole("button", { name: "Discard draft", exact: true }).click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).draft.reason, oldKey)).toBe("Older tab saves last");
  expect(await page.evaluate(key => localStorage.getItem(key), newKey)).toBeNull();
  await other.getByLabel("Reason for change").fill("Save only the newer terms draft");
  await other.getByRole("button", { name: "Save creator settings", exact: true }).click();
  await expect(other.getByRole("status")).toContainText("Saved in Supabase");
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).draft.reason, oldKey)).toBe("Older tab saves last");
  expect(await page.evaluate(key => localStorage.getItem(key), newKey)).toBeNull();
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  expect(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), prefix)).toEqual([]);
  await evidence(other, testInfo, { creatorId: creator.creator_id, oldVersion: creator.terms_version, newVersion: newer.terms_version, stored });
  await other.close();
});

test("content fixture reset removes created documents and preserves referrals", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  expect((await request.post(`${control}/reset-content`)).ok()).toBe(true);
  const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  const baseline = await cms(request, "/api/admin/content/documents?type=benchmark");
  const referralSnapshot = await creators(request);
  const receipt = await cms(request, "/api/admin/content/publish", {
    operation: "create", type: "benchmark", createIntentId: require("node:crypto").randomUUID(), document: { title: "Created after the content baseline", sortOrder: 77 },
  });
  await cms(request, "/api/admin/content/publish", { operation: "replace", type: "hero", documentId: HERO_ID, expectedRevision: original.revision, document: { ...original.document, description: "Changed after the content baseline" } });
  const deletedId = baseline.documents[0]._id;
  await cms(request, "/api/admin/content/publish", { operation: "delete", type: "benchmark", documentId: deletedId, expectedRevision: baseline.documents[0].revision });
  expect((await request.post(`${control}/reset-content`)).ok()).toBe(true);
  const reset = await cms(request, "/api/admin/content/documents?type=benchmark");
  expect(reset.documents.map(document => document._id).sort()).toEqual(baseline.documents.map(document => document._id).sort());
  expect((await request.get(`/api/admin/content/documents/${receipt.documentId}`, { headers: { "x-admin-key": ADMIN_KEY } })).status()).toBe(404);
  expect((await cms(request, `/api/admin/content/documents/${HERO_ID}`)).document.description).toBe(original.document.description);
  expect(await creators(request)).toEqual(referralSnapshot);
  await login(page); await choose(page, "Benchmark");
  await evidence(page, testInfo, { createdId: receipt.documentId, restoredId: deletedId, benchmarkIds: reset.documents.map(document => document._id), referralCount: referralSnapshot.length });
});

test("empty Portable Text exposes validation on its accessible field", async ({ page }, testInfo) => {
  await page.route("**/api/admin/content/documents/tooling-privacyPolicy", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.document.sections = [{ _key: "empty-validation-section", _type: "object", heading: "Empty text section", content: {} }];
    await route.fulfill({ response, json: body });
  });
  await login(page); await choose(page, "Privacy Policy Page");
  await page.getByRole("button", { name: "Empty text section", exact: true }).click();
  await expect(page.getByText("No text yet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Content", exact: true })).toHaveCount(0);
  await page.getByLabel("Page Title", { exact: true }).fill("Empty text validation");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const field = page.getByRole("group", { name: "Content", exact: true });
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const errorId = await field.getAttribute("aria-describedby");
  expect(errorId).toBe("content-error-sections%5B0%5D.content");
  await expect(page.locator(`[id="${errorId}"]`)).toContainText("An array is required.");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(field).toHaveAttribute("aria-describedby", errorId);
  await evidence(page, testInfo, { renderedBlocks: 0, errorId, invalid: await field.getAttribute("aria-invalid") });
});
