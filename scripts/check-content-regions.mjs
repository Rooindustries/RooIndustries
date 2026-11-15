import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

const config = JSON.parse(readFileSync("vercel.json", "utf8"));
const { functions } = config;
assert.deepEqual(config.regions, ["dub1"], "Default function region must be dub1");
assert.deepEqual(functions["app/api/downloads/file/route.js"]?.regions, ["iad1"], "File download region must be iad1");
for (const pattern of [
  "app/api/admin/content/**/*",
  "app/api/admin/referral-creators/route.js",
  "app/api/content/**/*",
  "app/api/tools/*/download/route.js",
  "app/api/admin/commerce-readiness/route.js",
  "app/api/bookingAvailability/route.js",
  "app/api/holdSlot/route.js",
  "app/api/releaseHold/route.js",
  "app/api/payment/**/*",
  "app/api/razorpay/**/*",
  "app/api/ref/**/*",
]) {
  assert.deepEqual(functions[pattern]?.regions, ["dub1"], `${pattern} must remain in dub1`);
}
const routeFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = join(directory, entry.name);
  return entry.isDirectory() ? routeFiles(file) : /^(?:route|page)\.(?:js|jsx|ts|tsx)$/.test(entry.name) ? [file] : [];
});
for (const file of routeFiles("app")) {
  assert.doesNotMatch(readFileSync(file, "utf8"), /\bpreferredRegion\b/, `${file} declares preferredRegion`);
}
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
}
console.log(`Dublin function regions configured for ${routes.length} content and admin routes.`);
