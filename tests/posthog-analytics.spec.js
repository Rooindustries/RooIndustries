const { test, expect } = require("./fixtures/booking-flow.cjs");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const siteOrigin = "https://www.rooindustries.com";
const recorderDir = path.dirname(require.resolve("posthog-js/dist/lazy-recorder.js"));
const bookingId = "booking-posthog-fixture";
const desktopChrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const customer = ["visitor@example.invalid", "fixture_visitor", "Ryzen 7700", "RTX 4070"];
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

const decode = (request) => {
  const body = request.postDataBuffer();
  if (!body?.length) return [];
  const text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString("utf8") : body.toString("utf8");
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : payload.batch || [payload];
};

const unpackSnapshot = (item) => {
  if (typeof item?.data !== "string" || !item.cv) return item;
  return { ...item, data: JSON.parse(zlib.gunzipSync(Buffer.from(item.data, "latin1")).toString("utf8")) };
};

async function stubPostHog(page) {
  const seen = { events: [], snapshots: [], requests: [], posthogHosts: [] };
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  await page.route((url) => url.hostname.endsWith("posthog.com"), (route) => {
    seen.posthogHosts.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await page.route(/^https:\/\/(scripts\.seorce\.com|widget\.intercom\.io|js\.intercomcdn\.com)\//, (route) =>
    route.fulfill({ contentType: "application/javascript", body: "" }));
  await page.route(`${siteOrigin}/_vercel/**`, (route) => route.fulfill({ status: 204, body: "" }));
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
  test.use({ siteOrigin });

  test("PostHog records the booking funnel without customer details", async ({ page, flow }) => {
    test.setTimeout(180000);
    const seen = await stubPostHog(page);

    await page.goto(flow.site("/packages?utm_source=launch&utm_campaign=posthog"));
    await expect.poll(() => pageviews(seen)).toContain(`${siteOrigin}/packages`);
    const landing = named(seen, "$pageview")[0];
    expect(landing.properties.$pathname).toBe("/packages");
    expect(landing.properties.utm_source).toBe("launch");

    const details = page.getByRole("button", { name: "See What's Included" }).first();
    await details.click();
    await expect.poll(() => named(seen, "package_viewed").length).toBe(1);
    const viewed = named(seen, "package_viewed")[0].properties;
    expect(viewed.package).toBeTruthy();
    expect(viewed.surface).toBe("details");
    const dialog = page.getByRole("dialog", { name: viewed.package });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("link", { name: /Book Now/ }).first().click();
    await expect(page).toHaveURL(`${siteOrigin}/booking`);
    await expect.poll(() => pageviews(seen)).toContain(`${siteOrigin}/booking`);
    await expect.poll(() => named(seen, "package_selected").map((event) => event.properties.package)).toEqual([viewed.package]);

    let finalizeRoute;
    await page.route("**/api/payment/finalize", (route) => { finalizeRoute = route; });
    await flow.review();
    await expect(page.getByRole("heading", { name: "Review your booking", exact: true })).toBeVisible();
    await flow.payment();
    await expect.poll(() => named(seen, "checkout_started").length).toBe(1);
    await expect.poll(() => seen.snapshots.some((item) => item.type === 2)).toBe(true);

    await page.getByRole("button", { name: "Pay your way", exact: true }).click();
    await expect(page).toHaveURL(`${siteOrigin}/__test/checkout-handoff`);
    await page.goto(flow.site("/payment?dodo_return=1"), { waitUntil: "domcontentloaded" });
    await expect.poll(() => Boolean(finalizeRoute)).toBe(true);
    await finalizeRoute.fulfill({ json: {
      ok: true, status: "booked", provider: "dodo", bookingId,
      emailDispatch: { allSent: true, client: { sent: true }, owner: { sent: true } },
      emailDispatchToken: "",
      analyticsReceipt: {
        eventId: "a".repeat(40), packageTitle: "Performance Vertex Overhaul", paymentType: "paid",
        provider: "dodo", amount: 84.99, currency: "USD", referralCode: "", attribution: null,
      },
    } });
    await expect(page).toHaveURL(`${siteOrigin}/payment-success`);
    await expect.poll(() => named(seen, "booking_completed").length).toBe(1);
    await expect.poll(() => named(seen, "$identify").length).toBe(1);

    const completed = named(seen, "booking_completed")[0].properties;
    expect(completed).toMatchObject({ payment_type: "paid", payment_provider: "dodo", amount: 84.99, currency: "USD" });
    const identify = named(seen, "$identify")[0];
    expect(identify.properties.distinct_id).toBe(bookingId);
    expect(completed.distinct_id).toBe(bookingId);

    const journeyId = await page.evaluate(() => JSON.parse(sessionStorage.getItem("sales_attribution")).journeyId);
    expect(identify.properties.$anon_distinct_id).toBe(journeyId);
    const anonymous = seen.events.filter((event) => !["$identify", "booking_completed"].includes(event.event) && event.properties.distinct_id !== bookingId);
    expect(new Set(anonymous.map((event) => event.properties.distinct_id))).toEqual(new Set([journeyId]));

    for (const event of seen.events) {
      const url = event.properties.$current_url;
      expect(url.startsWith(`${siteOrigin}/`), url).toBe(true);
      expect(url).not.toMatch(/[?#]/);
    }
    expect(seen.posthogHosts).toEqual([]);
    const sent = JSON.stringify([seen.events, seen.snapshots]);
    for (const value of customer) expect(sent).not.toContain(value);
    expect(seen.snapshots.some((item) => item.type === 2)).toBe(true);
    expect(JSON.stringify(seen.snapshots)).not.toContain("Review your booking");

    const stored = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]);
    expect(stored.filter((key) => /^(ph_|__ph)/.test(key))).toEqual([]);
    expect((await page.context().cookies()).filter((cookie) => cookie.name.startsWith("ph_"))).toEqual([]);
  });

  test("the creator portal loads no PostHog", async ({ page, flow }) => {
    const seen = await stubPostHog(page);
    await page.goto(flow.site("/referrals/login"));
    await expect(page.locator("main")).toBeVisible();
    await page.waitForTimeout(6000);
    expect(seen.requests).toEqual([]);
  });
});

test("PostHog stays off on local hosts", async ({ page, flow }) => {
  const requests = [];
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/ingest/")) requests.push(request.url()); });

  await page.goto(flow.site("/packages"));
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
