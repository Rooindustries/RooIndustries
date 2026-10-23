import assert from "node:assert/strict";

const origin = new URL(process.env.ROO_TEST_MONITOR_ORIGIN);
const vercel = new URL(process.env.VERCEL_API_URL);
for (const url of [origin, vercel]) {
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.ok(url.port && !url.username && !url.password);
}
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin === "https://www.rooindustries.com") {
    const target = new URL(origin);
    target.pathname = url.pathname;
    target.search = url.search;
    return original(target, { ...init, redirect: "manual" });
  }
  assert.ok([origin.origin, vercel.origin].includes(url.origin), "Fixture refused a nonlocal destination.");
  return original(input, { ...init, redirect: "manual" });
};
