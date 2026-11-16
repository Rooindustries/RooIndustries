import fs from "node:fs";
import { planProblems } from "./lib/playwright-proof.mjs";
import {
  FIXED_GROUPS, assignRestGroups, groupPattern, groupSpecFiles, listReport, readTimings, reportTests,
} from "./playwright-groups.mjs";

const USAGE = "usage: plan-playwright-proof.mjs plan <tests at a time> <legs json> <timings file> [<config>]\n" +
  "       plan-playwright-proof.mjs files <plan file> <leg>";

const planLegs = (workers, legs, timingsFile, config) => {
  const report = listReport({ config });
  const specFiles = groupSpecFiles(report, config);
  const listed = Object.groupBy(reportTests(report), ({ id }) => id[0]);
  const timings = readTimings(timingsFile);
  const restGroups = new Map();
  const filesOf = ({ group, seed }) => {
    if (Object.hasOwn(FIXED_GROUPS, group)) return FIXED_GROUPS[group];
    if (!restGroups.has(seed)) restGroups.set(seed, assignRestGroups(specFiles, timings, seed));
    return restGroups.get(seed)[group]?.files;
  };
  const plan = {
    head_sha: process.env.GITHUB_SHA,
    workers: Number(workers),
    legs: legs.map((leg) => ({ name: `${leg.group}-${leg.repeat}`, group: leg.group, repeat: leg.repeat, files: filesOf(leg) })),
    tests: Object.fromEntries(specFiles.map((file) => [file, (listed[file] || []).map(({ id }) => id)])),
  };
  const problems = planProblems(plan);
  if (problems.length) throw new Error(["The plan does not hold, so nothing was run.", ...problems].join("\n"));
  return plan;
};

const [command, ...args] = process.argv.slice(2);
if (command === "plan" && (args.length === 3 || args.length === 4)) {
  const [workers, legs, timingsFile, config] = args;
  process.stdout.write(`${JSON.stringify(planLegs(workers, JSON.parse(legs), timingsFile, config))}\n`);
} else if (command === "files" && args.length === 2) {
  const [planFile, name] = args;
  const leg = JSON.parse(fs.readFileSync(planFile, "utf8")).legs.find((planned) => planned.name === name);
  if (!leg) throw new Error(`The plan has no leg ${name}.`);
  process.stdout.write(`${groupPattern(leg.files)}\n`);
} else {
  throw new Error(USAGE);
}
