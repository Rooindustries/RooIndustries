import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve("scripts/tested-tree.sh");
const repository = "Rooindustries/RooIndustries";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const workspace = ({ touchLockfile = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tested-tree-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "ci@example.invalid");
  git(dir, "config", "user.name", "CI");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "page.js"), "export default 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  fs.writeFileSync(path.join(dir, "page.js"), "export default 2;\n");
  if (touchLockfile) fs.writeFileSync(path.join(dir, "package-lock.json"), "{\"changed\":true}\n");
  git(dir, "commit", "--quiet", "-am", "merge");
  return { dir, tree: git(dir, "rev-parse", "HEAD^{tree}") };
};

const stubGh = (dir, responses) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, "responses.json"), JSON.stringify(responses));
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
endpoint="$2"
filter="$4"
echo "$endpoint" >> "${dir}/calls"
jq -e --arg endpoint "$endpoint" '.[$endpoint]' "${dir}/responses.json" > /dev/null || { echo "unexpected call $endpoint" >&2; exit 3; }
jq --arg endpoint "$endpoint" '.[$endpoint]' "${dir}/responses.json" | jq -r "$filter"
`,
  );
  fs.chmodSync(path.join(bin, "gh"), 0o755);
  return bin;
};

const check = (dir, bin) => {
  const output = path.join(dir, "github-output");
  fs.writeFileSync(output, "");
  const log = execFileSync("bash", [script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: repository },
  });
  return { tested: fs.readFileSync(output, "utf8").trim(), log };
};

const runResponse = (overrides = {}) => ({
  conclusion: "success",
  event: "pull_request",
  path: ".github/workflows/tests.yml",
  head_repository: { full_name: repository },
  id: 77,
  ...overrides,
});

const responsesFor = (tree, run, { expired = false } = {}) => ({
  [`repos/${repository}/actions/artifacts?name=tested-tree-${tree}&per_page=100`]: {
    artifacts: [{ expired, workflow_run: { id: 77 } }],
  },
  [`repos/${repository}/actions/runs/77`]: run,
});

test("a tree a passed pull request run recorded skips main's suite", () => {
  const { dir, tree } = workspace();
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=true", result.log);
});

test("a failed pull request run doesn't count", () => {
  const { dir, tree } = workspace();
  assert.equal(check(dir, stubGh(dir, responsesFor(tree, runResponse({ conclusion: "failure" })))).tested, "tested=false");
});

test("a run from a fork doesn't count", () => {
  const { dir, tree } = workspace();
  const fork = runResponse({ head_repository: { full_name: "someone/fork" } });
  assert.equal(check(dir, stubGh(dir, responsesFor(tree, fork))).tested, "tested=false");
});

test("an expired record doesn't count", () => {
  const { dir, tree } = workspace();
  assert.equal(check(dir, stubGh(dir, responsesFor(tree, runResponse(), { expired: true }))).tested, "tested=false");
});

test("an untested tree runs the suite", () => {
  const { dir, tree } = workspace();
  const responses = { [`repos/${repository}/actions/artifacts?name=tested-tree-${tree}&per_page=100`]: { artifacts: [] } };
  assert.equal(check(dir, stubGh(dir, responses)).tested, "tested=false");
});

test("a merge that changes the lockfile runs the suite without asking GitHub", () => {
  const { dir, tree } = workspace({ touchLockfile: true });
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=false");
  assert.equal(fs.existsSync(path.join(dir, "calls")), false);
});
