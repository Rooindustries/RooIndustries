const { test, expect } = require("@playwright/test");

test.skip(process.env.TOOLING_STATIC_REVALIDATION !== "1", "Needs its own server with a cold content cache: npm run test:static:revalidation.");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const contentControl = (request, baseURL) => async data => {
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  const response = await request.post(new URL("/__content", contentURL).href, { data });
  expect(response.status()).toBe(200);
};

const pageReader = (request, timeline) => async (route, step) => {
  const response = await request.get(route, { headers: { accept: "text/html" } });
  const body = await response.text();
  const record = {
    route,
    step,
    status: response.status(),
    cache: response.headers()["x-nextjs-cache"] ?? null,
    headings: [...body.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(match => match[1].replace(/<[^>]*>/g, "")),
  };
  timeline.push(record);
  return { ...record, body };
};

test("/packages and /faq keep their last content when revalidation cannot read it", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const control = contentControl(request, baseURL);
  const timeline = [];
  const read = pageReader(request, timeline);
  const expected = {
    "/packages": "Performance Vertex Max",
    "/faq": "Synthetic local question 1",
  };
  try {
    await control({ outage: ["hero", "package", "packagesSettings", "faqSection"] });
    await wait(61000);
    for (const route of Object.keys(expected)) {
      const trigger = await read(route, "first request after the revalidation window");
      expect(trigger.status).toBe(200);
      expect(trigger.cache).toBe("STALE");
      expect(trigger.body).toContain(expected[route]);
    }
    for (const [route, text] of Object.entries(expected)) {
      await expect.poll(async () => (await read(route, "waiting for the failed revalidation to settle")).cache, { timeout: 20000 }).toBe("HIT");
      const after = await read(route, "after the failed revalidation");
      expect.soft(after.status, route).toBe(200);
      expect.soft(after.body.includes(text), route).toBe(true);
    }
  } finally {
    await control({ reset: true });
    await testInfo.attach("static-pages-revalidation", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});

test("/about, /contact, /privacy, /terms, /tools and /meet-the-team keep their last content when revalidation cannot read it", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const control = contentControl(request, baseURL);
  const timeline = [];
  const read = pageReader(request, timeline);
  const expected = {
    "/about": "About Roo Industries",
    "/contact": "Synthetic local contact information.",
    "/privacy": "Synthetic local information",
    "/terms": "Synthetic local information",
    "/tools": "Fixture layout tool 1",
    "/meet-the-team": "Fixture Member Alpha",
  };
  const fallbacks = {
    "/contact": "Ready to optimize your PC?",
    "/tools": "No tools are listed right now.",
    "/meet-the-team": "Wailshark",
  };
  try {
    await control({ outage: ["contact", "privacyPolicy", "terms", "tool", "meetTheTeam"] });
    await wait(61000);
    for (const [route, text] of Object.entries(expected)) {
      const trigger = await read(route, "first request after the revalidation window");
      expect(trigger.status, route).toBe(200);
      expect(trigger.cache, route).toBe("STALE");
      expect(trigger.body, route).toContain(text);
    }
    for (const [route, text] of Object.entries(expected)) {
      await expect.poll(async () => (await read(route, "waiting for the failed revalidation to settle")).cache, { timeout: 20000 }).toBe("HIT");
      const after = await read(route, "after the failed revalidation");
      expect.soft(after.status, route).toBe(200);
      expect.soft(after.body.includes(text), route).toBe(true);
      if (fallbacks[route]) expect.soft(after.body.includes(fallbacks[route]), route).toBe(false);
      if (route === "/privacy") expect.soft(after.headings, route).toEqual(["Privacy Policy"]);
      if (route === "/terms") expect.soft(after.headings, route).toEqual(["Terms of Service"]);
    }
  } finally {
    await control({ reset: true });
    await testInfo.attach("static-public-pages-revalidation", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});

test("/contact, /privacy, /terms and /meet-the-team keep their last content when the CMS returns no document", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const control = contentControl(request, baseURL);
  const timeline = [];
  const read = pageReader(request, timeline);
  const expected = {
    "/contact": "Synthetic local contact information.",
    "/privacy": "Synthetic local information",
    "/terms": "Synthetic local information",
    "/meet-the-team": "Fixture Member Alpha",
  };
  try {
    await control({ missing: ["contact", "privacyPolicy", "terms", "meetTheTeam"] });
    await wait(61000);
    for (const [route, text] of Object.entries(expected)) {
      const trigger = await read(route, "first request after the revalidation window");
      expect(trigger.status, route).toBe(200);
      expect(trigger.cache, route).toBe("STALE");
      expect(trigger.body, route).toContain(text);
    }
    for (const [route, text] of Object.entries(expected)) {
      await expect.poll(async () => (await read(route, "waiting for the revalidation to settle")).cache, { timeout: 20000 }).toBe("HIT");
      const after = await read(route, "after the revalidation without a document");
      expect.soft(after.status, route).toBe(200);
      expect.soft(after.body.includes(text), route).toBe(true);
      if (route === "/contact") expect.soft(after.body.includes("Ready to optimize your PC?"), route).toBe(false);
      if (route === "/privacy") expect.soft(after.headings, route).toEqual(["Privacy Policy"]);
      if (route === "/terms") expect.soft(after.headings, route).toEqual(["Terms of Service"]);
    }
  } finally {
    await control({ reset: true });
    await testInfo.attach("static-pages-missing-document", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});

test("/faq publishes its own changes while unrelated home content is unavailable", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const control = contentControl(request, baseURL);
  const timeline = [];
  const read = pageReader(request, timeline);
  const question = "Revalidation probe question";
  try {
    await control({ outage: ["hero", "package"] });
    await control({ patch: { _id: "faq", questions: [{ _key: "revalidation-probe", question, answer: "This probe answer shows the FAQ page rebuilt while other content was unavailable." }] } });
    await wait(61000);
    const trigger = await read("/faq", "first request after the revalidation window");
    expect(trigger.status).toBe(200);
    expect(trigger.cache).toBe("STALE");
    await expect.poll(async () => (await read("/faq", "waiting for the rebuilt page")).body.includes(question), { timeout: 20000 }).toBe(true);
  } finally {
    await control({ reset: true });
    await testInfo.attach("faq-unrelated-outage", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});
