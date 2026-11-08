import fs from "node:fs";
import {
  smokeRequest, isCiTarget, smokeErrorDetail,
  SmokeResponseError,
} from "./lib/production-smoke-request.mjs";
import { installCheckoutProbe } from "./lib/production-smoke-browser.mjs";
import { isIP } from "node:net";
import { isProductionMonitor } from "./lib/production-monitor.mjs";
import { log, logError, redact, redactObject, redactSecret, deploymentOrigin } from "./lib/production-diagnostics.mjs";

const PRODUCTION = "https://www.rooindustries.com";
const MONEY_PAGES = ["/", "/packages", "/booking", "/payment"];
const REFERRAL_CODE = "roo-smoke-check";
const SMOKE_DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MS || 180000);
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS || 20000);
const PRICE_PATTERN = /^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/;

class Refusal extends Error {}
class CouldNotRun extends Error {}

const activity = { phase: "browser launch", deadline: null, timer: null, requests: new Set() };
let rejectDeadline;
const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
const startDeadline = () => {
  if (activity.deadline) return;
  activity.deadline = Date.now() + SMOKE_DEADLINE_MS;
  activity.timer = setTimeout(() => rejectDeadline(deadlineError()), SMOKE_DEADLINE_MS);
};
const requestStarted = request => {
  activity.requests.add(request);
};
const deadlineError = () => {
  const detail = `the smoke deadline passed during ${activity.phase}`;
  return activity.requests.size ? new Error(detail) : new CouldNotRun(detail);
};

const parseArgs = (argv) => {
  const options = { base: PRODUCTION };
  for (let index = 0; index < argv.length; index += 1) {
    if (["--base", "--report"].includes(argv[index]) && argv[index + 1]) {
      options[argv[index] === "--base" ? "base" : "report"] = argv[index + 1];
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
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};

const resolveBase = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Refusal("The smoke target is not a valid URL.");
  }
  if (url.username || url.password) throw new Refusal("The smoke target must not contain credentials.");
  const recoveryOrigin = process.env.SMOKE_DEPLOYMENT_URL && deploymentOrigin(process.env.SMOKE_DEPLOYMENT_URL);
  const recoveryTarget = url.origin === recoveryOrigin && url.hostname.endsWith(".vercel.app");
  const liveMonitor = isProductionMonitor() && (url.origin === PRODUCTION || recoveryTarget);
  if (process.env.GITHUB_ACTIONS === "true" && !(isCiTarget(url) || liveMonitor)) {
    throw new Refusal("CI requires an explicit loopback smoke target; live monitoring is disabled.");
  }
  if (url.origin === PRODUCTION) return url.origin;
  if (recoveryTarget) return url.origin;
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) return url.origin;
  throw new Refusal(`the smoke only runs against ${PRODUCTION} or a local test server, not ${url.origin}.`);
};

