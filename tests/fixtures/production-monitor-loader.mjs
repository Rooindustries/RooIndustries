import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const origin = new URL(process.env.ROO_TEST_MONITOR_ORIGIN);
const previous = new URL(process.env.ROO_TEST_PREVIOUS_ORIGIN);
const restored = new URL(process.env.ROO_TEST_RESTORED_ORIGIN);
const vercel = new URL(process.env.VERCEL_API_URL);
const unconfirmed = process.env.ROO_TEST_UNCONFIRMED_ORIGIN && new URL(process.env.ROO_TEST_UNCONFIRMED_ORIGIN);
for (const url of [origin, previous, restored, vercel, ...(unconfirmed ? [unconfirmed] : [])]) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password);
}
const original = globalThis.fetch;
const aliases = { "https://www.rooindustries.com": origin, "https://rooindustries-live-roo-industries.vercel.app": origin,
  "https://rooindustries-previous-roo-industries.vercel.app": previous,
  "https://rooindustries-newer-roo-industries.vercel.app": restored,
  ...(unconfirmed ? { "https://unconfirmed.vercel.app": unconfirmed } : {}) };
const localOrigins = new Set([origin.origin, previous.origin, restored.origin, vercel.origin, unconfirmed?.origin]);
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (aliases[url.origin]) {
    const target = new URL(aliases[url.origin]);
    target.pathname = url.pathname;
    target.search = url.search;
    return original(target, { ...init, redirect: "manual" });
  }
  assert.ok(localOrigins.has(url.origin), "Fixture refused a nonlocal destination.");
  return original(input, { ...init, redirect: "manual" });
};

const launch = chromium.launch.bind(chromium);
chromium.launch = async options => {
  const browser = await launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async options => {
    const context = await newContext(options);
    const register = context.route.bind(context);
    context.route = async (pattern, handler) => {
      await register(pattern, handler);
      await register("**/*", async route => {
        const request = route.request();
        if (request.method() !== "GET") return route.fallback();
        const url = new URL(request.url());
        const target = aliases[url.origin];
        if (!target) {
          if (localOrigins.has(url.origin)) return route.fallback();
          return route.abort("blockedbyclient");
        }
        const fixture = new URL(url.pathname + url.search, target);
        const response = await original(fixture, { redirect: "manual" });
        const headers = Object.fromEntries(response.headers);
        if (response.status >= 300 && response.status < 400 && headers.location) {
          const destination = new URL(headers.location, url);
          if (aliases[destination.origin]) {
            headers.location = new URL(destination.pathname + destination.search, aliases[destination.origin]).href;
          } else if (!localOrigins.has(destination.origin)) return route.abort("blockedbyclient");
        }
        delete headers["content-length"];
        delete headers["content-encoding"];
        return route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      });
    };
    return context;
  };
  return browser;
};
