const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { CONTENT_TYPES } = require("../src/lib/cms/contentSchema.js");
const { PUBLIC_CONTENT_RESOURCES } = require("../src/lib/publicContentQueries.js");
const { ALL_PUBLIC_ROUTES } = require("../src/lib/routes.js");
const { MONEY_BACK_FAQ_QUESTION, MONEY_BACK_FAQ_ANSWER } = require("../src/lib/policyContent.js");
const fieldContract = require("./fixtures/cms-field-contract.cjs");

const ADMIN_KEY = "synthetic-admin-key";
const EMAIL = "content-admin@example.invalid";
const PASSWORD = "Synthetic-Content-Password-123";
const HERO_ID = "tooling-hero";
const FAQ_ID = "tooling-contact";

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
  const navigation = page.getByRole("navigation", { name: "Content types", includeHidden: true });
  await expect(navigation).toBeAttached();
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Types", exact: true }).first().click();
  await navigation.getByRole("button", { name: title, exact: true }).click();
};
const hero = async page => {
  await choose(page, "Hero Section");
  await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
};
const faq = async page => {
  await choose(page, "Contact Section");
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

test("ROO-66 public fixture HTML and API stay identical", async ({ page, request }, testInfo) => {
  test.skip(process.env.ROO_TEST_DEV === "1", "Public byte comparison requires a production build.");
  const buildId = await fs.readFile(path.join(testInfo.config.metadata.toolingDistDir, "BUILD_ID"), "utf8");
  const normalize = html => html.split(buildId.trim()).join("BUILD_ID")
    .replace(/(\/_next\/static\/[^"'\s<>\\]*?)[a-f0-9]{8,64}(?=\.(?:js|css))/g, "$1BUILD_HASH")
    .replace(/^(<!DOCTYPE html>)<!--[A-Za-z0-9_-]+-->/, "$1<!--BUILD_ID-->");
  const snapshot = { pages: {}, api: {} };
  for (const pathname of [...ALL_PUBLIC_ROUTES.filter(pathname => pathname !== "/tourney"), "/upgrade/fixture-upgrade", "/downloads/fixture-download"]) {
    expect((await request.get(pathname)).status()).toBe(200);
    const response = await request.get(pathname);
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    const normalized = normalize(html);
    snapshot.pages[pathname] = { html, normalized, sha256: createHash("sha256").update(normalized).digest("hex") };
  }
  const packages = await cms(request, "/api/admin/content/documents?type=package");
  const firstPackage = await cms(request, `/api/admin/content/documents/${packages.documents[0]._id}`);
  for (const resource of PUBLIC_CONTENT_RESOURCES) {
    const query = resource === "package" ? `?title=${encodeURIComponent(firstPackage.document.title)}` : resource === "upgrade-link" ? "?slug=fixture-upgrade" : "";
    const response = await request.get(`/api/content/${resource}${query}`);
    expect(response.status()).toBe(200);
    snapshot.api[resource] = await response.text();
  }
  snapshot.api.bookingAvailability = await (await request.get("/api/bookingAvailability")).text();
  const coupons = await cms(request, "/api/admin/content/documents?type=coupon");
  const coupon = await cms(request, `/api/admin/content/documents/${coupons.documents[0]._id}`);
  snapshot.api.validateCoupon = await (await request.get(`/api/ref/validateCoupon?code=${encodeURIComponent(coupon.document.code)}`)).text();
  const artifact = testInfo.outputPath("public-content.json");
  await fs.writeFile(artifact, JSON.stringify(snapshot, null, 2));
  await testInfo.attach("public-content", { path: artifact, contentType: "application/json" });
  if (process.env.ROO_PUBLIC_CONTENT_BASELINE) {
    const baseline = JSON.parse(await fs.readFile(process.env.ROO_PUBLIC_CONTENT_BASELINE, "utf8"));
    for (const pathname of Object.keys(snapshot.pages)) {
      expect(snapshot.pages[pathname].normalized, `${pathname} public HTML changed`).toBe(baseline.pages[pathname].normalized);
    }
    expect(snapshot.api).toEqual(baseline.api);
  }
  await page.goto("/admin/content");
  await evidence(page, testInfo, { publicHtmlSha256: Object.fromEntries(Object.entries(snapshot.pages).map(([pathname, value]) => [pathname, value.sha256])), apiResources: Object.keys(snapshot.api) });
});

const prepareFieldFixture = async (request, baseURL, document) => {
  const response = await request.post(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/cms-field-fixture`, { data: document });
  expect(response.ok(), await response.text()).toBe(true);
};

const expandEditor = async page => {
  await expect(page.getByRole("region", { name: "Editor", exact: true })).toHaveAttribute("aria-busy", "false");
  const closed = page.getByRole("region", { name: "Editor", exact: true }).locator('button[aria-expanded="false"]');
  while (await closed.count()) await closed.first().click();
};
const expectUnused = async (page, type, fieldPath) => {
  const helpId = `content-help-${encodeURIComponent(fieldPath)}`;
  await expect(page.locator(`[id="${helpId}"]`), `${type}.${fieldPath} silently does nothing`).toHaveText(UNUSED_NOTE);
  const controls = page.locator(`[aria-describedby~="${helpId}"]`);
  expect(await controls.count(), `${type}.${fieldPath} lacks an accessible note`).toBeGreaterThan(0);
  for (const control of await controls.all()) expect(await control.evaluate(node => node.readOnly || node.disabled || node.getAttribute("aria-disabled") === "true")).toBe(true);
};

const publishDraft = async (page, schema, original, document, beforePublish) => {
  await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
  await page.evaluate(({ original, document }) => {
    localStorage.setItem(`roo-content-draft:v1:doc:${original.document._id}`, JSON.stringify({ document, assets: original.assets, baseRevision: original.revision, documentId: original.document._id, type: original.document._type, savedAt: new Date().toISOString() }));
  }, { original, document });
  await choose(page, schema.name === "hero" ? "Contact Section" : "Hero Section");
  await choose(page, schema.title);
  if (!schema.singleton) {
    const title = original.document[schema.preview.title] || original.document.title || original.document._id;
    await page.getByRole("region", { name: `${schema.title} list`, exact: true }).getByRole("button").filter({ hasText: title }).first().click();
  }
  await page.getByRole("button", { name: "Restore my changes", exact: true }).click();
  await beforePublish?.();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
};

test.describe("CMS field contract", () => {
test.afterEach(async ({ request, baseURL }) => {
  expect((await request.post(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/reset-content`)).ok()).toBe(true);
});
test("ROO-66 every schema field has an explicit rendered, internal or unused contract", async ({ page }, testInfo) => {
  const classified = [];
  for (const schema of CONTENT_TYPES) {
    const fields = fieldContract.schemaFields(schema.fields);
    for (const { field, path } of fields) {
      if (fieldContract.operationalReadOnly[schema.name]?.includes(path)) { expect(field.readOnly).toBe(true); continue; }
      const usage = fieldContract.classify(schema.name, path);
      const internal = fieldContract.internal[schema.name]?.[path];
      if (fieldContract.overrideKeys[schema.name]?.includes(path)) {
        expect(usage, `${schema.name}.${path} selects public behavior`).toBe("RENDERED");
        expect(field.overrideKey).toBe(true);
        expect(field.unusedWhen, `${schema.name}.${path} must never be frozen`).toBeUndefined();
      }
      if (usage === "RENDERED") expect(field.readOnly, `${schema.name}.${path} must remain editable`).not.toBe(true);
      if (internal) {
        expect(internal.consumer).toMatch(/^src\/.+:\d+$/);
        expect(field.readOnly, `${schema.name}.${path} has an internal consumer`).not.toBe(true);
        expect(field.description).not.toBe(UNUSED_NOTE);
      }
      if (usage === "UNUSED") expect(field).toMatchObject({ unusedOnSite: true, readOnly: true, preserveStoredValue: true, description: UNUSED_NOTE });
      classified.push({ type: schema.name, path, usage, internal });
    }
    for (const path of [...(fieldContract.rendered[schema.name] || []), ...(fieldContract.unused[schema.name] || []), ...Object.keys(fieldContract.internal[schema.name] || {})]) {
      expect(fields.some(item => item.path === path), `Stale CMS field contract: ${schema.name}.${path}`).toBe(true);
    }
  }
  await login(page);
  await evidence(page, testInfo, { classified });
});

test("ROO-66 publishing the owner recipient changes real booking notifications", async ({ page, request, baseURL }, testInfo) => {
  const schema = CONTENT_TYPES.find(type => type.name === "bookingSettings");
  const id = schema.fixedId;
  const original = await cms(request, `/api/admin/content/documents/${id}`);
  await login(page); await choose(page, schema.title);
  const recipient = page.getByLabel("Booking Owner Email", { exact: true });
  await expect(recipient).toBeEditable();
  const results = [];
  for (const email of [`owner-first-${randomUUID()}@fixture.invalid`, `owner-second-${randomUUID()}@fixture.invalid`]) {
    await recipient.fill(email);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    expect((await cms(request, `/api/admin/content/documents/${id}`)).document.ownerEmail).toBe(email);
    const notification = await request.post(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/owner-notification`);
    expect(notification.ok(), await notification.text()).toBe(true);
    const result = await notification.json();
    expect(result.result.body.emailDispatch.owner.sent).toBe(true);
    const owner = result.emails.find(message => message.subject.startsWith("New booking"));
    expect([owner.to].flat()).toEqual([email]);
    expect(result.emails.some(message => [message.to].flat().includes(original.document.ownerEmail))).toBe(false);
    results.push({ email, messages: result.emails, result: result.result });
  }
  await evidence(page, testInfo, { notifications: results });
});

for (const schema of CONTENT_TYPES.filter(type => !["footer", "siteSettings"].includes(type.name))) {
  test(`ROO-66 every editable ${schema.name} field reaches a public or internal consumer or shows its unused note`, async ({ page, request, baseURL }, testInfo) => {
    test.setTimeout(180000);
    const binding = fieldContract.bindings[schema.name];
    expect(binding, "New editor types require a public contract").toBeTruthy();
    for (const item of fieldContract.schemaFields(schema.fields)) if ((fieldContract.unused[schema.name] || []).includes(item.path)) {
      expect(item.field, `${schema.name}.${item.path} needs unused metadata`).toMatchObject({ unusedOnSite: true, readOnly: true, preserveStoredValue: true, description: UNUSED_NOTE });
    }
    const list = await cms(request, `/api/admin/content/documents?type=${schema.name}`);
    const entry = schema.fixedId ? list.documents.find(document => document._id === schema.fixedId) : list.documents[0];
    const initial = await cms(request, `/api/admin/content/documents/${entry._id}`);
    const marker = `cms66-${randomUUID().slice(0, 8)}`;
    const upload = async (kind, token) => {
      const comment = Buffer.from(token);
      const zip = Buffer.alloc(22); zip.writeUInt32LE(0x06054b50); zip.writeUInt16LE(comment.length, 20);
      const bytes = kind === "image" ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text x="0" y="12">${token}</text></svg>`) : Buffer.concat([zip, comment]);
      const mimeType = kind === "image" ? "image/svg+xml" : "application/zip";
      const issued = await cms(request, "/api/admin/content/assets/upload", { kind, fileName: `${token}.${kind === "image" ? "svg" : "zip"}`, mimeType, byteSize: bytes.length, sha1: createHash("sha1").update(bytes).digest("hex"), sha256: createHash("sha256").update(bytes).digest("hex") });
      if (issued.alreadyExists) return issued.assetId;
      expect(new URL(issued.signedUrl).hostname).toBe("127.0.0.1");
      expect((await request.put(issued.signedUrl, { data: bytes, headers: { "content-type": mimeType } })).ok()).toBe(true);
      return (await cms(request, "/api/admin/content/assets/finalize", { uploadId: issued.uploadId })).assetId;
    };
    const reference = async token => {
      const id = `fixture-${createHash("sha1").update(token).digest("hex")}`;
      await prepareFieldFixture(request, baseURL, { _id: id, _type: "package", title: token, price: "$321.67", order: 99 });
      return id;
    };
    const seed = await fieldContract.buildDocument({ schema, current: initial.document, marker: `seed66-${randomUUID().slice(0, 8)}`, origin: baseURL, upload, reference });
    await prepareFieldFixture(request, baseURL, seed.document);
    const original = await cms(request, `/api/admin/content/documents/${entry._id}`);
    const pending = await fieldContract.buildDocument({ schema, current: original.document, marker, origin: baseURL, upload, reference, preserveUnused: true });
    const usage = item => fieldContract.classify(schema.name, item.path, fieldContract.get(pending.document, item.path.replace(/\.?[^.[\]]+$/, "")) || pending.document, fieldContract.contextFor(pending.document, item.path));
    await login(page);
    await choose(page, schema.title);
    if (!schema.singleton) await page.getByRole("region", { name: `${schema.title} list`, exact: true }).getByRole("button").filter({ hasText: original.document[schema.preview.title] || original.document._id }).first().click();
    await expandEditor(page);
    const unusedResults = [];
    const checkedBeforeRestore = new Set();
    for (const item of seed.cases.filter(item => !item.bare && fieldContract.unusedField(schema.name, item.path, fieldContract.get(pending.document, item.path.replace(/\.?[^.[\]]+$/, "")) || pending.document, fieldContract.contextFor(pending.document, item.path)))) {
      unusedResults.push(item.path);
      if (fieldContract.unused[schema.name]?.some(parent => fieldContract.patternPath(item.path).startsWith(`${parent}[].`))) {
        await expectUnused(page, schema.name, item.path);
        checkedBeforeRestore.add(item.path);
      }
    }
    if (!pending.cases.length) {
      for (const path of unusedResults) await expectUnused(page, schema.name, path);
      await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
      await evidence(page, testInfo, { type: schema.name, unused: unusedResults });
      return;
    }
    for (const path of unusedResults) {
      const keys = path.replace(/\[(\d+)\]/g, ".$1").split(".");
      const last = keys.pop();
      const parent = keys.reduce((value, key) => value?.[key], pending.document);
      if (parent) delete parent[last];
    }
    if (schema.fields.some(field => field.name === "sortOrder")) await prepareFieldFixture(request, baseURL, { ...pending.document, _id: `${entry._id}-order-peer`, title: `${marker}-order-peer`, sortOrder: pending.document.sortOrder - 1 });
    await publishDraft(page, schema, original, pending.document, async () => {
      await expandEditor(page);
      for (const path of unusedResults) if (!checkedBeforeRestore.has(path)) await expectUnused(page, schema.name, path);
    });
    const stored = await cms(request, `/api/admin/content/documents/${entry._id}`);
    for (const path of unusedResults) expect(fieldContract.get(stored.document, path)).toEqual(fieldContract.get(original.document, path));
    const internalCases = pending.cases.filter(item => !item.bare && usage(item) === "INTERNAL");
    for (const item of internalCases.filter(item => !["object", "array"].includes(item.field.type))) expect(fieldContract.get(stored.document, item.path), `${schema.name}.${item.path} must remain publishable`).toEqual(item.value);
    const verifyInternal = async () => {
      const checked = [];
      for (const item of internalCases) {
        const consumer = fieldContract.internalField(schema.name, item.path);
        const current = await cms(request, `/api/admin/content/documents/${entry._id}`);
        await page.goto("/admin/content");
        await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
        await choose(page, schema.title);
        if (!schema.singleton) await page.getByRole("region", { name: `${schema.title} list`, exact: true }).getByRole("button").filter({ hasText: current.document[schema.preview.title] }).first().click();
        if (consumer.kind === "documentTitle") {
          expect(schema.singleton).not.toBe(true);
          await expect(page.getByRole("region", { name: `${schema.title} list`, exact: true }).getByRole("button").filter({ hasText: item.value })).toBeVisible();
          expect((await cms(request, `/api/admin/content/documents?type=${schema.name}`)).documents.find(row => row._id === entry._id).preview.title).toBe(item.value);
        } else if (consumer.kind === "ownerNotification") {
          const notification = await request.post(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/owner-notification`);
          expect(notification.ok(), await notification.text()).toBe(true);
          const result = await notification.json();
          expect(result.result.body.emailDispatch.owner.sent).toBe(true);
          expect([result.emails.find(message => message.subject.startsWith("New booking")).to].flat()).toEqual([item.value]);
        } else throw new Error(`Missing INTERNAL consumer assertion: ${consumer.kind}`);
        checked.push({ path: item.path, ...consumer });
      }
      return checked;
    };
    if (!pending.cases.some(item => usage(item) === "RENDERED" && !["object", "array"].includes(item.field.type))) {
      await evidence(page, testInfo, { type: schema.name, internal: await verifyInternal(), unused: unusedResults });
      return;
    }
    const endpoint = binding.resource ? `/api/content/${binding.resource}${schema.name === "upgradeLink" ? `?slug=${pending.document.slug.current}` : ""}` : `${binding.endpoint}${schema.name === "coupon" ? `?code=${pending.document.code}&packageTitle=${encodeURIComponent((await cms(request, `/api/admin/content/documents/${pending.document.eligiblePackages[0]._ref}`)).document.title)}` : ""}`;
    let body, publicData;
    const anchor = pending.cases.find(item => typeof item.value === "string" && usage(item) === "RENDERED");
    await expect.poll(async () => {
      const publicResponse = await request.get(endpoint);
      expect(publicResponse.ok(), await publicResponse.text()).toBe(true);
      body = await publicResponse.json();
      publicData = binding.resource ? body.data : schema.name === "bookingSettings" ? body.settings : body.coupon;
      if (["benchmark", "tool", "package", "review"].includes(schema.name)) publicData = publicData.find(document => document._id === entry._id || schema.name === "benchmark" && document.title === pending.document.title || schema.name === "review" && document.alt === pending.document.alt);
      return fieldContract.get(publicData, schema.name === "faqSection" ? anchor.path.replace(/^questions/, "") : anchor.path);
    }, { timeout: 75000, intervals: [100, 500, 1000], message: `${schema.name} published markers must reach the public API after its cache expires` }).toEqual(anchor.value);
    const publishedArtifact = testInfo.outputPath("published-content.json");
    await fs.writeFile(publishedArtifact, JSON.stringify({ stored: stored.document, response: body }, null, 2));
    await testInfo.attach("published-content", { path: publishedArtifact, contentType: "application/json" });
    expect(publicData).toBeTruthy();
    if (binding.page) {
      await page.goto(binding.page === "/" ? "/#services" : binding.page);
      if (schema.name === "faqSection") await page.getByRole("button").filter({ hasText: pending.document.questions[0].question }).first().click();
      if (["proReviewsCarousel", "services", "howItWorks", "supportedGames"].includes(schema.name)) await page.locator(schema.name === "proReviewsCarousel" ? ".ri-reviews-heading" : schema.name === "services" ? "#services" : schema.name === "howItWorks" ? "#how-it-works" : "#supported-games").scrollIntoViewIfNeeded();
      if (schema.name === "supportedGames") await page.getByRole("button", { name: "View All Games", exact: true }).click();
    }
    const renderedBody = () => page.evaluate(() => document.body.innerText + [...document.querySelectorAll("body [href],body [src],body [alt],body [placeholder]")].map(node => ["href", "src", "alt", "placeholder"].map(name => node.getAttribute(name) || "").join(" ")).join(" "));
    let renderedPages = "";
    if (schema.name === "services") {
      await expect(page.getByRole("button", { name: "Next benchmark page" })).toBeVisible();
      renderedPages += await renderedBody();
      while (await page.getByRole("button", { name: "Next benchmark page" }).isEnabled()) {
        await page.getByRole("button", { name: "Next benchmark page" }).click();
        renderedPages += await renderedBody();
      }
    }
    const checked = [];
    for (const item of pending.cases) {
      const pattern = fieldContract.patternPath(item.path);
      if (usage(item) !== "RENDERED") continue;
      if (["object", "array"].includes(item.field.type)) continue;
      let actual = fieldContract.get(publicData, item.path);
      if (schema.name === "faqSection") actual = fieldContract.get(publicData, item.path.replace(/^questions/, ""));
      if (schema.name === "tool" && item.path === "icon") actual = publicData.iconUrl;
      if (schema.name === "upgradeLink" && item.path === "targetPackage") actual = publicData.targetPackage;
      if (schema.name === "upgradeLink" && item.path === "slug") {
        expect(body.data.title).toBe(pending.document.title);
        const previous = await request.get(`/api/content/upgrade-link?slug=${original.document.slug.current}`);
        expect(previous.ok()).toBe(true);
        expect((await previous.json()).data, "The former slug must stop resolving after publishing its replacement").toBeNull();
        checked.push(item.path); continue;
      }
      if (item.path.endsWith("sortOrder")) {
        const peerId = `${entry._id}-order-peer`;
        const ordered = (await (await request.get(endpoint)).json()).data;
        expect(ordered.some(row => row.title === `${marker}-order-peer`)).toBe(true);
        expect(ordered.some(row => row.title === pending.document.title)).toBe(true);
        expect(ordered.findIndex(row => row.title === `${marker}-order-peer`)).toBeLessThan(ordered.findIndex(row => row.title === pending.document.title));
        await page.goto("/admin/content");
        await publishDraft(page, schema, stored, { ...stored.document, sortOrder: item.value - 2 });
        const reordered = (await (await request.get(endpoint)).json()).data;
        expect(reordered.findIndex(row => row.title === pending.document.title)).toBeLessThan(reordered.findIndex(row => row.title === `${marker}-order-peer`));
        if (binding.page) await page.goto(binding.page);
        checked.push(item.path); continue;
      }
      if (schema.name === "coupon" && item.path.startsWith("eligiblePackages")) {
        const invalid = await request.get(endpoint.replace(/packageTitle=[^&]*/, "packageTitle=not-an-eligible-package"));
        expect((await invalid.json()).error).toBe("This coupon is not valid for the selected package.");
      } else if (item.field.type === "reference") {
        const target = await cms(request, `/api/admin/content/documents/${item.value._ref}`);
        expect(JSON.stringify(actual)).toContain(target.document.title);
      } else if (item.field.type === "image" || item.field.type === "file") expect(JSON.stringify(actual)).toContain(item.value.asset._ref.split("-")[1]);
      else if (schema.name === "coupon" && !["code", "discountType", "discountAmount", "canCombineWithReferral"].includes(item.path)) {
        const latest = await cms(request, `/api/admin/content/documents/${entry._id}`);
        let changed, error;
        if (item.path === "discountPercent") {
          changed = { discountType: "percent" };
        } else if (item.path === "isActive") { changed = { isActive: false }; error = "This coupon is not active."; }
        else if (item.path === "validFrom") { changed = { validFrom: "2099-01-01T00:00:00.000Z" }; error = "This coupon is not valid yet."; }
        else if (item.path === "validTo") { changed = { validTo: "2020-01-01T00:00:00.000Z" }; error = "This coupon has expired."; }
        else if (item.path === "maxUses") {
          await prepareFieldFixture(request, baseURL, { ...latest.document, timesUsed: 1 });
          changed = { maxUses: 1 }; error = "This coupon has reached its maximum number of uses.";
        } else throw new Error(`No public behavior assertion for coupon.${item.path}`);
        await page.goto("/admin/content");
        const before = await cms(request, `/api/admin/content/documents/${entry._id}`);
        await publishDraft(page, schema, before, { ...before.document, ...changed });
        const result = await (await request.get(endpoint)).json();
        if (error) expect(result.error).toBe(error);
        else expect(result.coupon.discountPercent).toBe(item.value);
        const after = await cms(request, `/api/admin/content/documents/${entry._id}`);
        await publishDraft(page, schema, after, latest.document);
      } else if (schema.name === "tool" && item.path === "downloadUrl") {
        await page.goto("/admin/content");
        const latest = await cms(request, `/api/admin/content/documents/${entry._id}`);
        await publishDraft(page, schema, latest, { ...latest.document, downloadMode: "external" });
        const external = (await (await request.get(endpoint)).json()).data.find(row => row._id === entry._id);
        expect(external.downloadUrl).toBe(item.value);
        await page.goto(binding.page);
        await page.getByRole("article").filter({ hasText: pending.document.title }).getByRole("button", { name: "Download", exact: true }).click();
        const opened = page.waitForEvent("popup");
        await page.getByRole("dialog").getByRole("button", { name: "Download", exact: true }).click();
        const popup = await opened;
        await expect.poll(() => popup.url()).toBe(item.value);
        await popup.close();
      } else if (binding.page && typeof item.token === "string" && !(binding.api || []).some(path => pattern === path || pattern.startsWith(`${path}[`)) && !["date", "datetime", "number"].includes(item.field.type) && !item.field.options?.list && !item.listed) {
        await expect.poll(async () => (renderedPages + await renderedBody()).toLowerCase().replace(/\s+/g, ""), { message: `${schema.name}.${item.path} was published but never rendered` }).toContain(item.token.toLowerCase().replace(/\s+/g, ""));
      } else expect(actual, `${schema.name}.${item.path} disappeared from the public API`).toEqual(item.value);
      checked.push(item.path);
    }
    await evidence(page, testInfo, { type: schema.name, marker, rendered: checked, internal: await verifyInternal(), unused: unusedResults, endpoint, publicData });
  });
}

for (const fixture of [
  { name: "refund/warranty FAQ", type: "faqSection", path: "questions", group: "Questions", key: "question", label: "Question", match: "Refund and warranty?", next: "Money-back and warranty?", fields: [{ name: "answer", label: "Answer", value: "Submitted new answer café 日本語" }], seed: { questions: [{ _key: "ordinary", question: "Fixture ordinary question?", answer: "Fixture ordinary answer" }] } },
  { name: "Overwatch benchmark", type: "services", path: "benchPages[0].games", group: "Games (3 per page recommended)", key: "gameTitle", label: "Game Title", match: "Overwatch 2", next: "Overwatch", fields: [{ name: "beforeFps", label: "Before FPS", value: 123 }, { name: "afterFps", label: "Optimized FPS", value: 234 }, { name: "metricLabel", label: "Avg/low Badge", value: "Submitted new metric" }, { name: "gpu", label: "GPU", value: "Submitted new GPU" }, { name: "cpu", label: "CPU", value: "Submitted new CPU" }, { name: "ram", label: "RAM", value: "Submitted new RAM" }], seed: { benchPages: [{ _key: "bench", games: [{ _key: "ordinary", gameTitle: "Fixture ordinary game", beforeFps: 100, afterFps: 150 }] }] } },
  ...["CPU", "GPU"].map(label => ({ name: `${label} hardware stat`, type: "about", path: "recordDetails", group: "Record Details", key: "label", label: "Label", match: label, next: label === "CPU" ? "GPU" : "CPU", fields: [{ name: "value", label: "Value", value: `Submitted new ${label} café 日本語` }], seed: { recordDetails: [{ _key: "ordinary", label: "RANK", value: "#31" }] } })),
]) {
  test(`ROO-66 a new ${fixture.name} keeps submitted fields and its override key`, async ({ page, request, baseURL }, testInfo) => {
    const schema = CONTENT_TYPES.find(type => type.name === fixture.type);
    const list = await cms(request, `/api/admin/content/documents?type=${fixture.type}`);
    const id = schema.fixedId || list.documents[0]._id;
    const initial = await cms(request, `/api/admin/content/documents/${id}`);
    await prepareFieldFixture(request, baseURL, { ...initial.document, ...fixture.seed });
    await login(page); await choose(page, schema.title); await expandEditor(page);
    const group = page.getByRole("group", { name: fixture.group, exact: true });
    await group.getByRole("button", { name: "Add item", exact: true }).click();
    for (const field of fixture.fields) await group.getByLabel(field.label, { exact: true }).last().fill(String(field.value));
    const key = group.getByLabel(fixture.label, { exact: true }).last();
    await key.fill(fixture.match);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    let stored = await cms(request, `/api/admin/content/documents/${id}`);
    const created = fieldContract.get(stored.document, fixture.path)[1];
    expect(created[fixture.key]).toBe(fixture.match);
    for (const field of fixture.fields) expect(created[field.name], `New ${fixture.name} must not lose ${field.name}`).toBe(field.value);
    expect(fieldContract.get(stored.document, fixture.path)[0]).toEqual(fieldContract.get(fixture.seed, fixture.path)[0]);
    await expandEditor(page);
    await expect(key).toBeEditable();
    for (const field of fixture.fields) await expectUnused(page, fixture.type, `${fixture.path}[1].${field.name}`);
    const resource = fieldContract.bindings[fixture.type].resource;
    let publicData;
    await expect.poll(async () => {
      const response = await request.get(`/api/content/${resource}`);
      expect(response.ok(), await response.text()).toBe(true);
      publicData = (await response.json()).data;
      return fixture.type === "faqSection" ? publicData.length : fieldContract.get(publicData, `${fixture.path}[1].${fixture.key}`);
    }, { timeout: 75000, intervals: [100, 500, 1000] }).toBe(fixture.type === "faqSection" ? 2 : fixture.match);
    const publicPage = await page.context().newPage();
    try {
      await publicPage.goto(fixture.type === "faqSection" ? "/faq" : "/");
      if (fixture.type === "faqSection") {
        expect(publicData[1]).toMatchObject({ question: MONEY_BACK_FAQ_QUESTION, answer: MONEY_BACK_FAQ_ANSWER });
        await publicPage.getByRole("button").filter({ hasText: MONEY_BACK_FAQ_QUESTION }).click();
        await expect(publicPage.getByText(MONEY_BACK_FAQ_ANSWER, { exact: true })).toBeVisible();
        expect(publicData.every(row => row.question?.trim())).toBe(true);
      } else if (fixture.type === "services") {
        const benchmark = publicPage.getByRole("article", { name: "Overwatch 2 benchmark", exact: true });
        await expect(benchmark).toHaveCount(1);
        await expect(benchmark.getByText("200", { exact: true })).toBeVisible();
        await expect(benchmark.getByText("450", { exact: true })).toBeVisible();
        await expect(benchmark).toContainText("RTX 4080");
        await expect(benchmark).not.toContainText("Submitted new");
      } else {
        expect(publicData.recordDetails[1]).toMatchObject({ label: fixture.match, value: fixture.fields[0].value });
        const summary = publicPage.locator(".ri-proof-summary");
        await expect(summary.locator("dt")).toHaveText(["RANK"]);
        await expect(summary.locator("dd")).toHaveText(["#31"]);
      }
      await publicPage.screenshot({ path: testInfo.outputPath("public-override.png"), fullPage: true });
    } finally { await publicPage.close(); }
    await key.fill(fixture.next);
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    stored = await cms(request, `/api/admin/content/documents/${id}`);
    expect(fieldContract.get(stored.document, `${fixture.path}[1].${fixture.key}`)).toBe(fixture.next);
    await expandEditor(page);
    for (const field of fixture.fields) {
      expect(fieldContract.get(stored.document, `${fixture.path}[1].${field.name}`)).toBe(field.value);
      await expectUnused(page, fixture.type, `${fixture.path}[1].${field.name}`);
    }
    const ordinaryKey = `Fixture ordinary key ${randomUUID()}`;
    await key.fill(ordinaryKey);
    const dependent = group.getByLabel(fixture.fields[0].label, { exact: true }).last();
    await expect(dependent).toBeEditable();
    const ordinaryValue = typeof fixture.fields[0].value === "number" ? 777 : `Published ordinary value ${randomUUID()}`;
    await dependent.fill(String(ordinaryValue));
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    stored = await cms(request, `/api/admin/content/documents/${id}`);
    expect(fieldContract.get(stored.document, `${fixture.path}[1].${fixture.key}`)).toBe(ordinaryKey);
    expect(fieldContract.get(stored.document, `${fixture.path}[1].${fixture.fields[0].name}`)).toBe(ordinaryValue);
    await expect.poll(async () => {
      const response = await request.get(`/api/content/${resource}`);
      const data = (await response.json()).data;
      return fixture.type === "faqSection" ? data[1].question : fieldContract.get(data, `${fixture.path}[1].${fixture.key}`);
    }, { timeout: 75000, intervals: [100, 500, 1000] }).toBe(ordinaryKey);
    await expandEditor(page);
    await evidence(page, testInfo, { created, publicData, ordinaryKey, ordinaryValue, finalRow: fieldContract.get(stored.document, fixture.path)[1] });
  });
}

for (const matchingSelector of [false, true]) {
  test(`ROO-66 two-tab reconciliation retains A's draft after B ${matchingSelector ? "publishes the same selector with a different preserved answer" : "changes the original ordinary answer"}`, async ({ page, context, browser, request, baseURL }, testInfo) => {
    const id = "faq";
    const initial = await cms(request, `/api/admin/content/documents/${id}`);
    await prepareFieldFixture(request, baseURL, { ...initial.document, questions: [{ _key: "ordinary", question: "Fixture ordinary question?", answer: "Original ordinary answer café" }] });
    const original = await cms(request, `/api/admin/content/documents/${id}`);
    await login(page); await choose(page, "FAQ"); await expandEditor(page);
    const selector = "Refund and warranty?";
    await page.getByLabel("Question", { exact: true }).fill(selector);
    await page.clock.install();
    const pending = await hold(page, "**/api/admin/content/publish", { forward: false });
    const second = await browser.newContext({ baseURL, javaScriptEnabled: true });
    const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
    const marker = await (await request.get(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/fixture`)).json();
    await guardBrowserContext(second, marker.origins);
    await second.addCookies(await context.cookies());
    const tabB = await second.newPage();
    try {
      await page.getByRole("button", { name: "Publish", exact: true }).click(); await pending.arrived;
      await tabB.goto("/admin/content"); await choose(tabB, "FAQ"); await expandEditor(tabB);
      await tabB.getByLabel("Answer", { exact: true }).fill("B's concurrent ordinary answer 日本語");
      await tabB.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(tabB.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
      if (matchingSelector) {
        await expandEditor(tabB);
        await tabB.getByLabel("Question", { exact: true }).fill(selector);
        await tabB.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(tabB.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
      }
      const stored = await cms(request, `/api/admin/content/documents/${id}`);
      expect(stored.document.questions[0].answer).toBe("B's concurrent ordinary answer 日本語");
      expect(stored.document.questions[0].question).toBe(matchingSelector ? selector : "Fixture ordinary question?");
      await page.clock.fastForward(31000);
      await expect(page.getByRole("alert").filter({ hasText: /not published.*retry/i })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toHaveCount(0);
      const draft = await page.evaluate(id => JSON.parse(localStorage.getItem(`roo-content-draft:v1:doc:${id}`)), id);
      expect(draft.baseRevision).toBe(original.revision);
      expect(draft.document.questions[0]).toMatchObject({ question: selector, answer: original.document.questions[0].answer });
      await evidence(page, testInfo, { matchingSelector, stored, draft });
    } finally { await pending.release(); await second.close(); }
  });
}

for (const operation of ["delete canonical", "create extra"]) {
  test(`ROO-66 a stale editor cannot ${operation} FAQ through a publish command`, async ({ page, request, baseURL }, testInfo) => {
    const original = await cms(request, "/api/admin/content/documents/faq");
    const legacy = await cms(request, "/api/admin/content/documents/fixture-faq-legacy");
    const command = operation === "delete canonical"
      ? { operation: "delete", type: "faqSection", documentId: "faq", expectedRevision: original.revision }
      : { operation: "create", type: "faqSection", documentId: "fixture-extra-faq", createIntentId: randomUUID(), document: { _id: "fixture-extra-faq", questions: [] } };
    const response = await request.post("/api/admin/content/publish", { headers: { "x-admin-key": ADMIN_KEY }, data: command });
    try {
      expect(response.status(), await response.text()).toBe(409);
      expect((await response.json()).error).toMatch(/canonical FAQ/i);
      expect(await cms(request, "/api/admin/content/documents/faq")).toEqual(original);
      expect(await cms(request, "/api/admin/content/documents/fixture-faq-legacy")).toEqual(legacy);
      await login(page); await choose(page, "FAQ");
      await evidence(page, testInfo, { operation, status: response.status(), original, legacy });
    } finally {
      if (operation === "delete canonical" && response.ok()) expect((await request.post(`http://127.0.0.1:${Number(new URL(baseURL).port) + 6}/faq-create-fixture/legacy`)).ok()).toBe(true);
    }
  });
}

for (const entryPoint of ["editor", "publish command"]) {
  test(`ROO-66 ${entryPoint} protects an unused hardware row and permits removing rendered rows`, async ({ page, request, baseURL }, testInfo) => {
    const id = "tooling-about";
    const initial = await cms(request, `/api/admin/content/documents/${id}`);
    await prepareFieldFixture(request, baseURL, { ...initial.document, recordDetails: [
      { _key: "cpu", label: "CPU", value: "Legacy protected CPU café", sub: "Legacy protected sub 日本語" },
      { _key: "score", label: "SCORE", value: "12345" },
    ] });
    const original = await cms(request, `/api/admin/content/documents/${id}`);
    await login(page); await choose(page, "About Section"); await expandEditor(page);
    if (entryPoint === "editor") {
      await expect(page.getByLabel("Label", { exact: true }).first()).toBeEditable();
      const remove = page.getByRole("button", { name: "CPU", exact: true }).locator("..").getByRole("button", { name: "Remove item", exact: true });
      await expect(remove).toBeDisabled();
      const description = await remove.getAttribute("aria-describedby");
      expect(description).toBeTruthy();
      await expect(page.locator(`[id="${description}"]`)).toHaveText(UNUSED_NOTE);
      const ordinary = page.getByRole("button", { name: "SCORE", exact: true }).locator("..").getByRole("button", { name: "Remove item", exact: true });
      await expect(ordinary).toBeEnabled(); await ordinary.click();
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
      expect((await cms(request, `/api/admin/content/documents/${id}`)).document.recordDetails).toEqual([original.document.recordDetails[0]]);
    } else {
      for (const document of [{ ...original.document, recordDetails: [original.document.recordDetails[1]] }, { ...original.document, recordDetails: undefined }]) {
        const response = await request.post("/api/admin/content/publish", { headers: { "x-admin-key": ADMIN_KEY }, data: { operation: "replace", type: "about", documentId: id, expectedRevision: original.revision, document } });
        expect(response.status(), await response.text()).toBe(409);
        expect((await response.json()).error).toContain(UNUSED_NOTE);
        expect(await cms(request, `/api/admin/content/documents/${id}`)).toEqual(original);
      }
      await cms(request, "/api/admin/content/publish", { operation: "replace", type: "about", documentId: id, expectedRevision: original.revision, document: { ...original.document, recordDetails: [original.document.recordDetails[0]] } });
      expect((await cms(request, `/api/admin/content/documents/${id}`)).document.recordDetails).toEqual([original.document.recordDetails[0]]);
    }
    await evidence(page, testInfo, { entryPoint, original });
  });
}

test("ROO-66 protected legacy rows without item keys cannot be erased by shifting ordinary rows", async ({ page, request, baseURL }, testInfo) => {
  const id = "tooling-about";
  const initial = await cms(request, `/api/admin/content/documents/${id}`);
  await prepareFieldFixture(request, baseURL, { ...initial.document, recordDetails: [
    { label: "CPU", value: "Legacy unkeyed CPU", sub: "Legacy unkeyed sub" },
    { label: "SCORE", value: "12345" },
  ] });
  const original = await cms(request, `/api/admin/content/documents/${id}`);
  const response = await request.post("/api/admin/content/publish", { headers: { "x-admin-key": ADMIN_KEY }, data: {
    operation: "replace", type: "about", documentId: id, expectedRevision: original.revision,
    document: { ...original.document, recordDetails: [original.document.recordDetails[1]] },
  } });
  expect(response.status(), await response.text()).toBe(409);
  expect(await cms(request, `/api/admin/content/documents/${id}`)).toEqual(original);
  await cms(request, "/api/admin/content/publish", { operation: "replace", type: "about", documentId: id, expectedRevision: original.revision, document: { ...original.document, recordDetails: [original.document.recordDetails[0]] } });
  expect((await cms(request, `/api/admin/content/documents/${id}`)).document.recordDetails).toEqual([original.document.recordDetails[0]]);
  await login(page); await choose(page, "About Section"); await expandEditor(page);
  await expect(page.getByRole("button", { name: "CPU", exact: true }).locator("..").getByRole("button", { name: "Remove item", exact: true })).toBeDisabled();
  await evidence(page, testInfo, { original, status: response.status() });
});

for (const variant of ["standard", "ambassador"]) {
  test(`ROO-66 ${variant} cards freeze only unused variant fields and update immediately on a style switch`, async ({ page, request, baseURL }, testInfo) => {
    const schema = CONTENT_TYPES.find(type => type.name === "meetTheTeam");
    const id = "tooling-meetTheTeam";
    const initial = await cms(request, `/api/admin/content/documents/${id}`);
    const card = { _key: "member", name: `Variant fixture ${variant}`, title: "Fixture role", bio: "Fixture biography", initials: "VF", tags: ["Legacy fixture tag"], platformBadge: "Legacy fixture platform", ctaLabel: "Legacy fixture CTA", ctaUrl: `${baseURL}/cms-marker/legacy-variant-cta` };
    await prepareFieldFixture(request, baseURL, { ...initial.document, showFounder: false, sections: [{ _key: "section", title: "Fixture section", variant, cards: [card] }] });
    const original = await cms(request, `/api/admin/content/documents/${id}`);
    await login(page); await choose(page, schema.title); await expandEditor(page);
    const unused = variant === "standard" ? ["platformBadge", "ctaLabel", "ctaUrl"] : ["tags"];
    for (const field of unused) await expectUnused(page, schema.name, `sections[0].cards[0].${field}`);
    const document = structuredClone(original.document);
    document.sections[0].cards[0].name += " published";
    for (const field of unused) document.sections[0].cards[0][field] = field === "tags" ? ["Attempted unused tag"] : field === "ctaUrl" ? `${baseURL}/cms-marker/attempted-variant-cta` : "Attempted unused value";
    await publishDraft(page, schema, original, document);
    let stored = await cms(request, `/api/admin/content/documents/${id}`);
    for (const field of unused) expect(stored.document.sections[0].cards[0][field]).toEqual(card[field]);
    await expandEditor(page);
    const style = page.getByLabel("Card Style", { exact: true });
    await expect(style).toBeEnabled();
    const nextVariant = variant === "standard" ? "ambassador" : "standard";
    await style.selectOption(nextVariant);
    const cards = page.getByRole("group", { name: "Cards", exact: true });
    const token = `variant-${randomUUID()}`;
    if (nextVariant === "ambassador") {
      for (const [label, value] of [["Platform Badge", `${token}-platform`], ["CTA Label", `${token}-cta`], ["CTA URL", `${baseURL}/cms-marker/${token}`]]) {
        await expect(cards.getByLabel(label, { exact: true })).toBeEditable();
        await cards.getByLabel(label, { exact: true }).fill(value);
      }
      await expectUnused(page, schema.name, "sections[0].cards[0].tags");
    } else {
      const tags = cards.getByRole("group", { name: "Tags", exact: true });
      await expect(tags.getByRole("textbox").first()).toBeEditable();
      await tags.getByRole("textbox").first().fill(`${token}-tag`);
      for (const field of ["platformBadge", "ctaLabel", "ctaUrl"]) await expectUnused(page, schema.name, `sections[0].cards[0].${field}`);
    }
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    stored = await cms(request, `/api/admin/content/documents/${id}`);
    expect(stored.document.sections[0].variant).toBe(nextVariant);
    const publicPage = await page.context().newPage();
    try {
      await publicPage.goto("/meet-the-team");
      if (nextVariant === "ambassador") {
        await expect(publicPage.getByText(`${token}-platform`, { exact: true })).toBeVisible();
        await expect(publicPage.getByRole("link", { name: `${token}-cta`, exact: true })).toHaveAttribute("href", `${baseURL}/cms-marker/${token}`);
        await expect(publicPage.getByText(card.tags[0], { exact: true })).toHaveCount(0);
      } else {
        await expect(publicPage.getByText(`${token}-tag`, { exact: true })).toBeVisible();
        await expect(publicPage.getByText(card.platformBadge, { exact: true })).toHaveCount(0);
        await expect(publicPage.getByRole("link", { name: card.ctaLabel, exact: true })).toHaveCount(0);
      }
      await publicPage.screenshot({ path: testInfo.outputPath("public-variant.png"), fullPage: true });
    } finally { await publicPage.close(); }
    await evidence(page, testInfo, { variant, nextVariant, unused, stored });
  });
}

test("ROO-66 a missing legacy unused value never blanks its submitted replacement", async ({ page, request, baseURL }, testInfo) => {
  const id = "tooling-about";
  const current = await cms(request, `/api/admin/content/documents/${id}`);
  await prepareFieldFixture(request, baseURL, { ...current.document, recordDetails: [{ _key: "cpu", label: "CPU", value: "Stored CPU value" }] });
  const original = await cms(request, `/api/admin/content/documents/${id}`);
  const document = structuredClone(original.document);
  document.recordDetails[0].sub = "First stored unused subtext café 日本語";
  document.recordDetails[0].value = "Attempted overwrite of stored value";
  await cms(request, "/api/admin/content/publish", { operation: "replace", type: "about", documentId: id, expectedRevision: original.revision, document });
  const stored = await cms(request, `/api/admin/content/documents/${id}`);
  expect(stored.document.recordDetails[0]).toEqual({ _key: "cpu", label: "CPU", value: "Stored CPU value", sub: document.recordDetails[0].sub });
  await login(page); await choose(page, "About Section"); await expandEditor(page);
  await expectUnused(page, "about", "recordDetails[0].sub");
  await expectUnused(page, "about", "recordDetails[0].value");
  await expect(page.getByLabel("Label", { exact: true })).toBeEditable();
  await evidence(page, testInfo, { original: original.document.recordDetails[0], stored: stored.document.recordDetails[0] });
});

test("ROO-66 override keys stay editable and dependent fields preserve legacy values", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const block = text => [{ _key: "legacy-block", _type: "block", style: "normal", markDefs: [], children: [{ _key: "legacy-span", _type: "span", text, marks: [] }] }];
  const fixtures = [
    { type: "about", seed: { recordDetails: [{ _key: "cpu", label: "CPU", value: "Legacy CPU café", sub: "Legacy CPU detail" }, { _key: "gpu", label: "GPU", value: "Legacy GPU 日本語", sub: "Legacy GPU detail" }] }, paths: ["recordDetails[0].value", "recordDetails[0].sub", "recordDetails[1].value", "recordDetails[1].sub"], keys: [["recordDetails[0].label", "GPU"], ["recordDetails[1].label", "CPU"]], used: "recordTitle", value: "Published fixture proof" },
    { type: "package", seed: { title: "XOC / Extreme Overclocking", description: "Legacy package café", checkedBullets: ["Legacy checked"], uncheckedBullets: ["Legacy unchecked"] }, paths: ["description", "checkedBullets", "uncheckedBullets"], used: "price", value: "$321.67" },
    { type: "faqSection", seed: { questions: [
      { _key: "money-back", question: "Refund and warranty?", answer: "Legacy warranty café" },
      { _key: "free-retune", question: "Free reoptimization?", answer: "Legacy retune 日本語" },
      { _key: "ordinary", question: "Fixture ordinary question?", answer: "Fixture ordinary answer" },
    ] }, paths: ["questions[0].answer", "questions[1].answer"], keys: [["questions[0].question", `Money-back and warranty? ${randomUUID()}`], ["questions[1].question", `Free reoptimization? ${randomUUID()}`]], used: "questions[2].answer", value: "Published ordinary answer" },
    { type: "terms", seed: { sections: [
      { _key: "refunds", heading: "Payments and refunds", content: block("Legacy refund café") },
      { _key: "reschedule", heading: "Rescheduling policy", content: block("Legacy cancellation 日本語") },
    ] }, paths: ["sections[0].content", "sections[1].content"], keys: [["sections[1].heading", `Cancellations and rescheduling ${randomUUID()}`]], used: "title", value: "Published fixture terms" },
    { type: "meetTheTeam", seed: { sections: [{ _key: "team", title: "Fixture team", variant: "standard", cards: [
      { _key: "wanted", name: "Wanted", bio: "Legacy Wanted café" }, { _key: "candi", name: "Candi", bio: "Legacy Candi 日本語" },
    ] }] }, paths: ["sections[0].cards[0].bio", "sections[0].cards[1].bio"], used: "heroTitle", value: "Published fixture team" },
    { type: "services", seed: { benchPages: [{ _key: "bench", games: [{ _key: "ovw", gameTitle: " Overwatch 2 ", beforeFps: 123, afterFps: 234, metricLabel: "Legacy metric", gpu: "Legacy GPU", cpu: "Legacy CPU", ram: "Legacy RAM" }] }] }, keys: [["benchPages[0].games[0].gameTitle", "Overwatch"]], paths: ["benchPages[0].games[0].beforeFps", "benchPages[0].games[0].afterFps", "benchPages[0].games[0].metricLabel", "benchPages[0].games[0].gpu", "benchPages[0].games[0].cpu", "benchPages[0].games[0].ram", "benchPages[0].games[0].gameLogo"], used: "benchBeforeLabel", value: "Published fixture before" },
  ];
  const results = [];
  await login(page);
  for (const item of fixtures) {
    const schema = CONTENT_TYPES.find(type => type.name === item.type);
    const list = await cms(request, `/api/admin/content/documents?type=${item.type}`);
    const id = schema.fixedId || (item.type === "package" ? list.documents.find(document => document.preview.title === "Performance Vertex Max")._id : list.documents[0]._id);
    const current = await cms(request, `/api/admin/content/documents/${id}`);
    await prepareFieldFixture(request, baseURL, { ...current.document, ...item.seed });
    const original = await cms(request, `/api/admin/content/documents/${id}`);
    await page.goto("/admin/content");
    await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
    await choose(page, schema.title);
    if (!schema.singleton) await page.getByRole("region", { name: `${schema.title} list`, exact: true }).getByRole("button").filter({ hasText: original.document[schema.preview.title] }).first().click();
    await expandEditor(page);
    for (const fieldPath of item.paths) await expectUnused(page, item.type, fieldPath);
    for (const [fieldPath] of item.keys || []) {
      const definition = fieldContract.schemaFields(schema.fields).find(field => field.path === fieldContract.patternPath(fieldPath)).field;
      const index = Number([...fieldPath.matchAll(/\[(\d+)\]/g)].at(-1)?.[1] || 0);
      await expect(page.getByLabel(definition.title, { exact: true }).nth(index)).toBeEditable();
      expect(await page.locator(`[id="content-help-${encodeURIComponent(fieldPath)}"]`).allTextContents()).not.toContain(UNUSED_NOTE);
    }
    const pending = structuredClone(original.document);
    const set = (path, value) => { const keys = path.replace(/\[(\d+)\]/g, ".$1").split("."); const last = keys.pop(); const parent = keys.reduce((object, key) => object[key], pending); if (value === undefined) delete parent[last]; else parent[last] = value; };
    set(item.used, item.value);
    for (const [fieldPath, value] of item.keys || []) set(fieldPath, value);
    for (const fieldPath of item.paths) set(fieldPath, undefined);
    await publishDraft(page, schema, original, pending);
    const stored = await cms(request, `/api/admin/content/documents/${id}`);
    for (const fieldPath of item.paths) expect(fieldContract.get(stored.document, fieldPath)).toEqual(fieldContract.get(original.document, fieldPath));
    expect(fieldContract.get(stored.document, item.used)).toBe(item.value);
    await expandEditor(page);
    for (const [fieldPath, value] of item.keys || []) {
      expect(fieldContract.get(stored.document, fieldPath)).toBe(value);
      await expect(page.getByRole("button", { name: value, exact: true })).toBeVisible();
    }
    results.push({ type: item.type, preserved: item.paths, keys: item.keys, published: item.used });
  }
  await evidence(page, testInfo, { conditionalOverrides: results });
});
});

const UNUSED_NOTE = "Not shown on the site yet. Edits here won't appear.";
const unusedFields = [
  { type: "Packages Section", label: "Heading" },
  { type: "FAQ Settings", label: "Heading" },
  { type: "Services Section", label: "Heading" },
  { type: "Supported Games Section", label: "Title" },
  { type: "Pro Reviews Carousel", label: "Section Title" },
  { type: "Hero Section", label: "Tagline" },
  { type: "Hero Section", label: "CTA Note Icon" },
  { type: "Hero Section", label: "Bottom Bullet Points", array: true },
];

for (const field of unusedFields) {
  test(`ROO-66 ${field.type} ${field.label} is visibly and accessibly read-only`, async ({ page }, testInfo) => {
    await login(page); await choose(page, field.type);
    const input = field.array ? page.getByRole("group", { name: field.label, exact: true }) : page.getByLabel(field.label, { exact: true });
    await expect(input).toBeVisible();
    if (field.type !== "Hero Section") await expect(page.getByRole("region", { name: "Editor", exact: true }).getByRole("heading", { name: await input.inputValue(), exact: true })).toBeVisible();
    const describedBy = await input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const note = page.locator(`[id="${describedBy}"]`);
    await expect(note).toHaveText(UNUSED_NOTE);
    await expect(note).toBeVisible();
    if (field.array) {
      await expect(input).toHaveAttribute("aria-disabled", "true");
      await expect(input.getByRole("button")).toHaveCount(0);
    }
    const controls = field.array ? await input.getByRole("textbox").all() : [input];
    expect(controls.length).toBeGreaterThan(0);
    const values = [];
    for (const control of controls) {
      await expect(control).not.toBeEditable();
      await expect(control).toHaveAttribute("readonly", "");
      const value = await control.inputValue();
      await control.focus(); await control.press("End"); await control.pressSequentially("Attempted edit");
      await expect(control).toHaveValue(value);
      values.push(value);
    }
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    await input.scrollIntoViewIfNeeded();
    await evidence(page, testInfo, { field, describedBy, note: await note.textContent(), values });
  });
}

test("ROO-66 FAQ only opens the canonical document and offers no extra creation", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const legacy = await cms(request, "/api/admin/content/documents/fixture-faq-legacy");
  const canonical = await cms(request, "/api/admin/content/documents/faq");
  await page.route("**/api/admin/content/documents?type=faqSection", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.documents.sort((a, b) => a._id === "faq" ? 1 : b._id === "faq" ? -1 : 0);
    await route.fulfill({ response, json: body });
  });
  await login(page); await choose(page, "FAQ");
  await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  await expect(page.getByText("Only the canonical FAQ document is shown on the site. Additional FAQ documents cannot be created here.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Questions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: canonical.document.questions[0].question, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Legacy extra FAQ question", exact: true })).toHaveCount(0);
  expect(await cms(request, "/api/admin/content/documents/fixture-faq-legacy")).toEqual(legacy);
  await evidence(page, testInfo, { canonicalId: canonical.document._id, extraDocumentUnchanged: legacy.document });
});

