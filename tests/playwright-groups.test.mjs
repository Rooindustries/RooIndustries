import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";
import {
  assignRestGroups,
  groupPattern,
  listSpecFiles,
  FIXED_GROUPS,
  JOB_RESERVE_MS,
  REST_1_EXTRA_SECONDS,
  REST_GROUPS,
} from "../scripts/playwright-groups.mjs";
import { mergeTimings } from "../scripts/playwright-timings.mjs";

const specFiles = listSpecFiles();
const timings = JSON.parse(fs.readFileSync(".github/playwright-timings.json", "utf8"));
const readMatrix = (timingFile = ".github/playwright-timings.json") => JSON.parse(execFileSync(process.execPath,
  ["scripts/playwright-groups.mjs", "matrix", timingFile],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

const assertBudgetsFit = (suites) => {
  for (const suite of suites) {
    const extraMs = suite.name === "rest-1" ? REST_1_EXTRA_SECONDS * 1000 : 0;
    assert.ok(suite.timeoutMs + extraMs + JOB_RESERVE_MS <= suite.timeoutMinutes * 60000,
      `${suite.name} must leave the full reserve for setup, shutdown and artifacts`);
    assert.ok(Number.isInteger(suite.timeoutMinutes) && suite.timeoutMinutes <= 360,
      `${suite.name} must fit a valid job limit`);
  }
};

const fixedPatterns = ["/section-nav\\.spec\\.js$", "/booking-flow\\.spec\\.js$"];

const groupPatterns = (files, fileTimings) => [
  ...fixedPatterns,
  ...Object.values(assignRestGroups(files, fileTimings))
    .filter(({ files: group }) => group.length)
    .map(({ files: group }) => groupPattern(group)),
];

const assertEachFileInOneGroup = (files, listGroup, fileTimings) => {
  const owners = Object.fromEntries(files.map((file) => [file, 0]));
  for (const pattern of groupPatterns(files, fileTimings)) {
    for (const file of listGroup(pattern)) owners[file] = (owners[file] ?? 0) + 1;
  }
  for (const [file, count] of Object.entries(owners)) assert.equal(count, 1, `${file} ran in ${count} groups`);
};

test("Playwright runs every spec file in exactly one browser group", () => {
  assert.ok(specFiles.length > 0);
  assert.ok(!specFiles.includes("admin-cms.spec.js"));
  assertEachFileInOneGroup(specFiles, (filter) => listSpecFiles({ filter }), timings);
});

test("rest groups stay within one file of each other, counting rest-1's extra checks", () => {
  const groups = assignRestGroups(specFiles, timings);
  const loads = REST_GROUPS.map((name) => groups[name].load);
  const heaviest = Math.max(...Object.values(timings));
  assert.ok(Math.max(...loads) - Math.min(...loads) <= heaviest, JSON.stringify(loads));
  assert.ok(groups["rest-1"].load >= REST_1_EXTRA_SECONDS);
});

test("a new spec file with no timing yet still gets a group", () => {
  const groups = assignRestGroups([...specFiles, "brand-new-page.spec.js"], timings);
  const owners = REST_GROUPS.filter((name) => groups[name].files.includes("brand-new-page.spec.js"));
  assert.equal(owners.length, 1);
});

test("the same timings always give the same groups", () => {
  assert.deepEqual(assignRestGroups([...specFiles].reverse(), timings), assignRestGroups(specFiles, timings));
});

test("the workflow gets group files, graceful deadlines and job limits from one measured plan", () => {
  const jobs = yaml.safeLoad(fs.readFileSync(".github/workflows/tests.yml", "utf8")).jobs;
  const job = jobs.playwright;
  assert.ok(job.needs.includes("playwright-plan"));
  assert.equal(job.strategy.matrix, "${{ fromJSON(needs.playwright-plan.outputs.matrix) }}");
  assert.equal(job["timeout-minutes"], "${{ matrix.suite.timeoutMinutes }}");
  assert.equal(job.env.PW_GROUP_TIMEOUT_MS, "${{ matrix.suite.timeoutMs }}");
  assert.equal(job.env.PW_FILES, "${{ matrix.suite.pattern }}");
  const planJob = jobs["playwright-plan"];
  assert.equal(planJob.outputs.matrix, "${{ steps.plan.outputs.matrix }}");
  assert.ok(planJob.steps.some(step => step.id === "plan" &&
    step.run?.includes("scripts/playwright-groups.mjs matrix .playwright-timings/timings.json") &&
    step.run.includes('"matrix=$matrix" >> "$GITHUB_OUTPUT"')));
  const { suite } = readMatrix();
  assert.deepEqual(suite.map(group => group.name), [...Object.keys(FIXED_GROUPS), ...REST_GROUPS]);
  assertBudgetsFit(suite);
  const owners = Object.fromEntries(specFiles.map(file => [file, 0]));
  for (const group of suite) {
    const files = specFiles.filter(file => new RegExp(group.pattern).test(`/tests/${file}`));
    assert.ok(files.length, group.name);
    for (const file of files) owners[file] += 1;
    const measured = files.reduce((total, file) => total + (timings[file] || 0), 0);
    assert.ok(group.timeoutMs > measured * 1000, `${group.name} needs time beyond its healthy measured run`);
    assert.ok(group.timeoutMs >= 60 * 60000 - JOB_RESERVE_MS - group.extraMs,
      `${group.name} must use the job budget instead of stale estimates`);
    assert.equal(group.relocate, group.name === "navigation");
  }
  for (const [file, count] of Object.entries(owners)) assert.equal(count, 1, `${file} ran in ${count} groups`);
});

test("recent real runs and their retries fit without relying on the old file estimates", () => {
  const recent = JSON.parse(fs.readFileSync("tests/fixtures/playwright-timeouts/recent-runs.json", "utf8"));
  const { suite } = readMatrix();
  for (const group of suite) {
    assert.ok(group.timeoutMs > recent.durationMs[group.name], `${group.name}: ${recent.source}`);
  }
  const rest = suite.find(group => group.name === "rest-1");
  assert.ok(rest.timeoutMs > 944000, "The November 8 rest-1 run outlasted its old 889-second deadline");
});

test("old file estimates never shorten or inflate the existing job budget", () => {
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results", "playwright-budget-"));
  const timingFile = path.join(dir, "timings.json");
  try {
    for (const seconds of [10, 100, 1200, 5000]) {
      fs.writeFileSync(timingFile, JSON.stringify({ ...timings, "booking-flow.spec.js": seconds }));
      const { suite } = readMatrix(timingFile);
      assertBudgetsFit(suite);
      const group = suite.find(group => group.name === "booking");
      assert.equal(group.timeoutMinutes, 60);
      assert.equal(group.timeoutMs, 50 * 60000);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every native browser run fits the combined job deadline", () => {
  const jobs = yaml.safeLoad(fs.readFileSync(".github/workflows/tests.yml", "utf8")).jobs;
  const job = jobs.native;
  const plan = JSON.parse(execFileSync(process.execPath, ["scripts/playwright-groups.mjs", "native"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.ok(job.needs.includes("playwright-plan"));
  assert.equal(jobs["playwright-plan"].outputs.native, "${{ steps.plan.outputs.native }}");
  assert.ok(jobs["playwright-plan"].steps.some(step => step.id === "plan" &&
    step.run?.includes("node scripts/playwright-groups.mjs native") &&
    step.run.includes('"native=$native" >> "$GITHUB_OUTPUT"')));
  assert.equal(job["timeout-minutes"], "${{ fromJSON(needs.playwright-plan.outputs.native).timeoutMinutes }}");
  const runs = job.steps.filter(step => step.run?.includes("playwright test"));
  const deadlines = runs.map(step => {
    const match = step.env.PW_GROUP_TIMEOUT_MS.match(
      /^\$\{\{ fromJSON\(needs\.playwright-plan\.outputs\.native\)\.(\w+) \}\}$/,
    );
    assert.ok(match, `${step.name} must use the job plan`);
    return plan[match[1]];
  });
  assert.deepEqual(deadlines, [35 * 60000, 20 * 60000]);
  assert.ok(plan.extraMs >= 7 * 60000, "Setup and the remaining native suites need time too");
  const required = deadlines.reduce((total, deadline) => total + deadline, plan.extraMs + JOB_RESERVE_MS);
  assert.ok(required <= plan.timeoutMinutes * 60000, "Both browser runs must fit before shutdown and uploads");
});

test("every creator-portal run and its route audit fit the same job budget", () => {
  const jobs = yaml.safeLoad(fs.readFileSync(".github/workflows/tests.yml", "utf8")).jobs;
  const job = jobs.routes;
  const suites = job.strategy.matrix.suite;
  assert.equal(job["timeout-minutes"], "${{ matrix.suite.timeoutMinutes }}");
  for (const suite of suites) {
    const runs = job.steps.filter(step => step.name === "Run browser suite" ||
      (suite.name === "creator-portal" && step.run?.includes("npm run test:fixture-ports:browser")));
    assert.equal(runs.length, suite.name === "creator-portal" ? 2 : 1);
    const required = runs.length * Number(job.env.PW_GROUP_TIMEOUT_MS) +
      (suite.extraMs || 0) + JOB_RESERVE_MS;
    assert.ok(required <= suite.timeoutMinutes * 60000, suite.name);
    if (suite.name === "creator-portal") assert.ok(suite.extraMs >= 15 * 60000);
  }
});

test("merged timings use each file's median across runs", () => {
  const report = (seconds) => ({
    suites: [{ file: "a.spec.js", specs: [{ tests: [{ results: [{ duration: seconds * 1000 }] }] }], suites: [] }],
  });
  assert.deepEqual(mergeTimings([report(10), report(40), report(20)]), { "a.spec.js": 20 });
});

test("the timing collector includes failed attempts and retries", () => {
  const report = {
    suites: [{ file: "retry.spec.js", specs: [{ tests: [{ results: [
      { duration: 120000, status: "timedOut", retry: 0 },
      { duration: 75000, status: "passed", retry: 1 },
    ] }] }] }],
  };
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results", "playwright-timings-"));
  try {
    fs.writeFileSync(path.join(dir, "retry.json"), JSON.stringify(report));
    const timings = JSON.parse(execFileSync(process.execPath, ["scripts/playwright-timings.mjs", dir]));
    assert.equal(timings["retry.spec.js"], 195);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a spec file in a subfolder is found and runs in exactly one group", () => {
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results", "playwright-groups-"));
  const config = path.join(dir, "playwright.config.mjs");
  fs.writeFileSync(config, 'export default { testDir: "./tests", testMatch: "**/*.spec.js" };\n');
  fs.mkdirSync(path.join(dir, "tests", "admin"), { recursive: true });
  const spec = 'import { test } from "@playwright/test";\ntest("loads", () => {});\n';
  for (const file of ["section-nav", "booking-flow", "home", "admin/home", "admin/publish"]) {
    fs.writeFileSync(path.join(dir, "tests", `${file}.spec.js`), spec);
  }
  fs.writeFileSync(path.join(dir, "tests", "admin", "helper.js"), "");
  try {
    const files = listSpecFiles({ config });
    assert.deepEqual(files, [
      "admin/home.spec.js",
      "admin/publish.spec.js",
      "booking-flow.spec.js",
      "home.spec.js",
      "section-nav.spec.js",
    ]);
    assertEachFileInOneGroup(files, (filter) => listSpecFiles({ config, filter }), {});
    const before = { ...process.env };
    process.env.PLAYWRIGHT_JSON_OUTPUT_NAME = "elsewhere.json";
    process.env.PLAYWRIGHT_JSON_OUTPUT_DIR = dir;
    process.env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(dir, "elsewhere.json");
    try {
      assert.deepEqual(listSpecFiles({ config }), files);
    } finally {
      for (const name of ["PLAYWRIGHT_JSON_OUTPUT_NAME", "PLAYWRIGHT_JSON_OUTPUT_DIR", "PLAYWRIGHT_JSON_OUTPUT_FILE"]) {
        if (name in before) process.env[name] = before[name];
        else delete process.env[name];
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a spec Playwright can't load fails the listing with its error", () => {
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results", "playwright-groups-"));
  const config = path.join(dir, "playwright.config.mjs");
  fs.writeFileSync(config, 'export default { testDir: "./tests" };\n');
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "broken.spec.js"), 'throw new Error("broken spec file");\n');
  try {
    assert.throws(() => listSpecFiles({ config }), /broken spec file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("both scripts can be imported without a script path", () => {
  for (const script of ["playwright-groups", "playwright-timings"]) {
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import("./scripts/${script}.mjs");`]);
  }
});
