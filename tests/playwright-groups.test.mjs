import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assignRestGroups,
  groupPattern,
  listSpecFiles,
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
