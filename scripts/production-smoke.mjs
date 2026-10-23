import fs from "node:fs";
import { isIP } from "node:net";
import { isProductionMonitor } from "./lib/production-monitor.mjs";
import { log, logError, redact, redactObject, deploymentOrigin } from "./lib/production-diagnostics.mjs";

const PRODUCTION = "https://www.rooindustries.com";
const MONEY_PAGES = ["/", "/packages", "/booking", "/payment"];
const REFERRAL_CODE = "roo-smoke-check";
const ATTEMPTS = 3;
const RETRY_MS = Number(process.env.SMOKE_RETRY_MS || 10000);
const SMOKE_DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MS || 180000);
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_REQUEST_TIMEOUT_MS || 20000);
const PRICE_PATTERN = /^\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const isCiTarget = (url) => url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password;

class Refusal extends Error {}

// The runner could not reach the site at all (DNS, TLS, refused or reset connections, a dead browser).
// A deployment can't cause these, so they mean "the smoke could not run", never a money-path failure.
class CouldNotRun extends Error {}
class ApplicationFailure extends Error {}
class InitializationIncomplete extends Error {}
// Only failures of the connection itself are the runner's: a deploy can't cause them. Anything the browser
// refused on the site's say-so (CSP, CORS, redirects, bad responses) is the site's failure.
const RUNNER_NET_ERRORS = new Set([
  "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_ABORTED", "net::ERR_CONNECTION_FAILED", "net::ERR_CONNECTION_TIMED_OUT",
  "net::ERR_TIMED_OUT", "net::ERR_EMPTY_RESPONSE", "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NAME_RESOLUTION_FAILED", "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NETWORK_CHANGED", "net::ERR_NETWORK_IO_SUSPENDED", "net::ERR_SOCKET_NOT_CONNECTED",
  "net::ERR_INCOMPLETE_CHUNKED_ENCODING", "net::ERR_CONTENT_LENGTH_MISMATCH", "net::ERR_SSL_PROTOCOL_ERROR",
]);
const runnerNetError = (text) => {
  const code = String(text || "").match(/net::ERR_[A-Z0-9_]+/)?.[0] || "";
  return RUNNER_NET_ERRORS.has(code) || code.startsWith("net::ERR_CERT_");
};
// Node's fetch reports every network-level failure as a TypeError: "fetch failed" before a response arrives,
// "terminated" when the connection drops mid-body. Only its own header and body timeouts mean the site was slow.
const SITE_TIMEOUTS = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const asRunnerFault = (error, what) => {
  if (error instanceof CouldNotRun) return error;
  const fetchTransport = error?.name === "TypeError" && /^(?:fetch failed|terminated)$/.test(error.message) &&
    !SITE_TIMEOUTS.has(error.cause?.code);
  const transport = fetchTransport || runnerNetError(error?.message);
  return transport ? new CouldNotRun(`couldn't reach ${what}: ${error.cause?.code || error.cause?.message || error.message}`) : error;
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

const allowSmokeRequests = async (context, base, checkout) => {
  const active = new Set();
  const blockedScripts = [];
  context.on("close", () => { for (const controller of active) controller.abort(); });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let quote = false;
    if (checkout && request.method() === "POST" && url.origin === base && url.pathname === "/api/payment/quote" && !url.search) {
      try {
        const body = request.postDataJSON();
        const fields = ["packageTitle", "originalOrderId", "startTimeUTC", "email", "referralCode", "couponCode", "upgradeIntentToken"];
        quote = body?.packageTitle === checkout.packageTitle && Object.entries(body).every(([key, value]) =>
          fields.includes(key) && (key === "packageTitle" || value === ""));
      } catch {}
    }
    const allowed = (request.method() === "GET" || quote) &&
      (process.env.GITHUB_ACTIONS !== "true" || isCiTarget(url) || (isProductionMonitor() && url.origin === base));
    if (!allowed) {
      if (request.resourceType() === "script" && url.origin !== base) blockedScripts.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (process.env.GITHUB_ACTIONS !== "true" && !quote) return route.continue();
    const controller = new AbortController();
    active.add(controller);
    try {
      // Playwright skips routing later redirects, so CI refuses them before delivery.
      const response = await fetch(request.url(), {
        method: request.method(), headers: request.headers(), body: quote ? request.postData() : undefined,
        redirect: "manual", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (response.status >= 300 && response.status < 400) return route.abort("blockedbyclient");
      const body = Buffer.from(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers);
      delete headers["content-encoding"];
      delete headers["content-length"];
      return await route.fulfill({ status: response.status, headers, body });
    } catch (error) {
      const codes = [
        [/ECONNRESET|socket hang up/, "connectionreset"],
        [/ECONNREFUSED/, "connectionrefused"],
        [/ENOTFOUND|EAI_AGAIN/, "namenotresolved"],
        [/EHOSTUNREACH|ENETUNREACH/, "addressunreachable"],
      ];
      const reason = asRunnerFault(error, request.url()) instanceof CouldNotRun ? "connectionfailed"
        : codes.find(([pattern]) => pattern.test(error.message))?.[1] || "failed";
      await route.abort(reason).catch(() => {});
    } finally {
      active.delete(controller);
    }
  });
  await context.routeWebSocket(/.*/, (socket) => socket.close());
  return blockedScripts;
};

// Each browser check gets its own page with only GETs and an anonymous quote. Only connection failures on the site's own requests count
// as requests the runner couldn't load; resources the site blocks or refuses remain site failures.
const withSmokePage = async (browser, base, contextOptions, check) => {
  const { checkout, ...browserOptions } = contextOptions;
  const context = await browser.newContext({ ...browserOptions, serviceWorkers: "block" });
  const lost = [];
  const pending = new Set();
  let blockedScripts = [];
  try {
    blockedScripts = await allowSmokeRequests(context, base, checkout);
    if (checkout) await context.addInitScript((booking) => {
      sessionStorage.setItem("checkout_booking_state", JSON.stringify(booking));
    }, checkout);
    const page = await context.newPage();
    const origin = new URL(base).origin;
    const applicationError = new Promise((_, reject) => {
      page.on("response", response => {
        if (checkout && response.url() === `${base}/api/payment/quote` && response.request().method() === "POST" && response.status() !== 200) {
          reject(new ApplicationFailure(`/payment quote answered ${response.status()}`));
        }
      });
      page.on("pageerror", error => {
        const sources = (error.stack || "").split("\n").filter(frame => /^\s+at /.test(frame))
          .flatMap(frame => frame.match(/https?:\/\/[^\s)]+/g) || []);
        const origins = sources.map(source => { try { return new URL(source).origin; } catch { return null; } });
        if (origins.length && origins.every(source => source && source !== origin)) return;
        if (lost.length && (runnerNetError(error.message) || /^(Failed to fetch|Load failed|NetworkError)/i.test(error.message))) {
          reject(new CouldNotRun(`couldn't load ${lost[0]}: ${error.message}`));
          return;
        }
        reject(new ApplicationFailure(`${new URL(page.url()).pathname} has a rendering error: ${error.message}`));
      });
    });
    page.on("request", request => {
      if (new URL(request.url()).origin === origin && ["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())) pending.add(request);
    });
    page.on("requestfinished", request => pending.delete(request));
    page.on("requestfailed", (request) => {
      pending.delete(request);
      const reason = request.failure()?.errorText || "";
      if (new URL(request.url()).origin === origin && runnerNetError(reason)) {
        lost.push(`${new URL(request.url()).pathname} (${reason || "failed"})`);
      }
    });
    return await Promise.race([check(page), applicationError]);
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    if (lost.length && !(error instanceof CouldNotRun)) throw new CouldNotRun(`couldn't load ${lost[0]}: ${error.message}`);
    if (pending.size && !(error instanceof CouldNotRun)) throw new CouldNotRun(`client resources are still loading: ${error.message}`);
    if (blockedScripts.length && !(error instanceof CouldNotRun)) throw new CouldNotRun(`the smoke blocked external scripts from ${blockedScripts[0]}: ${error.message}`);
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
    const unpriced = cards.filter((card) => !card.name || !PRICE_PATTERN.test(card.price));
    if (unpriced.length) throw new Error(`cards without a name or price: ${JSON.stringify(unpriced)}`);
    const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
    const offers = nodes(scripts.map((text) => JSON.parse(text))).filter((node) => node["@type"] === "Offer");
    const published = offers.map((offer) => ({ name: offer.itemOffered?.name, price: Number(offer.price) }));
    const shown = cards.map((card) => ({ name: card.name, price: Number(card.price.replace(/[$,]/g, "")) }));
    if (JSON.stringify(published) !== JSON.stringify(shown)) {
      throw new Error(`structured data offers ${JSON.stringify(published)} don't match the cards ${JSON.stringify(shown)}`);
    }
    selectCheckout({ packageTitle: cards[0].name, packagePrice: cards[0].price });
    return `${cards.length} packages priced`;
});

const APP_ERROR_PATTERN = /application error|client-side exception|internal server error/i;
const FLOW_MARKERS = {
  "/booking": "Select a Date and Time for Your Session",
  "/payment": "Booking Summary",
};

const checkPageRenders = (browser, base, pathname, checkout) => withSmokePage(browser, base, { checkout }, async (page) => {
    let quoted = false;
    if (pathname === "/payment") page.on("response", (response) => {
      if (response.url() === `${base}/api/payment/quote` && response.request().method() === "POST" && response.status() === 200) quoted = true;
    });
    const response = await page.goto(`${base}${pathname}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new ApplicationFailure(`${pathname} answered ${response?.status()}`);
    const markerTimeout = Number(process.env.SMOKE_MARKER_TIMEOUT_MS || 15000);
    await page.waitForFunction(() => document.body.innerText.trim().length >= 20, null, { timeout: markerTimeout })
      .catch(() => { throw new Error(`${pathname} rendered no visible content`); });
    const text = await page.evaluate(() => document.body.innerText);
    if (APP_ERROR_PATTERN.test(text)) throw new ApplicationFailure(`${pathname} shows an application error`);
    if (pathname === "/") {
      await page.waitForFunction(() => {
        const visible = (element) => {
          if (!element?.innerText.trim() || getComputedStyle(element).visibility !== "visible") return false;
          const bounds = element.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0) return false;
          let opacity = 1;
          for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            opacity *= Number(getComputedStyle(ancestor).opacity);
          }
          return opacity > 0;
        };
        const heading = document.querySelector("#top h1");
        const bookingLink = document.querySelector('#top a[href="/#packages"]');
        return visible(heading) && visible(bookingLink);
      }, null, { timeout: markerTimeout })
        .catch(() => { throw new Error("/ is missing its homepage heading or booking link"); });
    }
    const marker = FLOW_MARKERS[pathname];
    if (marker) {
      await page.waitForFunction((expected) => document.body.innerText.includes(expected), marker, {
        timeout: markerTimeout,
      }).catch(async () => {
        const initialized = await page.locator(`[data-roo-flow-ready="${pathname.slice(1)}"]`).count();
        const Failure = initialized ? ApplicationFailure : InitializationIncomplete;
        throw new Failure(`${pathname} is missing "${marker}"`);
      });
    }
    const flow = pathname === "/" ? "home" : pathname.slice(1);
    await page.waitForFunction((expected) => document.querySelector(`[data-roo-flow-ready="${expected}"]`), flow, {
      timeout: markerTimeout,
    }).catch(() => {
      throw new InitializationIncomplete(`${pathname} did not finish client initialization`);
    });
    if (marker) {
      const control = pathname === "/booking" ? '[data-roo-flow-ready="booking"] button:not(:disabled)' : '#payment-coupon-code';
      const heading = page.getByRole("heading", { name: marker, exact: true });
      const input = page.locator(control).first();
      const usable = async (locator) => {
        await locator.scrollIntoViewIfNeeded({ timeout: markerTimeout });
        await page.waitForFunction((element) => {
          const bounds = element.getBoundingClientRect();
          if (bounds.width <= 0 || bounds.height <= 0 || getComputedStyle(element).visibility !== "visible") return false;
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
      try {
        await usable(heading);
        await usable(input);
        await input.click({ trial: true, timeout: markerTimeout });
      } catch {
        throw new Error(`${pathname} content or controls are not visible and usable`);
      }
    }
    if (pathname === "/payment" && !quoted) throw new Error("/payment did not confirm a real checkout quote");
    if (APP_ERROR_PATTERN.test(await page.evaluate(() => document.body.innerText))) {
      throw new ApplicationFailure(`${pathname} shows an application error`);
    }
    return "renders";
});

const checkReferral = (browser, base) => withSmokePage(browser, base, {}, async (page) => {
    const response = await page.goto(`${base}/packages?ref=${REFERRAL_CODE}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (response?.status() !== 200) throw new Error(`/packages?ref answered ${response?.status()}`);
    await page.waitForFunction((code) => window.sessionStorage.getItem("referral_session") === code, REFERRAL_CODE, { timeout: 15000 })
      .catch(() => { throw new Error("the ?ref code was not remembered for checkout"); });
    return "code remembered";
});

const withBrowserRetries = async (browser, base, check) => {
  let lastError;
  let applicationFailure;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await check(browser, base);
    } catch (error) {
      if (error instanceof ApplicationFailure) applicationFailure = error;
      lastError = browser.isConnected() ? asRunnerFault(error, base) : new CouldNotRun(`the browser closed: ${error.message}`);
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
  }
  throw applicationFailure || lastError;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const base = resolveBase(options.base);
  const startedAt = Date.now();
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
  let checkout;
  try {
    checks.push(
      ["package prices", () => withBrowserRetries(browser, base, (b, url) => checkPrices(b, url, value => { checkout = value; }))],
      ["referral capture", () => withBrowserRetries(browser, base, checkReferral)],
      ["home page renders", () => withBrowserRetries(browser, base, (b, url) => checkPageRenders(b, url, "/"))],
      ["booking page renders", () => withBrowserRetries(browser, base, (b, url) => checkPageRenders(b, url, "/booking"))],
      ["payment page renders", () => withBrowserRetries(browser, base, (b, url) => checkPageRenders(b, url, "/payment", checkout))],
    );
    for (const [name, run] of checks) {
      try {
        const detail = await withinDeadline(run);
        results.push({ name, ok: true, detail: detail || "" });
        log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
      } catch (error) {
        // Running out of the smoke's own time budget is the runner's problem; only evidence from the site counts against a deploy.
        const fault = browser.isConnected() || error instanceof CouldNotRun || error instanceof ApplicationFailure ? error : new CouldNotRun(`the browser closed: ${error.message}`);
        if (fault instanceof CouldNotRun) {
          results.push({ name, ok: false, couldNotRun: true, detail: fault.message });
          log(`SKIP  ${name}: ${fault.message}`);
          if (!browser.isConnected() || Date.now() >= deadline) break;
          continue;
        }
        results.push({ name, ok: false, ...(error instanceof InitializationIncomplete ? { initializationIncomplete: true } : {}), detail: error.message });
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
  else if (unreachable.length) log(`Smoke could not run: ${unreachable.length} check(s) couldn't reach ${base} from this runner.`);
  else log(`All money-path checks passed on ${base}.`);
  const code = failed.length ? 2 : unreachable.length ? 1 : 0;
  if (options.report) fs.writeFileSync(options.report, JSON.stringify(redactObject({ version: 1, base, startedAt, completedAt: Date.now(), results })), { mode: 0o600 });
  if (Date.now() >= deadline) {
    await browser.close().catch(() => {});
    process.exit(code);
  }
  process.exitCode = code;
};

main().catch((error) => {
  logError(error instanceof Refusal ? `Refusing: ${error.message}` : `Smoke could not run: ${error.message}`);
  process.exitCode = 1;
});
