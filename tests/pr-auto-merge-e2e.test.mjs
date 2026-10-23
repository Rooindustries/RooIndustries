import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const head = "a".repeat(40);
const repo = "fixture/website";
const prefix = `/repos/${repo}`;
const bot = login => ({ login: `${login}[bot]`, type: "Bot" });
const token = "fixture-github-token";
const userToken = "fixture-user-token";
const seerCheck = (overrides = {}) => ({ id: 100, name: "Seer Code Review", app: { id: 12637, slug: "sentry" },
  head_sha: head, status: "completed", conclusion: "success", completed_at: "2026-10-23T00:00:00Z", ...overrides });
const workflow = yaml.safeLoad(readFileSync(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8"));
const jobNames = job => job.strategy?.matrix?.suite
  ? job.strategy.matrix.suite.map(suite => job.name.replace("${{ matrix.suite.name }}", suite.name))
  : [job.name];
const checkNames = Object.values(workflow.jobs).flatMap(jobNames);
const splitCheckNames = ["routes", "revalidation"].flatMap(id => jobNames(workflow.jobs[id]));

const baseline = () => ({
  pull: { number: 1, html_url: "https://github.com/fixture/website/pull/1", title: "Fixture PR", state: "open", draft: false,
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: repo } },
    head: { ref: "fixture-change", sha: head, repo: { full_name: repo } }, mergeable_state: "clean" },
  baseTip: "b".repeat(40),
  reviews: [{ id: 1, user: bot("coderabbitai"), state: "APPROVED", commit_id: head, submitted_at: "2026-10-23T00:00:00Z" }],
  workflow: { id: 1, path: ".github/workflows/tests.yml" },
  workflowRuns: [
    { id: 600, workflow_id: 1, check_suite_id: 10, head_sha: head, path: ".github/workflows/tests.yml" },
    { id: 700, workflow_id: 2, check_suite_id: 20, head_sha: head, path: ".github/workflows/auto-merge.yml" },
  ],
  checks: [...checkNames.map((name, index) => ({ id: index + 1, name, app: { slug: "github-actions" }, check_suite: { id: 10 },
    status: "completed", conclusion: "success", completed_at: "2026-10-23T00:00:00Z" })), seerCheck()],
  statuses: [],
  comments: [{ id: 10, node_id: "codex-review", updated_at: "2026-10-23T00:00:00Z", user: bot("chatgpt-codex-connector"),
    body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, status: "completed", has_unresolved_findings: false } })} -->` }],
  threads: [],
  editor: null,
});

const runScenario = async (name, { setup, changeSecond, mergeStatus = 200, event = "pull_request_target", eventBody, useUserToken = false, expectedCode = 0 } = {}) => {
  const state = baseline();
  setup?.(state);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pr-gate-e2e-"));
  const requests = [];
  let snapshots = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, "http://fixture");
      const credential = req.headers.authorization === `Bearer ${userToken}` ? "user" : "workflow";
      requests.push({ method: req.method, path: url.pathname, query: url.search, body, credential });
      const send = (code, payload) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (![token, userToken].some(value => req.headers.authorization === `Bearer ${value}`)) return send(401, { message: "Unexpected fixture credential" });
      if (req.method === "GET" && url.pathname === `${prefix}/git/ref/heads/main`) return send(200, { object: { sha: state.baseTip } });
      if (req.method === "GET" && url.pathname === `${prefix}/actions/workflows/tests.yml`) return send(200, state.workflow);
      if (req.method === "GET" && url.pathname === `${prefix}/actions/runs`) {
        assert.equal(url.searchParams.get("head_sha"), state.pull.head.sha);
        if (state.workflowPageTwo && !url.searchParams.has("page")) {
          res.setHeader("link", `<https://api.github.com${url.pathname}?head_sha=${state.pull.head.sha}&page=2>; rel="next"`);
        }
        return send(200, { workflow_runs: url.searchParams.has("page") ? state.workflowPageTwo : state.workflowRuns });
      }
      if (req.method === "GET" && /^\/repos\/fixture\/website\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) {
        const runId = Number(url.pathname.split("/").at(-2));
        const jobs = state.jobs ?? state.checks.filter(check => check.app?.slug === "github-actions").map(check => ({
          id: check.id, run_id: runId, head_sha: head, name: check.name, status: check.status, conclusion: check.conclusion,
          runner_id: 1, steps: [{ status: "completed", started_at: "2026-10-23T00:00:00Z" }],
        }));
        if (state.jobPageTwo && !url.searchParams.has("page")) {
          const nextPage = new URL(url);
          nextPage.searchParams.set("page", "2");
          res.setHeader("link", `<https://api.github.com${nextPage.pathname}${nextPage.search}>; rel="next"`);
        }
        return send(200, { jobs: url.searchParams.has("page") ? state.jobPageTwo : jobs });
      }
      if (req.method === "GET" && url.pathname.startsWith(`${prefix}/compare/`)) {
        assert.equal(url.pathname, `${prefix}/compare/${state.baseTip}...${state.pull.head.sha}`);
        return send(200, state.comparison || {
          status: "ahead", behind_by: 0, base_commit: { sha: state.baseTip }, merge_base_commit: { sha: state.baseTip },
        });
      }
      if (url.pathname === "/graphql") {
        if (body.query.includes("IssueComment")) return send(200, { data: { node: { editor: state.editor } } });
        return send(200, { data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads,
        } } } } });
      }
      if (req.method === "GET" && url.pathname === `${prefix}/pulls`) return send(200, [state.pull]);
      if (req.method === "GET" && url.pathname === `${prefix}/pulls/1`) {
        snapshots += 1;
        if (snapshots === 2) changeSecond?.(state);
        return send(200, state.pull);
      }
      if (req.method === "GET" && url.pathname === `${prefix}/pulls/1/reviews`) return send(200, state.reviews);
      if (url.pathname.endsWith("/check-runs")) {
        if (state.latestChecks && url.searchParams.get("filter") !== "all") return send(200, { check_runs: state.latestChecks });
        if (state.checkPageTwo && !url.searchParams.has("page")) {
          const nextPage = new URL(url);
          nextPage.searchParams.set("page", "2");
          res.setHeader("link", `<https://api.github.com${nextPage.pathname}${nextPage.search}>; rel="next"`);
        }
        return send(200, { check_runs: url.searchParams.has("page") ? state.checkPageTwo : state.checks });
      }
      if (url.pathname.endsWith("/statuses")) {
        assert.equal(url.pathname, `${prefix}/commits/${state.pull.head.sha}/statuses`);
        return send(200, state.statusesHead && state.statusesHead !== state.pull.head.sha ? [] : state.statuses);
      }
      if (req.method === "GET" && url.pathname === `${prefix}/issues/1/comments`) return send(200, state.comments);
      if (req.method === "GET" && url.pathname === `${prefix}/labels/needs-owner`) return send(200, { name: "needs-owner" });
      if (req.method === "PUT" && url.pathname === `${prefix}/pulls/1/merge`) return send(mergeStatus, { merged: mergeStatus === 200, message: "Fixture merge result" });
      if (req.method === "POST" && ["/comments", "/labels"].some(suffix => url.pathname === `${prefix}/issues/1${suffix}`)) return send(201, { id: 20 });
      if (req.method === "PATCH" && url.pathname.startsWith(`${prefix}/issues/comments/`)) return send(200, { id: 20 });
      if (req.method === "DELETE" && url.pathname === `${prefix}/issues/1/labels/needs-owner`) return send(200, {});
      return send(404, { message: `Unhandled fixture route ${req.method} ${url.pathname}` });
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ message: error.message })); }
  });
  let child;
  try {
    server.listen(0, process.env.ROO_TEST_HOST || "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const eventPath = path.join(scratch, "event.json");
    await fs.writeFile(eventPath, JSON.stringify(eventBody || { pull_request: { number: 1 } }));
    child = spawn(process.execPath, ["--import", "./tests/fixtures/github-api-transport.mjs", "scripts/pr-auto-merge-apply.mjs"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, REPO: repo, GH_TOKEN: token,
        ...(useUserToken ? { AUTO_MERGE_TOKEN: userToken } : {}),
        ROO_GITHUB_FIXTURE_ORIGIN: `http://${address.address}:${address.port}`,
        GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: "700" },
      timeout: 30000,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [code] = await once(child, "close");
    const artifact = path.join(root, "test-results/pr-auto-merge", `${name}.json`);
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, JSON.stringify({ code, output, requests }, null, 2));
    assert.equal(code, expectedCode, output);
    const merges = requests.filter(request => request.method === "PUT");
    const comments = requests.filter(request => request.body?.body).map(request => request.body.body);
    return { merges, comments, requests, snapshots };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(scratch, { recursive: true, force: true });
  }
};