const bypassCookies = async base => {
  const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (!bypass) return [];
  try {
    const response = await smokeRequest(base, {
      headers: { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" },
      redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const cookies = response.headers.getSetCookie().map(header => {
      if (header.includes(bypass)) throw new Error("the bypass cookie contains the automation secret");
      const [pair, ...attributes] = header.split(";").map(part => part.trim());
      const separator = pair.indexOf("=");
      if (separator <= 0) throw new Error("invalid bypass cookie");
      const flags = attributes.map(attribute => attribute.toLowerCase());
      const path = attributes.find(attribute => /^path=/i.test(attribute))?.slice(5) || "/";
      const sameSite = attributes.find(attribute => /^samesite=/i.test(attribute))?.slice(9).toLowerCase();
      const cookieUrl = new URL(base);
      cookieUrl.pathname = path;
      return {
        name: pair.slice(0, separator), value: pair.slice(separator + 1), url: cookieUrl.href,
        secure: flags.includes("secure"), httpOnly: flags.includes("httponly"),
        ...(["strict", "lax", "none"].includes(sameSite)
          ? { sameSite: sameSite[0].toUpperCase() + sameSite.slice(1) } : {}),
      };
    });
    for (const cookie of cookies) redactSecret(cookie.value);
    await response.body?.cancel();
    if (!cookies.length) throw new Error("the deployment did not set a bypass cookie");
    return cookies;
  } catch (error) {
    throw new CouldNotRun(`deployment protection: ${smokeErrorDetail(error)}`);
  }
};

let cookies = [];

const checkGet = (browser, url, check, base) =>
  withSmokePage(browser, base, { javaScriptEnabled: false }, async page => {
    const response = await navigate(page, url);
    if (!response?.ok()) throw new Error(`${new URL(url).pathname} answered ${response?.status()}`);
    let body;
    try { body = await response.body(); } catch (error) {
      throw new CouldNotRun(`reading ${new URL(url).pathname}: ${smokeErrorDetail(error)}`);
    }
    return check(response, body);
  });

const expectHtml = async (response) => {
  const type = response.headers()["content-type"];
  if (!String(type).includes("text/html")) throw new SmokeResponseError(`answered ${type}`);
};

const expectAvailability = async (response, data) => {
  let body;
  try {
    body = JSON.parse(data.toString());
  } catch (error) {
    throw new SmokeResponseError("availability is invalid JSON", { cause: error });
  }
  if (body?.ok !== true) throw new SmokeResponseError("answered ok: false");
  if (!Array.isArray(body?.settings?.dateSlots)) throw new SmokeResponseError("has no dateSlots list");
  if (!Array.isArray(body?.bookedSlots)) throw new SmokeResponseError("has no bookedSlots list");
};

const firstRequest = request => {
  while (request.redirectedFrom()) request = request.redirectedFrom();
  return request;
};

const allowSmokeRequests = async (context, required, failed) => {
  await context.route("**/*", async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = request.method() === "GET" &&
        (process.env.GITHUB_ACTIONS !== "true" || isCiTarget(url) || isProductionMonitor());
      if (!allowed) {
        if (required(request)) failed(new CouldNotRun(`${url.pathname} is blocked by the smoke request policy`));
        return await route.abort("blockedbyclient");
      }
      await route.continue();
    } catch (error) {
      failed(new CouldNotRun(`request handling: ${smokeErrorDetail(error)}`));
    }
  });
  await context.routeWebSocket(/.*/, (socket) => socket.close());
};

const navigate = (page, url) => {
  startDeadline();
  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
};

const withSmokePage = async (browser, base, contextOptions, check) => {
  const { checkout, ...browserOptions } = contextOptions;
  const required = request => {
    if (request.resourceType() === "script" && browserOptions.javaScriptEnabled === false) return false;
    if (["document", "script", "stylesheet"].includes(request.resourceType())) return true;
    const url = new URL(firstRequest(request).url());
    return url.origin === base && [
      "/api/payment/quote", "/api/payment/providers", "/api/bookingAvailability",
    ].includes(url.pathname);
  };
  const context = await browser.newContext({ ...browserOptions, serviceWorkers: "block" })
    .catch(error => { throw new CouldNotRun(error.message); });
  const pending = new Set();
  const timers = new Map();
  let drained;
  let fail;
  const applicationError = new Promise((_, reject) => {
    fail = reject;
  });
  const hasApplicationError = pattern => new RegExp(pattern, "i").test(document.body?.innerText || "");
  try {
    let page;
    try {
      await allowSmokeRequests(context, required, fail);
      if (cookies.length) await context.addCookies(cookies);
      if (checkout) await installCheckoutProbe(context, checkout);
      page = await context.newPage();
    } catch (error) {
      throw new CouldNotRun(`preparing the browser: ${smokeErrorDetail(error)}`);
    }
    const responseError = error => fail(error instanceof SmokeResponseError ? new Error(smokeErrorDetail(error))
      : new CouldNotRun(`response handling: ${smokeErrorDetail(error)}`));
    const observe = handler => (...args) => {
      try { Promise.resolve(handler(...args)).catch(responseError); } catch (error) { responseError(error); }
    };
    page.on("pageerror", observe(error => {
      const sources = (error.stack || "").split("\n").filter(frame => /^\s+at /.test(frame))
        .flatMap(frame => frame.match(/https?:\/\/[^\s)]+/g) || []);
      const origins = sources.map(source => { try { return new URL(source).origin; } catch { return null; } });
      if (origins.length && origins.every(origin => origin && origin !== base)) return;
      fail(new Error(`${new URL(page.url()).pathname} has a rendering error: ${error.message}`));
    }));
    page.on("request", observe(request => {
      if (required(request)) {
        const original = firstRequest(request);
        const url = new URL(request.url());
        if (process.env.GITHUB_ACTIONS === "true" && !isCiTarget(url) && !isProductionMonitor()) {
          fail(new CouldNotRun(`${url.pathname} is blocked by the smoke request policy`));
        }
        pending.add(original);
        requestStarted(original);
        timers.set(request, setTimeout(() => fail(new Error(`${url.pathname} timed out`)), REQUEST_TIMEOUT_MS));
      }
    }));
    const redirects = response => [301, 302, 303, 307, 308].includes(response.status()) &&
      response.headers().location;
    page.on("response", observe(response => {
      const request = response.request();
      if (required(request) && !redirects(response) && !response.ok()) {
        throw new SmokeResponseError(`${new URL(request.url()).pathname} answered ${response.status()}`);
      }
    }));
    const clearRequest = request => {
      clearTimeout(timers.get(request));
      timers.delete(request);
      const original = firstRequest(request);
      activity.requests.delete(original);
      return original;
    };
    const finish = original => {
      pending.delete(original);
      if (!pending.size) drained?.();
    };
    page.on("requestfinished", observe(async request => {
      if (!required(request)) return;
      const original = clearRequest(request);
      const response = await request.response();
      if (!response) throw new Error(`${new URL(request.url()).pathname} has no response`);
      if (request.redirectedTo() || redirects(response)) return;
      if (new URL(original.url()).pathname === "/api/payment/quote") {
        let payload;
        const body = await response.body();
        try { payload = JSON.parse(body.toString()); } catch (error) {
          throw new SmokeResponseError("/payment quote is invalid JSON", { cause: error });
        }
        if (payload?.ok !== true || !payload.quoteFingerprint || !payload.quote ||
            !Number.isFinite(payload.quote.netAmount) || typeof payload.quote.isFree !== "boolean") {
          throw new SmokeResponseError("/payment quote is invalid");
        }
      }
      finish(original);
    }));
    page.on("requestfailed", observe(request => {
      if (!required(request)) return;
      const original = clearRequest(request);
      const reason = request.failure()?.errorText || "request failed";
      if (!/ERR_ABORTED/.test(reason)) {
        const detail = /ERR_TOO_MANY_REDIRECTS/.test(reason) ? "exceeded the redirect limit" : reason;
        fail(new Error(`${new URL(request.url()).pathname} ${detail}`));
      }
      finish(original);
    }));
    const renderedError = page.waitForFunction(hasApplicationError, APP_ERROR_PATTERN.source, {
      polling: 50, timeout: 0,
    }).then(() => {
      throw new Error(`${new URL(page.url()).pathname} shows an application error`);
    });
    const loaded = async () => {
      const result = await check(page, fail);
      if (pending.size) await new Promise(resolve => { drained = resolve; });
      if (await page.evaluate(hasApplicationError, APP_ERROR_PATTERN.source)) {
        throw new Error(`${new URL(page.url()).pathname} shows an application error`);
      }
      return result;
    };
    return await Promise.race([loaded(), applicationError, renderedError]);
  } catch (error) {
    if (!browser.isConnected()) throw new CouldNotRun(`the browser closed: ${error.message}`);
    throw error;
  } finally {
    for (const [request, timer] of timers) {
      clearTimeout(timer);
      activity.requests.delete(firstRequest(request));
    }
    await context.close();
  }
};

