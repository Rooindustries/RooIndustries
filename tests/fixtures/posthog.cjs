const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { randomUUID } = require("node:crypto");
const { expect } = require("@playwright/test");
const { fixtureOrigin } = require("./fixture-ports.cjs");

const recorderDir = path.dirname(require.resolve("posthog-js/dist/lazy-recorder.js"));
const SENDS_KEY = "roo-test-posthog-sends";
const POSTHOG_CODE = /\[PostHog\.js\]|phc_[A-Za-z0-9]{20,}/;
const MUTATION_FIELDS = ["texts", "attributes", "removes", "adds"];
const remoteConfig = {
  analytics: { endpoint: "/i/v0/e/" },
  sessionRecording: {
    endpoint: "/s/", recorderVersion: "v2", consoleLogRecordingEnabled: false, networkPayloadCapture: null,
  },
  supportedCompression: ["gzip-js"],
  hasFeatureFlags: false,
  featureFlags: {},
  autocapture_opt_out: true,
  heatmaps: false,
  surveys: false,
  siteApps: [],
};

const decodeBody = (body) => {
  if (!body?.length) return [];
  let text = (body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body) : body).toString("utf8");
  if (text.startsWith("data=")) text = Buffer.from(new URLSearchParams(text).get("data"), "base64").toString("utf8");
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : payload.batch || [payload];
};
const decode = (request) => decodeBody(request.postDataBuffer());

const gunzipJson = (value) => JSON.parse(zlib.gunzipSync(Buffer.from(value, "latin1")).toString("utf8"));

const unpackSnapshot = (item) => {
  if (!item?.cv) return item;
  if (typeof item.data === "string") return { ...item, data: gunzipJson(item.data) };
  const data = { ...item.data };
  for (const field of MUTATION_FIELDS) if (typeof data[field] === "string") data[field] = gunzipJson(data[field]);
  return { ...item, data };
};

const ingest = async (route, seen) => {
  const request = route.request();
  const url = new URL(request.url());
  seen.requests.push(url.pathname);
  if (url.pathname.startsWith("/ingest/static/")) {
    const name = path.basename(url.pathname);
    const file = path.join(recorderDir, name);
    const served = /^(lazy|posthog)-recorder\.js$/.test(name) && fs.existsSync(file);
    if (!served) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ contentType: "application/javascript", body: fs.readFileSync(file) });
  }
  if (url.pathname.startsWith("/ingest/array/") && url.pathname.endsWith(".js")) {
    const token = JSON.stringify(url.pathname.split("/")[3]);
    const config = JSON.stringify(remoteConfig);
    return route.fulfill({
      contentType: "application/javascript",
      body: `window._POSTHOG_REMOTE_CONFIG = { ${token}: { config: ${config}, siteApps: [] } };`,
    });
  }
  if (url.pathname.startsWith("/ingest/array/") || url.pathname.startsWith("/ingest/flags")) {
    return route.fulfill({ json: remoteConfig });
  }
  const sender = request.frame().page();
  const events = decode(request);
  const recorded = events.filter((event) => event.event !== "$snapshot");
  let first;
  if (recorded.length) {
    const entry = seen.recording.then(async () => {
      const url = `${fixtureOrigin(process.env.BASE_URL, "TOOLING_CONTENT_PORT")}/batch`;
      const { cookie } = await request.allHeaders();
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-fixture-routed": "1" },
        body: JSON.stringify({ batch: recorded }),
      });
      if (!response.ok) throw new Error(`PostHog fixture returned ${response.status}`);
      return (await response.json()).first;
    });
    seen.recording = entry.then(() => undefined);
    first = await entry;
  }
  for (const event of events) {
    if (event.event === "$snapshot") {
      seen.snapshots.push(...event.properties.$snapshot_data.map(unpackSnapshot));
    } else {
      seen.senders.set(event, sender);
      seen.arrived.set(event, first++);
      seen.events.push(event);
    }
  }
  seen.events.sort((a, b) => seen.arrived.get(a) - seen.arrived.get(b));
  return route.fulfill({ json: { status: 1 } });
};

