import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { assignRestGroups, groupPattern, REST_1_EXTRA_SECONDS, REST_GROUPS } from "../scripts/playwright-groups.mjs";
import { mergeTimings } from "../scripts/playwright-timings.mjs";

const specFiles = fs.readdirSync("tests").filter((file) => file.endsWith(".spec.js"));
const timings = JSON.parse(fs.readFileSync(".github/playwright-timings.json", "utf8"));

test("every spec file runs in exactly one browser group", () => {
  const patterns = [
    "/section-nav\\.spec\\.js$",
    "/booking-flow\\.spec\\.js$",
    ...Object.values(assignRestGroups(specFiles, timings)).map(({ files }) => groupPattern(files)),
  ].map((pattern) => new RegExp(pattern));
  for (const file of specFiles) {
    const matches = patterns.filter((pattern) => pattern.test(`/repo/tests/${file}`));
    assert.equal(matches.length, 1, `${file} matched ${matches.length} groups`);
  }
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
