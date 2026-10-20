const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const http = require("node:http");
const { PREBUILT_ROUTES } = require("../src/lib/routes");

const HOME_CACHE = /^s-maxage=60, stale-while-revalidate=\d+$/;
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

test.describe("home page caching", () => {
  for (const method of ["GET", "HEAD"]) {
    test(`${method} / is served from the prebuilt page cache only`, async ({ request }, testInfo) => {
      const home = await served(request, testInfo, `home-${method.toLowerCase()}`, "/", { method });
      expect(home.status).toBe(200);
      expect(home.value("cache-control")).toMatch(HOME_CACHE);
      expect(home.value("cdn-cache-control")).toBeNull();
      expect(home.value("vercel-cdn-cache-control")).toBeNull();
      expect(home.value("set-cookie")).toBeNull();
    });
  }

  for (const path of PREBUILT_ROUTES) {
    const name = path === "/" ? "home" : path.slice(1);
    test(`a campaign query on ${path} gets the same response headers as ${path}`, async ({ request }, testInfo) => {
      const plain = await served(request, testInfo, `${name}-plain`, path);
      const campaign = await served(request, testInfo, `${name}-utm`, `${path}?utm_source=newsletter&ref=friend`);
      expect(campaign.status).toBe(200);
      if (path === "/") expect(campaign.value("cache-control")).toMatch(HOME_CACHE);
      for (const key of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control", "content-type", "vary", "x-nextjs-prerender", "set-cookie"]) {
        expect(campaign.value(key), key).toBe(plain.value(key));
      }
    });

    test(`an RSC request with a query on ${path} still gets the RSC payload`, async ({ request }, testInfo) => {
      const response = await served(request, testInfo, `${name}-rsc-query`, `${path}?ref=friend&_rsc=abc12`, { headers: { ...HTML, rsc: "1" } });
      expect(response.status).toBe(200);
      expect(response.value("content-type")).toContain("text/x-component");
    });
  }

  for (const [name, headers] of [
    ["rsc", { rsc: "1" }],
    ["next-router-prefetch", { rsc: "1", "next-router-prefetch": "1" }],
    ["next-router-state-tree", { rsc: "1", "next-router-state-tree": "%5B%22%22%5D" }],
    ["next-router-segment-prefetch", { rsc: "1", "next-router-prefetch": "1", "next-router-segment-prefetch": "/_tree" }],
  ]) {
    test(`a ${name} request for / still gets the RSC payload`, async ({ request }, testInfo) => {
      const response = await served(request, testInfo, `home-${name}`, "/", { headers: { ...HTML, ...headers } });
      expect(response.status).toBe(200);
      expect(response.value("content-type")).toContain("text/x-component");
      expect(response.value("cdn-cache-control")).toBeNull();
      expect(response.value("vercel-cdn-cache-control")).toBeNull();
    });
  }

  test("a request for / with next-action carries no CDN cache header", async ({ request }, testInfo) => {
    const response = await served(request, testInfo, "home-next-action", "/", { headers: { ...HTML, "next-action": "x" } });
    expect(response.value("cdn-cache-control")).toBeNull();
    expect(response.value("vercel-cdn-cache-control")).toBeNull();
  });

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

  for (const path of ["/", "/about", "/contact", "/privacy"]) {
    test(`the markdown representation of ${path} is not CDN cached`, async ({ request }, testInfo) => {
      const name = path === "/" ? "home" : path.slice(1);
      for (const [label, url] of [["plain", path], ["campaign", `${path}?utm_source=newsletter`]]) {
        const markdown = await served(request, testInfo, `${name}-markdown-${label}`, url, { headers: { accept: "text/markdown" } });
        expect(markdown.status).toBe(200);
        expect(markdown.value("content-type")).toContain("text/markdown");
        expect(markdown.value("cache-control")).toContain("no-store");
        expect(markdown.value("cdn-cache-control")).toBe("no-store");
        expect(markdown.value("vercel-cdn-cache-control")).toBe("no-store");
        expect(markdown.value("x-nextjs-prerender")).toBeNull();
      }
    });
  }

  test("the redirect that strips private parameters from / is not CDN cached", async ({ request, baseURL }, testInfo) => {
    const redirect = await served(request, testInfo, "home-token", "/?token=abc");
    expect(redirect.status).toBe(307);
    expect(new URL(redirect.value("location"), baseURL).searchParams.has("token")).toBe(false);
    expect(redirect.value("vercel-cdn-cache-control")).toBe("no-store");
  });

  for (const path of ["/about", "/contact", "/privacy"]) {
    for (const method of ["GET", "HEAD"]) {
      test(`${method} ${path} gets the same caching as /`, async ({ request }, testInfo) => {
        const name = `${path.slice(1)}-${method.toLowerCase()}`;
        const home = await served(request, testInfo, `home-for-${name}`, "/", { method });
        const pages = [
          await served(request, testInfo, `page-${name}`, path, { method }),
          await served(request, testInfo, `page-${name}-utm`, `${path}?utm_source=newsletter`, { method }),
        ];
        for (const page of pages) {
          expect(page.status).toBe(200);
          expect(page.value("cache-control")).toMatch(HOME_CACHE);
          expect(page.value("x-nextjs-prerender")).toMatch(/^1(, 1)*$/);
          for (const key of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control", "content-type", "vary", "set-cookie"]) {
            expect(page.value(key), key).toBe(home.value(key));
          }
        }
      });
    }
  }

  for (const path of ["/booking", "/payment", "/faq", "/reviews"]) {
    test(`${path} is not cached at the CDN`, async ({ request }, testInfo) => {
      const page = await served(request, testInfo, `page${path.replace(/\//g, "-")}`, path);
      expect(page.value("vercel-cdn-cache-control") ?? "").not.toContain("s-maxage");
    });
  }
});
