import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { localOrigin } from "./lib/test-target-safety.mjs";

const baseURL = localOrigin(process.env.BASE_URL);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
assert.equal(git("status", "--porcelain"), "", "Commit all changes before collecting navigation proof.");
const directory = path.resolve("test-results/section-nav-consecutive", `${commit.slice(0, 12)}-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const proof = { commit, baseURL, runs: [] };
const artifacts = ["phase1-nav-reliability", "phase1-client-crash-log", "phase1-hydration-log"];
for (const key of Object.keys(process.env)) if (/sentry.*dsn/i.test(key)) delete process.env[key];

for (let run = 1; run <= 5; run++) {
  assert.equal(git("rev-parse", "HEAD"), commit, "The proof commit changed.");
  assert.equal(git("status", "--porcelain"), "", "The proof source changed.");
  for (const artifact of artifacts) fs.rmSync("audit/" + artifact + ".json", { force: true });
  const report = path.join(directory, `run-${run}.json`);
  const log = fs.openSync(path.join(directory, `run-${run}.log`), "w");
  let result;
  try {
    result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "tests/section-nav.spec.js", "--project=chromium", "--workers=1", "--retries=0", "--reporter=line,json", `--output=${path.join(directory, `run-${run}`)}`], {
      env: { ...process.env, BASE_URL: baseURL, NAV_REPEAT_COUNT_DESKTOP: "5", NAV_REPEAT_COUNT_MOBILE: "3", NAV_CPU_THROTTLE_RATE: "1", PLAYWRIGHT_JSON_OUTPUT_NAME: report }, stdio: ["ignore", log, log],
    });
  } finally {
    fs.closeSync(log);
  }
  const missingArtifacts = [];
  for (const artifact of artifacts) {
    if (fs.existsSync(`audit/${artifact}.json`)) fs.copyFileSync(`audit/${artifact}.json`, path.join(directory, `run-${run}-${artifact}.json`));
    else missingArtifacts.push(artifact);
  }
  const stats = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, "utf8")).stats : null;
  proof.runs.push({ run, status: result.status, signal: result.signal, error: result.error?.message, stats, missingArtifacts });
  fs.writeFileSync(path.join(directory, "summary.json"), JSON.stringify(proof, null, 2) + "\n");
  assert.equal(git("rev-parse", "HEAD"), commit, "The proof commit changed during navigation.");
  assert.equal(git("status", "--porcelain"), "", "The proof source changed during navigation.");
  assert.equal(result.status, 0, `Navigation run ${run} failed; retain its report before fixing the cause.`);
  assert.deepEqual({ expected: stats?.expected, skipped: stats?.skipped, unexpected: stats?.unexpected, flaky: stats?.flaky }, { expected: 4, skipped: 0, unexpected: 0, flaky: 0 });
  assert.deepEqual(missingArtifacts, [], "The navigation run must produce all three fresh audit files.");
  console.log(`Navigation run ${run}/5: passed. Evidence: ${directory}`);
}
