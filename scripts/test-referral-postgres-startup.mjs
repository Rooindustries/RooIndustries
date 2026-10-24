#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { localMonitoringEnv } from "./lib/local-monitoring-env.mjs";

const suites = {
  terms: ["creator-terms", 56332, 500],
  social: ["social-reclaim", 56332, 600],
  authority: ["fallback-authority", 56832, 500],
};
const suite = process.argv[2] || "terms";
assert.ok(Object.hasOwn(suites, suite), "Unknown PostgreSQL startup suite");
const [name, base, size] = suites[suite];
const script = `scripts/test-referral-${name}-postgres.mjs`;
const env = localMonitoringEnv(process.env);
const host = env.ROO_TEST_POSTGRES_HOST || "127.0.0.1";
assert.equal(host, "127.0.0.1");
const artifact = path.resolve(suite === "terms" && env.ROO_REFERRAL_TERMS_ARTIFACT || `test-results/referral-${suite}-startup.json`);
const listener = net.createServer(socket => socket.resume());
const result = { suite, passed: false, sourceHashes: {} };
try {
  listener.listen(0, host);
  await once(listener, "listening");
  result.occupiedPort = listener.address().port;
  for (let attempt = 0; attempt < 16384; attempt++) {
    const client = net.createConnection({ host, port: result.occupiedPort });
    await once(client, "connect");
    const port = client.localPort;
    const closed = once(client, "close");
    client.end();
    await closed;
    if (port >= base && port < base + size) {
      result.timeWaitPort = port;
      break;
    }
  }
  assert.ok(result.timeWaitPort, "No closed client port in the former random range");
  const probe = net.createServer();
  probe.listen(result.timeWaitPort, host);
  try {
    await assert.rejects(once(probe, "listening"), { code: "EADDRINUSE" });
    result.clientPortUnavailable = true;
  } finally {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
  }
  const seed = `Math.random = () => ${(result.timeWaitPort - base + 0.5) / size};`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(seed)}`, script], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
  try {
    const [code, signal] = await once(child, "exit");
    result.childExit = code;
    assert.equal(signal, null, output);
    assert.equal(code, 0, output);
    process.stdout.write(output);
  } finally {
    clearTimeout(timeout);
  }
  result.passed = true;
} catch (error) {
  result.error = error.message;
  throw error;
} finally {
  if (listener.listening) await new Promise(resolve => listener.close(resolve));
  result.listenerStopped = !listener.listening;
  for (const file of [script, "scripts/test-referral-postgres-startup.mjs", "scripts/lib/postgres-fixture-port.mjs"]) {
    if (fs.existsSync(file)) result.sourceHashes[file] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify(result, null, 2) + "\n");
}
process.stdout.write(JSON.stringify({ artifact, ...result }) + "\n");
