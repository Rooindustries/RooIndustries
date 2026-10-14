import { writeFileSync } from "node:fs";

const base = process.argv[2];
const artifact = process.argv[3] || "home-cdn-cache-check.json";
if (!base || !/^https:\/\//.test(base)) {
  console.error("Usage: node scripts/check-home-cdn-cache.mjs https://<deployment host> [artifact.json]");
  process.exit(2);
}

const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const HTML = { accept: "text/html,application/xhtml+xml", "user-agent": BROWSER_UA };
const stamp = Date.now();
const log = [];
const failures = [];

async function hit(name, path, { method = "GET", headers = HTML } = {}) {
  const response = await fetch(new URL(path, base), { method, headers, redirect: "manual" });
  const body = method === "HEAD" ? "" : await response.text();
  const entry = {
    name,
    path,
    method,
    status: response.status,
    cache: response.headers.get("x-vercel-cache"),
    age: response.headers.get("age"),
    contentType: response.headers.get("content-type"),
    location: response.headers.get("location"),
    setCookie: response.headers.get("set-cookie"),
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

const key = `/?utm_source=cdncheck${stamp}`;
const first = await hit("html first", key);
const second = await hit("html second", key);
for (const entry of [first, second]) {
  check(entry.status === 200, "home HTML returns 200", entry);
  check(String(entry.contentType).includes("text/html"), "home HTML is text/html", entry);
  check(!entry.setCookie, "home HTML sets no cookie", entry);
}
check(second.cache === "HIT", "a repeated home HTML request is a CDN hit", second);
check(headPart(second.body).includes('property="og:title"'), "cached home HTML keeps og:title in <head>", second);

const rsc = await hit("rsc on cached key", key, { headers: { ...HTML, rsc: "1" } });
check(String(rsc.contentType).includes("text/x-component"), "RSC request gets an RSC payload", rsc);
check(!cached(rsc), "RSC request is never served from the CDN cache", rsc);

const markdown = await hit("markdown on cached key", key, { headers: { accept: "text/markdown", "user-agent": BROWSER_UA } });
check(String(markdown.contentType).includes("text/markdown"), "markdown request gets markdown", markdown);
check(!cached(markdown), "markdown is never served from the CDN cache", markdown);

const after = await hit("html after rsc and markdown", key);
check(String(after.contentType).includes("text/html") && after.cache === "HIT", "HTML key still serves cached HTML", after);

const headKey = `/?utm_source=cdnhead${stamp}`;
await hit("head first", headKey, { method: "HEAD" });
const afterHead = await hit("get after head", headKey);
check(afterHead.status === 200 && afterHead.bytes > 10000 && String(afterHead.contentType).includes("text/html"), "a HEAD request does not leave an empty body for GET", afterHead);

const noUaKey = `/?utm_source=cdnnoua${stamp}`;
const noUa = await hit("no user agent", noUaKey, { headers: { accept: "text/html", "user-agent": "" } });
check(headPart(noUa.body).includes('property="og:title"'), "a request without a user agent keeps og:title in <head>", noUa);

const tokenPath = `/?token=probe${stamp}`;
for (const name of ["token first", "token second"]) {
  const redirect = await hit(name, tokenPath);
  check(redirect.status === 307, "private parameters redirect with 307", redirect);
  check(redirect.location && !new URL(redirect.location, base).searchParams.has("token"), "redirect drops the token", redirect);
  check(!cached(redirect), "the private-parameter redirect is never served from the CDN cache", redirect);
}

for (const path of ["/about", "/faq"]) {
  await hit(`${path} first`, path);
  const repeat = await hit(`${path} second`, path);
  check(!cached(repeat), `${path} is never served from the CDN cache`, repeat);
}

writeFileSync(artifact, JSON.stringify({ base, checkedAt: new Date(stamp).toISOString(), log, failures }, null, 2));
for (const entry of log) console.log(`${entry.name.padEnd(28)} ${entry.status} ${String(entry.cache).padEnd(6)} ${entry.contentType || ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.message}`);
  process.exit(1);
}
console.log(`PASS ${log.length} requests, artifact ${artifact}`);
