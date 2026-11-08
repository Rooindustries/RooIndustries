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
const HOSTED = "runner.environment == 'github-hosted'";
const HOSTED_ONLY_DEPS = [
  `\${{ ${HOSTED} && '--with-deps' || '' }}`,
  `\${{ inputs.browser-deps == 'true' && ${HOSTED} && '--with-deps' || '' }}`,
];
const INSTALLS = /\bsudo\b|apt-get|install-deps|--with-deps/;

const files = fs.readdirSync(".github/workflows");
const workflows = files
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, workflow: yaml.load(fs.readFileSync(path.join(".github/workflows", file), "utf8")) }));
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

test("pull request jobs from forks run only on GitHub-hosted runners", () => {
  for (const job of jobs.filter(({ file, workflow }) => events({ file, on: workflow.on }).some((event) => event === "pull_request" || event === "pull_request_target"))) {
    const { forkLabel, label } = runner(job);
    assert.match(forkLabel ?? label, GITHUB_HOSTED, `${job.file} ${job.id} runs forks' pull requests on ${forkLabel ?? label}`);
  }
});

test("test jobs run on the website's runners, forks' pull requests on GitHub-hosted ones", () => {
  const tests = jobs.filter(({ file }) => file === "tests.yml");
  assert.ok(tests.length > 0);
  for (const job of tests) {
    assert.deepEqual(runner(job), { forkLabel: "ubuntu-24.04", variable: "TESTS_RUNNER", label: "roo-site" }, job.id);
  }
});

test("production smoke has a lane of its own and runs only for deployments", () => {
  const smoke = jobs.filter(({ file }) => file === "production-smoke.yml");
  assert.ok(smoke.length > 0);
  for (const job of smoke) {
    assert.deepEqual(events({ file: job.file, on: job.workflow.on }), ["deployment_status"]);
    assert.deepEqual(runner(job), { variable: "SMOKE_RUNNER", label: "roo-smoke" }, job.id);
    assert.ok(job.job.steps.every((step) => step.if === undefined), "smoke steps run unconditionally");
  }
  for (const job of jobs.filter(({ file }) => file !== "production-smoke.yml")) {
    const { forkLabel, label } = runner(job);
    assert.ok(label !== "roo-smoke" && forkLabel !== "roo-smoke", `${job.file} ${job.id}`);
  }
});

test("system packages are installed only on GitHub-hosted runners", () => {
  const steps = [
    ...jobs.flatMap(({ file, job }) => (job.steps ?? []).map((step) => ({ file, step }))),
    ...actions.flatMap((file) => yaml.load(fs.readFileSync(file, "utf8")).runs.steps.map((step) => ({ file, step }))),
  ];
  const hostedOnly = (condition) => typeof condition === "string" && !/\|\||\$\{\{|[()]|!(?!=)/.test(condition) && condition.split(" && ").includes(HOSTED);
  let guarded = 0;
  for (const { file, step } of steps) {
    const run = String(step.run ?? "");
    let rest = [run];
    for (const guard of HOSTED_ONLY_DEPS) rest = rest.flatMap((part) => part.split(guard));
    guarded += rest.length - 1;
    for (const part of rest) assert.ok(!part.includes("${{"), `${file}: run lines take no expressions but the hosted-only --with-deps guards: ${run}`);
    if (rest.some((part) => INSTALLS.test(part))) assert.ok(hostedOnly(step.if), `${file}: ${run.split("\n")[0]} installs packages on every runner`);
  }
  assert.equal(guarded, 2);
});
