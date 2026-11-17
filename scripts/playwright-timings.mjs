import fs from "node:fs";
import path from "node:path";
import { mergeTimings } from "./lib/playwright-timings.mjs";

const reportFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return reportFiles(full);
    return entry.name.endsWith(".json") ? [full] : [];
  });

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
