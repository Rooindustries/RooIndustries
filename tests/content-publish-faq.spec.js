const { randomUUID } = require("node:crypto");
const { test, expect } = require("@playwright/test");
const { createContentGate } = require("./fixtures/content-store-gate.cjs");
const { PREBUILT_ROUTES } = require("../src/lib/routes");

const PAGES = PREBUILT_ROUTES.filter((route) => route !== "/tourney");
const DOCUMENTS = "^roo_fetch_public_content_documents$";
const html = { accept: "text/html" };

const read = async (request, path, headers = {}) => {
  const response = await request.get(path, { headers: { ...html, ...headers } });
  return { status: response.status(), cache: response.headers()["x-nextjs-cache"] ?? null, body: await response.text() };
};

const refusals = async (request, gate) => (await (await request.get(`${gate.control}/page-refusals`)).json());

test("FAQ publishes its own change without embedding an unconfirmed hero", async ({ request, baseURL }) => {
  const gate = createContentGate(request, baseURL);
  await read(request, "/booking");
  await read(request, "/");
  const hero = await gate.document("tooling-hero");
  const faq = await gate.document("faq");
  const tag = randomUUID().slice(0, 8);
  const oldHero = hero.document.headingLine1;
  const newHero = `Probe hero ${tag}`;
  const question = `Probe question ${tag}`;
  const failing = gate.traced();
  const seen = [];
  try {
    await gate.publish(hero, { headingLine1: newHero });
    await gate.publish(await gate.document("faq"), { questions: [...(faq.document.questions || []), { _key: `probe${tag}`, question, answer: "Probe answer for the FAQ rebuild check." }] });
    await failing.rules([{ rpc: DOCUMENTS, types: "(^|,)hero(,|$)", action: "fail" }]);
    let latest;
    await expect.poll(async () => {
      latest = await read(request, "/faq", failing.headers);
      seen.push({ status: latest.status, cache: latest.cache, newQuestion: latest.body.includes(question), oldHero: latest.body.includes(oldHero), newHero: latest.body.includes(newHero) });
      return latest.body.includes(question);
    }, { timeout: 45000, intervals: [3000] }).toBe(true);
    expect(seen.every(({ status }) => status < 500)).toBe(true);
    expect(latest.body).not.toContain(oldHero);
    expect(latest.body).not.toContain(newHero);
    expect(latest.cache).toBe("HIT");
  } finally {
    console.log(`FAQCASE ${JSON.stringify(seen)}`);
    await gate.restore("tooling-hero", hero.document);
    await gate.restore("faq", faq.document);
  }
});

for (const [id, type, failingPages] of [["tooling-contact", "contact", ["/contact"]], ["faq", "faqSection", ["/", "/faq"]]]) {
  test(`${type} outages log once while other pages keep rebuilding`, async ({ request, baseURL }) => {
    const gate = createContentGate(request, baseURL);
    for (const path of ["/booking", ...PAGES]) await read(request, path);
    const original = await gate.document(id);
    const before = (await refusals(request, gate)).length;
    const failing = gate.traced();
    const responses = [];
    try {
      const changes = type === "contact" ? { subtitle: `Outage ${randomUUID()}` } : { questions: [...(original.document.questions || []), { _key: randomUUID(), question: `Outage ${randomUUID()}`, answer: "Outage check answer." }] };
      await gate.publish(original, changes);
      await failing.rules([{ rpc: DOCUMENTS, types: `(^|,)${type}(,|$)`, action: "fail" }]);
      responses.push(await read(request, failingPages.at(-1), failing.headers));
      await expect.poll(async () => (await refusals(request, gate)).length - before, { timeout: 15000 }).toBe(1);
      const started = Date.now();
      await expect.poll(async () => {
        const pages = await Promise.all(PAGES.map((path) => read(request, path, failingPages.includes(path) ? failing.headers : {})));
        responses.push(...pages);
        return Date.now() - started >= 40000;
      }, { timeout: 50000, intervals: [5000] }).toBe(true);
      const events = (await refusals(request, gate)).slice(before);
      const calls = await (await request.get(`${gate.control}/store-calls?trace=${failing.trace}&details=1`)).json();
      const failedReads = calls.filter(({ rpc, types }) => rpc === "roo_fetch_public_content_documents" && new RegExp(`(^|,)${type}(,|$)`).test(types));
      console.log(`PARTIAL ${JSON.stringify({ refusals: events.length, labels: events.map(({ label }) => label), type, failedReads: failedReads.length, errors: responses.filter(({ status }) => status >= 500).length })}`);
      expect(responses.every(({ status }) => status < 500)).toBe(true);
      expect(failedReads.length).toBeGreaterThanOrEqual(2);
      expect(events).toEqual([{ label: "Page content unavailable; keeping the previous page" }]);
    } finally {
      await gate.restore(id, original.document);
    }
  });
}
