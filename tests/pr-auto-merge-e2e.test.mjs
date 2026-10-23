import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_CHECKS } from "../scripts/pr-auto-merge-gate.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const head = "a".repeat(40);
const repo = "fixture/website";
const prefix = `/repos/${repo}`;
const bot = login => ({ login: `${login}[bot]`, type: "Bot" });
const token = "fixture-github-token";

const baseline = () => ({
  pull: { number: 1, html_url: "https://github.com/fixture/website/pull/1", title: "Fixture PR", draft: false,
    base: { ref: "main", sha: "b".repeat(40), repo: { full_name: repo } },
    head: { ref: "fixture-change", sha: head, repo: { full_name: repo } }, mergeable_state: "clean" },
  reviews: [{ user: bot("coderabbitai"), state: "APPROVED", commit_id: head, submitted_at: "2026-10-23T00:00:00Z" }],
  checks: REQUIRED_CHECKS.map((name, index) => ({ id: index + 1, name, app: { slug: "github-actions" },
    status: "completed", conclusion: "success", completed_at: "2026-10-23T00:00:00Z" })),
  statuses: [],
  comments: [{ id: 10, node_id: "codex-review", user: bot("chatgpt-codex-connector"),
    body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: head, status: "completed", has_unresolved_findings: false } })} -->` }],
  threads: [],
  editor: null,
});

const runScenario = async (name, { setup, changeSecond, mergeStatus = 200, event = "pull_request_target", eventBody } = {}) => {
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
      requests.push({ method: req.method, path: url.pathname, query: url.search, body });
      const send = (code, payload) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Unexpected fixture credential" });
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
        ROO_GITHUB_FIXTURE_ORIGIN: `http://${address.address}:${address.port}`,
        GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath },
      timeout: 30000,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const [code] = await once(child, "close");
    const artifact = path.join(root, "test-results/pr-auto-merge", `${name}.json`);
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, JSON.stringify({ code, output, requests }, null, 2));
    assert.equal(code, 0, output);
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
};
for (const [name, setup] of Object.entries(refusals)) {
  test(`CLI leaves ${name} unmerged`, async () => {
    const result = await runScenario(name, { setup });
    assert.deepEqual(result.merges, []);
  });
}

for (const [name, changeSecond] of Object.entries({
  "moved-head": state => { state.pull.head.sha = "d".repeat(40); },
  "moved-main": state => { state.pull.base.sha = "d".repeat(40); },
  "new-review": state => { state.reviews[0].state = "CHANGES_REQUESTED"; },
  "new-failure": state => { state.checks[0].conclusion = "failure"; },
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
