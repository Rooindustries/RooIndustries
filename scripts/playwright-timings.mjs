import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const reportFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return reportFiles(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });

const fileSeconds = (report) => {
  if (
    report && typeof report === "object" && !Array.isArray(report) &&
    !("suites" in report) && Object.values(report).every((value) => typeof value === "number")
  ) return report;
  const seconds = {};
  const walk = (suite, file) => {
    const owner = suite.file || file;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          seconds[owner] = (seconds[owner] || 0) + result.duration / 1000;
        }
      }
    }
    for (const child of suite.suites || []) walk(child, owner);
  };
  for (const suite of report.suites || []) walk(suite, suite.file);
  return seconds;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const mergeTimings = (reports) => {
  const samples = {};
  for (const report of reports) {
    for (const [file, seconds] of Object.entries(fileSeconds(report))) {
      (samples[file] ||= []).push(seconds);
    }
  }
  return Object.fromEntries(
    Object.keys(samples)
      .sort()
      .map((file) => [file, Math.round(median(samples[file]) * 10) / 10]),
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const allowEmpty = args.includes("--allow-empty");
  const [dir] = args.filter((arg) => arg !== "--allow-empty");
  if (!dir) {
    throw new Error(
      "Usage: node scripts/playwright-timings.mjs [--allow-empty] <directory of Playwright JSON reports>",
    );
  }
  const reports = reportFiles(dir).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const timings = mergeTimings(reports);
  if (!allowEmpty && !Object.keys(timings).length) throw new Error(`No Playwright test timings found under ${dir}`);
  process.stdout.write(`${JSON.stringify(timings, null, 2)}\n`);
}
