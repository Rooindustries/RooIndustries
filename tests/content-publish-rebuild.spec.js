const { randomUUID } = require("node:crypto");
const { test, expect } = require("@playwright/test");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");
const { PREBUILT_ROUTES } = require("../src/lib/routes");

const READS = "^roo_(read_public_content_revision|fetch_public_content_documents|asset_manifest_for_refs)$";
const PAGES = PREBUILT_ROUTES.filter((route) => route !== "/tourney");
const RECOVERY_MS = 40000;
const html = { accept: "text/html" };

const read = async (request, path, headers = {}) => {
  const response = await request.get(path, { headers: { ...html, ...headers } });
  const cacheControl = response.headers()["cache-control"] || "";
  return { path, status: response.status(), cache: response.headers()["x-nextjs-cache"] ?? null, maxAge: Number(cacheControl.match(/s-maxage=(\d+)/)?.[1] ?? NaN), body: await response.text() };
};

const firstDocument = async (gate, ids) => {
  for (const id of ids) { try { return await gate.document(id); } catch { continue; } }
  throw new Error(`none of ${ids.join(", ")} exists`);
};

const forceFailedRebuild = async ({ request, baseURL, label, mode }) => {
  const gate = createContentGate(request, baseURL);
  const tally = { label, served5xx: 0, staleAsFresh: 0, stillOldAfterRecovery: 0, examples: [] };
  if (mode === "warm") for (const path of ["/booking", "/payment", ...PAGES]) await read(request, path);
  const refusals = async () => (await (await request.get(`${gate.control}/page-refusals`)).json()).length;
  const beforeRefusals = await refusals();
  const tag = randomUUID().slice(0, 8);
  const pkg = await gate.document("tooling-package-0");
  const contact = await gate.document("tooling-contact");
  const banner = await firstDocument(gate, ["discordBanner", "fixture-discordBanner"]);
  const failing = gate.traced();
  try {
  const old = { price: pkg.document.price, subtitle: contact.document.subtitle, link: banner.document.link };
  const fresh = { price: `$${(300 + Math.floor(Math.random() * 600)).toFixed(0)}.17`, subtitle: `Probe subtitle ${tag}`, link: `https://discord.gg/probe${tag}` };
  await gate.publish(pkg, { price: fresh.price });
  await gate.publish(contact, { subtitle: fresh.subtitle });
  await gate.publish(banner, { link: fresh.link });
  const showsOld = (page) =>
    (page.body.includes(old.link) && !page.body.includes(fresh.link)) ||
    (["/", "/packages"].includes(page.path) && page.body.includes(old.price) && !page.body.includes(fresh.price)) ||
    (page.path === "/contact" && old.subtitle && page.body.includes(old.subtitle) && !page.body.includes(fresh.subtitle));
  const judge = (page, phase, pageLife) => {
    if (page.status >= 500) { tally.served5xx += 1; tally.examples.push(`${phase} ${page.path} ${page.status}`); }
    if (page.status === 200 && page.cache === "HIT" && showsOld(page) && page.maxAge >= pageLife) {
      tally.staleAsFresh += 1;
      tally.examples.push(`${phase} ${page.path} HIT s-maxage=${page.maxAge} pre-publish`);
    }
  };
  const pageLife = (await read(request, "/terms")).maxAge;
  await failing.rules([{ rpc: READS, action: "fail" }]);
  for (const page of await Promise.all(PAGES.map((path) => read(request, path, failing.headers)))) judge(page, "during", pageLife);
  if (mode === "warm") {
    for (const path of ["/booking", "/payment"]) {
      const page = await read(request, path, failing.headers);
      expect(page.status, `${path} during a read outage`).toBe(200);
    }
  }
  const started = Date.now();
  while (Date.now() - started < RECOVERY_MS) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    for (const page of await Promise.all(PAGES.map((path) => read(request, path)))) judge(page, `+${Math.round((Date.now() - started) / 1000)}s`, pageLife);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const page of await Promise.all(PAGES.map((path) => read(request, path)))) {
    if (showsOld(page)) { tally.stillOldAfterRecovery += 1; tally.examples.push(`after ${page.path} ${page.cache} s-maxage=${page.maxAge}`); }
  }
  tally.refusals = (await refusals()) - beforeRefusals;
  tally.examples = [...new Set(tally.examples)].slice(0, 12);
  console.log(`CHECK ${JSON.stringify(tally)}`);
  return tally;
  } finally {
    await gate.cleanup(
      () => failing.rules([]),
      () => gate.restore("tooling-package-0", pkg.document),
      () => gate.restore("tooling-contact", contact.document),
      () => gate.restore(banner.document._id, banner.document),
      () => gate.rebuild(PAGES),
      () => gate.clearRounds(),
    );
  }
};

test("a failed read during a rebuild after a publish", async ({ request, baseURL }) => {
  test.setTimeout(300000);
  const results = [];
  for (const mode of ["cold", "warm"]) results.push(await forceFailedRebuild({ request, baseURL, label: mode, mode }));
  for (const { label, served5xx, staleAsFresh, stillOldAfterRecovery, refusals } of results) {
    expect({ label, served5xx, staleAsFresh, stillOldAfterRecovery, refusals }).toEqual({
      label, served5xx: 0, staleAsFresh: 0, stillOldAfterRecovery: 0, refusals: 1,
    });
  }
});
