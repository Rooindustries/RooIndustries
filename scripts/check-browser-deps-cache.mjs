import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const load = file => yaml.load(fs.readFileSync(file, "utf8"));
const setup = load(".github/actions/setup/action.yml");
const steps = setup.runs.steps;
const enabled = "${{ inputs.browsers != '' && inputs.browser-deps == 'true' && !startsWith(runner.name, 'devbox-') }}";
const packages = steps.find(step => step.id === "system-packages");
assert.equal(packages?.if, enabled, "Read the system package key whenever browser dependencies are enabled.");
assert.equal(packages.run.split("\n")[0], 'rm -rf -- "${HOME:?}/.cache/roo-playwright-apt"',
  "Clear leftover system packages before restoring the cache.");
assert.ok(packages.run.includes('echo "week=$(date -u +%G-%V)" >> "$GITHUB_OUTPUT"'),
  "Use the current UTC ISO week for the system package cache.");
const install = steps.findIndex(step => step.run?.includes("scripts/install-browser-deps.sh"));
const cache = steps.findIndex(step => step.uses === "actions/cache/restore@v4" &&
  step.with?.path === "~/.cache/roo-playwright-apt/*.deb");
assert.ok(cache >= 0 && install > cache, "Restore system packages before installing browser dependencies.");
assert.ok(steps.indexOf(packages) < cache, "Clear system packages before restoring the cache.");
assert.equal(steps[cache].if, enabled, "Restore system packages whenever browser dependencies are enabled.");
assert.equal(steps[install].if, enabled, "Install browser system packages whenever dependencies are enabled.");
assert.equal(steps[cache].id, "apt-packages");
assert.equal(steps[install].id, "install-system-packages");
for (const part of ["runner.arch", "steps.system-packages.outputs.os", "steps.playwright.outputs.version",
  "steps.playwright.outputs.browsers", "steps.system-packages.outputs.image"]) {
  assert.ok(steps[cache].with.key.includes("${{ " + part + " }}"), `System package cache key must include ${part}.`);
}
assert.ok(steps[cache].with.key.endsWith("-${{ steps.system-packages.outputs.week }}"),
  "Use the current week as the final part of the system package cache key.");
assert.equal(steps[cache].with["restore-keys"],
  steps[cache].with.key.replace("${{ steps.system-packages.outputs.image }}-${{ steps.system-packages.outputs.week }}", ""),
  "Reuse package archives from older runner images with the same browsers and operating system.");
const save = steps.findIndex(step => step.uses === "actions/cache/save@v4" &&
  step.with?.path === steps[cache].with.path);
assert.equal(save, install + 1, "Save downloaded system packages immediately after a successful install.");
assert.equal(steps[save].if,
  "${{ always() && steps.install-system-packages.outcome == 'success' && steps.apt-packages.outputs.cache-hit != 'true' && github.ref == 'refs/heads/main' && !startsWith(runner.name, 'devbox-') }}",
  "Save successful installs on main even if another step fails, but never cache a failed install.");
assert.equal(steps[save].with.key, "${{ steps.apt-packages.outputs.cache-primary-key }}");

const seedFile = ".github/workflows/browser-deps-cache.yml";
const seed = load(seedFile);
assert.deepEqual(seed.on.push.branches, ["main"], "Seed shared caches on main, independently of skipped browser jobs.");
for (const file of [seedFile, ".github/actions/setup/action.yml", "scripts/install-browser-deps.sh",
  "package.json", "package-lock.json"]) {
  assert.ok(seed.on.push.paths.includes(file), `Refresh shared system packages when ${file} changes.`);
}
assert.ok(seed.on.schedule.some(schedule => schedule.cron === "41 3 * * 1"), "Refresh system packages weekly.");
assert.ok(Object.hasOwn(seed.on, "workflow_dispatch"), "Allow manual refreshes of the shared cache.");
const job = seed.jobs["browser-deps"];
assert.equal(job["runs-on"], "ubuntu-24.04");
assert.equal(job.needs, undefined, "Cache refreshes must not depend on the tested-tree shortcut.");
assert.equal(job.if, undefined, "Cache refreshes must run on every configured event.");
const seedSetup = job.steps.find(step => step.uses === "./.github/actions/setup");
assert.equal(seedSetup?.with.browsers, "${{ matrix.browsers }}");
assert.notEqual(seedSetup.with["browser-deps"], "false");

for (const directory of [".github/actions", ".github/workflows"]) {
  for (const entry of fs.readdirSync(directory, { recursive: true })) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const file = path.join(directory, entry);
    if (file === ".github/workflows/production-smoke.yml") continue;
    assert.ok(!/install-deps|--with-deps/.test(fs.readFileSync(file, "utf8")),
      `${file}: install browser dependencies through the cached setup action.`);
    if (directory !== ".github/workflows" || file === seedFile) continue;
    for (const workflowJob of Object.values(load(file).jobs ?? {})) {
      for (const step of workflowJob.steps ?? []) {
        if (step.uses !== "./.github/actions/setup" || !step.with?.browsers ||
          step.with["browser-deps"] === "false") continue;
        assert.ok(job.strategy.matrix.browsers.includes(step.with.browsers),
          `${file}: seed the shared system package cache for ${step.with.browsers}.`);
      }
    }
  }
}
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.match(manifest.devDependencies["js-yaml"], /^\d+\.\d+\.\d+$/, "Pin the YAML parser used by this check.");
console.log("Browser system dependency installs use the package cache.");