test("CLI merges only the evaluated head after two complete snapshots", async () => {
  const result = await runScenario("approved");
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
  assert.ok(result.comments.some(body => body.includes("Squash-merged into main")));
});

test("CLI accepts all actual workflow groups without removed check names", async () => {
  assert.equal(new Set(checkNames).size, checkNames.length);
  assert.equal(splitCheckNames.length, 4);
  const result = await runScenario("workflow-groups-green", { setup: state => { state.comments = []; } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
});

for (const name of splitCheckNames) {
  for (const stage of ["initial", "final"]) {
    for (const [condition, status, conclusion] of [
      ["missing", null, null], ["queued", "queued", null],
      ["running", "in_progress", null], ["failed", "completed", "failure"],
    ]) {
      test(`CLI blocks ${condition} split group ${name} at the ${stage} snapshot`, async () => {
        const change = state => {
          const check = state.checks.find(check => check.name === name);
          assert.ok(check, `The real workflow must report ${name}.`);
          if (condition === "missing") state.checks = state.checks.filter(item => item !== check);
          else Object.assign(check, { status, conclusion });
        };
        const result = await runScenario(`split-${name.replaceAll(" ", "-")}-${condition}-${stage}`, {
          [stage === "initial" ? "setup" : "changeSecond"]: change,
        });
        assert.deepEqual(result.merges, []);
        if (stage === "initial") assert.ok(result.comments.some(body => body.includes(name)));
        else {
          assert.equal(result.snapshots, 2);
          assert.equal(result.requests.filter(request => request.path.endsWith("/check-runs")).length, 2);
          assert.ok(result.comments.some(body => body.includes("pr-auto-merge-action:wait")));
        }
      });
    }
  }
}

for (const [name, value] of [
  ["missing", undefined], ["null", null], ["string-false", "false"], ["string-true", "true"],
  ["zero", 0], ["one", 1], ["array", []], ["object", {}], ["unresolved", true],
]) {
  test(`CLI ignores an optional Codex ${name} unresolved-findings flag`, async () => {
    const result = await runScenario(`codex-flag-${name}`, { setup: state => {
      state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
        commit_sha: head, status: "completed", has_unresolved_findings: value,
      } })} -->`;
    } });
    assert.equal(result.merges.length, 1);
  });
}

test("CLI ignores an optional malformed Codex verdict at the final snapshot", async () => {
  const result = await runScenario("codex-flag-changed", { changeSecond: state => {
    state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
      commit_sha: head, status: "completed", has_unresolved_findings: "false",
    } })} -->`;
  } });
  assert.equal(result.snapshots, 2);
  assert.equal(result.merges.length, 1);
});

for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "success"]]) {
  for (const [kind, suffix] of [["plain", ""], ["branch", "@main"], ["full-ref", "@refs/heads/fixture-change"]]) {
    test(`CLI ignores its own ${status} ${conclusion || ""} gate check with a ${kind} path on a manual dispatch`, async () => {
      const result = await runScenario(`self-check-${status}-${conclusion}-${kind}`, {
        event: "workflow_dispatch", eventBody: {},
        setup: state => {
          state.workflowRuns[1].path += suffix;
          state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "github-actions" }, check_suite: { id: 20 }, status, conclusion });
        },
      });
      assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
    });
  }
}

for (const workflowPath of [undefined, ".github/workflows/auto-merge.yml-other@main"]) {
  test(`CLI keeps a current-run gate check with a ${workflowPath ? "different" : "missing"} workflow path`, async () => {
    const result = await runScenario(`unrecognized-gate-path-${Boolean(workflowPath)}`, { setup: state => {
      state.workflowRuns[1].path = workflowPath;
      state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "github-actions" }, check_suite: { id: 20 }, status: "in_progress", conclusion: null });
    } });
    assert.deepEqual(result.merges, []);
  });
}

