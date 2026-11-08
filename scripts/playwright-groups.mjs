import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const FIXED_GROUPS = { navigation: ["section-nav.spec.js"], booking: ["booking-flow.spec.js"] };
export const REST_GROUPS = ["rest-1", "rest-2", "rest-3", "rest-4"];
export const REST_1_EXTRA_SECONDS = 250;
export const JOB_RESERVE_MS = 10 * 60 * 1000;
const BROWSER_JOB_MINUTES = 60;

const planJob = (deadlines, extraMs) => ({
  ...deadlines,
  extraMs,
  timeoutMinutes: Math.ceil((Object.values(deadlines).reduce((sum, ms) => sum + ms, 0) +
    extraMs + JOB_RESERVE_MS) / 60000),
});

const nativePlan = planJob({ adminTimeoutMs: 35 * 60000, bookingTimeoutMs: 20 * 60000 }, 15 * 60000);

const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");

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
  const args = [playwrightCli, "test", "--list", "--reporter=json"];
  if (config) args.push("--config", config);
  if (filter) args.push(filter);
  const readReport = () => JSON.parse(fs.readFileSync(reportFile, "utf8"));
  try {
    execFileSync(process.execPath, args, {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile },
    });
    return reportSpecFiles(readReport());
  } catch (error) {
    const errors = fs.existsSync(reportFile) ? (readReport().errors || []).map(({ message }) => message) : [];
    throw new Error(["Playwright couldn't list the spec files", ...errors].join("\n"), { cause: error });
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

const browserMatrix = (specFiles, timings) => {
  const rest = assignRestGroups(specFiles, timings);
  const suite = [...Object.keys(FIXED_GROUPS), ...REST_GROUPS].map((name) => {
    const fixedFiles = FIXED_GROUPS[name];
    const assigned = fixedFiles ? {
      files: specFiles.filter(file => fixedFiles.includes(path.posix.basename(file))),
      load: fixedFiles.reduce((total, file) => total + (timings[file] ?? median(Object.values(timings))), 0),
    } : rest[name];
    if (!assigned.files.length) throw new Error(`Browser group ${name} has no spec files`);
    const extraMs = name === "rest-1" ? REST_1_EXTRA_SECONDS * 1000 : 0;
    const timeoutMs = BROWSER_JOB_MINUTES * 60000 - JOB_RESERVE_MS - extraMs;
    console.error(`${name}: ${assigned.files.length} files, about ${Math.round(assigned.load)}s`);
    return {
      name,
      relocate: name === "navigation",
      pattern: groupPattern(assigned.files),
      ...planJob({ timeoutMs }, extraMs),
    };
  });
  return { suite };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [group, timingsFile] = process.argv.slice(2);
  if (group !== "native" && group !== "matrix") throw new Error(`Unknown browser group "${group}"`);
  const plan = group === "native" ? nativePlan : browserMatrix(listSpecFiles(),
    readTimings([timingsFile, path.join(".github", "playwright-timings.json")]));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}
