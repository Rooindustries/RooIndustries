import assert from "node:assert/strict";

const origin = new URL(process.env.ROO_TEST_MONITOR_ORIGIN);
const previous = new URL(process.env.ROO_TEST_PREVIOUS_ORIGIN);
const vercel = new URL(process.env.VERCEL_API_URL);
for (const url of [origin, previous, vercel]) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password);
}
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  const aliases = { "https://www.rooindustries.com": origin, "https://rooindustries-live-roo-industries.vercel.app": origin,
    "https://rooindustries-previous-roo-industries.vercel.app": previous };
  if (aliases[url.origin]) {
    const target = new URL(aliases[url.origin]);
    target.pathname = url.pathname;
    target.search = url.search;
    return original(target, { ...init, redirect: "manual" });
  }
  assert.ok([origin.origin, previous.origin, vercel.origin].includes(url.origin), "Fixture refused a nonlocal destination.");
  return original(input, { ...init, redirect: "manual" });
};
