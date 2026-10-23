#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { localMonitoringEnv } from "./lib/local-monitoring-env.mjs";

const env = localMonitoringEnv(process.env);
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const host = process.env.ROO_TEST_POSTGRES_HOST || "127.0.0.1";
assert.equal(host, "127.0.0.1");
const artifact = path.resolve(process.env.ROO_REFERRAL_TERMS_ARTIFACT || "test-results/referral-terms-startup.json");
const random = Math.random;
let listener;
let port;
let failure;
for (const candidate of [56754, ...Array.from({ length: 500 }, (_, index) => 56332 + index)]) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(candidate, host, resolve);
    });
    listener = server;
    port = candidate;
    break;
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
  }
}
assert.ok(listener, "No available port for the occupied-port fixture");
Math.random = () => (port - 56332 + 0.5) / 500;
try {
  await import("./test-referral-creator-terms-postgres.mjs");
} catch (error) {
  failure = error;
} finally {
  Math.random = random;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({
    passed: !failure,
    occupiedPort: port,
    listenerStopped: !listener.listening,
    error: failure?.message,
  }, null, 2) + "\n");
}
if (failure) throw failure;
process.stdout.write(JSON.stringify({ artifact, passed: true, listenerStopped: true }) + "\n");
