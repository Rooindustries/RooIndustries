import fs from "node:fs";
import { isIP } from "node:net";

const PRODUCTION = "https://www.rooindustries.com";
const MONEY_PAGES = ["/", "/packages", "/booking", "/payment"];
const REFERRAL_CODE = "roo-smoke-check";
const ATTEMPTS = 3;
const RETRY_MS = Number(process.env.SMOKE_RETRY_MS || 10000);
const SMOKE_DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MS || 180000);
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS || 20000);
const PRICE_PATTERN = /^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/;

class Refusal extends Error {}

// The runner could not reach the site at all (DNS, TLS, refused or reset connections, a dead browser).
// A deployment can't cause these, so they mean "the smoke could not run", never a money-path failure.
class CouldNotRun extends Error {}
// Node's fetch reports every network-level failure as a TypeError: "fetch failed" before a response arrives,
// "terminated" when the connection drops mid-body. Only its own header and body timeouts mean the site was slow.
const SITE_TIMEOUTS = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const asRunnerFault = (error, what) => {
  if (error instanceof CouldNotRun) return error;
  const fetchTransport = error?.name === "TypeError" && /^(?:fetch failed|terminated)$/.test(error.message) &&
    !SITE_TIMEOUTS.has(error.cause?.code);
  const transport = fetchTransport || /net::ERR_/.test(String(error?.message));
  return transport ? new CouldNotRun(`couldn't reach ${what}: ${error.cause?.code || error.cause?.message || error.message}`) : error;
};

const parseArgs = (argv) => {
  const options = { base: PRODUCTION };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base" && argv[index + 1]) {
      options.base = argv[index + 1];
      index += 1;
    } else {
      throw new Refusal(`unknown option "${argv[index]}". Usage: npm run smoke:production [-- --base <url>]`);
    }
  }
  return options;
};

const isPrivateHost = (hostname) => {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  if (isIP(hostname) !== 4) return false;
  const [a, b] = hostname.split(".").map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

const resolveBase = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal(`"${value}" is not a URL.`);
  }
  if (url.origin === PRODUCTION) return url.origin;
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) return url.origin;
  throw new Refusal(`the smoke only runs against ${PRODUCTION} or a local test server, not ${url.origin}.`);
};

const getWithRetries = async (url, check) => {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      return await check(response);
    } catch (error) {
      lastError = asRunnerFault(error, url);
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw lastError;
};

const expectHtml = async (response) => {
  if (response.status !== 200) throw new Error(`answered ${response.status}`);
  if (!String(response.headers.get("content-type")).includes("text/html")) throw new Error(`answered ${response.headers.get("content-type")}`);
  await response.arrayBuffer();
};

const expectAvailability = async (response) => {
  if (response.status !== 200) throw new Error(`answered ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true) throw new Error("answered ok: false");
  if (!Array.isArray(body?.settings?.dateSlots)) throw new Error("has no dateSlots list");
  if (!Array.isArray(body?.bookedSlots)) throw new Error("has no bookedSlots list");
};

const allowOnlyGet = (context) => context.route("**/*", (route) =>
  route.request().method() === "GET" ? route.continue() : route.abort());

// Each browser check gets its own GET-only page. If a check fails after one of the site's own GET requests never
// arrived (a script or page lost to a reset, refused or timed-out connection), the runner couldn't load the page,
// so the failure says nothing about the deploy. Navigation-cancelled requests (net::ERR_ABORTED) don't count.
const withSmokePage = async (browser, base, contextOptions, check) => {
  const context = await browser.newContext(contextOptions);
  const lost = [];
  try {
    await allowOnlyGet(context);
    const page = await context.newPage();
    const origin = new URL(base).origin;
    page.on("requestfailed", (request) => {
      const reason = request.failure()?.errorText || "";
      if (request.method() === "GET" && new URL(request.url()).origin === origin && reason !== "net::ERR_ABORTED") {
        lost.push(`${new URL(request.url()).pathname} (${reason || "failed"})`);
      }
    });
    return await check(page);
  } catch (error) {
    if (lost.length && !(error instanceof CouldNotRun)) throw new CouldNotRun(`couldn't load ${lost[0]}: ${error.message}`);
    throw error;
  } finally {
    await context.close();
  }
};

const nodes = (value) => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
};

const checkPrices = (browser, base) => withSmokePage(browser, base, { javaScriptEnabled: false }, async (page) => {
    const response = await page.goto(`${base}/packages`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages answered ${response?.status()}`);
    const cards = await page.locator(".ri-package-card").evaluateAll((elements) => elements.map((card) => ({
      name: card.querySelector("h3")?.textContent?.trim() || "",
      price: card.querySelector(".ri-price-current")?.textContent?.trim() || "",
    })));
    if (!cards.length) throw new Error("no package cards rendered");
    const unpriced = cards.filter((card) => !card.name || !PRICE_PATTERN.test(card.price));
    if (unpriced.length) throw new Error(`cards without a name or price: ${JSON.stringify(unpriced)}`);
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const offers = nodes(scripts.map((text) => JSON.parse(text))).filter((node) => node["@type"] === "Offer");
    const published = offers.map((offer) => ({ name: offer.itemOffered?.name, price: Number(offer.price) }));
    const shown = cards.map((card) => ({ name: card.name, price: Number(card.price.replace(/[$,]/g, "")) }));
    if (JSON.stringify(published) !== JSON.stringify(shown)) {
      throw new Error(`structured data offers ${JSON.stringify(published)} don't match the cards ${JSON.stringify(shown)}`);
    }
    return `${cards.length} packages priced`;
});

