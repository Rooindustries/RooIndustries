import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import routes from "../src/lib/routes.js";

const baseUrl = process.env.BASE_URL;
if (!baseUrl) throw new Error("BASE_URL is required for agent-readiness checks");
const get = (path, accept = "text/html", method = "GET") => fetch(new URL(path, baseUrl), {
  method,
  headers: { Accept: accept },
  signal: AbortSignal.timeout(30000),
});
const contentHtml = (html) => html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
const textContent = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const hasAcceptVary = (response) => assert.ok(response.headers.get("vary")?.toLowerCase().split(/,\s*/).includes("accept"));
const hasSafeCache = (response) => {
  if (response.headers.get("content-type")?.startsWith("text/html")) {
    assert.match(response.headers.get("cache-control") || "", /no-store|no-cache|max-age=0/);
  } else {
    hasAcceptVary(response);
  }
};

for (const path of ["/", "/about", "/contact", "/privacy"]) {
  test(`${path} serves substantial HTML and Markdown with separate representations`, async () => {
    for (const accept of ["text/markdown", "text/html", "text/markdown", "text/html"]) {
      const response = await get(path, accept);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").startsWith(accept));
      hasSafeCache(response);
      const body = await response.text();
      if (accept === "text/html") {
        assert.equal(response.headers.get("cdn-cache-control"), "no-store");
        const html = contentHtml(body);
        const headings = [...html.matchAll(/<h([1-6])\b[^>]*>/gi)].map((match) => Number(match[1]));
        assert.equal(headings[0], 1);
        assert.equal(headings.filter((level) => level === 1).length, 1);
        headings.forEach((level, i) => { if (i) assert.ok(level <= headings[i - 1] + 1); });
        const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => textContent(match[1])).join(" ");
        assert.ok(paragraphs.length >= 500, `${path}: ${paragraphs.length} paragraph characters`);
      } else {
        assert.match(body, /^# /);
        assert.ok(body.length >= 500);
        assert.doesNotMatch(body, /<script|<!doctype|<html/i);
      }
    }
    for (const accept of ["text/html", "text/markdown"]) {
      const response = await get(path, accept, "HEAD");
      assert.equal(response.status, 200);
      assert.ok(response.headers.get("content-type").startsWith(accept));
      hasSafeCache(response);
      assert.equal(await response.text(), "");
    }
  });
}

test("Accept quality, exclusion, and unsupported media types", async () => {
  for (const [accept, type, status] of [
    ["*/*", "text/html", 200],
    ["text/markdown; charset=utf-8", "text/markdown", 200],
    ["text/markdown;q=0.3,text/html;q=0.9", "text/html", 200],
    ["text/markdown;q=0.9,text/html;q=0.3", "text/markdown", 200],
    ["text/markdown;q=0,*/*;q=0.5", "text/html", 200],
    ["application/json", "text/plain", 406],
    ["text/html;q=0,text/markdown;q=0", "text/plain", 406],
  ]) {
    const response = await get("/", accept);
    assert.equal(response.status, status, accept);
    assert.ok(response.headers.get("content-type").startsWith(type), accept);
    hasSafeCache(response);
    await response.text();
  }
});

test("missing paths keep 404 status and offer recovery in Markdown", async () => {
  for (const path of ["/agent-readiness-nonexistent", "/nested/agent-readiness-nonexistent", "/agent-readiness-nonexistent.txt", "/agent-readiness-nonexistent.png"]) {
    for (const accept of ["*/*", "text/markdown", "text/html"]) {
      const response = await get(path, accept);
      assert.equal(response.status, 404, path);
      hasSafeCache(response);
      const body = await response.text();
      if (accept !== "text/html") {
        assert.match(response.headers.get("cache-control") || "", /no-store/);
        assert.ok(response.headers.get("content-type").startsWith("text/markdown"));
        for (const link of ["/sitemap.xml", "/llms.txt", "/contact"]) assert.ok(body.includes(link));
      } else {
        assert.match(body, /Back to Home/);
      }
    }
    const head = await get(path, "text/markdown", "HEAD");
    assert.equal(head.status, 404);
    assert.equal(await head.text(), "");
  }
});

test("framework assets keep their cache policy without caching missing chunks", async () => {
  const home = await get("/");
  const html = await home.text();
  const source = html.match(/<script[^>]*src="(\/_next\/static\/[^\"]+\.js(?:\?[^\"]*)?)"/)[1];
  const script = await get(source, "*/*", "HEAD");
  assert.equal(script.status, 200);
  if (process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production") {
    assert.match(script.headers.get("cache-control") || "", /max-age=31536000/);
  }
  const missing = await get("/_next/static/agent-readiness-nonexistent.js", "*/*");
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get("cache-control") || "", /no-store|no-cache|max-age=0/);
  await missing.text();
});

test("asset URLs remove sensitive parameters and retain their bytes and content type", async () => {
  const path = "/favicon-96x96.png";
  const response = await fetch(new URL(`${path}?paymenttoken=example&email=example&v=1`, baseUrl), {
    redirect: "manual",
    headers: { Accept: "text/markdown" },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location"), baseUrl);
  assert.equal(location.pathname, path);
  assert.equal(location.search, "?v=1");
  for (const accept of ["image/png", "text/markdown"]) {
    const image = await get(path, accept);
    assert.equal(image.status, 200);
    assert.ok(image.headers.get("content-type").startsWith("image/png"));
    if (process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production") {
      assert.match(image.headers.get("cache-control") || "", /max-age=31536000/);
    }
    assert.ok(!image.headers.get("vary")?.toLowerCase().split(/,\s*/).includes("accept"));
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), readFileSync(new URL(`../public${path}`, import.meta.url)));
  }
});

test("published public routes, discovery files, and their local links resolve", async () => {
  const llms = await get("/llms.txt", "text/plain");
  assert.equal(llms.status, 200);
  assert.ok(llms.headers.get("content-type").startsWith("text/plain"));
  const instructions = await llms.text();
  assert.match(instructions, /^# Roo Industries\n\n> /);
  assert.match(instructions, /## When to use this/);
  const sitemap = await get("/sitemap.xml", "application/xml");
  assert.equal(sitemap.status, 200);
  const xml = await sitemap.text();
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  const robots = await get("/robots.txt", "text/plain");
  assert.equal(robots.status, 200);
  const robotsText = await robots.text();
  if (process.env.VERCEL_ENV === "preview") {
    assert.match(robotsText, /User-agent: \*\nDisallow: \//);
  } else {
    assert.match(robotsText, /Sitemap: https:\/\/www.rooindustries.com\/sitemap.xml/);
  }
  const linkedPaths = [
    ...instructions.matchAll(/\]\((https:\/\/www\.rooindustries\.com[^)]+)\)/g),
    ...xml.matchAll(/<loc>([^<]+)<\/loc>/g),
  ].map((match) => new URL(match[1]).pathname);
  const paths = new Set([...routes.ALL_PUBLIC_ROUTES, "/BIOSGuide", "/markdown", ...linkedPaths]);
  assert.ok(linkedPaths.includes("/about"));
  for (const path of paths) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    await response.text();
  }
});

test("Organization JSON-LD publishes support details without a fabricated address", async () => {
  const response = await get("/");
  const html = await response.text();
  const data = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
  const organization = data.find((item) => item["@type"] === "Organization");
  assert.equal(organization.contactPoint["@type"], "ContactPoint");
  assert.equal(organization.contactPoint.email, "serviroo@rooindustries.com");
  assert.equal(organization.contactPoint.contactType, "customer support");
  assert.equal(organization.address, undefined);
});
