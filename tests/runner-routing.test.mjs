import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const LABEL = "[a-z0-9][a-z0-9.-]*";
const PLAIN_LABEL = new RegExp(`^${LABEL}$`);
const VARIABLE_OR_LABEL = new RegExp(`^\\$\\{\\{ vars\\.([A-Z][A-Z0-9_]*) \\|\\| '(${LABEL})' \\}\\}$`);
const FORKS_ELSEWHERE = new RegExp(
  "^\\$\\{\\{ github\\.event_name == 'pull_request' && github\\.event\\.pull_request\\.head\\.repo\\.full_name != github\\.repository" +
  ` && '(${LABEL})' \\|\\| vars\\.([A-Z][A-Z0-9_]*) \\|\\| '(${LABEL})' \\}\\}$`,
);
const GITHUB_HOSTED = /^ubuntu-(?:latest|[0-9]{2}\.[0-9]{2})$/;
const DEPOT_HOSTED = /^depot-ubuntu-(?:latest|[0-9]{2}\.[0-9]{2})$/;
const vmLabel = (label) => GITHUB_HOSTED.test(label) || DEPOT_HOSTED.test(label);
const OUTSIDE_DEVBOX = "!startsWith(runner.name, 'devbox-')";
const OUTSIDE_DEVBOX_DEPS = [
  `\${{ ${OUTSIDE_DEVBOX} && '--with-deps' || '' }}`,
  `\${{ inputs.browser-deps == 'true' && ${OUTSIDE_DEVBOX} && '--with-deps' || '' }}`,
];
const INSTALLS = /\bsudo\b|apt-get|install-deps|--with-deps/;

const files = fs.readdirSync(".github/workflows");
const workflows = files
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, workflow: yaml.safeLoad(fs.readFileSync(path.join(".github/workflows", file), "utf8")) }));
const jobs = workflows.flatMap(({ file, workflow }) => Object.entries(workflow.jobs).map(([id, job]) => ({ file, workflow, id, job })));
const actions = fs.readdirSync(".github/actions").map((name) => path.join(".github/actions", name, "action.yml"));

const events = ({ file, on }) => {
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((event) => typeof event === "string")) return on;
  assert.ok(on && typeof on === "object" && !Array.isArray(on), `${file}: unreadable triggers ${JSON.stringify(on)}`);
  return Object.keys(on);
};

const runner = ({ file, id, job }) => {
  const runsOn = job["runs-on"];
  if (typeof runsOn === "string" && PLAIN_LABEL.test(runsOn)) return { label: runsOn };
  const variable = typeof runsOn === "string" ? VARIABLE_OR_LABEL.exec(runsOn) : null;
  if (variable) return { variable: variable[1], label: variable[2] };
  const forks = typeof runsOn === "string" ? FORKS_ELSEWHERE.exec(runsOn) : null;
  assert.ok(forks, `${file} ${id}: runs-on is not one of the checked forms: ${JSON.stringify(runsOn)}`);
  return { forkLabel: forks[1], variable: forks[2], label: forks[3] };
};

test("workflows are .yml files and every job names its runner in one of the checked forms", () => {
  for (const file of files) assert.match(file, /^[a-z0-9-]+\.yml$/, `unexpected file in .github/workflows: ${file}`);
  for (const file of actions) assert.ok(fs.existsSync(file), `missing ${file}`);
  for (const job of jobs) runner(job);
});

const checkForkRouting = (job) => {
  const triggers = events({ file: job.file, on: job.workflow.on });
  const route = runner(job);
  const where = `${job.file} ${job.id}`;
  if (triggers.includes("pull_request_target")) {
    assert.deepEqual(Object.keys(route), ["label"], `${where}: pull_request_target jobs name one GitHub-hosted label`);
    assert.match(route.label, GITHUB_HOSTED, `${where} runs pull_request_target on ${route.label}`);
  }
  if (triggers.includes("pull_request")) {
    const forkLabel = route.forkLabel ?? (route.variable === undefined ? route.label : undefined);
    assert.ok(forkLabel !== undefined, `${where}: a repository variable would choose the runner for forks' pull requests`);
    assert.match(forkLabel, GITHUB_HOSTED, `${where} runs forks' pull requests on ${forkLabel}`);
  }
  if (route.variable !== undefined || !vmLabel(route.label)) {
    const allowed = job.file === "production-smoke.yml" ? ["deployment_status"] : ["push", "pull_request"];
    const untrusted = triggers.filter((trigger) => !allowed.includes(trigger));
    assert.deepEqual(untrusted, [], `${where}: a dedicated runner is reachable from ${untrusted.join(", ")}`);
  }
};

