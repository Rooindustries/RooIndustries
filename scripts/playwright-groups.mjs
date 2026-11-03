import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const FIXED_GROUPS = { navigation: ["section-nav.spec.js"], booking: ["booking-flow.spec.js"] };
export const REST_GROUPS = ["rest-1", "rest-2", "rest-3", "rest-4"];
export const REST_1_EXTRA_SECONDS = 250;

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const median = (values) => {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

export const reportSpecFiles = (report) => {
  const files = new Set();
  const walk = (suite) => {
    if (suite.file && suite.specs?.length) files.add(suite.file);
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);
  return [...files].sort();
};

export const listSpecFiles = ({ filter, config } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-list-"));
  const reportFile = path.join(dir, "list.json");
  const args = ["playwright", "test", "--list", "--reporter=json"];
  if (config) args.push("--config", config);
  if (filter) args.push(filter);
  try {
    execFileSync("npx", args, { stdio: "ignore", env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile } });
    return reportSpecFiles(JSON.parse(fs.readFileSync(reportFile, "utf8")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export const assignRestGroups = (specFiles, timings) => {
  const fixed = new Set(Object.values(FIXED_GROUPS).flat());
  const rest = specFiles.filter((file) => !fixed.has(path.posix.basename(file))).sort();
  const fallback = median(Object.values(timings));
  const weight = (file) => (Number.isFinite(timings[file]) ? timings[file] : fallback);
  const groups = REST_GROUPS.map((name, index) => ({
    name,
    load: index === 0 ? REST_1_EXTRA_SECONDS : 0,
    files: [],
  }));
  const ordered = [...rest].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  for (const file of ordered) {
    const lightest = groups.reduce((best, group) => (group.load < best.load ? group : best));
    lightest.files.push(file);
    lightest.load += weight(file);
  }
  return Object.fromEntries(groups.map((group) => [group.name, { files: group.files.sort(), load: group.load }]));
};

export const groupPattern = (files) => {
  const names = files.map((file) => escape(file.replace(/\.spec\.js$/, "")));
  return `/tests/(${names.join("|")})\\.spec\\.js$`;
};

const readTimings = (candidates) => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
  }
  throw new Error(`No Playwright timings file found in ${candidates.filter(Boolean).join(", ")}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [group, timingsFile] = process.argv.slice(2);
  if (!REST_GROUPS.includes(group)) throw new Error(`Unknown rest group "${group}"`);
  const specFiles = listSpecFiles();
  const timings = readTimings([timingsFile, path.join(".github", "playwright-timings.json")]);
  const assigned = assignRestGroups(specFiles, timings)[group];
  if (!assigned.files.length) throw new Error(`Rest group ${group} has no spec files`);
  console.error(`${group}: ${assigned.files.length} files, about ${Math.round(assigned.load)}s`);
  process.stdout.write(`${groupPattern(assigned.files)}\n`);
}
