import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import yaml from "js-yaml";

const SELF_HOSTED = new Set(["self-hosted", "devbox", "roo-site", "roo-smoke"]);
const load = (file) => yaml.load(fs.readFileSync(file, "utf8"));
const workflows = fs.readdirSync(".github/workflows")
  .filter((file) => file.endsWith(".yml"))
  .map((file) => ({ file, workflow: load(path.join(".github/workflows", file)) }));
const actions = fs.readdirSync(".github/actions")
  .map((name) => path.join(".github/actions", name, "action.yml"))
  .filter((file) => fs.existsSync(file))
  .map((file) => ({ file, action: load(file) }));

const tokenize = (source) => {
  const tokens = [];
  const pattern = /\s*('(?:[^']|'')*'|&&|\|\||==|!=|\(|\)|[A-Za-z_][\w.-]*)/y;
  while (pattern.lastIndex < source.trim().length) {
    const match = pattern.exec(source);
    assert.ok(match, `Unsupported expression: ${source}`);
    tokens.push(match[1]);
  }
  return tokens;
};

const evaluate = (source, context) => {
  const tokens = tokenize(source);
  let index = 0;
  const lookup = (name) => name.split(".").reduce((value, key) => (value == null ? null : value[key]), context);
  const primary = () => {
    const token = tokens[index++];
    if (token === "(") {
      const value = or();
      assert.equal(tokens[index++], ")");
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    return lookup(token) ?? null;
  };
  const compare = () => {
    const left = primary();
    const operator = tokens[index];
    if (operator !== "==" && operator !== "!=") return left;
    index += 1;
    const equal = String(left ?? "") === String(primary() ?? "");
    return operator === "==" ? equal : !equal;
  };
  const and = () => {
    let value = compare();
    while (tokens[index] === "&&") {
      index += 1;
      const right = compare();
      value = value ? right : value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[index] === "||") {
      index += 1;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const value = or();
  assert.equal(index, tokens.length, `Unparsed expression: ${source}`);
  return value;
};

const runnerFor = (runsOn, context) => {
  const match = /^\$\{\{(.*)\}\}$/s.exec(String(runsOn).trim());
  return match ? evaluate(match[1], context) : runsOn;
};

const contexts = {
  forkPullRequest: { event_name: "pull_request", repository: "Rooindustries/RooIndustries", event: { pull_request: { head: { repo: { full_name: "someone/RooIndustries" } } } } },
  pullRequest: { event_name: "pull_request", repository: "Rooindustries/RooIndustries", event: { pull_request: { head: { repo: { full_name: "Rooindustries/RooIndustries" } } } } },
  push: { event_name: "push", repository: "Rooindustries/RooIndustries", event: {} },
};

test("pull request jobs from forks never reach the self-hosted runners", () => {
  for (const { file, workflow } of workflows) {
    if (!("pull_request" in workflow.on) && !("pull_request_target" in workflow.on)) continue;
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const vars of [{}, { TESTS_RUNNER: "roo-site" }]) {
        const label = runnerFor(job["runs-on"], { github: contexts.forkPullRequest, vars });
        assert.ok(!SELF_HOSTED.has(label), `${file} ${id} sends a fork's pull request to ${label}`);
      }
    }
  }
});

test("the test jobs run on the website's own runners for its branches and main", () => {
  const { workflow } = workflows.find(({ file }) => file === "tests.yml");
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const event of [contexts.pullRequest, contexts.push]) {
      assert.equal(runnerFor(job["runs-on"], { github: event, vars: {} }), "roo-site", `tests.yml ${id}`);
      assert.equal(runnerFor(job["runs-on"], { github: event, vars: { TESTS_RUNNER: "ubuntu-24.04" } }), "ubuntu-24.04", `tests.yml ${id}`);
    }
  }
});

test("production smoke has a lane of its own and runs only for deployments", () => {
  const { workflow } = workflows.find(({ file }) => file === "production-smoke.yml");
  assert.deepEqual(Object.keys(workflow.on), ["deployment_status"]);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.equal(runnerFor(job["runs-on"], { github: contexts.push, vars: {} }), "roo-smoke", id);
  }
  for (const { workflow: other, file } of workflows.filter(({ file }) => file !== "production-smoke.yml")) {
    for (const [id, job] of Object.entries(other.jobs)) {
      for (const event of Object.values(contexts)) {
        assert.notEqual(runnerFor(job["runs-on"], { github: event, vars: {} }), "roo-smoke", `${file} ${id}`);
      }
    }
  }
});

test("system package installs run only on GitHub-hosted runners", () => {
  const steps = [
    ...workflows.flatMap(({ file, workflow }) => Object.values(workflow.jobs).flatMap((job) => (job.steps || []).map((step) => ({ file, step })))),
    ...actions.flatMap(({ file, action }) => (action.runs.steps || []).map((step) => ({ file, step }))),
  ];
  const hosted = "runner.environment == 'github-hosted'";
  for (const { file, step } of steps) {
    const run = String(step.run || "");
    if (/\bsudo\b|install-deps|apt-get/.test(run)) {
      assert.ok(String(step.if || "").includes(hosted), `${file}: ${run.split("\n")[0]}`);
    }
    if (run.includes("--with-deps")) {
      assert.ok(String(step.if || "").includes(hosted) || run.includes(`${hosted} && '--with-deps'`), `${file}: ${run.split("\n")[0]}`);
    }
  }
});