test("pull request jobs from forks run only on GitHub-hosted runners", () => {
  for (const job of jobs) checkForkRouting(job);
});

test("the routing check rejects routes a fork or an untrusted event could reach", () => {
  const template = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || vars.TESTS_RUNNER || 'roo-site' }}";
  const fixture = (on, runsOn) => ({ file: "fixture.yml", id: "job", workflow: { on }, job: { "runs-on": runsOn } });
  for (const [on, runsOn] of [
    ["pull_request", "${{ vars.TESTS_RUNNER || 'ubuntu-24.04' }}"],
    ["pull_request", "roo-site"],
    [["pull_request_target"], template],
    [{ pull_request_target: null }, "${{ vars.TESTS_RUNNER || 'ubuntu-24.04' }}"],
    [["push", "pull_request"], "self-hosted"],
    [["pull_request_review"], template],
    [["issue_comment"], "roo-site"],
    [{ workflow_run: { workflows: ["Tests"] } }, "${{ vars.TESTS_RUNNER || 'ubuntu-24.04' }}"],
    [["deployment_status"], "roo-site"],
    [["schedule"], "roo-site"],
    [["workflow_dispatch"], "roo-site"],
    [["schedule", "workflow_dispatch"], "roo-site"],
    [["schedule", "workflow_dispatch"], "${{ vars.TESTS_RUNNER || 'depot-ubuntu-24.04' }}"],
  ]) {
    assert.throws(() => checkForkRouting(fixture(on, runsOn)), assert.AssertionError, `${JSON.stringify(on)} ${runsOn}`);
  }
  for (const [on, runsOn] of [
    ["pull_request", template],
    ["pull_request", "ubuntu-24.04"],
    [["pull_request_target"], "ubuntu-24.04"],
    ["push", "${{ vars.TESTS_RUNNER || 'roo-site' }}"],
    [["schedule", "workflow_dispatch"], "depot-ubuntu-24.04"],
    [["pull_request_review", "issue_comment"], "ubuntu-24.04"],
  ]) {
    checkForkRouting(fixture(on, runsOn));
  }
});

test("test jobs run on the website's runners, forks' pull requests on GitHub-hosted ones", () => {
  const tests = jobs.filter(({ file }) => file === "tests.yml");
  assert.ok(tests.length > 0);
  for (const job of tests) {
    assert.deepEqual(runner(job), { forkLabel: "ubuntu-24.04", variable: "TESTS_RUNNER", label: "roo-site" }, job.id);
  }
});

const checkSmokeActions = (step) => {
  if (!Object.hasOwn(step, "uses")) return;
  const { uses } = step;
  assert.ok(uses === "actions/checkout@v4" || uses === "actions/setup-node@v4", `${uses}: action is not allowed in production smoke`);
  if (uses === "actions/setup-node@v4") {
    assert.ok(
      !Object.keys(step.with ?? {}).some((input) => ["cache", "cache-dependency-path"].includes(input.toLowerCase())),
      `${uses}: production smoke cannot use cache inputs`,
    );
  }
};

test("production smoke runs on Depot by default and only for deployments", () => {
  const smoke = jobs.filter(({ file }) => file === "production-smoke.yml");
  assert.ok(smoke.length > 0);
  for (const job of smoke) {
    assert.deepEqual(events({ file: job.file, on: job.workflow.on }), ["deployment_status"]);
    assert.equal(job.job["runs-on"], "${{ vars.SMOKE_RUNNER || 'depot-ubuntu-24.04' }}", job.id);
    assert.ok(job.job.steps.every((step) => step.if === undefined), "smoke steps run unconditionally");
    for (const step of job.job.steps) checkSmokeActions(step);
  }
  for (const job of jobs) {
    const { forkLabel, label } = runner(job);
    assert.ok(label !== "roo-smoke" && forkLabel !== "roo-smoke", `${job.file} ${job.id}`);
  }
});

