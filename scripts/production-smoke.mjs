import fs from "node:fs";
import { smokeRequest } from "./lib/production-smoke-request.mjs";
import { isIP } from "node:net";
import { isProductionMonitor } from "./lib/production-monitor.mjs";
import { log, logError, redact, redactObject, deploymentOrigin } from "./lib/production-diagnostics.mjs";

const PRODUCTION = "https://www.rooindustries.com";
const MONEY_PAGES = ["/", "/packages", "/booking", "/payment"];
const REFERRAL_CODE = "roo-smoke-check";
const SMOKE_DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MS || 180000);
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS || 20000);
const PRICE_PATTERN = /^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isCiTarget = (url) =>
  url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;

class Refusal extends Error {}
class CouldNotRun extends Error {}

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
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
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
  if (process.env.GITHUB_ACTIONS === "true" && !(isCiTarget(url) || (isProductionMonitor() && (url.origin === PRODUCTION || recoveryTarget)))) {
    throw new Refusal("CI requires an explicit loopback smoke target; live monitoring is disabled.");
  }
  if (url.origin === PRODUCTION) return url.origin;
  if (recoveryTarget) return url.origin;
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) return url.origin;
  throw new Refusal(`the smoke only runs against ${PRODUCTION} or a local test server, not ${url.origin}.`);
};

const smokeHeaders = (url, base, original = {}) => {
  const headers = { ...original };
  delete headers["x-vercel-protection-bypass"];
  const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || "").trim();
  if (bypass && new URL(url).origin === base) headers["x-vercel-protection-bypass"] = bypass;
  return headers;
};

const checkGet = async (url, check, base) => {
  const response = await smokeRequest(url, {
    headers: smokeHeaders(url, base), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return check(response);
};

const expectHtml = async (response) => {
  if (!String(response.headers.get("content-type")).includes("text/html")) throw new Error(`answered ${response.headers.get("content-type")}`);
  await response.arrayBuffer();
};

const expectAvailability = async (response) => {
  const body = await response.json();
  if (body?.ok !== true) throw new Error("answered ok: false");
  if (!Array.isArray(body?.settings?.dateSlots)) throw new Error("has no dateSlots list");
  if (!Array.isArray(body?.bookedSlots)) throw new Error("has no bookedSlots list");
};

const requiresCheckoutResource = (request, base) => {
  if (["document", "script", "stylesheet"].includes(request.resourceType())) return true;
  const url = new URL(request.url());
  return url.origin === base && [
    "/api/payment/quote", "/api/payment/providers", "/api/bookingAvailability",
  ].includes(url.pathname);
};

const allowSmokeRequests = async (context, base, checkout, failed) => {
  const active = new Set();
  context.on("close", () => { for (const controller of active) controller.abort(); });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let quote = false;
    if (checkout && request.method() === "POST" && url.origin === base &&
        url.pathname === "/api/payment/quote" && !url.search) {
      try {
        const body = request.postDataJSON();
        const fields = ["packageTitle", "originalOrderId", "startTimeUTC", "email", "referralCode", "couponCode", "upgradeIntentToken"];
        quote = body?.packageTitle === checkout.packageTitle && Object.entries(body).every(([key, value]) =>
          fields.includes(key) && (key === "packageTitle" || value === ""));
      } catch {}
    }
    const allowed = (request.method() === "GET" || quote) &&
      (process.env.GITHUB_ACTIONS !== "true" || isCiTarget(url) || (isProductionMonitor() && url.origin === base));
    if (!allowed) return route.abort("blockedbyclient");
    if (quote) url.searchParams.set("packageTitle", checkout.packageTitle);
    const headers = smokeHeaders(url.href, base, request.headers());
    const controller = new AbortController();
    active.add(controller);
    try {
      const response = await smokeRequest(url.href, {
        headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const body = Buffer.from(await response.arrayBuffer());
      if (quote) {
        const payload = JSON.parse(body.toString());
        if (payload?.ok !== true || !payload.quoteFingerprint || !payload.quote ||
            !Number.isFinite(payload.quote.netAmount) || typeof payload.quote.isFree !== "boolean") {
          throw new Error("/payment quote is invalid");
        }
      }
      const responseHeaders = Object.fromEntries(response.headers);
      delete responseHeaders["content-encoding"];
      delete responseHeaders["content-length"];
      return await route.fulfill({ status: response.status, headers: responseHeaders, body });
    } catch (error) {
      if (!controller.signal.aborted && requiresCheckoutResource(request, base)) {
        const detail = error.name === "TimeoutError" ? "timed out" : error.message;
        failed(new Error(`${url.pathname} ${detail}`));
      }
      await route.abort("failed").catch(() => {});
    } finally {
      active.delete(controller);
    }
  });
  await context.routeWebSocket(/.*/, (socket) => socket.close());
};

const withSmokePage = async (browser, base, contextOptions, check) => {
  const { checkout, ...browserOptions } = contextOptions;
  const context = await browser.newContext({ ...browserOptions, serviceWorkers: "block" })
    .catch(error => { throw new CouldNotRun(error.message); });
  const pending = new Set();
  let drained;
  let fail;
  const applicationError = new Promise((_, reject) => {
    fail = reject;
  });
  const hasApplicationError = pattern => new RegExp(pattern, "i").test(document.body?.innerText || "");
  try {
    await allowSmokeRequests(context, base, checkout, fail);
    if (checkout) await context.addInitScript((booking) => {
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(booking));
    }, checkout);
    const page = await context.newPage();
    page.on("pageerror", error => {
      const sources = (error.stack || "").split("\n").filter(frame => /^\s+at /.test(frame))
        .flatMap(frame => frame.match(/https?:\/\/[^\s)]+/g) || []);
      const origins = sources.map(source => { try { return new URL(source).origin; } catch { return null; } });
      if (origins.length && origins.every(origin => origin && origin !== base)) return;
      fail(new Error(`${new URL(page.url()).pathname} has a rendering error: ${error.message}`));
    });
    page.on("request", request => {
      if (requiresCheckoutResource(request, base)) pending.add(request);
    });
    const finished = request => {
      pending.delete(request);
      if (!pending.size) drained?.();
    };
    page.on("requestfinished", finished);
    page.on("requestfailed", request => {
      if (browser.isConnected() && requiresCheckoutResource(request, base)) {
        fail(new Error(`${new URL(request.url()).pathname} failed: ${request.failure()?.errorText}`));
      }
      finished(request);
    });
    const renderedError = page.waitForFunction(hasApplicationError, APP_ERROR_PATTERN.source, {
      polling: 50, timeout: 0,
    }).then(() => {
      throw new Error(`${new URL(page.url()).pathname} shows an application error`);
    });
    const loaded = async () => {
      const result = await check(page);
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
    await context.close();
  }
};

const nodes = (value) => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nodes)];
};

