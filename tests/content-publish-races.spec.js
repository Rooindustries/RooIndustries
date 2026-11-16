const { randomUUID } = require("node:crypto");
const { test, expect } = require("./fixtures/isolated-content-test.cjs");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");

const read = async (request, path, headers = {}) => {
  const response = await request.get(path, { headers: { accept: "text/html", ...headers } });
  const maxAge = Number((response.headers()["cache-control"] || "").match(/s-maxage=(\d+)/)?.[1] ?? NaN);
  return { status: response.status(), cache: response.headers()["x-nextjs-cache"] ?? null, maxAge, body: await response.text() };
};

const writesFor = async (request, gate, key) =>
  (await (await request.get(`${gate.control}/test-page-writes`)).json()).filter((entry) => entry.key === key).length;

const waitFor = async (request, gate, params, timeout) => {
  const query = new URLSearchParams(params);
  return request.get(`${gate.control}/await-test-event?${query}`, timeout ? { timeout } : {});
};

const report = (name, result) => console.log(`CASE ${name} ${JSON.stringify(result)}`);

test("R1 a missing required singleton is never cached as fresh", async ({ request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  const hero = await gate.document("tooling-hero");
  const contact = await gate.document("tooling-contact");
  try {
  const before = await read(request, "/");
  expect(before.body).toContain(hero.document.headingLine1);
  expect((await request.post(`${gate.control}/remove-content-document`, { data: { id: "tooling-hero" } })).ok()).toBe(true);
  await gate.publish(contact, { subtitle: `Unrelated change ${randomUUID().slice(0, 6)}` });
  await waitFor(request, gate, { kind: "purge", trace: gate.admin.trace, count: "2" });
  const count = await writesFor(request, gate, "/");
  await read(request, "/");
  await waitFor(request, gate, { kind: "write", key: "/", count: String(count + 1) });
  const after = await read(request, "/");
  const result = { status: after.status, cache: after.cache, maxAge: after.maxAge, hasHero: after.body.includes(hero.document.headingLine1) };
  report("R1", result);
  expect(after.status).toBe(200);
  expect(after.cache === "HIT" && after.maxAge >= 60 && !result.hasHero, "fallback hero cached as fresh").toBe(false);
  } finally {
    await gate.cleanup(
      async () => { expect((await request.post(`${gate.control}/cms-field-fixture`, { data: hero.document })).ok()).toBe(true); },
      () => gate.restore("tooling-contact", contact.document),
      () => gate.rebuild(["/"]),
      () => gate.clearRounds(),
    );
  }
});

test("R2 a revision checked before publish cannot cache an old price after the second mark", async ({ request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  const pkg = await gate.document("tooling-package-0");
  const render = gate.traced();
  let trigger;
  try {
  const priceA = `$${400 + Math.floor(Math.random() * 400)}.11`;
  const priceB = `$${400 + Math.floor(Math.random() * 400)}.22`;
  await gate.publish(pkg, { price: priceA });
  await read(request, "/booking");
  await render.rules([{ rpc: "^roo_read_public_content_revision$", action: "pass", times: 1 }, { rpc: "^roo_read_public_content_revision$", action: "hold", times: 1 }]);
  const count = await writesFor(request, gate, "/packages");
  trigger = read(request, "/packages", { ...render.headers, "x-roo-test-hold-page-store": "1" });
  await waitFor(request, gate, { kind: "hold", trace: render.trace, count: "1" });
  const later = gate.traced();
  const current = await gate.document("tooling-package-0");
  const published = await later.cms("/api/admin/content/publish", gate.replaceCommand(current, { price: priceB }));
  expect(published.status).toBe(200);
  await render.release();
  await waitFor(request, gate, { kind: "hold", trace: render.trace, rpc: "page-store", count: "1" });
  await waitFor(request, gate, { kind: "purge", trace: later.trace, count: "2" });
  await render.release();
  const first = await trigger;
  const saved = await waitFor(request, gate, { kind: "write", key: "/packages", count: String(count + 1) }).then((response) => response.ok(), () => false);
  const refusals = (await (await request.get(`${gate.control}/page-refusals`)).json()).map(({ label }) => label);
  const held = (await (await request.get(`${gate.control}/store-holds?trace=${render.trace}`)).json()).includes("page-store");
  expect(saved, `/packages was not saved again; refusals seen: ${refusals.join(", ") || "none"}; ${held ? `held page store ${render.trace}` : "page store not held"}`).toBe(true);
  const after = await read(request, "/packages");
  const result = { calls: await render.calls(), refusals, firstCache: first.cache, cache: after.cache, maxAge: after.maxAge, showsA: after.body.includes(priceA), showsB: after.body.includes(priceB) };
  report("R2", result);
  expect(first.status).toBe(200);
  expect(after.status).toBe(200);
  expect(after.cache === "HIT" && after.maxAge >= 60 && !result.showsB, "a page without the published price cached as fresh").toBe(false);
  } finally {
    await gate.cleanup(
      () => render.close(),
      () => render.reset(),
      async () => { if (trigger) await trigger; },
      () => render.reset(),
      () => gate.restore("tooling-package-0", pkg.document),
      () => gate.rebuild(["/packages"]),
      () => gate.clearRounds(),
    );
  }
});

test("R3 a hanging content purge does not stop the page mark", async ({ request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  const pkg = await gate.document("tooling-package-0");
  const hanging = gate.traced();
  try {
  await read(request, "/packages");
  const count = await writesFor(request, gate, "/packages");
  const price = `$${400 + Math.floor(Math.random() * 400)}.33`;
  const publish = await request.fetch("/api/admin/content/publish", {
    method: "POST",
    headers: { ...hanging.headers, "x-admin-key": "synthetic-admin-key", "x-roo-test-hang-content-purge": "1" },
    data: gate.replaceCommand(pkg, { price }),
  });
  const answer = await publish.json();
  await read(request, "/packages");
  try { await waitFor(request, gate, { kind: "write", key: "/packages", count: String(count + 1) }, 7000); } catch {}
  const after = await read(request, "/packages");
  const result = { status: publish.status(), refresh: answer?.data?.refresh ?? null, cache: after.cache, maxAge: after.maxAge, showsNew: after.body.includes(price) };
  report("R3", result);
  expect(result.showsNew, "the published price never reached the page").toBe(true);
  expect(result.refresh).toEqual({ content: "pending", pages: "done" });
  } finally {
    await gate.cleanup(() => hanging.reset(), () => gate.restore("tooling-package-0", pkg.document), () => gate.rebuild(["/packages"]), () => gate.clearRounds());
  }
});