const APP_ERROR_PATTERN = /application error|client-side exception|internal server error/i;
const FLOW_MARKERS = {
  "/booking": "Select a Date and Time for Your Session",
  "/payment": "Booking Summary",
};

const checkPageRenders = (browser, base, pathname) => withSmokePage(browser, base, {}, async (page) => {
    const response = await page.goto(`${base}${pathname}`, { waitUntil: "load", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`${pathname} answered ${response?.status()}`);
    await page.waitForFunction(() => document.body.innerText.trim().length >= 20, null, { timeout: 15000 })
      .catch(() => { throw new Error(`${pathname} rendered no visible content`); });
    const text = await page.evaluate(() => document.body.innerText);
    if (APP_ERROR_PATTERN.test(text)) throw new Error(`${pathname} shows an application error`);
    const marker = FLOW_MARKERS[pathname];
    if (marker) {
      await page.waitForFunction((expected) => document.body.innerText.includes(expected), marker, {
        timeout: Number(process.env.SMOKE_MARKER_TIMEOUT_MS || 15000),
      }).catch(() => { throw new Error(`${pathname} is missing "${marker}"`); });
    }
    return "renders";
});

const checkReferral = (browser, base) => withSmokePage(browser, base, {}, async (page) => {
    const response = await page.goto(`${base}/packages?ref=${REFERRAL_CODE}`, { waitUntil: "load", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages?ref answered ${response?.status()}`);
    await page.waitForFunction((code) => window.sessionStorage.getItem("referral_session") === code, REFERRAL_CODE, { timeout: 15000 })
      .catch(() => { throw new Error("the ?ref code was not remembered for checkout"); });
    return "code remembered";
});

const withBrowserRetries = async (browser, base, check) => {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await check(browser, base);
    } catch (error) {
      lastError = browser.isConnected() ? asRunnerFault(error, base) : new CouldNotRun(`the browser closed: ${error.message}`);
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw lastError;
};

const main = async () => {
  const base = resolveBase(parseArgs(process.argv.slice(2)).base);
  const deadline = Date.now() + SMOKE_DEADLINE_MS;
  const withinDeadline = async (run) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CouldNotRun("the smoke deadline passed");
    let timer;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new CouldNotRun("the smoke deadline passed")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const checks = [
    ...MONEY_PAGES.map((path) => [`page ${path}`, () => getWithRetries(`${base}${path}`, expectHtml)]),
    ["booking availability", () => getWithRetries(`${base}/api/bookingAvailability`, expectAvailability)],
  ];
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    throw new Error(`Playwright is not installed: ${error.message}`);
  }
  const browser = await chromium.launch();
  const results = [];
  try {
    checks.push(
      ["package prices", () => withBrowserRetries(browser, base, checkPrices)],
      ["referral capture", () => withBrowserRetries(browser, base, checkReferral)],
      ["booking page renders", () => withBrowserRetries(browser, base, (b, url) => checkPageRenders(b, url, "/booking"))],
      ["payment page renders", () => withBrowserRetries(browser, base, (b, url) => checkPageRenders(b, url, "/payment"))],
    );
    for (const [name, run] of checks) {
      try {
        const detail = await withinDeadline(run);
        results.push({ name, ok: true, detail: detail || "" });
        console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
      } catch (error) {
        // Running out of the smoke's own time budget is the runner's problem; only evidence from the site counts against a deploy.
        const fault = browser.isConnected() || error instanceof CouldNotRun ? error : new CouldNotRun(`the browser closed: ${error.message}`);
        if (fault instanceof CouldNotRun) {
          results.push({ name, ok: false, couldNotRun: true, detail: fault.message });
          console.log(`SKIP  ${name}: ${fault.message}`);
          if (!browser.isConnected() || Date.now() >= deadline) break;
          continue;
        }
        results.push({ name, ok: false, detail: error.message });
        console.log(`FAIL  ${name}: ${error.message}`);
        if (Date.now() >= deadline) break;
      }
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((result) => !result.ok && !result.couldNotRun);
  const unreachable = results.filter((result) => result.couldNotRun);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((result) => `| ${result.ok ? "ok" : result.couldNotRun ? "SKIP" : "FAIL"} | ${result.name} | ${result.detail.replace(/\|/g, "\\|")} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Money-path smoke on ${base}`, "", "| Result | Check | Detail |", "| --- | --- | --- |", ...rows, ""].join("\n"));
  }
  if (failed.length) console.log(`${failed.length} money-path check(s) failed on ${base}.`);
  else if (unreachable.length) console.log(`Smoke could not run: ${unreachable.length} check(s) couldn't reach ${base} from this runner.`);
  else console.log(`All money-path checks passed on ${base}.`);
  const code = failed.length ? 2 : unreachable.length ? 1 : 0;
  if (Date.now() >= deadline) {
    await browser.close().catch(() => {});
    process.exit(code);
  }
  process.exitCode = code;
};

main().catch((error) => {
  console.error(error instanceof Refusal ? `Refusing: ${error.message}` : `Smoke could not run: ${error.message}`);
  process.exitCode = 1;
});