const nodes = (value) => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
};

const checkPrices = (browser, base, selectCheckout) =>
  withSmokePage(browser, base, { javaScriptEnabled: false }, async (page) => {
    const response = await navigate(page, `${base}/packages`);
    if (!response?.ok()) throw new Error(`/packages answered ${response?.status()}`);
    const cards = await page.locator(".ri-package-card").evaluateAll((elements) => elements.map((card) => ({
      name: card.querySelector("h3")?.textContent?.trim() || "",
      price: card.querySelector(".ri-price-current")?.textContent?.trim() || "",
    })));
    if (!cards.length) throw new Error("no package cards rendered");
    const selected = cards.find(card => card.name && PRICE_PATTERN.test(card.price));
    if (selected) selectCheckout({ packageTitle: selected.name, packagePrice: selected.price });
    const unpriced = cards.filter((card) => !card.name || !PRICE_PATTERN.test(card.price));
    if (unpriced.length) throw new Error(`cards without a name or price: ${JSON.stringify(unpriced)}`);
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const offers = nodes(scripts.map((text) => JSON.parse(text))).filter((node) => node["@type"] === "Offer");
    const published = offers.map((offer) => ({ name: offer.itemOffered?.name, price: Number(offer.price) }));
    const shown = cards.map((card) => ({ name: card.name, price: Number(card.price.replace(/[$,]/g, "")) }));
    if (JSON.stringify(published) !== JSON.stringify(shown)) {
      throw new Error(`structured data offers ${JSON.stringify(published)} ` +
        `don't match the cards ${JSON.stringify(shown)}`);
    }
    return `${cards.length} packages priced`;
});

