const { test, expect } = require("@playwright/test");

test.skip(process.env.TOOLING_STATIC_REVALIDATION !== "1", "Needs its own server with a cold content cache: npm run test:static:revalidation.");

test("/packages and /faq keep their last content when revalidation cannot read it", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  const control = async data => {
    const response = await request.post(new URL("/__content", contentURL).href, { data });
    expect(response.status()).toBe(200);
  };
  const expected = {
    "/packages": "Performance Vertex Max",
    "/faq": "Synthetic local question 1",
  };
  const timeline = [];
  const read = async (route, step) => {
    const response = await request.get(route, { headers: { accept: "text/html" } });
    const body = await response.text();
    const record = { route, step, status: response.status(), cache: response.headers()["x-nextjs-cache"] ?? null, hasContent: body.includes(expected[route]) };
    timeline.push(record);
    return record;
  };
  try {
    await control({ outage: ["package", "packagesSettings", "faqSection"] });
    await new Promise(resolve => setTimeout(resolve, 61000));
    for (const route of Object.keys(expected)) {
      const trigger = await read(route, "first request after the revalidation window");
      expect(trigger.status).toBe(200);
      expect(trigger.cache).toBe("STALE");
      expect(trigger.hasContent).toBe(true);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
    for (const route of Object.keys(expected)) {
      const after = await read(route, "after the failed revalidation");
      expect.soft(after.status, route).toBe(200);
      expect.soft(after.hasContent, route).toBe(true);
    }
  } finally {
    await control({ reset: true });
    await testInfo.attach("static-pages-revalidation", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});
