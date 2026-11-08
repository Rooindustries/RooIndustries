import assert from "node:assert/strict";
import { once, on } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { crc32 } from "node:zlib";
import { yauzl } from "playwright-core/lib/zipBundle";
import yaml from "js-yaml";
import { spawnGroup, signalGroup, holdDescendants, releaseGroupMembers } from "./lib/process-group.mjs";
import { installNetworkGuard, refuseEnvFiles } from "./lib/test-target-safety.mjs";
import { withNodeOption } from "./lib/node-options.mjs";

refuseEnvFiles();
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const configFile = path.resolve(process.argv[2] || "playwright.config.js");
const base = require(configFile);
const { writeFixturePorts, fixtureInstance } = require(path.join(path.dirname(configFile), "tests/fixtures/fixture-ports.cjs"));
const workflow = yaml.safeLoad(await fs.readFile(".github/workflows/tests.yml", "utf8"));
const output = path.join(root, "test-results");
await fs.mkdir(output, { recursive: true });
const artifact = await fs.mkdtemp(path.join(output, "playwright-timeouts-"));
const instance = fixtureInstance();
const server = http.createServer((request, response) => {
  response.end(request.url === "/__instance" ? instance : "<!doctype html><title>Local timeout fixture</title>");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;
writeFixturePorts(origin, instance, { TOOLING_CONTENT_PORT: port });
installNetworkGuard([origin]);
let active;
const interrupt = () => active && signalGroup(active, "SIGINT");
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const casesIn = suites => suites.flatMap(suite => [
  ...(suite.specs || []).flatMap(spec => spec.tests), ...casesIn(suite.suites || []),
]);

async function inspectTrace(file) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true }, (error, archive) => error ? reject(error) : resolve(archive)));
  let containsAction = false;
  try {
    const entries = on(zip, "entry", { close: ["end"] });
    zip.readEntry();
    for await (const [entry] of entries) {
      const stream = await new Promise((resolve, reject) =>
        zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
      const chunks = [];
      let checksum = 0;
      for await (const chunk of stream) {
        checksum = crc32(chunk, checksum);
        if (entry.fileName.endsWith(".trace")) chunks.push(chunk);
      }
      assert.equal(checksum, entry.crc32, entry.fileName);
      containsAction ||= Buffer.concat(chunks).includes("never-created");
      zip.readEntry();
    }
  } finally {
    zip.close();
  }
  return containsAction;
}

async function check(mode) {
  const directory = path.join(artifact, mode);
  await fs.mkdir(directory);
  const reportFile = path.join(directory, "results.json");
  const config = path.join(directory, "config.cjs");
  await fs.writeFile(config, `
const base = require(${JSON.stringify(configFile)});
module.exports = {
  ...base,
  metadata: { ...base.metadata, groupTimeoutMs: 12000 },
  globalTimeout: 16000,
  timeout: ${mode === "group" ? 60000 : 4000},
  retries: ${mode === "retry" ? 1 : 0},
  testDir: ${JSON.stringify(path.join(root, "tests/fixtures/playwright-timeouts"))},
  testMatch: "hang.fixture.cjs",
  webServer: undefined,
  outputDir: ${JSON.stringify(path.join(directory, "browser"))},
  reporter: [["line"], ["json", { outputFile: ${JSON.stringify(reportFile)} }]],
  projects: [{ ...base.projects[0], testMatch: undefined, testIgnore: undefined }],
  use: { ...base.use, video: "off" },
};
`);
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, DISPLAY: process.env.DISPLAY,
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    CI: "1", BASE_URL: origin, PW_PORT: String(port),
    PLAYWRIGHT_TIMEOUT_CASE: mode,
    TOOLING_NETWORK_GUARD: "1", ROO_TEST_NETWORK_ORIGINS: JSON.stringify([origin]),
  };
  Object.assign(env, withNodeOption(env, "--import", path.join(root, "scripts/lib/test-target-safety.mjs")));
  const logs = [];
  let members = [];
  let browserTracked = false;
  let watchdogExpired = false;
  const started = Date.now();
  active = spawnGroup(process.execPath, [require.resolve("@playwright/test/cli"), "test", "--config", config], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = chunk => {
    logs.push(chunk);
    if (!members.length && chunk.includes("Waiting for never-created")) {
      members = holdDescendants(active);
      browserTracked = members.some(fd => /chrome|chromium/.test(readFileSync(`/proc/self/fd/${fd}/comm`, "utf8")));
    }
  };
  active.stdout.on("data", capture);
  active.stderr.on("data", capture);
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    signalGroup(active, "SIGINT");
  }, 20000);
  let code;
  try {
    [code] = await once(active, "close");
  } finally {
    clearTimeout(watchdog);
    signalGroup(active, "SIGTERM");
    active = undefined;
  }
  const log = Buffer.concat(logs).toString();
  await fs.writeFile(path.join(directory, "run.log"), log);
  const report = JSON.parse(await fs.readFile(reportFile, "utf8"));
  const results = casesIn(report.suites).flatMap(test => test.results);
  const traces = results.flatMap(result => result.attachments).filter(item => item.name === "trace");
  const traceActions = await Promise.all(traces.map(trace => inspectTrace(trace.path)));
  return {
    mode, code, elapsedMs: Date.now() - started, watchdogExpired,
    statuses: results.map(result => result.status), traces: traces.length, traceActions,
    named: log.includes(`${mode}: browser action`), deadline: log.includes("Playwright group exceeded"),
    browserTracked, remainingProcesses: releaseGroupMembers(members),
  };
}

try {
  const results = [];
  for (const mode of ["pass", "test", "retry", "group"]) results.push(await check(mode));
  const budgetsFit = ["routes", "revalidation"].every(name => {
    const job = workflow.jobs[name];
    return job.strategy?.matrix?.suite.length === 2 && job.strategy["fail-fast"] === false &&
      job["timeout-minutes"] * 60000 > base.globalTimeout;
  });
  const report = { artifact, budgetsFit, results };
  await fs.writeFile(path.join(artifact, "check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.ok(budgetsFit, "Each browser group needs a separate job deadline.");
  assert.equal(results[0].code, 0);
  assert.equal(results[0].traces, 0, "Discard the healthy first attempt's trace.");
  for (const result of results.slice(1)) {
    assert.notEqual(result.code, 0, result.mode);
    assert.ok(!result.watchdogExpired && result.named && result.traces > 0, JSON.stringify(result));
    assert.ok(result.traceActions.every(Boolean), JSON.stringify(result));
    assert.ok(result.browserTracked, "Track the browser and workers before checking their shutdown.");
    assert.equal(result.remainingProcesses, 0, JSON.stringify(result));
  }
  assert.deepEqual(results[2].statuses, ["timedOut", "passed"]);
  assert.ok(results[3].deadline && results[3].elapsedMs < 16000, "Interrupt before the emergency deadline.");
} finally {
  interrupt();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
