import fs from "node:fs";
import { isIP } from "node:net";

const PRODUCTION = "https://www.rooindustries.com";
const MONEY_PAGES = ["/", "/packages", "/booking", "/payment"];
const REFERRAL_CODE = "roo-smoke-check";
const ATTEMPTS = 3;
const RETRY_MS = Number(process.env.SMOKE_RETRY_MS || 10000);
const PRICE_PATTERN = /^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/;

class Refusal extends Error {}

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
      const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(20000) });
      return await check(response);
    } catch (error) {
      lastError = error;
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
};

const allowOnlyGet = (context) => context.route("**/*", (route) =>
  route.request().method() === "GET" ? route.continue() : route.abort());

const nodes = (value) => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
};

const checkPrices = async (browser, base) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await allowOnlyGet(context);
    const page = await context.newPage();
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
  } finally {
    await context.close();
  }
};

const checkReferral = async (browser, base) => {
  const context = await browser.newContext();
  try {
    await allowOnlyGet(context);
    const page = await context.newPage();
    const response = await page.goto(`${base}/packages?ref=${REFERRAL_CODE}`, { waitUntil: "load", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages?ref answered ${response?.status()}`);
    await page.waitForFunction((code) => window.sessionStorage.getItem("referral_session") === code, REFERRAL_CODE, { timeout: 15000 })
      .catch(() => { throw new Error("the ?ref code was not remembered for checkout"); });
    return "code remembered";
  } finally {
    await context.close();
  }
};

const withBrowserRetries = async (browser, base, check) => {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await check(browser, base);
    } catch (error) {
      lastError = error;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw lastError;
};

const main = async () => {
  const base = resolveBase(parseArgs(process.argv.slice(2)).base);
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
    );
    for (const [name, run] of checks) {
      try {
        const detail = await run();
        results.push({ name, ok: true, detail: detail || "" });
        console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
      } catch (error) {
        results.push({ name, ok: false, detail: error.message });
        console.log(`FAIL  ${name}: ${error.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((result) => !result.ok);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((result) => `| ${result.ok ? "ok" : "FAIL"} | ${result.name} | ${result.detail.replace(/\|/g, "\\|")} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Money-path smoke on ${base}`, "", "| Result | Check | Detail |", "| --- | --- | --- |", ...rows, ""].join("\n"));
  }
  console.log(failed.length ? `${failed.length} money-path check(s) failed on ${base}.` : `All money-path checks passed on ${base}.`);
  process.exitCode = failed.length ? 2 : 0;
};

main().catch((error) => {
  console.error(error instanceof Refusal ? `Refusing: ${error.message}` : `Smoke could not run: ${error.message}`);
  process.exitCode = 1;
});
