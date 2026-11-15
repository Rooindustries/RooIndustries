import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

const functions = JSON.parse(readFileSync("vercel.json", "utf8")).functions;
const routeFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? routeFiles(file) : /^route\.(?:js|jsx|ts|tsx)$/.test(entry.name) ? [file] : [];
});
const routes = [
  ...routeFiles("app/api/admin/content"),
  ...routeFiles("app/api/content"),
  ...routeFiles("app/api/admin/referral-creators"),
  ...routeFiles("app/api/tools").filter((file) => matchesGlob(file, "app/api/tools/*/download/route.*")),
];

for (const route of routes) {
  const matches = Object.entries(functions).filter(([pattern]) => matchesGlob(route, pattern));
  assert.ok(matches.length, `No function region configured for ${route}`);
  for (const [pattern, settings] of matches) {
    assert.deepEqual(settings.regions, ["dub1"], `${route} has conflicting regions in ${pattern}`);
    assert.deepEqual(settings, matches[0][1], `${route} has conflicting function settings in ${pattern}`);
  }
  assert.doesNotMatch(readFileSync(route, "utf8"), /\bpreferredRegion\b/, `${route} declares preferredRegion`);
}
console.log(`Dublin function regions configured for ${routes.length} content and admin routes.`);