const checkPrices = (browser, base, selectCheckout) => withSmokePage(browser, base, { javaScriptEnabled: false }, async (page) => {
    const response = await page.goto(`${base}/packages`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages answered ${response?.status()}`);
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
      throw new Error(`structured data offers ${JSON.stringify(published)} don't match the cards ${JSON.stringify(shown)}`);
    }
    return `${cards.length} packages priced`;
});

const APP_ERROR_PATTERN = /application error|client-side exception|internal server error/i;
const FLOW_MARKERS = {
  "/booking": "Select a Date and Time for Your Session",
  "/payment": "Booking Summary",
};

const checkPageRenders = (browser, base, pathname, checkout) => withSmokePage(browser, base, { checkout }, async (page) => {
    const flow = pathname === "/" ? "home" : pathname.slice(1);
    let quoted = false;
    if (pathname === "/payment") page.on("response", (response) => {
      if (response.url() === `${base}/api/payment/quote` &&
          response.request().method() === "POST" && response.status() === 200) quoted = true;
    });
    const response = await page.goto(`${base}${pathname}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`${pathname} answered ${response?.status()}`);
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
    const response = await page.goto(`${base}/packages?ref=${REFERRAL_CODE}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages?ref answered ${response?.status()}`);
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
  const deadline = Date.now() + SMOKE_DEADLINE_MS;
  const withinDeadline = async (run) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("the smoke deadline passed before required checkout checks finished");
    let timer;
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            "the smoke deadline passed before required checkout checks finished"
          )), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const checks = [
    ...MONEY_PAGES.map((path) => [`page ${path}`, () => checkGet(`${base}${path}`, expectHtml, base)]),
    ["booking availability", () => checkGet(`${base}/api/bookingAvailability`, expectAvailability, base)],
  ];
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch (error) {
    throw new Error(`Playwright is not installed: ${error.message}`);
  }
  const browserEnv = { ...process.env };
  for (const key of ["VERCEL_AUTOMATION_BYPASS_SECRET", "VERCEL_TOKEN", "GITHUB_TOKEN"]) delete browserEnv[key];
  const browser = await chromium.launch({ env: browserEnv });
  const results = [];
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
    for (const [name, run] of checks) {
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
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact([`### Money-path smoke on ${base}`, "", "| Result | Check | Detail |", "| --- | --- | --- |", ...rows, ""].join("\n")));
  }
  if (failed.length) log(`${failed.length} money-path check(s) failed on ${base}.`);
  else if (unreachable.length) log(`Smoke could not run: ${unreachable.length} check(s) stopped because the browser closed.`);
  else log(`All money-path checks passed on ${base}.`);
  const code = failed.length ? 2 : unreachable.length ? 1 : 0;
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(redactObject({ version: 1, base, startedAt, completedAt: Date.now(), results })), { mode: 0o600 });
  if (Date.now() >= deadline) {
    process.exit(code);
  }
  process.exitCode = code;
};

main().catch((error) => {
  logError(error instanceof Refusal ? `Refusing: ${error.message}` : `Smoke could not run: ${error.message}`);
  process.exitCode = 1;
});
