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
  REST_1_EXTRA_SECONDS,
  REST_GROUPS,
} from "../scripts/playwright-groups.mjs";
import { mergeTimings } from "../scripts/playwright-timings.mjs";

const specFiles = listSpecFiles();
const timings = JSON.parse(fs.readFileSync(".github/playwright-timings.json", "utf8"));

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

test("the workflow gets each browser group's files and deadline from its measured timings", () => {
  const job = yaml.safeLoad(fs.readFileSync(".github/workflows/tests.yml", "utf8")).jobs.playwright;
  assert.ok(job.steps.some(step => step.run?.includes('timings.json env >> "$GITHUB_ENV"')));
  const fullDuration = Object.values(timings).reduce((total, seconds) => total + seconds, 0);
  for (const group of [...Object.keys(FIXED_GROUPS), ...REST_GROUPS]) {
    const plan = execFileSync(process.execPath, ["scripts/playwright-groups.mjs", group,
      ".github/playwright-timings.json", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const env = Object.fromEntries(plan.trim().split("\n").map(line => line.split("=")));
    const files = specFiles.filter(file => new RegExp(env.PW_FILES).test(`/tests/${file}`));
    assert.ok(files.length, group);
    const measured = files.reduce((total, file) => total + (timings[file] || 0), 0);
    const deadline = Number(env.PW_GROUP_TIMEOUT_MS);
    assert.ok(deadline > measured * 1000, `${group} needs time beyond its healthy measured run`);
    assert.ok(deadline < fullDuration * 1000, `${group} must use its own workload`);
    assert.ok(deadline + 120000 < job["timeout-minutes"] * 60000, `${group} needs time to save reports`);
  }
});

test("a changed measurement updates the workflow deadline", () => {
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results", "playwright-budget-"));
  const timingFile = path.join(dir, "timings.json");
  const deadlines = [];
  try {
    for (const seconds of [10, 100]) {
      fs.writeFileSync(timingFile, JSON.stringify({ "booking-flow.spec.js": seconds }));
      const plan = execFileSync(process.execPath, ["scripts/playwright-groups.mjs", "booking", timingFile, "env"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      deadlines.push(Number(plan.match(/PW_GROUP_TIMEOUT_MS=(\d+)/)[1]));
    }
    assert.ok(deadlines[1] > deadlines[0], "The deadline must follow the selected group's measured time.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("merged timings use each file's median across runs", () => {
  const report = (seconds) => ({
    suites: [{ file: "a.spec.js", specs: [{ tests: [{ results: [{ duration: seconds * 1000 }] }] }], suites: [] }],
  });
  assert.deepEqual(mergeTimings([report(10), report(40), report(20)]), { "a.spec.js": 20 });
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