const refusals = {
  "human-statuses": state => { state.statuses = state.checks.map(check => ({ id: check.id, context: check.name, state: "success" })); state.checks = []; },
  "foreign-app": state => { state.checks.forEach(check => { check.app.slug = "other-app"; }); },
  "queued-rerun": state => { state.checks.push({ ...state.checks[0], id: 1000, status: "queued", conclusion: null }); },
  "paged-failure": state => { state.checkPageTwo = [{ ...state.checks[0], id: 1000, conclusion: "failure" }]; },
  "human-review": state => { state.reviews[0].user = { login: "coderabbitai", type: "User" }; },
  "old-approval": state => { state.reviews[0].commit_id = "c".repeat(40); },
  "open-thread": state => { state.threads.push({ isResolved: false, path: "src/app.js", comments: { nodes: [{ author: { login: "sentry" } }] } }); },
  "human-changes": state => { state.reviews.push({ user: { login: "fixture-person", type: "User" }, state: "CHANGES_REQUESTED", commit_id: head, submitted_at: "2026-10-23T01:00:00Z" }); },
  "behind-main": state => { state.pull.mergeable_state = "behind"; },
  "draft": state => { state.pull.draft = true; },
  "fork": state => { state.pull.head.repo.full_name = "other/website"; },
  "renamed-required-job": state => { state.checks.find(check => check.name === "Playwright booking").name = "Playwright reservation"; },
  "foreign-self-check-name": state => { state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "other-app" }, status: "completed", conclusion: "failure" }); },
  "other-workflow-failure": state => { state.checks.push({ id: 1000, name: "another-workflow", app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }); },
};
for (const [name, setup] of Object.entries(refusals)) {
  test(`CLI leaves ${name} unmerged`, async () => {
    const result = await runScenario(name, { setup });
    assert.deepEqual(result.merges, []);
  });
}

for (const [name, changeSecond] of Object.entries({
  "moved-head": state => { state.pull.head.sha = "d".repeat(40); },
  "moved-main": state => { state.pull.base.sha = "d".repeat(40); state.baseTip = state.pull.base.sha; },
  "new-review": state => { state.reviews[0].state = "CHANGES_REQUESTED"; },
  "new-failure": state => { state.checks[0].conclusion = "failure"; },
  "newly-closed": state => { state.pull.state = "closed"; },
})) {
  test(`CLI rechecks ${name} before sending a merge`, async () => {
    const result = await runScenario(name, { changeSecond });
    assert.equal(result.snapshots, 2);
    assert.deepEqual(result.merges, []);
    assert.ok(result.comments.some(body => body.includes("so nothing merged")));
  });
}

for (const mergeStatus of [409, 403]) {
  test(`CLI reports a ${mergeStatus} merge rejection without claiming a merge`, async () => {
    const result = await runScenario(`rejected-${mergeStatus}`, { mergeStatus });
    assert.equal(result.merges.length, 1);
    assert.ok(result.comments.every(body => !body.includes("Squash-merged into main")));
    assert.ok(result.comments.some(body => body.includes(`pr-auto-merge-action:${mergeStatus === 409 ? "wait" : "flag"}`)));
  });
}

for (const [event, eventBody] of [
  ["workflow_run", { workflow_run: { head_branch: "fixture-change", head_sha: head, pull_requests: [] } }],
  ["schedule", {}],
  ["workflow_dispatch", {}],
]) {
  test(`CLI discovers its pull request on ${event}`, async () => {
    const result = await runScenario(event, { event, eventBody });
    assert.equal(result.merges.length, 1);
  });
}

test("CLI ignores Tests pushes to main", async () => {
  const result = await runScenario("main-push", { event: "workflow_run", eventBody: { workflow_run: { head_branch: "main", event: "push" } } });
  assert.deepEqual(result.requests, []);
});

test("CLI leaves an already closed PR untouched", async () => {
  const result = await runScenario("already-closed", { setup: state => { state.pull.state = "closed"; } });
  assert.ok(result.requests.every(request => request.method === "GET" || request.path === "/graphql"));
});

test("CLI ignores human gate markers and still requests missing reviews", async () => {
  const result = await runScenario("human-markers", { setup: state => {
    state.reviews = [];
    state.comments.push({ id: 11, user: { login: "fixture-person", type: "User" },
      body: `<!-- pr-auto-merge-gate -->\n<!-- pr-review-request:${head} -->` });
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("@coderabbitai review")));
  assert.ok(result.requests.every(request => request.method !== "PATCH"));
});

test("CLI keeps a human change request with the agent when GitHub reports blocked", async () => {
  const result = await runScenario("blocked-human-review", { setup: state => {
    state.pull.mergeable_state = "blocked";
    state.reviews.push({ user: { login: "fixture-person", type: "User" }, state: "CHANGES_REQUESTED", commit_id: head, submitted_at: "2026-10-23T01:00:00Z" });
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("pr-auto-merge-action:wait")));
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

test("CLI refuses an independently moved main ref when the PR base payload stays unchanged", async () => {
  const result = await runScenario("independent-main-move", { changeSecond: state => { state.baseTip = "c".repeat(40); } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges, []);
});

test("CLI requests reviews through the available user credential and records a workflow receipt", async () => {
  const result = await runScenario("user-review-request", { useUserToken: true, setup: state => { state.comments = []; state.reviews = []; } });
  const request = result.requests.find(request => request.body?.body?.includes("@coderabbitai review"));
  assert.equal(request?.credential, "user");
  assert.ok(result.requests.some(request => request.credential === "workflow" && request.body?.body?.includes(`<!-- pr-review-request:${head}`)));
});

for (const [name, setup] of Object.entries({
  "different-workflow-required-jobs": state => { state.workflowRuns[0].workflow_id = 3; },
  "missing-workflow-provenance": state => { state.workflowRuns = []; },
  "different-head-workflow": state => { state.workflowRuns[0].head_sha = "d".repeat(40); },
  "missing-workflow-run-id": state => { delete state.workflowRuns[0].id; },
  "missing-check-suite": state => { state.checks.forEach(check => { delete check.check_suite; }); },
  "same-name-success-after-tests-failure": state => {
    state.checks[0].conclusion = "failure";
    state.workflowRuns.push({ id: 800, workflow_id: 3, check_suite_id: 30, head_sha: head });
    state.checks.push({ ...state.checks[0], id: 1000, check_suite: { id: 30 }, conclusion: "success" });
  },
  "same-name-failure-after-tests-success": state => {
    state.workflowRuns.push({ id: 800, workflow_id: 3, check_suite_id: 30, head_sha: head });
    state.checks.unshift({ ...state.checks[0], id: 0, check_suite: { id: 30 }, conclusion: "failure" });
  },
  "clean-but-stale-main": state => {
    state.comparison = { status: "diverged", behind_by: 1, base_commit: { sha: state.baseTip }, merge_base_commit: { sha: "c".repeat(40) } };
  },
  "missing-ancestry": state => { state.comparison = {}; },
  "contradicting-ancestry": state => {
    state.comparison = { status: "ahead", behind_by: 1, base_commit: { sha: state.baseTip }, merge_base_commit: { sha: state.baseTip } };
  },
  "wrong-comparison-base": state => {
    state.comparison = { status: "ahead", behind_by: 0, base_commit: { sha: "c".repeat(40) }, merge_base_commit: { sha: state.baseTip } };
  },
})) {
  test(`CLI refuses ${name}`, async () => {
    const result = await runScenario(name, { setup });
    assert.deepEqual(result.merges, []);
  });
}

for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "cancelled"]]) {
  test(`CLI preserves a foreign Actions gate check that is ${status} ${conclusion || ""}`, async () => {
    const result = await runScenario(`foreign-actions-gate-${status}-${conclusion}`, { setup: state => {
      state.workflowRuns.push({ id: 800, workflow_id: 3, check_suite_id: 30, head_sha: head });
      state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "github-actions" }, check_suite: { id: 30 }, status, conclusion });
    } });
    assert.deepEqual(result.merges, []);
  });
}

