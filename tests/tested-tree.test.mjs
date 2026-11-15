import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const script = path.resolve("scripts/tested-tree.sh");
const repository = "Rooindustries/RooIndustries";
const workspaces = [];

after(() => {
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const workspace = ({ touchLockfile = false, earlierLockfileCommit = false, touchPostgresAction = false } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tested-tree-"));
  workspaces.push(dir);
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "ci@example.invalid");
  git(dir, "config", "user.name", "CI");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "page.js"), "export default 1;\n");
  fs.mkdirSync(path.join(dir, ".github/actions/postgres"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github/actions/postgres/action.yml"), "name: postgres\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "base");
  if (earlierLockfileCommit) {
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{\"changed\":true}\n");
    git(dir, "commit", "--quiet", "-am", "lockfile");
  }
  fs.writeFileSync(path.join(dir, "page.js"), "export default 2;\n");
  if (touchLockfile) fs.writeFileSync(path.join(dir, "package-lock.json"), "{\"changed\":true}\n");
  if (touchPostgresAction) fs.writeFileSync(path.join(dir, ".github/actions/postgres/action.yml"), "name: postgres 2\n");
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
if ! jq -e --arg endpoint "$endpoint" '.[$endpoint]' "${dir}/responses.json" > /dev/null; then
  echo "unexpected call $endpoint" >&2
  exit 3
fi
jq --arg endpoint "$endpoint" '.[$endpoint]' "${dir}/responses.json" | jq -r "$filter"
`,
  );
  fs.chmodSync(path.join(bin, "gh"), 0o755);
  return bin;
};

const check = (dir, bin, before = git(dir, "rev-list", "--max-parents=0", "HEAD"), event = "push") => {
  const output = path.join(dir, "github-output");
  fs.writeFileSync(output, "");
  const log = execFileSync("bash", [script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: event,
      PUSH_BEFORE: before,
    },
  });
  return { tested: fs.readFileSync(output, "utf8").trim(), log };
};

const recordsEndpoint = (tree) => `repos/${repository}/actions/artifacts?name=tested-tree-${tree}&per_page=100`;

const runResponse = (overrides = {}) => ({
  conclusion: "success",
  event: "pull_request",
  path: ".github/workflows/tests.yml",
  head_repository: { full_name: repository },
  id: 77,
  ...overrides,
});

const responsesFor = (tree, run, { expired = false } = {}) => ({
  [recordsEndpoint(tree)]: {
    artifacts: [{ expired, workflow_run: { id: 77 } }],
  },
  [`repos/${repository}/actions/runs/77`]: run,
});

const checkQueue = (dir, responses) => {
  const result = check(dir, stubGh(dir, responses), "", "merge_group");
  assert.equal(fs.existsSync(path.join(dir, "calls")), true, "queue run must look up the tree");
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  if (responses[recordsEndpoint(tree)].artifacts.length > 0) {
    assert.match(fs.readFileSync(path.join(dir, "calls"), "utf8"), /actions\/runs\/77/);
  }
  return result;
};

test("a merge queue reuses a green pull request tree even when cache inputs changed", () => {
  const { dir, tree } = workspace({ touchLockfile: true });
  assert.equal(checkQueue(dir, responsesFor(tree, runResponse())).tested, "tested=true");
});

test("a merge queue does not reuse a different tree", () => {
  const { dir, tree } = workspace();
  const previousTree = git(dir, "rev-parse", "HEAD~1^{tree}");
  const responses = {
    ...responsesFor(previousTree, runResponse()),
    [recordsEndpoint(tree)]: { artifacts: [] },
  };
  assert.equal(checkQueue(dir, responses).tested, "tested=false");
  assert.equal(fs.readFileSync(path.join(dir, "calls"), "utf8").trim(), recordsEndpoint(tree));
});

test("a push reuses a green merge queue run on the same commit", () => {
  const { dir, tree } = workspace();
  const queueRun = runResponse({ event: "merge_group", head_sha: git(dir, "rev-parse", "HEAD") });
  assert.equal(check(dir, stubGh(dir, responsesFor(tree, queueRun))).tested, "tested=true");
});

for (const conclusion of ["failure", "cancelled", null]) {
  test(`a merge queue rejects a ${conclusion ?? "still-running"} run`, () => {
    const { dir, tree } = workspace();
    assert.equal(checkQueue(dir, responsesFor(tree, runResponse({ conclusion }))).tested, "tested=false");
  });
}

test("a merge queue rejects a run from a fork", () => {
  const { dir, tree } = workspace();
  const fork = runResponse({ head_repository: { full_name: "someone/fork" } });
  assert.equal(checkQueue(dir, responsesFor(tree, fork)).tested, "tested=false");
});

test("a merge queue rejects a run from an event outside the allowlist", () => {
  const { dir, tree } = workspace();
  const otherEvent = runResponse({ event: "workflow_dispatch" });
  assert.equal(checkQueue(dir, responsesFor(tree, otherEvent)).tested, "tested=false");
});

test("a merge queue rejects a run from another workflow", () => {
  const { dir, tree } = workspace();
  const otherWorkflow = runResponse({ path: ".github/workflows/other.yml" });
  assert.equal(checkQueue(dir, responsesFor(tree, otherWorkflow)).tested, "tested=false");
});

test("a merge queue reuses a green push run", () => {
  const { dir, tree } = workspace();
  assert.equal(checkQueue(dir, responsesFor(tree, runResponse({ event: "push" }))).tested, "tested=true");
});

test("a tree a passed pull request run recorded skips main's suite", () => {
  const { dir, tree } = workspace();
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=true", result.log);
});

test("a failed pull request run doesn't count", () => {
  const { dir, tree } = workspace();
  const failed = runResponse({ conclusion: "failure" });
  assert.equal(check(dir, stubGh(dir, responsesFor(tree, failed))).tested, "tested=false");
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
  assert.equal(check(dir, stubGh(dir, { [recordsEndpoint(tree)]: { artifacts: [] } })).tested, "tested=false");
});

test("a merge that changes the lockfile runs the suite without asking GitHub", () => {
  const { dir, tree } = workspace({ touchLockfile: true });
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=false");
  assert.equal(fs.existsSync(path.join(dir, "calls")), false);
});

test("a failed record lookup runs the suite instead of failing the job", () => {
  const { dir } = workspace();
  const result = check(dir, stubGh(dir, {}));
  assert.equal(result.tested, "tested=false", result.log);
});

test("a run that can't be looked up doesn't count, but another passed run still skips", () => {
  const { dir, tree } = workspace();
  const responses = responsesFor(tree, runResponse());
  responses[recordsEndpoint(tree)].artifacts.unshift({
    expired: false,
    workflow_run: { id: 66 },
  });
  const result = check(dir, stubGh(dir, responses));
  assert.equal(result.tested, "tested=true", result.log);
  assert.match(result.log, /Couldn't look up run 66/);
});

test("a push whose earlier commit changed the lockfile runs the suite", () => {
  const { dir, tree } = workspace({ earlierLockfileCommit: true });
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=false", result.log);
  assert.equal(fs.existsSync(path.join(dir, "calls")), false);
});

test("a push with no earlier main commit runs the suite", () => {
  const { dir, tree } = workspace();
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())), "0".repeat(40));
  assert.equal(result.tested, "tested=false", result.log);
});

test("a push whose earlier main commit can't be fetched runs the suite", () => {
  const { dir, tree } = workspace();
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())), "1".repeat(40));
  assert.equal(result.tested, "tested=false", result.log);
  assert.match(result.log, /Couldn't fetch the earlier main commit/);
});

test("a push that changes the PostgreSQL setup runs the suite so main saves its cache", () => {
  const { dir, tree } = workspace({ touchPostgresAction: true });
  const result = check(dir, stubGh(dir, responsesFor(tree, runResponse())));
  assert.equal(result.tested, "tested=false", result.log);
  assert.equal(fs.existsSync(path.join(dir, "calls")), false);
});
