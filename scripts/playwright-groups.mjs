import { REST_GROUPS, assignRestGroups, groupPattern, listSpecFiles, readTimings } from "./lib/playwright-groups.mjs";

const [group, timingsFile] = process.argv.slice(2);
if (!REST_GROUPS.includes(group)) throw new Error(`Unknown rest group "${group}"`);
const specFiles = listSpecFiles();
const timings = readTimings(timingsFile);
const assigned = assignRestGroups(specFiles, timings)[group];
if (!assigned.files.length) throw new Error(`Rest group ${group} has no spec files`);
console.error(`${group}: ${assigned.files.length} files, about ${Math.round(assigned.load)}s`);
process.stdout.write(`${groupPattern(assigned.files)}\n`);