test("ROO-66 a missing canonical FAQ starts a canonical document without touching extras", async ({ page, request, baseURL }, testInfo) => {
  const control = `http://127.0.0.1:${Number(new URL(baseURL).port) + 6}`;
  const legacy = await cms(request, "/api/admin/content/documents/fixture-faq-legacy");
  expect((await request.post(`${control}/faq-create-fixture/legacy`)).ok()).toBe(true);
  try {
    await login(page); await choose(page, "FAQ");
    await expect(page.getByRole("group", { name: "Questions", exact: true })).toBeVisible();
    await expect(page.getByText("Not published yet", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
    await page.getByRole("group", { name: "Questions", exact: true }).getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByLabel("Question", { exact: true }).fill("Canonical replacement question");
    await page.getByLabel("Answer", { exact: true }).fill("Canonical replacement answer");
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    const stored = await cms(request, "/api/admin/content/documents/faq");
    expect(stored.document.questions[0].question).toBe("Canonical replacement question");
    expect(await cms(request, "/api/admin/content/documents/fixture-faq-legacy")).toEqual(legacy);
    await evidence(page, testInfo, { documentId: stored.document._id, questions: stored.document.questions, legacyRevision: legacy.revision });
  } finally { expect((await request.post(`${control}/reset-content`)).ok()).toBe(true); }
});

test("ROO-66 the admin API cannot create a second FAQ document", async ({ page, request }, testInfo) => {
  const before = await cms(request, "/api/admin/content/documents?type=faqSection");
  const response = await request.post("/api/admin/content/publish", {
    headers: { "x-admin-key": ADMIN_KEY },
    data: { operation: "create", type: "faqSection", createIntentId: randomUUID(), document: { questions: [] } },
  });
  expect(response.status()).toBe(409);
  expect(await cms(request, "/api/admin/content/documents?type=faqSection")).toEqual(before);
  await login(page); await choose(page, "FAQ");
  await evidence(page, testInfo, { rejectedStatus: response.status(), documentIds: before.documents.map(document => document._id) });
});

test("ROO-66 publishing a used hero field preserves every legacy unused hero value", async ({ page, request }, testInfo) => {
  const original = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  const usedValue = `Used heading café 日本語 ${original.revision}`;
  await login(page); await hero(page);
  await page.getByLabel("Main Heading (Line 1)", { exact: true }).fill(usedValue);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
  const stored = await cms(request, `/api/admin/content/documents/${HERO_ID}`);
  expect(stored.document.headingLine1).toBe(usedValue);
  for (const field of ["tagline", "ctaNoteIcon", "bullets"]) expect(stored.document[field]).toEqual(original.document[field]);
  const publicResponse = await request.get("/api/content/hero");
  expect(publicResponse.ok()).toBe(true);
  expect((await publicResponse.json()).data.headingLine1).toBe(usedValue);
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Content types" })).toBeVisible();
  await hero(page);
  await expect(page.getByLabel("Main Heading (Line 1)", { exact: true })).toHaveValue(usedValue);
  await evidence(page, testInfo, { usedValue, unusedValues: { tagline: stored.document.tagline, ctaNoteIcon: stored.document.ctaNoteIcon, bullets: stored.document.bullets } });
});

for (const submitted of ["changed", "omitted"]) {
  test(`ROO-66 publishing with ${submitted} unused values keeps stored headings intact`, async ({ page, request, baseURL }, testInfo) => {
    const results = [];
    for (const [type, field, otherUnusedField] of [
      ["packagesSettings", "heading", "badgeText"], ["faqSettings", "title", "eyebrow"],
      ["services", "heading", "subheading"], ["supportedGames", "title", "subtitle"], ["proReviewsCarousel", "title", "subtitle"],
    ]) {
      const id = `tooling-${type}`;
      const current = await cms(request, `/api/admin/content/documents/${id}`);
      await prepareFieldFixture(request, baseURL, { ...current.document, [otherUnusedField]: "Legacy unused sibling" });
      const original = await cms(request, `/api/admin/content/documents/${id}`);
      const document = { ...original.document, [otherUnusedField]: `Unrelated ${submitted} publish` };
      if (submitted === "changed") document[field] = "Attempted overwrite";
      else delete document[field];
      await cms(request, "/api/admin/content/publish", { operation: "replace", type, documentId: id, expectedRevision: original.revision, document });
      const stored = await cms(request, `/api/admin/content/documents/${id}`);
      expect(stored.document[field]).toEqual(original.document[field]);
      expect(stored.document[otherUnusedField]).toBe(original.document[otherUnusedField]);
      results.push({ type, field, value: stored.document[field], revision: stored.revision });
    }
    await login(page); await choose(page, "Packages Section");
    await evidence(page, testInfo, { submitted, results });
  });
}

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

    test("publication response lost accepts server defaults", async ({ page, request }, testInfo) => {
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

    test("newer referral edits rebase after an in-flight save", async ({ page, request }, testInfo) => {
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
  await page.getByRole("group", { name: "Date-Based Time Slots (Vertex / Default)", exact: true }).getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Date", { exact: true }).fill("2099-01-11");
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
    expect(JSON.parse(drafts[0][1])).toMatchObject({ createIntentId: submitted.createIntentId, document: { dateSlots: [{ date: "2099-01-11" }] } });
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
  await page.getByRole("group", { name: "Date-Based Time Slots (Vertex / Default)", exact: true }).getByRole("button", { name: "Add item", exact: true }).click();
  await page.getByLabel("Date", { exact: true }).fill("2099-01-13");
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
    const stored = await cms(request, `/api/admin/content/documents/${receipt.documentId}`);
    expect(stored.document).toMatchObject({ backendOwner: "supabase", cutoverGeneration: expect.any(Number) });
    await fs.writeFile(testInfo.outputPath("creation-content.json"), JSON.stringify({ submitted: submitted.document, stored: stored.document, receipt }, null, 2));
    const beforeLookup = await contentCounts(request, control);
    await page.clock.fastForward(31000);
    await expect(page.getByRole("status").filter({ hasText: "Published. The live site" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("roo-content-draft:")))).toEqual([]);
    expect((await cms(request, `/api/admin/content/documents/${receipt.documentId}`)).document.dateSlots[0].date).toBe("2099-01-13");
    expect(writes).toBe(1);
    const afterLookup = await contentCounts(request, control);
    expect(afterLookup).toEqual(beforeLookup);
    await evidence(page, testInfo, { receipt, createIntentId: submitted.createIntentId, writes, beforeLookup, afterLookup });
  } finally {
    await pending.release();
    expect((await request.post(`${control}/reset-content`)).ok()).toBe(true);
  }
});

test("create reconciliation refuses a status response without a committed receipt", async ({ page, request }, testInfo) => {
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
    await page.route("**/api/admin/content/publish/status", route => route.fulfill({ json: { ok: true, data: { ...content, documentId: receipt.documentId } } }));
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