const APP_ERROR_PATTERN = /application error|client-side exception|internal server error/i;
const FLOW_MARKERS = {
  "/booking": "Select a Date and Time for Your Session",
  "/payment": "Booking Summary",
};

const checkPageRenders = (browser, base, pathname, checkout) =>
  withSmokePage(browser, base, { checkout }, async (page, fail) => {
    const flow = pathname === "/" ? "home" : pathname.slice(1);
    let quoted = false;
    if (pathname === "/payment") page.on("response", (response) => {
      try {
        const request = firstRequest(response.request());
        const url = new URL(request.url());
        if (url.origin === base && url.pathname === "/api/payment/quote" &&
            request.method() === "GET" && response.ok()) quoted = true;
      } catch (error) {
        fail(new CouldNotRun(`response handling: ${smokeErrorDetail(error)}`));
      }
    });
    const response = await navigate(page, `${base}${pathname}`);
    if (!response?.ok()) throw new Error(`${pathname} answered ${response?.status()}`);
    const markerTimeout = Number(process.env.SMOKE_MARKER_TIMEOUT_MS || 15000);
    await page.waitForFunction(() => document.body.innerText.trim().length >= 20, null, { timeout: markerTimeout })
      .catch(() => { throw new Error(`${pathname} rendered no visible content`); });
    const usable = async (locator) => {
      await locator.evaluate(element => element.scrollIntoView({ block: "center", behavior: "instant" }), null, {
        timeout: markerTimeout,
      });
      await page.waitForFunction((element) => {
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0 || element.disabled ||
            getComputedStyle(element).visibility !== "visible") return false;
        let opacity = 1;
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          opacity *= Number(style.opacity);
          if (style.pointerEvents === "none" || node.inert) return false;
        }
        if (opacity < 0.1) return false;
        const top = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return element === top || element.contains(top);
      }, await locator.elementHandle(), { timeout: markerTimeout });
    };
    const marker = FLOW_MARKERS[pathname];
    if (marker) {
      await page.waitForFunction((expected) => document.body.innerText.includes(expected), marker, {
        timeout: markerTimeout,
      }).catch(() => {
        throw new Error(`${pathname} is missing "${marker}"`);
      });
    }
    await page.waitForFunction((expected) =>
      document.querySelector(`[data-roo-flow-ready="${expected}"]`) ||
      (expected === "payment" && document.querySelector('[data-roo-payment-unavailable="true"]')), flow, {
      timeout: markerTimeout,
    }).catch(() => {
      throw new Error(`${pathname} did not finish client initialization`);
    });
    if (pathname === "/payment" && await page.locator('[data-roo-payment-unavailable="true"]').count()) {
      throw new Error("/payment has no usable payment provider");
    }
    const controls = pathname === "/"
      ? [page.locator("#top h1"), page.locator('#top a[href="/#packages"]')]
      : [page.getByRole("heading", { name: marker, exact: true }), page.locator(pathname === "/booking"
        ? '[data-roo-flow-ready="booking"] button:not(:disabled)' : '#payment-coupon-code').first()];
    try {
      for (const control of controls) await usable(control);
    } catch {
      throw new Error(pathname === "/" ? "/ is missing its homepage heading or booking link"
        : `${pathname} content or controls are not visible and usable`);
    }
    if (pathname === "/payment" && !quoted) throw new Error("/payment did not confirm a real checkout quote");
    return "renders";
});

