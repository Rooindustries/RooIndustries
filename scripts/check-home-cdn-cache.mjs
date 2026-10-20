import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const base = process.argv[2];
const artifact = process.argv[3] || "test-results/home-cdn-cache-check.json";
const usage = "Usage: npm run check:cdn -- https://<deployment host> [artifact.json] ['{\"header\":\"value\"}']";
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
    cdnCacheControl: response.headers.get("cdn-cache-control"),
    contentType: response.headers.get("content-type"),
    vary: response.headers.get("vary"),
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

const cached = (entry) => ["HIT", "STALE", "PRERENDER"].includes(entry.cache);
const noStore = (entry) => /no-store/.test(entry.cacheControl || "") && /no-store/.test(entry.cdnCacheControl || "no-store");
const headPart = (body) => body.split("</head>")[0];
const isHtml = (entry) => String(entry.contentType).includes("text/html");
const isMarkdown = (entry) => String(entry.contentType).includes("text/markdown");
const variesOnAccept = (entry) => String(entry.vary || "").toLowerCase().split(/,\s*/).includes("accept");
const MARKDOWN = { accept: "text/markdown", "user-agent": BROWSER_UA };
const PREBUILT_PATHS = ["/", "/about", "/contact", "/privacy"];
const isPrebuiltHtml = (entry) => entry.method === "GET" && PREBUILT_PATHS.includes(new URL(entry.path, base).pathname) && isHtml(entry);

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

let homeHtmlVary;
for (const path of PREBUILT_PATHS) {
  const htmlFirst = `${path}?utm_source=cdnhtmlfirst${stamp}`;
  const html = [await hit(`${path} html`, htmlFirst)];
  const repeat = await hit(`${path} html again`, htmlFirst);
  html.push(repeat);
  check(cached(repeat), `a repeated ${path} HTML request is served from cache`, repeat);
  const markdown = [await hit(`${path} markdown after html`, htmlFirst, { headers: MARKDOWN })];
  html.push(await hit(`${path} html after markdown`, htmlFirst));
  const rsc = await hit(`${path} rsc`, htmlFirst, { headers: { ...HTML, rsc: "1" } });
  check(rsc.status === 200 && String(rsc.contentType).includes("text/x-component"), `${path} RSC request gets an RSC payload`, rsc);
  html.push(await hit(`${path} html after rsc`, htmlFirst));

  const markdownFirst = `${path}?utm_source=cdnmarkdownfirst${stamp}`;
  markdown.push(await hit(`${path} markdown first`, markdownFirst, { headers: MARKDOWN }));
  html.push(await hit(`${path} html after markdown first`, markdownFirst));
  markdown.push(await hit(`${path} markdown after html`, markdownFirst, { headers: MARKDOWN }));

  const headKey = `${path}?utm_source=cdnhead${stamp}`;
  const headHtml = await hit(`${path} head html`, headKey, { method: "HEAD" });
  check(headHtml.status === 200 && isHtml(headHtml), `HEAD ${path} gets text/html`, headHtml);
  markdown.push(await hit(`${path} head markdown`, headKey, { method: "HEAD", headers: MARKDOWN }));
  html.push(await hit(`${path} get after head`, headKey));

  const unsupportedKey = `${path}?utm_source=cdnunsupported${stamp}`;
  for (const name of ["first", "second"]) {
    const unsupported = await hit(`${path} json ${name}`, unsupportedKey, { headers: { accept: "application/json", "user-agent": BROWSER_UA } });
    check(unsupported.status === 406, `${path} answers an unsupported Accept with 406`, unsupported);
    check(!cached(unsupported) && noStore(unsupported), `the ${path} 406 is never cached`, unsupported);
    check(variesOnAccept(unsupported), `the ${path} 406 varies on Accept`, unsupported);
  }
  html.push(await hit(`${path} html after 406`, unsupportedKey));

  for (const entry of html) {
    check(entry.status === 200 && isHtml(entry) && entry.bytes > 10000, `${path} HTML request gets the full HTML page`, entry);
    if (path === "/" && homeHtmlVary === undefined) homeHtmlVary = entry.vary;
    check(entry.vary === homeHtmlVary, `${path} HTML varies like / HTML`, entry);
  }
  for (const entry of markdown) {
    check(entry.status === 200 && isMarkdown(entry), `${path} Markdown request gets Markdown`, entry);
    check(!cached(entry) && noStore(entry), `${path} Markdown is never cached`, entry);
    check(variesOnAccept(entry), `${path} Markdown varies on Accept`, entry);
  }
}

let waitSeconds = 0;
for (const path of PREBUILT_PATHS) {
  const ageProbe = await hit(`${path} age probe`, path);
  const age = Number(ageProbe.age) || 0;
  waitSeconds = Math.max(waitSeconds, age < 61 ? 62 - age : 62);
}
console.log(`Waiting ${waitSeconds}s for the prebuilt pages to go stale before the leak check`);
await sleep(waitSeconds * 1000);
const leakToken = `leak${stamp}`;
for (const path of PREBUILT_PATHS) await hit(`${path} leak trigger`, `${path}?ref=${leakToken}&gclid=${leakToken}`);
await sleep(5000);
for (const path of PREBUILT_PATHS) {
  const leakHtml = await hit(`${path} html after leak trigger`, path);
  const leakRsc = await hit(`${path} rsc after leak trigger`, path, { headers: { ...HTML, rsc: "1" } });
  check(!leakHtml.body.includes(leakToken), `a rebuild triggered by a query keeps that query out of the ${path} HTML`, leakHtml);
  check(!leakRsc.body.includes(leakToken), `a rebuild triggered by a query keeps that query out of the ${path} RSC payload`, leakRsc);
}

for (const entry of log.filter(isPrebuiltHtml)) {
  const pathname = new URL(entry.path, base).pathname;
  check(entry.setCookies.every((name) => name === "_vercel_jwt"), `${pathname} HTML sets no cookie`, entry);
  check(/max-age=0|no-cache|no-store/.test(entry.cacheControl || "") && !/s-maxage/.test(entry.cacheControl || ""), `${pathname} HTML reaches clients with max-age=0 and no s-maxage`, entry);
}

mkdirSync(dirname(artifact), { recursive: true });
writeFileSync(artifact, JSON.stringify({ base, checkedAt: new Date(stamp).toISOString(), extraHeaderNames: Object.keys(extraHeaders), log, failures }, null, 2));
for (const entry of log) console.log(`${entry.name.padEnd(40)} ${entry.method.padEnd(4)} ${entry.status} ${String(entry.cache).padEnd(9)} ${String(entry.contentType || "").padEnd(32)} vary: ${entry.vary || ""}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.message}`);
  process.exit(1);
}
console.log(`PASS ${log.length} requests, artifact ${artifact}`);
