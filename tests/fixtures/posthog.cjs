const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const recorderDir = path.dirname(require.resolve("posthog-js/dist/lazy-recorder.js"));
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

const decode = (request) => {
  const body = request.postDataBuffer();
  if (!body?.length) return [];
  const text = body[0] === 0x1f && body[1] === 0x8b ? zlib.gunzipSync(body).toString("utf8") : body.toString("utf8");
  const payload = JSON.parse(text);
  return Array.isArray(payload) ? payload : payload.batch || [payload];
};

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
  for (const event of decode(request)) {
    if (event.event === "$snapshot") seen.snapshots.push(...event.properties.$snapshot_data.map(unpackSnapshot));
    else seen.events.push(event);
  }
  return route.fulfill({ json: { status: 1 } });
};

const stubPostHog = async (context, origin) => {
  const seen = { events: [], snapshots: [], requests: [], posthogHosts: [], scripts: [] };
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  await context.route((url) => url.hostname.endsWith("posthog.com"), (route) => {
    seen.posthogHosts.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await context.route(`${origin}/ingest/**`, (route) => ingest(route, seen));
  context.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    seen.scripts.push(response.text().then((body) => (POSTHOG_CODE.test(body) ? response.url() : ""), () => ""));
  });
  return seen;
};

const postHogCode = async (seen) => (await Promise.all(seen.scripts)).filter(Boolean);
const named = (seen, name) => seen.events.filter((event) => event.event === name);
const pageviews = (seen) => named(seen, "$pageview").map((event) => event.properties.$current_url);
const posthogFixtures = {
  posthog: async ({ context, baseURL }, use) => use(await stubPostHog(context, baseURL)),
};

module.exports = { posthogFixtures, postHogCode, named, pageviews };
