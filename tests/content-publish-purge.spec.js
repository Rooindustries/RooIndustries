const { randomUUID } = require("node:crypto");
const { test, expect } = require("@playwright/test");
const { CONTENT_READ, createContentGate } = require("./fixtures/content-store-gate.cjs");

const PACKAGE = "tooling-package-0";
const PACKAGES = "/api/content/packages-list";
const NO_STORE = "no-store, max-age=0";
const CONTENT_PURGE = { operation: "dangerouslyDeleteByTag", target: "public-content", options: null };

const priceOf = async (response) =>
  (await response.json()).data.find((row) => row._id === PACKAGE)?.price;

const expectNotCacheable = (response) => {
  expect(response.headers()["cache-control"]).toBe(NO_STORE);
  expect(response.headers()["vercel-cache-tag"]).toBeUndefined();
  expect(response.headers()["vercel-cdn-cache-control"]).toBeUndefined();
};

const expectCacheable = (response) => {
  expect(response.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate, s-maxage=60");
  expect(response.headers()["vercel-cdn-cache-control"]).toBe("public, max-age=60");
  expect(response.headers()["vercel-cache-tag"]).toBe("public-content");
};

const expectPurges = (gate, count) =>
  expect.poll(async () => (await gate.admin.purges()).map(({ trace, ...purge }) => purge), {
    timeout: 20000,
    intervals: [250, 500, 1000],
  }).toEqual(Array(count).fill(CONTENT_PURGE));

const couponTerms = async (request, coupon, packageTitle) => {
  const query = new URLSearchParams({ code: coupon.document.code, packageTitle });
  const response = await request.get(`/api/ref/validateCoupon?${query}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).coupon;
};

test("publishing a package price and a coupon purges the content API right away and once more, and serves the new terms", async ({ request, baseURL }) => {
  test.setTimeout(180000);
  const gate = createContentGate(request, baseURL);
  const pkg = await gate.document(PACKAGE);
  const receipt = await gate.cms("/api/admin/content/publish", {
    operation: "create",
    type: "coupon",
    createIntentId: randomUUID(),
    document: {
      title: "Purge check coupon",
      code: `PURGE${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`,
      discountType: "percent",
      discountPercent: 10,
      isActive: true,
      canCombineWithReferral: false,
      eligiblePackages: [{ _key: "purge-check", _type: "reference", _ref: PACKAGE }],
    },
  });
  const coupon = await gate.document(receipt.documentId);
  await expectPurges(gate, 2);
  let couponRevision = coupon.revision;

  try {
    expect(await couponTerms(request, coupon, pkg.document.title)).toMatchObject({ discountType: "percent", discountPercent: 10 });
    await gate.publish(pkg, { price: "$123.45" });
    await expectPurges(gate, 3);
    const listed = await gate.traced().content(PACKAGES);
    expectCacheable(listed);
    expect(await priceOf(listed)).toBe("$123.45");
    await expect.poll(async () => (await (await request.get("/packages")).text()).includes("$123.45"), {
      timeout: 60000,
      intervals: [500, 1000, 2000],
    }).toBe(true);
    await expectPurges(gate, 4);

    couponRevision = (await gate.publish(coupon, { discountType: "percent", discountPercent: 25 })).revision;
    expect(await couponTerms(request, coupon, pkg.document.title)).toMatchObject({ discountType: "percent", discountPercent: 25 });
    await expectPurges(gate, 6);
  } finally {
    await gate.cms("/api/admin/content/publish", { operation: "delete", type: "coupon", documentId: coupon.document._id, expectedRevision: couponRevision });
    await gate.restore(PACKAGE, pkg.document);
  }
});

test("a read that started before another server published is sent no-store and never kept", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const original = await gate.document(PACKAGE);
  try {
    expect(await priceOf(await gate.traced().content(PACKAGES))).toBe(original.document.price);
    await gate.publishElsewhere(original, { price: "$301.01" });

    const slow = gate.traced();
    await slow.rules([{ rpc: CONTENT_READ, action: "hold", times: 1 }]);
    const pending = slow.content(PACKAGES);
    await slow.waitForHold();
    await gate.publishElsewhere(await gate.document(PACKAGE), { price: "$302.02" });
    await slow.release();
    const late = await pending;
    expectNotCacheable(late);
    expect(await priceOf(late)).toBe("$301.01");

    const down = gate.traced();
    await down.rules([{ rpc: ".", action: "fail" }]);
    const kept = await down.content(PACKAGES);
    expectNotCacheable(kept);
    expect(await priceOf(kept)).toBe(original.document.price);

    const current = await gate.traced().content(PACKAGES);
    expectCacheable(current);
    expect(await priceOf(current)).toBe("$302.02");
  } finally {
    await gate.restore(PACKAGE, original.document);
  }
});

test("a failed publish keeps the CDN copy and the last good server copy while the store is down", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const original = await gate.document(PACKAGE);
  const warm = await gate.traced().content(PACKAGES);
  expect(warm.status()).toBe(200);
  expect(await priceOf(warm)).toBe(original.document.price);

  const down = gate.traced();
  await down.rules([{ rpc: ".", action: "fail" }]);
  const attempt = await down.cms("/api/admin/content/publish", gate.replaceCommand(original, { price: "$404.04" }));
  expect(attempt.status).toBe(503);
  await expect.poll(() => down.purges(), { timeout: 10000 }).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  expect((await down.purges()).map(({ operation }) => operation)).toEqual(["invalidateByTag"]);
  const served = await down.content(PACKAGES);
  expect(served.status()).toBe(200);
  expectNotCacheable(served);
  expect(await priceOf(served)).toBe(original.document.price);
  expect((await gate.document(PACKAGE)).document.price).toBe(original.document.price);
});

test("unknown package titles and upgrade slugs are answered without reading the store", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const { document } = await gate.document(PACKAGE);
  const warm = gate.traced();
  const known = await warm.content(`/api/content/package?title=${encodeURIComponent(document.title)}`);
  expect((await known.json()).data).toMatchObject({ title: document.title, price: document.price });
  expect((await (await warm.content("/api/content/upgrade-link?slug=fixture-upgrade")).json()).data).toMatchObject({ targetPackage: { title: document.title } });

  const junk = gate.traced();
  for (let index = 0; index < 6; index += 1) {
    const title = await junk.content(`/api/content/package?title=${encodeURIComponent(`Junk package ${index}`)}`);
    expect(title.status()).toBe(200);
    expect((await title.json()).data).toBeNull();
    const slug = await junk.content(`/api/content/upgrade-link?slug=junk-upgrade-${index}`);
    expect(slug.status()).toBe(200);
    expect((await slug.json()).data).toBeNull();
  }
  expect(await junk.contentReads()).toEqual([]);
});

test("a read that misses its deadline answers with the last good copy and still warms the server through waitUntil", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const original = await gate.document(PACKAGE);
  try {
    expect(await priceOf(await gate.traced().content(PACKAGES))).toBe(original.document.price);
    await gate.publishElsewhere(original, { price: "$505.05" });

    const late = gate.traced();
    await late.rules([{ rpc: CONTENT_READ, action: "hold", times: 1 }]);
    const fallback = await late.content(PACKAGES);
    expectNotCacheable(fallback);
    expect(await priceOf(fallback)).toBe(original.document.price);
    expect(await late.keptAlive()).toEqual(["registered"]);

    await late.release();
    await expect.poll(() => late.keptAlive(), { timeout: 15000 }).toEqual(["registered", "settled"]);
    const after = gate.traced();
    const warmed = await after.content(PACKAGES);
    expectCacheable(warmed);
    expect(await priceOf(warmed)).toBe("$505.05");
    expect(await after.contentReads()).toEqual([]);
  } finally {
    await gate.restore(PACKAGE, original.document);
  }
});

test("a read with no saved copy that misses its deadline answers 503 no-store and still warms the server through waitUntil", async ({ request, baseURL }) => {
  test.setTimeout(120000);
  const gate = createContentGate(request, baseURL);
  const titles = [];
  for (const id of [PACKAGE, "tooling-package-1"]) titles.push((await gate.document(id)).document.title);
  const path = `/api/content/package?${titles.map((title) => `title=${encodeURIComponent(title)}`).join("&")}`;
  expect((await (await gate.traced().content(PACKAGES)).json()).ok).toBe(true);

  const cold = gate.traced();
  await cold.rules([{ rpc: CONTENT_READ, action: "hold", times: 1 }]);
  const startedAt = Date.now();
  const unavailable = await cold.content(path);
  const waited = Date.now() - startedAt;
  expect(unavailable.status()).toBe(503);
  expect(unavailable.headers()["cache-control"]).toBe(NO_STORE);
  expect(unavailable.headers()["vercel-cache-tag"]).toBeUndefined();
  expect(waited).toBeGreaterThanOrEqual(4500);
  expect(waited).toBeLessThan(8000);
  expect(await cold.contentReads()).toHaveLength(1);
  expect(await cold.keptAlive()).toEqual(["registered"]);

  await cold.release();
  await expect.poll(() => cold.keptAlive(), { timeout: 15000 }).toEqual(["registered", "settled"]);
  const after = gate.traced();
  const warmed = await after.content(path);
  expect(warmed.status()).toBe(200);
  expectCacheable(warmed);
  expect(titles).toContain((await warmed.json()).data.title);
  expect(await after.contentReads()).toEqual([]);
});