const stubPostHog = async (context, origin, capture) => {
  const seen = {
    events: [], snapshots: [], requests: [], posthogHosts: [], scripts: [], loading: new Set(), senders: new WeakMap(),
    taken: 0, arrived: new Map(), recording: Promise.resolve(),
  };
  seen.received = async () => {
    const url = `${fixtureOrigin(process.env.BASE_URL, "TOOLING_CONTENT_PORT")}/__posthog?capture=${capture}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PostHog fixture returned ${response.status}`);
    const { events } = await response.json();
    for (const { fixtureOrder, fixtureRouted, ...event } of events.slice(seen.taken)) {
      if (fixtureRouted || event.event === "$snapshot") continue;
      seen.events.push(event);
      seen.arrived.set(event, fixtureOrder);
    }
    seen.taken = events.length;
    seen.events.sort((a, b) => seen.arrived.get(a) - seen.arrived.get(b));
  };
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  seen.restoreRoutes = async () => {
    await context.route((url) => url.hostname.endsWith("posthog.com"), (route) => {
      seen.posthogHosts.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    await context.route(`${origin}/ingest/**`, async (route) => {
      seen.loading.add(route);
      try {
        return await ingest(route, seen);
      } finally {
        seen.loading.delete(route);
      }
    });
  };
  await seen.restoreRoutes();
  context.on("request", (request) => {
    if (request.resourceType() === "script" && !new URL(request.url()).pathname.startsWith("/ingest/")) {
      seen.loading.add(request);
    }
  });
  const settle = (request) => seen.loading.delete(request);
  for (const settled of ["requestfinished", "requestfailed"]) context.on(settled, settle);
  context.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    seen.scripts.push(response.text().then((body) => (POSTHOG_CODE.test(body) ? response.url() : ""), () => ""));
  });
  return seen;
};

const postHogCode = async (seen) => (await Promise.all(seen.scripts)).filter(Boolean);
const named = (seen, name) => seen.events.filter((event) => event.event === name);
const arrived = async (seen, name) => {
  await seen.received();
  return named(seen, name);
};
const closeTab = async (page) => {
  await page.unrouteAll({ behavior: "wait" });
  await page.context().unrouteAll({ behavior: "wait" });
  await page.close({ runBeforeUnload: true });
};
const recordSends = (page) => page.addInitScript((key) => {
  if (localStorage.getItem(key) === null) localStorage.setItem(key, "[]");
  const note = (transport, url) => {
    const path = new URL(String(url), location.href).pathname;
    if (!path.startsWith("/ingest/")) return;
    const sends = JSON.parse(localStorage.getItem(key));
    sends.push({ transport, path });
    localStorage.setItem(key, JSON.stringify(sends));
  };
  const beacon = Navigator.prototype.sendBeacon;
  Navigator.prototype.sendBeacon = function (url, ...args) {
    note("sendBeacon", url);
    return beacon.call(this, url, ...args);
  };
  const fetchRequest = window.fetch;
  window.fetch = function (input, ...args) {
    note("fetch", input instanceof Request ? input.url : input);
    return fetchRequest.call(this, input, ...args);
  };
  const urls = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    urls.set(this, url);
    return open.call(this, method, url, ...args);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    note("xhr", urls.get(this));
    return send.call(this, ...args);
  };
}, SENDS_KEY);
const sendsFrom = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), SENDS_KEY);
const expectLeavesFollowViews = (seen) => {
  for (const leave of named(seen, "$pageleave")) {
    const id = leave.properties.$prev_pageview_id;
    expect(id).toBeTruthy();
    const view = named(seen, "$pageview").find((event) => event.properties.$pageview_id === id);
    expect(view, `Missing page view for ${id}`).toBeTruthy();
    expect(leave.properties.$prev_pageview_pathname).toBe(view.properties.$pathname);
    expect(seen.arrived.get(view)).toBeLessThan(seen.arrived.get(leave));
  }
};
const pageviews = (seen, keep = () => true) =>
  named(seen, "$pageview").filter(keep).map((event) => event.properties.$current_url);
const posthogFixtures = {
  posthog: async ({ context, baseURL }, use, testInfo) => {
    const capture = `pw-${testInfo.testId}-${testInfo.retry}-${randomUUID()}`.replace(/[^A-Za-z0-9_-]/g, "_");
    await context.addCookies([{ name: "roo_posthog_capture", value: capture, url: baseURL }]);
    await use(await stubPostHog(context, baseURL, capture));
  },
};

module.exports = {
  posthogFixtures, postHogCode, named, pageviews, arrived, closeTab, expectLeavesFollowViews, recordSends, sendsFrom,
};
