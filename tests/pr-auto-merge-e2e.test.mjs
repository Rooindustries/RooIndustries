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

const root = fileURLToPath(new URL("../", import.meta.url));
const head = "a".repeat(40);
const repo = "fixture/website";
const prefix = `/repos/${repo}`;
const bot = login => ({ login: `${login}[bot]`, type: "Bot" });
const token = "fixture-github-token";
const userToken = "fixture-user-token";
const workflow = readFileSync(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
const matrixNames = [...workflow.matchAll(/^ {10}- name:\s*(\S+)\s*$/gm)].map(([, name]) => name);
const checkNames = [...workflow.matchAll(/^ {4}name:\s*(.+?)\s*$/gm)].flatMap(([, name]) =>
  name.includes("${{ matrix.suite.name }}")
    ? matrixNames.map(suite => name.replace("${{ matrix.suite.name }}", suite))
    : [name]
);

const baseline = () => ({
  pull: { number: 1, html_url: "https://github.com/fixture/website/pull/1", title: "Fixture PR", state: "open", draft: false,
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: repo } },
    head: { ref: "fixture-change", sha: head, repo: { full_name: repo } }, mergeable_state: "clean" },
  baseTip: "b".repeat(40),
  reviews: [{ user: bot("coderabbitai"), state: "APPROVED", commit_id: head, submitted_at: "2026-10-23T00:00:00Z" }],
  workflow: { id: 1, path: ".github/workflows/tests.yml" },
  workflowRuns: [
    { id: 600, workflow_id: 1, check_suite_id: 10, head_sha: head, path: ".github/workflows/tests.yml" },
    { id: 700, workflow_id: 2, check_suite_id: 20, head_sha: head, path: ".github/workflows/auto-merge.yml" },
  ],
  checks: checkNames.map((name, index) => ({ id: index + 1, name, app: { slug: "github-actions" }, check_suite: { id: 10 },
    status: "completed", conclusion: "success", completed_at: "2026-10-23T00:00:00Z" })),
  statuses: [],
  comments: [{ id: 10, node_id: "codex-review", user: bot("chatgpt-codex-connector"),
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
        if (state.checkPageTwo && !url.searchParams.has("page")) {
          res.setHeader("link", `<https://api.github.com${url.pathname}?page=2>; rel="next"`);
        }
        return send(200, { check_runs: url.searchParams.has("page") ? state.checkPageTwo : state.checks });
      }
      if (url.pathname.endsWith("/statuses")) return send(200, state.statuses);
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

for (const [name, value] of [
  ["missing", undefined], ["null", null], ["string-false", "false"], ["string-true", "true"],
  ["zero", 0], ["one", 1], ["array", []], ["object", {}], ["unresolved", true],
]) {
  test(`CLI leaves a ${name} unresolved-findings flag unmerged`, async () => {
    const result = await runScenario(`codex-flag-${name}`, { setup: state => {
      state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
        commit_sha: head, status: "completed", has_unresolved_findings: value,
      } })} -->`;
    } });
    assert.deepEqual(result.merges, []);
  });
}

test("CLI rejects a malformed verdict that arrives at the final snapshot", async () => {
  const result = await runScenario("codex-flag-changed", { changeSecond: state => {
    state.comments[0].body = `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: {
      commit_sha: head, status: "completed", has_unresolved_findings: "false",
    } })} -->`;
  } });
  assert.equal(result.snapshots, 2);
  assert.deepEqual(result.merges, []);
});

for (const [status, conclusion] of [["queued", null], ["in_progress", null], ["completed", "failure"], ["completed", "success"]]) {
  test(`CLI ignores its own ${status} ${conclusion || ""} gate check on a manual dispatch`, async () => {
    const result = await runScenario(`self-check-${status}-${conclusion}`, {
      event: "workflow_dispatch", eventBody: {},
      setup: state => state.checks.push({ id: 1000, name: "auto-merge-gate", app: { slug: "github-actions" }, check_suite: { id: 20 }, status, conclusion }),
    });
    assert.deepEqual(result.merges.map(request => request.body), [{ merge_method: "squash", sha: head }]);
  });
}

const refusals = {
  "human-statuses": state => { state.statuses = state.checks.map(check => ({ id: check.id, context: check.name, state: "success" })); state.checks = []; },
  "foreign-app": state => { state.checks.forEach(check => { check.app.slug = "other-app"; }); },
  "queued-rerun": state => { state.checks.push({ ...state.checks[0], id: 1000, status: "queued", conclusion: null }); },
  "paged-failure": state => { state.checkPageTwo = [{ ...state.checks[0], id: 1000, conclusion: "failure" }]; },
  "human-review": state => { state.reviews[0].user = { login: "coderabbitai", type: "User" }; },
  "forged-codex": state => { state.comments[0].user = { login: "chatgpt-codex-connector", type: "User" }; },
  "edited-codex": state => { state.editor = { login: "fixture-person" }; },
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
  const request = result.requests.find(request => request.body?.body?.includes("@codex review"));
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
  for (const reviewer of ["coderabbit", "codex"]) {
    test(`CLI requests only ${reviewer} with the ${useUserToken ? "user" : "workflow"} credential`, async () => {
      const result = await runScenario(`request-only-${reviewer}-${useUserToken}`, { useUserToken, setup: state => {
        if (reviewer === "coderabbit") state.reviews = [];
        else state.comments = [];
      } });
      const wanted = reviewer === "coderabbit" ? "@coderabbitai review" : "@codex review";
      const approved = reviewer === "coderabbit" ? "@codex review" : "@coderabbitai review";
      assert.ok(result.comments.some(body => body.includes(wanted)));
      assert.ok(result.comments.every(body => !body.includes(approved)));
      assert.ok(result.comments.every(body => !body.includes("Requested both reviews")));
    });
  }
}

test("CLI includes a holding reviewer alongside a pending reviewer", async () => {
  const result = await runScenario("request-held-and-pending", { setup: state => {
    state.reviews[0].state = "CHANGES_REQUESTED";
    state.comments = [];
  } });
  assert.ok(result.comments.some(body => body.includes("@coderabbitai review") && body.includes("@codex review")));
});

for (const expired of [false, true]) {
  test(`CLI ${expired ? "flags an expired" : "waits for a recent"} unanswered review request without repeating it`, async () => {
    const result = await runScenario(`pending-request-${expired}`, { setup: state => {
      state.comments = [{ id: 11, user: bot("github-actions"), created_at: new Date(Date.now() - (expired ? 25 : 1) * 3600000).toISOString(),
        body: `<!-- pr-review-request:${head} -->` }];
      state.reviews = [];
    } });
    assert.deepEqual(result.merges, []);
    assert.ok(result.comments.every(body => !body.includes("@codex review")));
    assert.equal(result.requests.some(request => request.body?.labels?.includes("needs-owner")), expired);
  });
}