test("production smoke permits only approved actions without setup-node cache inputs", () => {
  for (const step of [
    { uses: "actions/setup-go@v5" },
    { uses: "actions/setup-node@v4", with: { cache: "npm" } },
    { uses: "actions/setup-node@v4", with: { Cache: false } },
    { uses: "actions/setup-node@v4", with: { "cache-dependency-path": "package-lock.json" } },
    { uses: "actions/setup-node@v4", with: { "Cache-Dependency-Path": "" } },
    { uses: "actions/cache@v4" },
    { uses: "actions/cache/restore@v4" },
    { uses: "actions/cache/save@v4" },
    { uses: "third-party/action@v1" },
    { uses: "actions/setup-node@v3" },
    { uses: "actions/checkout@v3" },
    { uses: "actions/checkout@v4 " },
    { uses: null },
  ]) {
    assert.throws(() => checkSmokeActions(step), assert.AssertionError, String(step.uses));
  }
  for (const step of [
    { uses: "actions/setup-node@v4", with: { "node-version": 22 } },
    { uses: "actions/checkout@v4" },
    { run: "npm ci" },
  ]) {
    checkSmokeActions(step);
  }
});

const outsideDevbox = (condition) => {
  if (typeof condition !== "string") return false;
  const expression = condition.startsWith("${{ ") && condition.endsWith(" }}") ? condition.slice(4, -3) : condition;
  const terms = expression.split(" && ");
  return terms.filter((term) => term === OUTSIDE_DEVBOX).length === 1 && terms.every((term) => (
    term === OUTSIDE_DEVBOX || (term.length > 0 && term.trim() === term && !/\|\||\$\{\{|[()]|!(?!=)/.test(term))
  ));
};

const checkInstall = ({ file, step }) => {
  const run = String(step.run ?? "");
  let rest = [run];
  for (const guard of OUTSIDE_DEVBOX_DEPS) rest = rest.flatMap((part) => part.split(guard));
  for (const part of rest) assert.ok(!part.includes("${{"), `${file}: run lines take no expressions but the outside-the-dev-box --with-deps guards: ${run}`);
  if (rest.some((part) => INSTALLS.test(part))) assert.ok(outsideDevbox(step.if), `${file}: ${run.split("\n")[0]} must install packages only outside the dev box runners`);
  return rest.length - 1;
};

test("system packages are installed only outside the dev box runners", () => {
  const steps = [
    ...jobs.flatMap(({ file, job }) => (job.steps ?? []).map((step) => ({ file, step }))),
    ...actions.flatMap((file) => yaml.safeLoad(fs.readFileSync(file, "utf8")).runs.steps.map((step) => ({ file, step }))),
  ];
  assert.equal(steps.reduce((count, step) => count + checkInstall(step), 0), 2);
});

test("package installs remain guarded in workflows and actions", () => {
  const install = { run: "npx playwright install --with-deps chromium" };
  for (const file of ["fixture.yml", ".github/actions/fixture/action.yml"]) {
    assert.throws(() => checkInstall({ file, step: install }), assert.AssertionError, file);
    checkInstall({ file, step: { ...install, if: OUTSIDE_DEVBOX } });
    assert.throws(() => checkInstall({ file, step: { run: "echo ${{ vars.TEST }}" } }), assert.AssertionError, file);
  }
});

test("system package guards reject unsafe conditions and accept the dev box exclusion", () => {
  const install = { run: "sudo apt-get install example" };
  assert.throws(() => checkInstall({ file: "fixture.yml", step: install }), assert.AssertionError);
  for (const condition of [
    "runner.environment == 'github-hosted'",
    `\${{ ${OUTSIDE_DEVBOX} || true }}`,
    "${{ startsWith(runner.name, 'devbox-') }}",
    `\${{ ${OUTSIDE_DEVBOX} && ${OUTSIDE_DEVBOX} }}`,
    `\${{ ${OUTSIDE_DEVBOX} && (inputs.browsers != '') }}`,
    `\${{ ${OUTSIDE_DEVBOX} && !inputs.browsers }}`,
    `\${{ ${OUTSIDE_DEVBOX} && \${{ inputs.browsers }} }}`,
    `\${{ ${OUTSIDE_DEVBOX} &&  }}`,
  ]) {
    assert.throws(() => checkInstall({ file: "fixture.yml", step: { ...install, if: condition } }), assert.AssertionError, String(condition));
  }
  for (const condition of [
    `\${{ ${OUTSIDE_DEVBOX} }}`,
    `\${{ inputs.browsers != '' && ${OUTSIDE_DEVBOX} }}`,
    OUTSIDE_DEVBOX,
  ]) {
    checkInstall({ file: "fixture.yml", step: { ...install, if: condition } });
  }
});
