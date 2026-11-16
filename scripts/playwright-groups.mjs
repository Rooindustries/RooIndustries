import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const FIXED_GROUPS = { navigation: ["section-nav.spec.js"], booking: ["booking-flow.spec.js"] };
export const REST_GROUPS = ["rest-1", "rest-2", "rest-3", "rest-4"];
export const REST_1_EXTRA_SECONDS = 250;

const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const nativeOnly = new Set(["booking-hold.spec.js", "booking-email-browser.spec.js", "booking-payment-recovery.spec.js", "booking-coupons.spec.js", "lookup-filters-browser.spec.js"]);

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

export const reportTests = (report) => {
  const tests = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests) {
        tests.push({ id: [spec.file, spec.line, spec.column, test.projectName, [...titles, spec.title]], results: test.results });
      }
    }
    for (const child of suite.suites || []) walk(child, [...titles, child.title]);
  };
  for (const suite of report.suites || []) walk(suite, []);
  return tests;
};

export const listReport = ({ filter, config } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-list-"));
  const reportFile = path.join(dir, "list.json");
  const args = [playwrightCli, "test", "--list", "--reporter=json"];
  if (config) args.push("--config", config);
  if (filter) args.push(filter);
  const readReport = () => JSON.parse(fs.readFileSync(reportFile, "utf8"));
  try {
    execFileSync(process.execPath, args, {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
    });
    return readReport();
  } catch (error) {
    const errors = fs.existsSync(reportFile) ? (readReport().errors || []).map(({ message }) => message) : [];
    throw new Error(["Playwright couldn't list the spec files", ...errors].join("\n"), { cause: error });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export const listSpecFiles = (options = {}) => {
  const files = reportSpecFiles(listReport(options));
  return options.config ? files : files.filter(file => !nativeOnly.has(file));
};

export const assignRestGroups = (specFiles, timings, seed = 0) => {
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
  const start = seed % ordered.length;
  for (const file of [...ordered.slice(start), ...ordered.slice(0, start)]) {
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

export const readTimings = (timingsFile) => {
  const candidates = [timingsFile, path.join(".github", "playwright-timings.json")];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf8"));
  }
  throw new Error(`No Playwright timings file found in ${candidates.filter(Boolean).join(", ")}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [group, timingsFile] = process.argv.slice(2);
  if (!REST_GROUPS.includes(group)) throw new Error(`Unknown rest group "${group}"`);
  const specFiles = listSpecFiles();
  const timings = readTimings(timingsFile);
  const assigned = assignRestGroups(specFiles, timings)[group];
  if (!assigned.files.length) throw new Error(`Rest group ${group} has no spec files`);
  console.error(`${group}: ${assigned.files.length} files, about ${Math.round(assigned.load)}s`);
  process.stdout.write(`${groupPattern(assigned.files)}\n`);
}
