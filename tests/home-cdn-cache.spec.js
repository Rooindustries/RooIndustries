const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const http = require("node:http");

const HOME_CDN_CACHE = "s-maxage=60, stale-while-revalidate=86400, stale-if-error=86400";
const HTML = { accept: "text/html" };
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const fetchHead = (url, headers) => new Promise((resolve, reject) => {
  const request = http.get(url, { headers }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => resolve({
      status: response.statusCode,
      sentHeaders: request.getRawHeaderNames().map((name) => name.toLowerCase()),
      head: body.slice(0, Math.max(body.indexOf("</head>"), 0)),
    }));
  });
  request.on("error", reject);
});

const ogTags = (head) => (head.match(/<meta[^>]*property="og:[^"]+"[^>]*>/g) || []).sort();

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

  test("a request for / without a user agent keeps the link preview tags in the head", async ({ baseURL }, testInfo) => {
    const url = new URL("/", baseURL);
    const bare = await fetchHead(url, { accept: "text/html" });
    const browser = await fetchHead(url, { accept: "text/html", "user-agent": BROWSER_UA });
    const artifact = testInfo.outputPath("home-user-agent.json");
    await fs.writeFile(artifact, JSON.stringify({
      withoutUserAgent: { status: bare.status, sentHeaders: bare.sentHeaders, headOgTags: ogTags(bare.head), headHasTitle: bare.head.includes("<title>") },
      withUserAgent: { status: browser.status, sentHeaders: browser.sentHeaders, headOgTags: ogTags(browser.head), headHasTitle: browser.head.includes("<title>") },
    }, null, 2));
    await testInfo.attach("home-user-agent", { path: artifact, contentType: "application/json" });
    expect(bare.sentHeaders).not.toContain("user-agent");
    expect(bare.status).toBe(200);
    expect(bare.head).toContain('property="og:title"');
    expect(bare.head).toContain("<title>");
    expect(browser.status).toBe(200);
    expect(ogTags(browser.head).length).toBeGreaterThan(0);
    expect(ogTags(bare.head)).toEqual(ogTags(browser.head));
  });

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

  for (const path of ["/about", "/contact", "/privacy", "/booking", "/payment", "/faq", "/reviews"]) {
    test(`${path} is not CDN cached by the home page rule`, async ({ request }, testInfo) => {
      const page = await served(request, testInfo, `page${path.replace(/\//g, "-")}`, path);
      expect(page.value("vercel-cdn-cache-control") ?? "").not.toContain("s-maxage");
    });
  }
});
