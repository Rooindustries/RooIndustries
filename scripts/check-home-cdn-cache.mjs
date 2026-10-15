import { writeFileSync } from "node:fs";

const base = process.argv[2];
const artifact = process.argv[3] || "home-cdn-cache-check.json";
const usage = "Usage: node scripts/check-home-cdn-cache.mjs https://<deployment host> [artifact.json] ['{\"header\":\"value\"}']";
if (!base || !/^https:\/\//.test(base)) {
  console.error(usage);
  process.exit(2);
}
let extraHeaders = {};
if (process.argv[4] !== undefined) {
  try {
    extraHeaders = JSON.parse(process.argv[4]);
  } catch {
    extraHeaders = null;
  }
  if (!extraHeaders || typeof extraHeaders !== "object" || Array.isArray(extraHeaders) || Object.values(extraHeaders).some((value) => typeof value !== "string")) {
    console.error("Extra request headers must be a JSON object of string values.");
    console.error(usage);
    process.exit(2);
  }
}

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const HTML = { accept: "text/html,application/xhtml+xml", "user-agent": BROWSER_UA };
const stamp = Date.now();
const log = [];
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hit(name, path, { method = "GET", headers = HTML } = {}) {
  const response = await fetch(new URL(path, base), { method, headers: { ...extraHeaders, ...headers }, redirect: "manual" });
  const body = method === "HEAD" ? "" : await response.text();
  const entry = {
    name,
    path,
    method,
    status: response.status,
    cache: response.headers.get("x-vercel-cache"),
    age: response.headers.get("age"),
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    setCookies: response.headers.getSetCookie().map((cookie) => cookie.split("=")[0].trim()),
    bytes: body.length,
  };
  log.push(entry);
  return { ...entry, body };
}

function check(condition, message, entry) {
  if (!condition) failures.push({ message, entry: { ...entry, body: undefined } });
}

const cached = (entry) => entry.cache === "HIT" || entry.cache === "STALE";
const headPart = (body) => body.split("</head>")[0];
const isHtml = (entry) => String(entry.contentType).includes("text/html");
const isHomeHtml = (entry) => entry.method === "GET" && new URL(entry.path, base).pathname === "/" && isHtml(entry);

const key = `/?utm_source=cdncheck${stamp}`;
const first = await hit("html first", key);
check(first.status === 200 && isHtml(first), "home HTML returns 200 text/html", first);

const second = await hit("html second", key);
check(second.status === 200 && isHtml(second), "home HTML returns 200 text/html", second);
check(cached(second), "a repeated home HTML request is served from cache", second);
check(headPart(second.body).includes('property="og:title"'), "cached home HTML keeps og:title in <head>", second);

const rsc = await hit("rsc on the same key", key, { headers: { ...HTML, rsc: "1" } });
check(String(rsc.contentType).includes("text/x-component"), "RSC request gets an RSC payload", rsc);
const afterRsc = await hit("html after rsc", key);
check(afterRsc.status === 200 && isHtml(afterRsc), "HTML request after an RSC request still gets HTML", afterRsc);

const markdown = await hit("markdown on the same key", key, { headers: { accept: "text/markdown", "user-agent": BROWSER_UA } });
check(String(markdown.contentType).includes("text/markdown"), "markdown request gets markdown", markdown);
check(!cached(markdown), "markdown is never served from cache", markdown);
const afterMarkdown = await hit("html after markdown", key);
check(afterMarkdown.status === 200 && isHtml(afterMarkdown), "HTML request after a Markdown request still gets HTML", afterMarkdown);

const headKey = `/?utm_source=cdnhead${stamp}`;
await hit("head first", headKey, { method: "HEAD" });
const afterHead = await hit("get after head", headKey);
check(afterHead.status === 200 && afterHead.bytes > 10000 && isHtml(afterHead), "a HEAD request does not leave an empty body for GET", afterHead);

const noUaKey = `/?utm_source=cdnnoua${stamp}`;
const noUa = await hit("no user agent", noUaKey, { headers: { accept: "text/html", "user-agent": "" } });
check(headPart(noUa.body).includes('property="og:title"'), "a request without a user agent keeps og:title in <head>", noUa);

const tokenPath = `/?token=probe${stamp}`;
for (const name of ["token first", "token second"]) {
  const redirect = await hit(name, tokenPath);
  check(redirect.status === 307, "private parameters redirect with 307", redirect);
  check(redirect.location && !new URL(redirect.location, base).searchParams.has("token"), "redirect drops the token", redirect);
  check(!cached(redirect), "the private-parameter redirect is never served from cache", redirect);
}

for (const path of ["/about", "/faq"]) {
  await hit(`${path} first`, path);
  const repeat = await hit(`${path} second`, path);
  check(!cached(repeat), `${path} is never served from cache`, repeat);
}

const ageProbe = await hit("age probe", "/");
const age = Number(ageProbe.age) || 0;
const waitSeconds = age < 61 ? 61 - age : 0;
console.log(`Waiting ${waitSeconds}s for the home page to go stale before the leak check`);
await sleep(waitSeconds * 1000);
const leakToken = `leak${stamp}`;
await hit("leak trigger", `/?ref=${leakToken}&gclid=${leakToken}`);
await sleep(5000);
const leakHtml = await hit("html after leak trigger", "/");
const leakRsc = await hit("rsc after leak trigger", "/", { headers: { ...HTML, rsc: "1" } });
check(!leakHtml.body.includes(leakToken), "a rebuild triggered by a query keeps that query out of the home HTML", leakHtml);
check(!leakRsc.body.includes(leakToken), "a rebuild triggered by a query keeps that query out of the home RSC payload", leakRsc);

for (const entry of log.filter(isHomeHtml)) {
  check(entry.setCookies.every((name) => name === "_vercel_jwt"), "home HTML sets no cookie", entry);
  check(/max-age=0|no-cache|no-store/.test(entry.cacheControl || "") && !/s-maxage/.test(entry.cacheControl || ""), "home HTML reaches clients with max-age=0 and no s-maxage", entry);
}

writeFileSync(artifact, JSON.stringify({ base, checkedAt: new Date(stamp).toISOString(), extraHeaderNames: Object.keys(extraHeaders), log, failures }, null, 2));
for (const entry of log) console.log(`${entry.name.padEnd(28)} ${entry.status} ${String(entry.cache).padEnd(9)} ${entry.contentType || ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.message}`);
  process.exit(1);
}
console.log(`PASS ${log.length} requests, artifact ${artifact}`);
