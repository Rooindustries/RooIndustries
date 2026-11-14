const { test, expect } = require("@playwright/test");
const { fixturePort } = require("./fixtures/fixture-ports.cjs");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const siteOrigin = "https://www.rooindustries.com";
const recorderDir = path.dirname(require.resolve("posthog-js/dist/lazy-recorder.js"));
const eventId = "a".repeat(40);
const desktopChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const customer = ["visitor@example.invalid", "fixture_visitor", "Ryzen 7700", "RTX 4070"];
const providers = { dodo: { enabled: true, mode: "test" }, razorpay: { enabled: false, mode: "disabled" }, paypal: { enabled: false, mode: "disabled" } };
const remoteConfig = {
  analytics: { endpoint: "/i/v0/e/" },
  sessionRecording: { endpoint: "/s/", recorderVersion: "v2", consoleLogRecordingEnabled: false, networkPayloadCapture: null },
  supportedCompression: ["gzip-js"],
  hasFeatureFlags: false,
  featureFlags: {},
  autocapture_opt_out: true,
  heatmaps: false,
  surveys: false,
  siteApps: [],
};

test.use({
  javaScriptEnabled: true,
  timezoneId: "Asia/Kolkata",
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  userAgent: desktopChrome,
  actionTimeout: 10000,
  navigationTimeout: 30000,
  trace: "off",
  video: "off",
});

test.beforeEach(async ({ context, baseURL }) => {
  const { guardBrowserContext } = await import("../scripts/lib/test-target-safety.mjs");
  const content = new URL(baseURL);
  content.port = String(fixturePort("TOOLING_CONTENT_PORT"));
  await guardBrowserContext(context, [baseURL, content.origin]);
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
});

const site = (pathname) => new URL(pathname, siteOrigin).href;

async function serveAsProduction(context, baseURL) {
  const date = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const api = {
    "/api/bookingAvailability": () => ({ settings: { dateSlots: [{ date, times: ["10:00", "11:00"] }] }, bookedSlots: [] }),
    "/api/holdSlot": (request) => ({
      ok: true, holdId: "fixture-hold-1", holdToken: "fixture-token-1",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), startTimeUTC: request.postDataJSON().startTimeUTC,
    }),
    "/api/releaseHold": () => ({ ok: true }),
    "/api/payment/providers": () => ({ ok: true, providers }),
    "/api/payment/quote": () => ({ ok: true, quoteFingerprint: "fixture-quote", providers, quote: {
      grossAmount: 84.99, netAmount: 84.99, isFree: false, couponDiscountAmount: 0, referralDiscountAmount: 0, referralDiscountPercent: 0,
    } }),
    "/api/payment/start": () => ({
      ok: true, paymentAccessToken: "fixture-payment", status: "started",
      providerPayload: { checkoutUrl: site("/__test/checkout-handoff") },
      sessionExpiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    }),
  };
  await context.route(`${siteOrigin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/__test/checkout-handoff") return route.fulfill({ contentType: "text/html", body: "<h1>Checkout handoff</h1>" });
    if (url.pathname.startsWith("/_vercel/")) return route.fulfill({ status: 204, body: "" });
    if (api[url.pathname]) return route.fulfill({ json: api[url.pathname](request) });
    const local = new URL(baseURL);
    local.pathname = url.pathname;
    local.search = url.search;
    const response = await route.fetch({ url: local.href, maxRedirects: 0 });
    return route.fulfill({ response });
  });
  await context.route(/^https:\/\/(scripts\.seorce\.com|widget\.intercom\.io|js\.intercomcdn\.com)\//, (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
}

const decode = (request) => {
  const body = request.postDataBuffer();
  if (!body?.length) return [];
  const text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString("utf8") : body.toString("utf8");
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : payload.batch || [payload];
};

const gunzipJson = (value) => JSON.parse(zlib.gunzipSync(Buffer.from(value, "latin1")).toString("utf8"));
const MUTATION_FIELDS = ["texts", "attributes", "removes", "adds"];

const unpackSnapshot = (item) => {
  if (!item?.cv) return item;
  if (typeof item.data === "string") return { ...item, data: gunzipJson(item.data) };
  const data = { ...item.data };
  for (const field of MUTATION_FIELDS) if (typeof data[field] === "string") data[field] = gunzipJson(data[field]);
  return { ...item, data };
};

async function stubPostHog(page) {
  const seen = { events: [], snapshots: [], requests: [], posthogHosts: [] };
  await page.route((url) => url.hostname.endsWith("posthog.com"), (route) => {
    seen.posthogHosts.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await page.route(`${siteOrigin}/ingest/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    seen.requests.push(url.pathname);
    if (url.pathname.startsWith("/ingest/static/")) {
      const name = path.basename(url.pathname);
      const file = path.join(recorderDir, name);
      if (!/^(lazy|posthog)-recorder\.js$/.test(name) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(file) });
    }
    if (url.pathname.startsWith("/ingest/array/") && url.pathname.endsWith(".js")) {
      const token = url.pathname.split("/")[3];
      return route.fulfill({ contentType: "application/javascript", body: `window._POSTHOG_REMOTE_CONFIG = { ${JSON.stringify(token)}: { config: ${JSON.stringify(remoteConfig)}, siteApps: [] } };` });
    }
    if (url.pathname.startsWith("/ingest/array/") || url.pathname.startsWith("/ingest/flags")) {
      return route.fulfill({ json: remoteConfig });
    }
    for (const event of decode(request)) {
      if (event.event === "$snapshot") seen.snapshots.push(...event.properties.$snapshot_data.map(unpackSnapshot));
      else seen.events.push(event);
    }
    return route.fulfill({ json: { status: 1 } });
  });
  return seen;
}

