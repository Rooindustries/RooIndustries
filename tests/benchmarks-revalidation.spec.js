const { test, expect } = require("@playwright/test");

const titles = ["Fixture Benchmark Alpha", "Fixture Benchmark Beta"];

test.skip(process.env.TOOLING_BENCHMARKS_REVALIDATION !== "1", "Needs its own server with a cold content cache: npm run test:benchmarks:revalidation.");

test("/benchmarks keeps its last results when revalidation cannot read the CMS", async ({ request, baseURL }, testInfo) => {
  test.setTimeout(180000);
  const contentURL = new URL(baseURL);
  contentURL.port = process.env.TOOLING_CONTENT_PORT || String(Number(contentURL.port) + 1);
  const control = async data => {
    const response = await request.post(new URL("/__content", contentURL).href, { data });
    expect(response.status()).toBe(200);
  };
  const timeline = [];
  const read = async step => {
    const response = await request.get("/benchmarks", { headers: { accept: "text/html" } });
    const body = await response.text();
    const record = {
      step,
      status: response.status(),
      cache: response.headers()["x-nextjs-cache"],
      titles: [...body.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map(match => match[1]),
    };
    timeline.push(record);
    return record;
  };
  try {
    await control({ outage: true });
    await new Promise(resolve => setTimeout(resolve, 61000));
    const trigger = await read("first request after the revalidation window");
    expect(trigger.status).toBe(200);
    expect(trigger.cache).toBe("STALE");
    expect(trigger.titles).toEqual(titles);
    await expect.poll(async () => (await read("waiting for the failed revalidation to settle")).cache, { timeout: 20000 }).toBe("HIT");
    const after = await read("after the failed revalidation");
    expect(after.status).toBe(200);
    expect(after.titles).toEqual(titles);
  } finally {
    await control({ reset: true });
    await testInfo.attach("benchmarks-revalidation", { body: JSON.stringify(timeline, null, 2), contentType: "application/json" });
  }
});
