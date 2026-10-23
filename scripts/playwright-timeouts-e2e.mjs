import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { yauzl } from "playwright-core/lib/zipBundle";
import { installNetworkGuard, refuseEnvFiles } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "test-results");
await mkdir(output, { recursive: true });
const artifact = await mkdtemp(path.join(output, "playwright-timeouts-"));
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Local timeout fixture</title><main>Ready</main>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
installNetworkGuard([origin]);
let active;
let cancelled = false;
const stop = signal => {
  if (!active?.pid) return;
  try { process.kill(-active.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
const interrupt = () => {
  cancelled = true;
  stop("SIGINT");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

function tests(suites) {
  return suites.flatMap(suite => [
    ...(suite.specs || []).flatMap(spec => spec.tests.map(test => ({ title: spec.title, ...test }))),
    ...tests(suite.suites || []),
  ]);
}

async function check(mode) {
  const directory = path.join(artifact, mode);
  await mkdir(directory);
  const reportPath = path.join(directory, "results.json");
  const configPath = path.join(directory, "config.cjs");
  await writeFile(configPath, `
const config = require(${JSON.stringify(path.join(root, "playwright.config.js"))});
${mode === "group" ? "if (process.env.TEST_WORKER_INDEX === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);" : ""}
module.exports = {
  ...config,
  metadata: { ...config.metadata, groupTimeoutMs: (config.metadata?.groupTimeoutMs || 0) / ${mode === "test" ? 30 : 200} },
  testDir: ${JSON.stringify(path.join(root, "tests/fixtures/playwright-timeouts"))},
  testMatch: "hang.fixture.cjs",
  webServer: undefined,
  outputDir: ${JSON.stringify(path.join(directory, "browser"))},
  timeout: ${mode === "test" ? "config.timeout / 60" : "config.timeout"},
  globalTimeout: (config.globalTimeout || 0) / ${mode === "test" ? 30 : 60},
  reporter: [["line"], ["json", { outputFile: ${JSON.stringify(reportPath)} }]],
  projects: [{ ...config.projects[0], testMatch: undefined, testIgnore: undefined }],
  use: { ...config.use, headless: true, video: "off" },
};
`);
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    CI: "1",
    BASE_URL: origin,
    ROO_TEST_HOST: "127.0.0.1",
    PW_PORT: String(port),
    PW_SERVER_ID: `timeouts-${process.pid}-${mode}`,
    TOOLING_NETWORK_GUARD: "1",
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([origin]),
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url))}`,
    PLAYWRIGHT_TIMEOUT_CASE: mode,
  };
  const logs = [];
  const started = Date.now();
  let watchdogExpired = false;
  let escalation;
  active = spawn(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "test", "--config", configPath], {
    cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  active.stdout.on("data", chunk => logs.push(chunk));
  active.stderr.on("data", chunk => logs.push(chunk));
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    stop("SIGINT");
    escalation = setTimeout(() => stop("SIGKILL"), 1500);
  }, 12000);
  let code;
  let signal;
  try { [code, signal] = await once(active, "close"); }
  finally {
    clearTimeout(watchdog);
    clearTimeout(escalation);
    stop("SIGTERM");
    active = null;
  }
  const log = Buffer.concat(logs).toString("utf8");
  await writeFile(path.join(directory, "run.log"), log);
  const report = JSON.parse(await readFile(reportPath, "utf8").catch(() => "{}"));
  const cases = tests(report.suites || []);
  const tracePaths = cases.flatMap(test => test.results.flatMap(result => result.attachments || []))
    .filter(attachment => attachment.name === "trace").map(attachment => attachment.path);
  const validTraces = [];
  for (const trace of tracePaths) {
    const zip = await new Promise((resolve, reject) =>
      yauzl.open(trace, { lazyEntries: true }, (error, archive) => error ? reject(error) : resolve(archive))
    );
    let containsHungAction = false;
    try {
      const entries = on(zip, "entry", { close: ["end"] });
      zip.readEntry();
      for await (const [entry] of entries) {
        const isTrace = entry.fileName.endsWith(".trace");
        if (isTrace) assert.ok(entry.uncompressedSize <= 16 * 1024 * 1024, "Trace entry exceeds 16 MiB.");
        const stream = await new Promise((resolve, reject) =>
          zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
        );
        const chunks = [];
        let checksum = 0;
        for await (const chunk of stream) {
          checksum = crc32(chunk, checksum);
          if (isTrace) chunks.push(chunk);
        }
        assert.equal(checksum, entry.crc32, `Trace entry CRC mismatch: ${entry.fileName}`);
        if (isTrace) containsHungAction ||= Buffer.concat(chunks).includes("never-created");
        zip.readEntry();
      }
    } finally {
      zip.close();
    }
    validTraces.push({ path: trace, containsHungAction, validZip: true });
  }
  const result = {
    mode, code, signal, watchdogExpired, elapsedMs: Date.now() - started,
    setupDelayMs: mode === "group" ? 3000 : 0,
    deadlineIncludesSetup: mode !== "group" || Date.now() - started < 9000,
    tests: cases.map(test => ({ title: test.title, statuses: test.results.map(result => result.status) })),
    namedFailure: log.includes(`${mode}: deliberately hung browser action`),
    deadlineReported: mode === "test" ? /Test timeout of \d+ms exceeded/.test(log) : /Playwright group exceeded \d+ms/.test(log),
    traces: validTraces,
  };
  await writeFile(path.join(directory, "check.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

try {
  const results = [];
  for (const mode of ["test", "group"]) {
    assert.ok(!cancelled, "The timeout check was cancelled.");
    results.push(await check(mode));
  }
  const ok = !cancelled && results.every(result => result.code !== 0 && !result.watchdogExpired && result.namedFailure &&
    result.deadlineReported && result.deadlineIncludesSetup && result.traces.length > 0 && result.traces.every(trace => trace.containsHungAction));
  await writeFile(path.join(output, "playwright-timeouts.json"), JSON.stringify({ ok, artifact, results }, null, 2) + "\n");
  console.log(JSON.stringify({ ok, artifact, results }));
  assert.ok(ok, "A hung browser action did not fail at its own deadline with its name and a valid trace.");
} finally {
  stop("SIGINT");
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