const named = (seen, name) => seen.events.filter((event) => event.event === name);
const pageviews = (seen) => named(seen, "$pageview").map((event) => event.properties.$current_url);

test.describe("production host", () => {
  test.beforeEach(async ({ context, baseURL }) => serveAsProduction(context, baseURL));

  test("PostHog records the booking funnel without customer details", async ({ page }) => {
    test.setTimeout(180000);
    const seen = await stubPostHog(page);

    await page.goto(site("/packages?utm_source=launch&utm_campaign=posthog"));
    await expect.poll(() => pageviews(seen)).toContain(`${siteOrigin}/packages`);
    const landing = named(seen, "$pageview")[0];
    expect(landing.properties.$pathname).toBe("/packages");
    expect(landing.properties.utm_source).toBe("launch");

    await page.getByRole("button", { name: "See What's Included" }).first().click();
    await expect.poll(() => named(seen, "view_item").length).toBe(1);
    const viewed = named(seen, "view_item")[0].properties;
    expect(viewed.package).toBeTruthy();
    expect(viewed.surface).toBe("packages");
    const dialog = page.getByRole("dialog", { name: viewed.package });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL(site("/booking"));
    await expect.poll(() => pageviews(seen)).toContain(`${siteOrigin}/booking`);
    await expect.poll(() => named(seen, "package_selected").map((event) => event.properties.package)).toEqual([viewed.package]);
    expect(named(seen, "package_selected")[0].properties.$current_url).toBe(`${siteOrigin}/packages`);

    let finalizeRoute;
    await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
    await page.getByRole("button", { name: /^Earliest available:/ }).click();
    await page.getByRole("button", { name: "10:00 AM", exact: true }).click();
    await page.getByRole("button", { name: "Next", exact: true }).last().click();
    await page.getByRole("textbox", { name: "Discord username", exact: true }).fill("fixture_visitor");
    await page.getByRole("textbox", { name: "Booking email", exact: true }).fill("visitor@example.invalid");
    await page.getByRole("textbox", { name: "PC specifications", exact: true }).fill("Ryzen 7700 / RTX 4070");
    await page.getByRole("textbox", { name: "Main game or application", exact: true }).fill("CS2");
    await page.getByRole("button", { name: "Review before payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Complete Payment", exact: true })).toBeVisible();
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2)).toBe(true);

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(site("/__test/checkout-handoff"));
    await page.goto(site("/payment?dodo_return=1"), { waitUntil: "domcontentloaded" });
    await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
    await finalizeRoute.fulfill({ json: {
      ok: true, status: "booked", provider: "dodo", bookingId: "fixture-posthog-booking",
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      emailDispatchToken: "",
      analyticsReceipt: {
        eventId, packageTitle: "Performance Vertex Overhaul", paymentType: "paid",
        provider: "dodo", amount: 84.99, currency: "USD", referralCode: "", attribution: null,
      },
    } });
    await expect(page).toHaveURL(site("/payment-success"));
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => named(seen, "$identify").length).toBe(1);

    const completed = named(seen, "booking_completed")[0].properties;
    expect(completed).toMatchObject({ event_id: eventId, payment_type: "paid", payment_provider: "dodo", amount: 84.99, currency: "USD" });
    expect(completed.distinct_id).toBe(eventId);
    const identify = named(seen, "$identify")[0];
    expect(identify.properties.distinct_id).toBe(eventId);

    const journeyId = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution")).journeyId);
    expect(identify.properties.$anon_distinct_id).toBe(journeyId);
    const anonymous = seen.events.filter((event) => event.properties.distinct_id !== eventId);
    expect(new Set(anonymous.map((event) => event.properties.distinct_id))).toEqual(new Set([journeyId]));

    for (const event of seen.events) {
      const url = event.properties.$current_url;
      expect(url.startsWith(`${siteOrigin}/`), url).toBe(true);
      expect(url).not.toMatch(/[?#]/);
    }
    expect(seen.posthogHosts).toEqual([]);
    const sent = JSON.stringify([seen.events, seen.snapshots]);
    for (const value of customer) expect(sent).not.toContain(value);
    const replay = JSON.stringify(seen.snapshots);
    expect(seen.snapshots.filter((item) => item.type === 3 && item.data.adds?.length).length).toBeGreaterThan(0);
    expect(replay).toContain("rooindustries.com/packages");
    expect(replay).not.toContain("Review your booking");
    expect(replay).not.toContain("utm_source");

    const stored = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    expect(stored.filter((key) => /^(ph_|__ph)/.test(key))).toEqual([]);
    expect((await page.context().cookies()).filter((cookie) => cookie.name.startsWith("ph_"))).toEqual([]);
  });

  test("a private landing waits, then starts with the journey after in-app navigation", async ({ page }) => {
    const seen = await stubPostHog(page);
    await page.goto(site("/referrals/login"));
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(6000);
    expect(seen.requests).toEqual([]);
    expect(seen.posthogHosts).toEqual([]);

    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect(page).not.toHaveURL(site("/referrals/login"));
    const pathname = new URL(page.url()).pathname;
    await expect.poll(() => pageviews(seen)).toEqual([`${siteOrigin}${pathname}`]);
    const journeyId = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution")).journeyId);
    expect(new Set(seen.events.map((event) => event.properties.distinct_id))).toEqual(new Set([journeyId]));
    expect(seen.posthogHosts).toEqual([]);
  });

  const holdPostHog = async (page, baseURL) => {
    const hold = { held: false };
    const gate = new Promise((resolve) => { hold.release = resolve; });
    await page.route(`${siteOrigin}/_next/static/chunks/**`, async (route) => {
      const local = new URL(baseURL);
      local.pathname = new URL(route.request().url()).pathname;
      const response = await route.fetch({ url: local.href });
      const body = await response.body();
      if (body.includes("[PostHog.js]")) {
        hold.held = true;
        await gate;
      }
      return route.fulfill({ response, body });
    });
    return hold;
  };

  test("an event keeps the page it happened on while PostHog is still loading", async ({ page, baseURL }) => {
    const seen = await stubPostHog(page);
    const hold = await holdPostHog(page, baseURL);

    await page.goto(site("/packages"));
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL(site("/booking"));
    hold.release();

    await expect.poll(() => named(seen, "package_selected").length).toBe(1);
    expect(named(seen, "package_selected")[0].properties.$current_url).toBe(`${siteOrigin}/packages`);
    expect(named(seen, "package_selected")[0].properties.$pathname).toBe("/packages");
  });

  test("a public event is still sent when PostHog finishes loading on a private page", async ({ page, baseURL }) => {
    const seen = await stubPostHog(page);
    const hold = await holdPostHog(page, baseURL);

    await page.goto(site("/packages"));
    await expect.poll(() => hold.held, { timeout: 20000 }).toBe(true);
    await page.getByRole("button", { name: "Referrals", exact: true }).click();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    hold.release();

    await expect.poll(() => named(seen, "service_visit").length, { timeout: 20000 }).toBe(1);
    expect(named(seen, "service_visit")[0].properties.$current_url).toBe(`${siteOrigin}/packages`);
    await page.waitForTimeout(4000);
    expect(seen.events.filter((event) => !event.properties.$current_url.startsWith(`${siteOrigin}/packages`))).toEqual([]);
    expect(JSON.stringify(seen.snapshots)).not.toContain("ref-login-identifier");
    expect(seen.posthogHosts).toEqual([]);
  });

  test("replay records nothing from a private page visited in the app", async ({ page }) => {
    const seen = await stubPostHog(page);
    await page.goto(site("/packages"));
    await expect.poll(() => seen.requests.some((pathname) => pathname.startsWith("/ingest/static/")), { timeout: 20000 }).toBe(true);
    await page.mouse.move(400, 300);
    await page.mouse.move(600, 500);
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2), { timeout: 20000 }).toBe(true);

    await page.getByRole("button", { name: "Referrals", exact: true }).click();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    await page.waitForTimeout(500);
    await page.goBack();
    await expect(page).toHaveURL(site("/packages"));
    await page.waitForTimeout(300);
    await page.goForward();
    await expect(page.locator("#ref-login-identifier")).toBeVisible();
    await page.waitForTimeout(300);
    const finalBack = await page.evaluate(() => Date.now());
    await page.goBack();
    await expect(page).toHaveURL(site("/packages"));
    const returned = Date.now();
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.move(300 + step * 60, 400);
      await page.waitForTimeout(800);
    }
    await expect.poll(() => seen.snapshots.some((item) => item.timestamp > returned + 3000), { timeout: 20000 }).toBe(true);

    expect(JSON.stringify(seen.snapshots)).not.toContain("ref-login-identifier");
    expect(seen.snapshots.some((item) => item.type === 2 && item.timestamp >= finalBack)).toBe(true);
    expect(seen.events.filter((event) => !event.properties.$current_url.startsWith(`${siteOrigin}/packages`))).toEqual([]);
  });

  test("a standalone public page is counted", async ({ page }) => {
    const seen = await stubPostHog(page);
    await page.goto(site("/tourney"));
    await expect.poll(() => pageviews(seen)).toEqual([`${siteOrigin}/tourney`]);
    expect(seen.posthogHosts).toEqual([]);
  });

  test("a non-sales landing is counted and the journey id carries across reloads", async ({ page }) => {
    const seen = await stubPostHog(page);
    await page.goto(site("/meet-the-team"));
    await expect.poll(() => pageviews(seen)).toEqual([`${siteOrigin}/meet-the-team`]);
    const landingId = named(seen, "$pageview")[0].properties.distinct_id;

    await page.getByRole("link", { name: "Packages", exact: true }).first().click();
    await expect(page).not.toHaveURL(site("/meet-the-team"));
    const journey = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution") || "null")?.journeyId);
    await expect.poll(journey).toBeTruthy();
    const journeyId = await journey();
    expect(journeyId).not.toBe(landingId);
    await expect.poll(() => named(seen, "service_visit").map((event) => event.properties.distinct_id)).toEqual([journeyId]);

    await page.reload();
    await expect.poll(() => named(seen, "$pageview").length).toBe(3);
    expect(named(seen, "$pageview").at(-1).properties.distinct_id).toBe(journeyId);
    expect(seen.posthogHosts).toEqual([]);
  });
});

test("PostHog stays off on local hosts", async ({ page, baseURL }) => {
  const requests = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/ingest/")) requests.push(request.url()); });

  await page.goto(new URL("/packages", baseURL).href);
  await page.getByRole("button", { name: "See What's Included" }).first().click();
  await page.waitForTimeout(6000);
  expect(requests).toEqual([]);
});

test("trailing slashes still redirect outside the PostHog proxy", async ({ request }) => {
  for (const [from, to] of [["/about/", "/about"], ["/upgrade/max/", "/upgrade/max"], ["/tourney/bracket/", "/tourney/bracket"]]) {
    const response = await request.get(from, { maxRedirects: 0 });
    expect(response.status(), from).toBe(308);
    expect(new URL(response.headers().location, "http://local").pathname, from).toBe(to);
  }
});