test("CLI preserves a gate check from an earlier run of its own workflow", async () => {
  const result = await runScenario("earlier-gate-run", { setup: state => {
    state.workflowRuns.push({ ...state.workflowRuns[1], id: 699, check_suite_id: 19 });
    state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "github-actions" }, check_suite: { id: 19 }, status: "completed", conclusion: "failure" });
  } });
  assert.deepEqual(result.merges, []);
});

test("CLI follows workflow-run pagination to establish Tests provenance", async () => {
  const result = await runScenario("workflow-pagination", { setup: state => {
    state.workflowPageTwo = state.workflowRuns;
    state.workflowRuns = [];
  } });
  assert.equal(result.merges.length, 1);
  assert.ok(result.requests.some(request => request.path.endsWith("/actions/runs") && request.query.includes("page=2")));
});

test("CLI rejects incomplete workflow metadata", async () => {
  const result = await runScenario("missing-workflow-id", { expectedCode: 1, setup: state => { delete state.workflow.id; } });
  assert.deepEqual(result.merges, []);
});

test("CLI rechecks ancestry on the final snapshot", async () => {
  const result = await runScenario("ancestry-changed", { changeSecond: state => {
    state.comparison = { status: "diverged", behind_by: 1, base_commit: { sha: state.baseTip }, merge_base_commit: { sha: "c".repeat(40) } };
  } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges, []);
});

test("CLI rechecks Tests provenance on the final snapshot", async () => {
  const result = await runScenario("workflow-provenance-changed", { changeSecond: state => { state.workflowRuns[0].workflow_id = 3; } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges, []);
});

test("CLI leaves a stale blocked branch with the owning agent", async () => {
  const result = await runScenario("blocked-stale-branch", { setup: state => {
    state.pull.mergeable_state = "blocked";
    state.comparison = { status: "diverged", behind_by: 1, base_commit: { sha: state.baseTip }, merge_base_commit: { sha: "c".repeat(40) } };
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

test("CLI accepts an identical main and head", async () => {
  const result = await runScenario("identical-main", { setup: state => {
    state.baseTip = head;
    state.comparison = { status: "identical", behind_by: 0, base_commit: { sha: head }, merge_base_commit: { sha: head } };
  } });
  assert.equal(result.merges.length, 1);
});

for (const useUserToken of [false, true]) {
  for (const reviewer of ["coderabbit", "seer"]) {
    test(`CLI requests only ${reviewer} with the ${useUserToken ? "user" : "workflow"} credential`, async () => {
      const result = await runScenario(`request-only-${reviewer}-${useUserToken}`, { useUserToken, setup: state => {
        if (reviewer === "coderabbit") state.reviews = [];
        else state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
      } });
      const wanted = reviewer === "coderabbit" ? "@coderabbitai review" : "@sentry review";
      const approved = reviewer === "coderabbit" ? "@sentry review" : "@coderabbitai review";
      assert.ok(result.comments.some(body => body.includes(wanted)));
      assert.ok(result.comments.every(body => !body.includes(approved)));
      assert.ok(result.comments.every(body => !body.includes("Requested both reviews")));
    });
  }
}

test("CLI includes a holding reviewer alongside a pending reviewer", async () => {
  const result = await runScenario("request-held-and-pending", { setup: state => {
    state.reviews[0].state = "CHANGES_REQUESTED";
    state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
  } });
  assert.ok(result.comments.some(body => body.includes("@coderabbitai review") && body.includes("@sentry review")));
});

for (const useUserToken of [false, true]) {
  test(`CLI requests a dismissed reviewer after a different review was requested with ${useUserToken ? "user" : "workflow"} credentials`, async () => {
    const first = await runScenario(`first-seer-request-${useUserToken}`, { useUserToken, setup: state => {
      state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
    } });
    const receipt = first.comments.find(body => body.includes(`<!-- pr-review-request:${head}`));
    assert.ok(receipt);
    const second = await runScenario(`dismissed-reviewer-${useUserToken}`, { useUserToken, setup: state => {
      state.reviews[0].state = "DISMISSED";
      state.comments = [{ id: 11, user: bot("github-actions"), body: receipt, created_at: new Date().toISOString() }];
    } });
    assert.ok(second.comments.some(body => body.includes("@coderabbitai review")));
    assert.ok(second.comments.every(body => !body.includes("@sentry review")));
    assert.ok(second.comments.some(body => body.includes(`<!-- pr-review-request:${head}:coderabbit`)));
  });
}

test("CLI does not use an approved reviewer's old receipt to expire an unrequested reviewer", async () => {
  const result = await runScenario("independent-review-deadlines", { setup: state => {
    state.reviews[0].state = "DISMISSED";
    state.comments.push({ id: 11, user: bot("github-actions"), created_at: new Date(Date.now() - 25 * 3600000).toISOString(),
      body: `<!-- pr-review-request:${head}:seer -->` });
  } });
  assert.ok(result.comments.some(body => body.includes("@coderabbitai review")));
  assert.ok(result.comments.every(body => !body.includes("@sentry review")));
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

test("CLI requests a newly pending reviewer even when another pending request timed out", async () => {
  const result = await runScenario("expired-and-new-review", { setup: state => {
    state.reviews = [];
    state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
    state.comments = [{ id: 11, user: bot("github-actions"), created_at: new Date(Date.now() - 25 * 3600000).toISOString(),
      body: `<!-- pr-review-request:${head}:seer -->` }];
  } });
  assert.ok(result.comments.some(body => body.includes("@coderabbitai review")));
  assert.ok(result.comments.every(body => !body.includes("@sentry review")));
  assert.ok(result.requests.some(request => request.body?.labels?.includes("needs-owner")));
});

for (const explicit of [false, true]) {
  test(`CLI ${explicit ? "honors an explicit" : "replaces an ambiguous"} legacy request receipt`, async () => {
    const result = await runScenario(`legacy-review-receipt-${explicit}`, { setup: state => {
      state.reviews = [];
      state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
      state.comments = [{ id: 11, user: bot("github-actions"), created_at: new Date().toISOString(),
        body: `${explicit ? "@sentry review" : "Requested reviews with the user credential."}\n<!-- pr-review-request:${head} -->` }];
    } });
    assert.ok(result.comments.some(body => body.includes("@coderabbitai review")));
    assert.equal(result.comments.some(body => body.includes("@sentry review")), !explicit);
  });
}

for (const expired of [false, true]) {
  test(`CLI ${expired ? "flags an expired" : "waits for a recent"} unanswered review request without repeating it`, async () => {
    const result = await runScenario(`pending-request-${expired}`, { setup: state => {
      state.comments = [{ id: 11, user: bot("github-actions"), created_at: new Date(Date.now() - (expired ? 25 : 1) * 3600000).toISOString(),
        body: `<!-- pr-review-request:${head}:coderabbit -->\n<!-- pr-review-request:${head}:seer -->` }];
      state.reviews = [];
      state.checks = state.checks.filter(check => check.name !== "Seer Code Review");
    } });
    assert.deepEqual(result.merges, []);
    assert.ok(result.comments.every(body => !body.includes("@sentry review")));
    assert.equal(result.requests.some(request => request.body?.labels?.includes("needs-owner")), expired);
  });
}

const controllerReceipts = result => result.comments
  .filter(body => body.includes("<!-- pr-review-request:") || body.includes("<!-- pr-review-round:"))
  .map((body, index) => ({ id: 1000 + index, user: bot("github-actions"), body, created_at: new Date().toISOString() }));

for (const [name, check] of [
  ["missing", null], ["pending", seerCheck({ status: "in_progress", conclusion: null })],
  ["old-head", seerCheck({ head_sha: "c".repeat(40) })],
  ["other-app", seerCheck({ app: { id: 999, slug: "other" } })],
  ["wrong-app-id", seerCheck({ app: { id: 999, slug: "sentry" } })],
  ["neutral", seerCheck({ conclusion: "neutral" })], ["skipped", seerCheck({ conclusion: "skipped" })],
  ["unknown", seerCheck({ conclusion: null })],
]) {
  test(`CLI waits for a clean current Seer review when its result is ${name}`, async () => {
    const result = await runScenario(`seer-${name}`, { setup: state => {
      state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
      if (check) state.checks.push(check);
    } });
    assert.deepEqual(result.merges, []);
    assert.ok(result.comments.some(body => body.includes("@sentry review")));
  });
}

test("CLI rechecks Seer completion in its final snapshot", async () => {
  const result = await runScenario("seer-final-snapshot", { changeSecond: state => {
    state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
  } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges, []);
});

test("CLI waits for a requested Seer review without repeating it, then accepts its late result", async () => {
  const first = await runScenario("seer-request", { setup: state => {
    state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
  } });
  const receipts = controllerReceipts(first);
  assert.ok(first.comments.some(body => body.includes("@sentry review")));
  const waiting = await runScenario("seer-waiting", { setup: state => {
    state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
    state.comments.push(...receipts);
  } });
  assert.deepEqual(waiting.merges, []);
  assert.ok(waiting.comments.every(body => !body.includes("@sentry review")));
  const complete = await runScenario("seer-late-complete", { setup: state => { state.comments.push(...receipts); } });
  assert.equal(complete.merges.length, 1);
});

test("CLI gives an unanswered Seer request the same 24-hour deadline", async () => {
  const first = await runScenario("seer-before-timeout", { setup: state => {
    state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
  } });
  const result = await runScenario("seer-timeout", { setup: state => {
    state.checks = state.checks.filter(item => item.name !== "Seer Code Review");
    state.comments.push(...controllerReceipts(first).map(comment => ({ ...comment, created_at: new Date(Date.now() - 25 * 3600000).toISOString() })));
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.requests.some(request => request.body?.labels?.includes("needs-owner")));
  assert.ok(result.comments.every(body => !body.includes("@sentry review")));
});

test("CLI retires the same reviewer's old receipt after dismissal without timing out its replacement", async () => {
  const first = await runScenario("rabbit-initial-request", { setup: state => { state.reviews = []; } });
  const old = controllerReceipts(first).map(comment => ({ ...comment, created_at: new Date(Date.now() - 25 * 3600000).toISOString() }));
  const setup = state => {
    state.reviews[0].state = "DISMISSED";
    state.comments.push(...old);
  };
  const renewed = await runScenario("rabbit-dismissed-request", { setup });
  assert.ok(renewed.comments.some(body => body.includes("@coderabbitai review")));
  assert.ok(renewed.requests.every(request => !request.body?.labels?.includes("needs-owner")));
  const waiting = await runScenario("rabbit-dismissed-wait", { setup: state => {
    setup(state);
    state.comments.push(...controllerReceipts(renewed));
  } });
  assert.ok(waiting.comments.every(body => !body.includes("@coderabbitai review")));
  assert.ok(waiting.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

test("CLI re-requests a held review after its finding is resolved without a source commit", async () => {
  const first = await runScenario("rabbit-held-open", { setup: state => {
    state.reviews[0].state = "CHANGES_REQUESTED";
    state.threads = [{ id: "finding", isResolved: false, path: "app/page.jsx", comments: { nodes: [{ author: { login: "coderabbitai" } }] } }];
  } });
  assert.ok(first.comments.every(body => !body.includes("@coderabbitai review")));
  const renewed = await runScenario("rabbit-held-resolved", { setup: state => {
    state.reviews[0].state = "CHANGES_REQUESTED";
    state.threads = [{ id: "finding", isResolved: true, path: "app/page.jsx", comments: { nodes: [{ author: { login: "coderabbitai" } }] } }];
    state.comments.push(...controllerReceipts(first));
  } });
  assert.ok(renewed.comments.some(body => body.includes("@coderabbitai review")));
});

test("CLI holds a stable completed review to one request generation and bounds repeated completed attempts", async () => {
  let receipts = [];
  for (let attempt = 0; attempt <= 8; attempt += 1) {
    const result = await runScenario(`rabbit-attempt-${attempt}`, { setup: state => {
      state.reviews[0] = { ...state.reviews[0], id: attempt + 1, state: "CHANGES_REQUESTED" };
      state.comments.push(...receipts);
    } });
    assert.equal(result.comments.some(body => body.includes("@coderabbitai review")), attempt < 8);
    assert.equal(result.requests.some(request => request.body?.labels?.includes("needs-owner")), attempt === 8);
    if (attempt === 0) {
      const unchanged = await runScenario("rabbit-unchanged-attempt", { setup: state => {
        state.reviews[0].state = "CHANGES_REQUESTED";
        state.comments.push(...controllerReceipts(result));
      } });
      assert.ok(unchanged.comments.every(body => !body.includes("@coderabbitai review")));
    }
    receipts.push(...controllerReceipts(result));
  }
});

test("CLI accepts a clean Seer retry without retaining the failed check from its earlier suite", async () => {
  const result = await runScenario("seer-recovered", { setup: state => {
    state.checks.push(seerCheck({ id: 99, conclusion: "failure", check_suite: { id: 55 } }));
    state.checks.find(check => check.id === 100).check_suite = { id: 56 };
  } });
  assert.equal(result.merges.length, 1);
});

test("CLI reports a completed merge as still awaiting production verification", async () => {
  const result = await runScenario("merge-awaits-production");
  assert.equal(result.merges.length, 1);
  assert.ok(result.comments.some(body => body.includes("Production verification is still pending")));
});

for (const conclusion of ["failure", "cancelled"]) {
  test(`CLI leaves a ${conclusion} check with the agent without flagging the owner`, async () => {
    const result = await runScenario(`agent-repairs-${conclusion}`, { setup: state => { state.checks[0].conclusion = conclusion; } });
    assert.deepEqual(result.merges, []);
    assert.ok(result.comments.some(body => body.includes("checks-red") && body.includes("Jest")));
    assert.ok(result.comments.every(body => !body.includes("@serviroo")));
    assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
  });
}

test("CLI waits for required checks that have not reported", async () => {
  const result = await runScenario("missing-tests", { setup: state => {
    state.checks = state.checks.filter(check => check.name === "Seer Code Review");
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("checks-missing") && body.includes("Playwright booking")));
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

test("CLI retains a failing status even when a genuine Tests check has the same name", async () => {
  const result = await runScenario("failing-status-same-name", { setup: state => {
    state.statuses = [{ id: 900, context: "Jest", state: "failure" }];
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("checks-red")));
});

test("CLI retains a failed Tests check when another app posts a newer same-name success", async () => {
  const result = await runScenario("other-app-cannot-clear-failure", { setup: state => {
    state.checks[0].conclusion = "failure";
    state.checks.push({ ...state.checks[0], id: 900, app: { slug: "other-app" }, conclusion: "success" });
  } });
  assert.deepEqual(result.merges, []);
});

test("CLI accepts a successful Tests rerun and green extra checks", async () => {
  const result = await runScenario("successful-tests-rerun", { setup: state => {
    state.checks.push({ ...state.checks[0], id: 900, conclusion: "success" });
    state.checks[0].conclusion = "failure";
    for (const [index, conclusion] of ["skipped", "neutral"].entries()) {
      state.checks.push({ id: 901 + index, name: `extra-${conclusion}`, app: { slug: "other-app" }, status: "completed", conclusion });
    }
  } });
  assert.equal(result.merges.length, 1);
});

test("CLI accepts the newer success in a commit-status history", async () => {
  const result = await runScenario("newest-commit-status", { setup: state => {
    state.statuses = [{ id: 900, context: "Vercel", state: "success" }, { id: 800, context: "Vercel", state: "pending" }];
  } });
  assert.equal(result.merges.length, 1);
});

test("CLI honors a later CodeRabbit request for changes after approval", async () => {
  const result = await runScenario("rabbit-later-changes", { setup: state => {
    state.reviews.push({ ...state.reviews[0], id: 2, state: "CHANGES_REQUESTED", submitted_at: "2026-10-23T01:00:00Z" });
    state.threads = [{ isResolved: false, path: "scripts/example.mjs", comments: { nodes: [{ author: { login: "coderabbitai" } }] } }];
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("coderabbit-hold")));
  assert.ok(result.comments.every(body => !body.includes("@coderabbitai review")));
});

for (const resolved of [false, true]) {
  test(`CLI ${resolved ? "accepts" : "blocks on"} an outdated ${resolved ? "resolved" : "unresolved"} finding`, async () => {
    const result = await runScenario(`outdated-finding-${resolved}`, { setup: state => {
      state.threads = [{ isResolved: resolved, isOutdated: true, path: "README.md", comments: { nodes: [{ author: { login: "chatgpt-codex-connector" } }] } }];
    } });
    assert.equal(result.merges.length, resolved ? 1 : 0);
  });
}

test("CLI keeps a failing money-path PR with its agent", async () => {
  const result = await runScenario("agent-repairs-money-path", { setup: state => {
    state.checks[0].conclusion = "failure";
    state.threads = [{ isResolved: false, path: "src/lib/checkoutStorage.js", comments: { nodes: [{ author: { login: "sentry" } }] } }];
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("open-findings") && body.includes("checks-red")));
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

for (const [name, change] of [
  ["conflicting", state => { state.pull.mergeable_state = "dirty"; }],
  ["non-main-base", state => { state.pull.base.ref = "develop"; }],
]) {
  test(`CLI does not merge a ${name} branch`, async () => {
    const result = await runScenario(name, { setup: change });
    assert.deepEqual(result.merges, []);
    assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
  });
}

test("CLI flags GitHub blocking an otherwise ready PR", async () => {
  const result = await runScenario("github-blocked-ready", { setup: state => { state.pull.mergeable_state = "blocked"; } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.comments.some(body => body.includes("github-blocked") && body.includes("@serviroo")));
  assert.ok(result.requests.some(request => request.body?.labels?.includes("needs-owner")));
});

for (const nextState of ["COMMENTED", "APPROVED", "DISMISSED"]) {
  test(`CLI ${nextState === "COMMENTED" ? "retains" : "clears"} an older human change request after ${nextState}`, async () => {
    const result = await runScenario(`human-review-${nextState}`, { setup: state => {
      const person = { user: { login: "fixture-person", type: "User" }, commit_id: "c".repeat(40) };
      state.reviews.push({ ...person, id: 2, state: "CHANGES_REQUESTED", submitted_at: "2026-10-23T01:00:00Z" },
        { ...person, id: 3, state: nextState, submitted_at: "2026-10-23T02:00:00Z" });
    } });
    assert.equal(result.merges.length, nextState === "COMMENTED" ? 0 : 1);
  });
}

test("CLI merges after eight review rounds once all reviewers agree", async () => {
  const result = await runScenario("agreed-after-cap", { setup: state => {
    for (let round = 0; round < 8; round += 1) {
      state.comments.push({ id: 100 + round, user: bot("github-actions"), body: `<!-- pr-review-round:previous-${round} -->` });
    }
  } });
  assert.equal(result.merges.length, 1);
});

test("CLI preserves a pending Seer request across check-run progress updates", async () => {
  const setup = state => {
    state.checks.find(check => check.name === "Seer Code Review").status = "in_progress";
    state.checks.find(check => check.name === "Seer Code Review").conclusion = null;
  };
  const first = await runScenario("seer-progress-request", { setup });
  const waiting = await runScenario("seer-progress-wait", { setup: state => {
    setup(state);
    state.checks.find(check => check.name === "Seer Code Review").id += 1;
    state.comments.push(...controllerReceipts(first));
  } });
  assert.deepEqual(waiting.merges, []);
  assert.ok(waiting.comments.every(body => !body.includes("@sentry review")));
});

test("CLI retires an answered Seer request before timing its next completed attempt", async () => {
  const setup = (state, attempt) => {
    const check = state.checks.find(item => item.name === "Seer Code Review");
    check.id += attempt;
    check.conclusion = "neutral";
  };
  const first = await runScenario("seer-old-held-request", { setup: state => setup(state, 0) });
  const result = await runScenario("seer-new-held-request", { setup: state => {
    setup(state, 1);
    state.comments.push(...controllerReceipts(first).map(comment => ({ ...comment,
      created_at: new Date(Date.now() - 25 * 3600000).toISOString() })));
  } });
  assert.ok(result.comments.some(body => body.includes("@sentry review")));
  assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
});

for (const expired of [false, true]) {
  for (const paged of [false, true]) {
    test(`CLI retains the ${expired ? "expired" : "recent"} Seer request during a rerun with completed history on ${paged ? "page two" : "page one"}`, async () => {
      const first = await runScenario(`seer-rerun-receipt-${expired}-${paged}`, { setup: state => {
        state.checks.find(check => check.name === "Seer Code Review").conclusion = "neutral";
      } });
      const receipts = controllerReceipts(first).map(comment => ({ ...comment,
        created_at: new Date(Date.now() - (expired ? 25 : 1) * 3600000).toISOString() }));
      const result = await runScenario(`seer-rerun-history-${expired}-${paged}`, { setup: state => {
        const completed = state.checks.find(check => check.name === "Seer Code Review");
        completed.conclusion = "neutral";
        state.checks.push(seerCheck({ id: 101, status: "in_progress", conclusion: null }));
        state.latestChecks = state.checks.filter(check => check !== completed);
        if (paged) {
          state.checks = state.latestChecks;
          state.checkPageTwo = [completed];
        }
        state.comments.push(...receipts);
      } });
      assert.deepEqual(result.merges, []);
      assert.ok(result.comments.every(body => !body.includes("@sentry review")));
      assert.equal(result.requests.some(request => request.body?.labels?.includes("needs-owner")), expired);
    });
  }
}

const localCi = state => {
  state.statuses = [{ id: 900, context: "local-ci", state: "success" }];
  state.jobs = state.checks.filter(check => check.app?.slug === "github-actions").map(check => {
    check.status = "queued";
    check.conclusion = null;
    check.started_at = "2026-10-23T00:00:00Z";
    return { id: check.id, run_id: 600, head_sha: head, name: check.name, status: "queued", conclusion: null,
      runner_id: 0, started_at: check.started_at, steps: [] };
  });
};

test("CLI accepts local-ci for the renamed groups before any Actions job starts", async () => {
  const result = await runScenario("split-groups-local-ci", { setup: state => {
    localCi(state);
    state.comments = [];
    assert.equal(state.jobs.filter(job => splitCheckNames.includes(job.name)).length, 4);
  } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
  assert.ok(result.comments.some(body => body.includes("local-ci")));
});

for (const [name, setup] of Object.entries({
  absent: state => { state.comments = []; },
  running: state => { state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, status: "running", has_unresolved_findings: null } })} -->`; },
  held: state => { state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, status: "completed", has_unresolved_findings: true } })} -->`; },
  malformed: state => { state.comments[0].body = '<!-- codex-review-state:v1 not-json -->'; },
  edited: state => { state.editor = { login: "fixture-person" }; },
  expired: state => { state.comments = [{ id: 11, user: bot("github-actions"), created_at: new Date(Date.now() - 25 * 3600000).toISOString(), body: `<!-- pr-review-request:${head}:codex -->` }]; },
})) {
  test(`policy: optional Codex ${name} does not prevent a reviewed merge`, async () => {
    const result = await runScenario(`optional-codex-${name}`, { setup });
    assert.equal(result.merges.length, 1);
    assert.ok(result.comments.every(body => !body.includes("@codex review")));
    assert.ok(result.requests.every(request => !request.body?.labels?.includes("needs-owner")));
  });
}

for (const stateName of ["clean", "unstable"]) {
  test(`policy: local-ci replaces unstarted Actions jobs on a ${stateName} head`, async () => {
    const result = await runScenario(`local-ci-${stateName}`, { setup: state => {
      localCi(state);
      state.pull.mergeable_state = stateName;
      state.comments = [];
    } });
    assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
    assert.ok(result.comments.some(body => body.includes("local-ci")));
  });
}

test("policy: local-ci permits a head with no Actions run or check yet", async () => {
  const result = await runScenario("local-ci-no-actions", { setup: state => {
    localCi(state);
    state.checks = state.checks.filter(check => check.app?.slug !== "github-actions");
    state.workflowRuns = [];
    state.jobs = [];
  } });
  assert.equal(result.merges.length, 1);
});

for (const [name, mutate, canMerge] of [
  ["null-runner", job => { job.runner_id = null; }, true],
  ["missing-runner", job => { delete job.runner_id; }, false],
  ["invalid-runner", job => { job.runner_id = "0"; }, false],
  ["null-runner-missing-steps", job => { job.runner_id = null; delete job.steps; }, false],
  ["null-runner-null-steps", job => { job.runner_id = null; job.steps = null; }, false],
  ["null-runner-started-step", job => { job.runner_id = null; job.steps = [{ status: "completed", started_at: "2026-10-23T00:00:00Z" }]; }, false],
  ["null-runner-running-job", job => { job.runner_id = null; job.status = "in_progress"; }, false],
]) {
  test(`policy: local-ci ${canMerge ? "accepts" : "refuses"} ${name}`, async () => {
    const result = await runScenario(`local-ci-${name}`, { setup: state => {
      localCi(state);
      state.jobs.forEach(mutate);
    } });
    assert.equal(result.merges.length, canMerge ? 1 : 0);
  });
}

test("policy: local-ci replaces jobs rejected before any runner or step started", async () => {
  const result = await runScenario("local-ci-unstarted-failure", { setup: state => {
    localCi(state);
    for (const job of state.jobs) { job.status = "completed"; job.conclusion = "failure"; }
    for (const check of state.checks.filter(check => check.app?.slug === "github-actions")) {
      check.status = "completed"; check.conclusion = "failure";
    }
  } });
  assert.equal(result.merges.length, 1);
});

for (const [name, mutate] of Object.entries({
  missing: state => { state.statuses = []; },
  pending: state => { state.statuses[0].state = "pending"; },
  failed: state => { state.statuses[0].state = "failure"; },
  error: state => { state.statuses[0].state = "error"; },
  "old-head": state => { state.statusesHead = "c".repeat(40); },
  "newer-failure": state => { state.statuses.push({ id: 901, context: "local-ci", state: "failure" }); },
  "newer-pending": state => { state.statuses.push({ id: 901, context: "local-ci", state: "pending" }); },
  "check-run-impostor": state => { state.statuses = []; state.checks.push({ id: 950, name: "local-ci", status: "completed", conclusion: "success", app: { slug: "other-app" } }); },
  "running-job": state => { state.jobs[0].status = "in_progress"; },
  "runner-assigned": state => { state.jobs[0].runner_id = 1; },
  "started-step": state => { state.jobs[0].steps = [{ status: "completed", started_at: "2026-10-23T00:00:00Z" }]; },
  "wrong-job-head": state => { state.jobs[0].head_sha = "c".repeat(40); },
  "wrong-job-run": state => { state.jobs[0].run_id = 999; },
  "missing-job": state => { state.jobs.shift(); },
  "failed-started-job": state => {
    state.jobs[0] = { ...state.jobs[0], status: "completed", conclusion: "failure", runner_id: 1 };
    state.checks[0] = { ...state.checks[0], status: "completed", conclusion: "failure" };
  },
  "other-app-failure": state => { state.checks.push({ id: 950, name: "security", app: { slug: "other-app" }, status: "completed", conclusion: "failure" }); },
  "same-name-status-failure": state => { state.statuses.push({ id: 950, context: "Jest", state: "failure" }); },
  "other-workflow-pending": state => {
    state.workflowRuns.push({ id: 800, workflow_id: 3, check_suite_id: 30, head_sha: head });
    state.checks.push({ ...state.checks[0], id: 950, check_suite: { id: 30 } });
  },
})) {
  test(`policy: local-ci does not hide ${name}`, async () => {
    const result = await runScenario(`local-ci-refuses-${name}`, { setup: state => { localCi(state); mutate(state); } });
    assert.deepEqual(result.merges, []);
  });
}

test("policy: job history on a later page prevents hiding an executed failure", async () => {
  const result = await runScenario("local-ci-job-pagination", { setup: state => {
    localCi(state);
    state.jobPageTwo = [{ ...state.jobs[0], id: 999, runner_id: 1, status: "completed", conclusion: "failure" }];
  } });
  assert.deepEqual(result.merges, []);
  assert.ok(result.requests.some(request => request.path.endsWith("/jobs") && request.query.includes("page=2")));
});

for (const [name, changeSecond] of Object.entries({
  "a-job-starts": state => { state.jobs[0].runner_id = 1; state.jobs[0].status = "in_progress"; },
  "local-result-fails": state => { state.statuses[0].state = "failure"; },
  "local-result-disappears": state => { state.statuses = []; },
})) {
  test(`policy: local-ci is rechecked before merge when ${name}`, async () => {
    const result = await runScenario(`local-ci-race-${name}`, { setup: localCi, changeSecond });
    assert.equal(result.snapshots, 2);
    assert.deepEqual(result.merges, []);
  });
}
