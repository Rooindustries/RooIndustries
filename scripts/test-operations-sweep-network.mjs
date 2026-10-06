const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { Agent, setGlobalDispatcher } from "undici";

const fixture = JSON.parse(fs.readFileSync(process.env.OPERATIONS_TEST_MANIFEST, "utf8"));
const origin = new URL(fixture.origin);
if (origin.protocol !== "http:" || origin.hostname !== testHost || !origin.port) throw new Error("Invalid operations fixture origin");
const hosts = new Set(["targeta.supabase.co", "targetb.supabase.co"]);
const destination = (input) => {
  const url = new URL(input);
  fs.appendFileSync(fixture.trace, `${JSON.stringify({ host: url.hostname, path: url.pathname, kind: "attempt" })}\n`);
  if (!hosts.has(url.hostname) || url.protocol !== "https:" || url.username || url.password) throw new Error("Non-fixture destination forbidden");
  return url;
};
const nativeFetch = globalThis.fetch;
for (const value of fixture.localOrigins || []) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== testHost || !url.port || url.origin !== value) throw new Error("Invalid owned fixture origin");
}
const fixtureAgent = new Agent();
setGlobalDispatcher({ dispatch(options, handler) {
  const requested = new URL(options.origin);
  const localOrigins = [origin.origin, ...(fixture.localOrigins || [])];
  if (localOrigins.includes(requested.origin)) return fixtureAgent.dispatch(options, handler);
  const target = destination(`${requested.origin}${options.path}`);
  const headers = Array.isArray(options.headers)
    ? [...options.headers, "x-operations-fixture-target", target.hostname]
    : { ...options.headers, "x-operations-fixture-target": target.hostname };
  return fixtureAgent.dispatch({ ...options, origin: origin.origin, headers }, handler);
} });
globalThis.fetch = (input, init) => {
  const url = destination(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers || (typeof input === "object" ? input.headers : undefined));
  headers.set("x-operations-fixture-target", url.hostname);
  return nativeFetch(`${origin.origin}${url.pathname}${url.search}`, {
    ...(typeof input === "object" && !(input instanceof URL) ? { method: input.method, body: input.body, duplex: "half" } : {}),
    ...init, headers, redirect: "error", signal: AbortSignal.timeout(15000),
  });
};
const nativeRequest = http.request;
const request = (input, options, callback) => {
  const settings = typeof input === "object" && !(input instanceof URL) ? input : options || {};
  const cb = typeof options === "function" ? options : callback;
  const url = destination(typeof input === "string" || input instanceof URL ? input
    : `${settings.protocol || "https:"}//${settings.hostname || settings.host}${settings.path || "/"}`);
  return nativeRequest({ ...settings, protocol: "http:", hostname: origin.hostname, host: origin.hostname, port: origin.port,
    agent: undefined, path: `${url.pathname}${url.search}`, headers: { ...settings.headers, "x-operations-fixture-target": url.hostname } }, cb);
};
http.request = https.request = request;
http.get = https.get = (...args) => { const req = request(...args); req.end(); return req; };
syncBuiltinESMExports();
const require = createRequire(import.meta.url);
const nextEnv = require("@next/env");
require.cache[require.resolve("@next/env")].exports = { ...nextEnv, loadEnvConfig: () => ({ combinedEnv: process.env, parsedEnv: {}, loadedEnvFiles: [] }) };
