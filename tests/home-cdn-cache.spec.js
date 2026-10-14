const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

const HOME_CDN_CACHE = "s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400";
const HTML = { accept: "text/html" };

async function served(request, testInfo, name, path, { method = "GET", headers = HTML } = {}) {
  const response = await request.fetch(path, { method, headers, maxRedirects: 0 });
  const record = { path, method, requestHeaders: headers, status: response.status(), headers: response.headersArray() };
  const artifact = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(artifact, JSON.stringify(record, null, 2));
  await testInfo.attach(name, { path: artifact, contentType: "application/json" });
  const value = (key) => {
    const values = record.headers.filter((header) => header.name.toLowerCase() === key).map((header) => header.value);
    return values.length ? values.join(", ") : null;
  };
  return { status: record.status, value };
}

test.describe("home page CDN caching", () => {
  for (const method of ["GET", "HEAD"]) {
    test(`${method} / for a browser is cached at the CDN only`, async ({ request }, testInfo) => {
      const home = await served(request, testInfo, `home-${method.toLowerCase()}`, "/", { method });
      expect(home.status).toBe(200);
      expect(home.value("vercel-cdn-cache-control")).toBe(HOME_CDN_CACHE);
      expect(home.value("cdn-cache-control")).toBe("no-store");
      expect(home.value("cache-control")).toContain("no-store");
      expect(home.value("set-cookie")).toBeNull();
    });
  }

  test("a campaign query on / gets the same CDN caching", async ({ request }, testInfo) => {
    const home = await served(request, testInfo, "home-utm", "/?utm_source=newsletter");
    expect(home.status).toBe(200);
    expect(home.value("vercel-cdn-cache-control")).toBe(HOME_CDN_CACHE);
  });

  for (const [key, value] of [
    ["rsc", "1"],
    ["next-router-prefetch", "1"],
    ["next-router-state-tree", "%5B%22%22%5D"],
    ["next-router-segment-prefetch", "/_tree"],
    ["next-action", "x"],
  ]) {
    test(`a request for / with ${key} is not CDN cached`, async ({ request }, testInfo) => {
      const response = await served(request, testInfo, `home-${key}`, "/", { headers: { ...HTML, [key]: value } });
      expect(response.value("vercel-cdn-cache-control") ?? "").not.toContain("s-maxage");
    });
  }

  test("the markdown representation of / is not CDN cached", async ({ request }, testInfo) => {
    const markdown = await served(request, testInfo, "home-markdown", "/", { headers: { accept: "text/markdown" } });
    expect(markdown.value("content-type")).toContain("text/markdown");
    expect(markdown.value("vercel-cdn-cache-control")).toBe("no-store");
  });

  test("the redirect that strips private parameters from / is not CDN cached", async ({ request, baseURL }, testInfo) => {
    const redirect = await served(request, testInfo, "home-token", "/?token=abc");
    expect(redirect.status).toBe(307);
    expect(new URL(redirect.value("location"), baseURL).searchParams.has("token")).toBe(false);
    expect(redirect.value("vercel-cdn-cache-control")).toBe("no-store");
  });

  for (const path of ["/about", "/booking", "/payment", "/faq", "/reviews"]) {
    test(`${path} is not CDN cached by the home page rule`, async ({ request }, testInfo) => {
      const page = await served(request, testInfo, `page${path.replace(/\//g, "-")}`, path);
      expect(page.value("vercel-cdn-cache-control") ?? "").not.toContain("s-maxage");
    });
  }
});