const checkReferral = (browser, base) => withSmokePage(browser, base, {}, async (page) => {
    const response = await navigate(page, `${base}/packages?ref=${REFERRAL_CODE}`);
    if (!response?.ok()) throw new Error(`/packages?ref answered ${response?.status()}`);
    await page.waitForFunction((code) => sessionStorage.getItem("referral_session") === code, REFERRAL_CODE, {
      timeout: Number(process.env.SMOKE_MARKER_TIMEOUT_MS || 15000),
    })
      .catch(() => { throw new Error("the ?ref code was not remembered for checkout"); });
    return "code remembered";
});

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const base = resolveBase(options.base);
  for (const name of ["SMOKE_DEADLINE_MS", "SMOKE_REQUEST_TIMEOUT_MS", "SMOKE_MARKER_TIMEOUT_MS"]) {
    if (process.env[name] === undefined) continue;
    const value = Number(process.env[name]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Refusal(`${name} must be a valid duration in milliseconds.`);
    }
  }
  const startedAt = Date.now();
  const withinDeadline = async (run) => {
    if (activity.deadline && Date.now() >= activity.deadline) throw deadlineError();
    return Promise.race([run(), deadline]);
  };
  const checks = [
    ...MONEY_PAGES.map((path) => [`page ${path}`, () => checkGet(browser, `${base}${path}`, expectHtml, base)]),
    ["booking availability", () => checkGet(browser, `${base}/api/bookingAvailability`, expectAvailability, base)],
  ];
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    throw new Error(`Playwright is not installed: ${error.message}`);
  }
  const browserEnv = { ...process.env };
  for (const key of ["VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_TOKEN", "GITHUB_TOKEN"]) delete browserEnv[key];
  const results = [];
  let browser;
  try {
    browser = await chromium.launch({ env: browserEnv, timeout: SMOKE_DEADLINE_MS });
  } catch (error) {
    const detail = `browser launch: ${smokeErrorDetail(error)}`;
    results.push({ name: "browser launch", ok: false, couldNotRun: true, detail });
    log(`SKIP  browser launch: ${detail}`);
  }
  if (browser) {
    try { cookies = await bypassCookies(base); } catch (error) {
      const detail = smokeErrorDetail(error);
      results.push({ name: "deployment protection", ok: false, couldNotRun: true, detail });
      log(`SKIP  deployment protection: ${detail}`);
      await browser.close();
      browser = null;
    }
  }
  let checkout;
  try {
    checks.push(
      ["package prices", () => checkPrices(browser, base, value => { checkout = value; })],
      ["referral capture", () => checkReferral(browser, base)],
      ["home page renders", () => checkPageRenders(browser, base, "/")],
      ["booking page renders", () => checkPageRenders(browser, base, "/booking")],
      ["payment page renders", () => {
        if (!checkout) {
          throw new Error("/payment has no usable checkout package because the package prices check failed");
        }
        return checkPageRenders(browser, base, "/payment", checkout);
      }],
    );
    for (const [name, run] of browser ? checks : []) {
      activity.phase = name;
      try {
        const detail = await withinDeadline(run);
        results.push({ name, ok: true, detail: detail || "" });
        log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
      } catch (error) {
        if (error instanceof CouldNotRun) {
          results.push({ name, ok: false, couldNotRun: true, detail: error.message });
          log(`SKIP  ${name}: ${error.message}`);
          break;
        }
        results.push({ name, ok: false, detail: error.message });
        log(`FAIL  ${name}: ${error.message}`);
        if (Date.now() >= activity.deadline) break;
      }
    }
  } finally {
    clearTimeout(activity.timer);
    await browser?.close();
  }
  const failed = results.filter((result) => !result.ok && !result.couldNotRun);
  const unreachable = results.filter((result) => result.couldNotRun);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map(result => {
      const status = result.ok ? "ok" : result.couldNotRun ? "SKIP" : "FAIL";
      return `| ${status} | ${result.name} | ${result.detail.replace(/\|/g, "\\|")} |`;
    });
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact([
      `### Money-path smoke on ${base}`, "", "| Result | Check | Detail |", "| --- | --- | --- |", ...rows, "",
    ].join("\n")));
  }
  if (failed.length) log(`${failed.length} money-path check(s) failed on ${base}.`);
  else if (unreachable.length) log(`Smoke could not run: ${unreachable.length} check(s) stopped.`);
  else log(`All money-path checks passed on ${base}.`);
  const code = failed.length ? 2 : unreachable.length ? 1 : 0;
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(redactObject({
    version: 1, base, startedAt, completedAt: Date.now(), results,
  })), { mode: 0o600 });
  if (activity.deadline && Date.now() >= activity.deadline) {
    process.exit(code);
  }
  process.exitCode = code;
};

main().catch((error) => {
  logError(error instanceof Refusal ? `Refusing: ${error.message}` : `Smoke could not run: ${error.message}`);
  process.exitCode = 1;
});
