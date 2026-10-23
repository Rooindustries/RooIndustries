import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { on, once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { yauzl } from "playwright-core/lib/zipBundle";
import yaml from "js-yaml";
import { installNetworkGuard, refuseEnvFiles } from "./lib/test-target-safety.mjs";

refuseEnvFiles();
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const config = require(path.join(root, "playwright.config.js"));
const workflow = yaml.safeLoad(await readFile(path.join(root, ".github/workflows/tests.yml"), "utf8"));
const jobPlans = {};
for (const [name, scripts] of Object.entries({
  routes: ["test:api:routes", "test:creator:portal"],
  revalidation: ["test:benchmarks:revalidation", "test:static:revalidation"],
})) {
  const job = workflow.jobs[name];
  jobPlans[name] = (job.strategy?.matrix?.suite || [{}]).flatMap(suite => {
    const expand = text => text.replace(/\$\{\{\s*matrix\.suite\.(\w+)\s*\}\}/g, (_, key) => suite[key]);
    const commands = job.steps.flatMap(step => [...expand(step.run || "").matchAll(/\bnpm run ([\w:-]+)/g)].map(match => match[1]))
      .filter(script => scripts.includes(script));
    const artifactName = expand(job.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"))?.with.name || "");
    return commands.map(script => ({
      id: `${name}-${suite.name || "shared"}`, script,
      timeoutMs: job["timeout-minutes"] * 60 * 1000,
      groups: commands.length, artifactName,
      budgetFits: commands.length * config.globalTimeout < job["timeout-minutes"] * 60 * 1000,
      siblingSurvivesFailure: !job.strategy || job.strategy["fail-fast"] === false,
    }));
  });
  assert.deepEqual(jobPlans[name].map(job => job.script).sort(), [...scripts].sort(), `${name} must keep every suite.`);
}
const workflowBudgetsFit = Object.values(jobPlans).every(jobs => jobs.every(job => job.budgetFits && job.siblingSurvivesFailure) &&
  new Set(jobs.map(job => job.artifactName)).size === jobs.length);
const jobDeadlines = new Map();
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

async function check(mode, job) {
  const isGroup = mode.startsWith("group");
  const setupDelayMs = mode === "group-first" ? 10000 : 0;
  const groupTimeoutMs = config.metadata.groupTimeoutMs / (isGroup ? 40 : 20);
  const globalTimeoutMs = isGroup ? config.globalTimeout / 40 + 10000 : config.globalTimeout / 20;
  assert.ok(groupTimeoutMs > 0 && globalTimeoutMs > groupTimeoutMs && config.timeout > 0);
  if (job && !jobDeadlines.has(job.id)) jobDeadlines.set(job.id, Date.now() + job.timeoutMs / 40);
  const directory = path.join(artifact, mode);
  await mkdir(directory);
  const reportPath = path.join(directory, "results.json");
  const configPath = path.join(directory, "config.cjs");
  await writeFile(configPath, `
const config = require(${JSON.stringify(path.join(root, "playwright.config.js"))});
${setupDelayMs ? `if (process.env.TEST_WORKER_INDEX === undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${setupDelayMs});` : ""}
module.exports = {
  ...config,
  metadata: { ...config.metadata, groupTimeoutMs: ${groupTimeoutMs} },
  testDir: ${JSON.stringify(path.join(root, "tests/fixtures/playwright-timeouts"))},
  testMatch: "hang.fixture.cjs",
  webServer: undefined,
  outputDir: ${JSON.stringify(path.join(directory, "browser"))},
  globalTimeout: ${globalTimeoutMs},
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
    NODE_ENV: "test",
    BASE_URL: origin,
    ROO_TEST_HOST: "127.0.0.1",
    PW_PORT: String(port),
    PW_SERVER_ID: `timeouts-${process.pid}-${mode}`,
    TOOLING_NETWORK_GUARD: "1",
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([origin]),
    NODE_OPTIONS: `--import=${fileURLToPath(new URL("./lib/test-target-safety.mjs", import.meta.url))}`,
    PLAYWRIGHT_TIMEOUT_CASE: mode,
    ...(!isGroup ? { PLAYWRIGHT_ACTION_TIMEOUT_MS: String(config.timeout / 12) } : {}),
  };
  const logs = [];
  const started = Date.now();
  let watchdogExpired = false;
  let jobDeadlineExpired = false;
  let escalation;
  active = spawn(process.execPath, [path.join(root, "node_modules/playwright/cli.js"), "test", "--config", configPath], {
    cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  active.stdout.on("data", chunk => logs.push(chunk));
  active.stderr.on("data", chunk => logs.push(chunk));
  const expire = () => {
    stop("SIGINT");
    escalation ??= setTimeout(() => stop("SIGKILL"), 5000);
  };
  const watchdog = setTimeout(() => {
    watchdogExpired = true;
    expire();
  }, 75000);
  const jobTimer = job ? setTimeout(() => {
    jobDeadlineExpired = true;
    expire();
  }, Math.max(0, jobDeadlines.get(job.id) - Date.now())) : undefined;
  let code;
  let signal;
  try { [code, signal] = await once(active, "close"); }
  finally {
    clearTimeout(watchdog);
    clearTimeout(jobTimer);
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
    mode, code, signal, watchdogExpired, jobDeadlineExpired, job, elapsedMs: Date.now() - started,
    setupDelayMs, groupTimeoutMs,
    deadlineIncludesSetup: !setupDelayMs || Date.now() - started < groupTimeoutMs + setupDelayMs * 0.8,
    tests: cases.map(test => ({ title: test.title, statuses: test.results.map(result => result.status) })),
    namedFailure: log.includes(`${mode}: deliberately hung browser action`),
    deadlineReported: isGroup ? /Playwright group exceeded \d+ms/.test(log) : /Test timeout of \d+ms exceeded/.test(log),
    traces: validTraces,
  };
  await writeFile(path.join(directory, "check.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

try {
  const results = [];
  for (const [mode, job] of [["pass"], ["test"], ["retry"], ["group-first", jobPlans.routes[0]], ["group-second", jobPlans.routes[1]]]) {
    assert.ok(!cancelled, "The timeout check was cancelled.");
    results.push(await check(mode, job));
  }
  const retry = results.find(result => result.mode === "retry");
  const retryRecovered = retry.tests.length === 1 && JSON.stringify(retry.tests[0].statuses) === JSON.stringify(["timedOut", "passed"]);
  const healthy = results.find(result => result.mode === "pass");
  const healthyPassed = healthy.code === 0 && healthy.tests.length === 1 && JSON.stringify(healthy.tests[0].statuses) === JSON.stringify(["passed"]);
  const ok = !cancelled && workflowBudgetsFit && healthyPassed && retryRecovered && results.filter(result => result.mode !== "pass").every(result => result.code !== 0 &&
    !result.watchdogExpired && !result.jobDeadlineExpired && result.namedFailure &&
    result.deadlineReported && result.deadlineIncludesSetup && result.traces.length > 0 && result.traces.every(trace => trace.containsHungAction));
  const report = { ok, artifact, workflowBudgetsFit, healthyPassed, retryRecovered, jobPlans, results };
  await writeFile(path.join(output, "playwright-timeouts.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  assert.ok(ok, "A hung browser action did not fail at its own deadline with its name and a valid trace.");
} finally {
  stop("SIGINT");
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
