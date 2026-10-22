import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  GATE_MARKER,
  REVIEW_REQUEST_PREFIX,
  REVIEW_ROUND_PREFIX,
  countReviewRounds,
  decide,
  gateComment,
  moneyDependencies,
  parseCodexState,
} from "./pr-auto-merge-gate.mjs";

const repo = process.env.REPO || process.env.GITHUB_REPOSITORY;
const readToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const mergeToken = process.env.AUTO_MERGE_TOKEN || readToken;

const api = async (token, path, { method = "GET", body } = {}) => {
  const response = await fetch(path.startsWith("http") ? path : `https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "pr-auto-merge",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.message || `GitHub ${method} ${path} returned ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { payload, headers: response.headers };
};

const paginate = async (path) => {
  const items = [];
  let next = `https://api.github.com/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (next) {
    const { payload, headers } = await api(readToken, next);
    items.push(...(Array.isArray(payload) ? payload : payload.check_runs || payload.statuses || []));
    const link = headers.get("link") || "";
    const match = link.match(/<([^>]+)>; rel="next"/);
    next = match ? match[1] : "";
  }
  return items;
};

const graphql = async (query, variables) => {
  const { payload } = await api(readToken, "graphql", { method: "POST", body: { query, variables } });
  if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
  return payload.data;
};

const login = (author) => author?.login || "";
const botNamed = (author, name) => author?.type === "Bot" && String(author.login || "").replace(/\[bot\]$/, "") === name;

const collectThreads = async (number) => {
  const [owner, name] = repo.split("/");
  const threads = [];
  let cursor = null;
  do {
    const data = await graphql(`query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { isResolved isOutdated path comments(first: 1) { nodes { author { login } } } }
          }
        }
      }
    }`, { owner, name, number, cursor });
    const page = data.repository.pullRequest.reviewThreads;
    for (const thread of page.nodes) {
      threads.push({
        author: thread.comments.nodes[0]?.author?.login || "",
        path: thread.path,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
};

const collectSnapshot = async (number) => {
  const { payload: pull } = await api(readToken, `repos/${repo}/pulls/${number}`);
  const [reviews, files, checkRuns, commentPage, statuses] = await Promise.all([
    paginate(`repos/${repo}/pulls/${number}/reviews`),
    paginate(`repos/${repo}/pulls/${number}/files`),
    paginate(`repos/${repo}/commits/${pull.head.sha}/check-runs`),
    paginate(`repos/${repo}/issues/${number}/comments`),
    paginate(`repos/${repo}/commits/${pull.head.sha}/statuses`),
  ]);
  const comments = Array.isArray(commentPage) ? commentPage : [];
  const codexComment = [...comments].reverse().find((comment) => botNamed(comment.user, "chatgpt-codex-connector") && comment.body?.includes("codex-review-state:v1"));
  const ownComments = comments.filter((comment) => botNamed(comment.user, "github-actions"));
  const checks = [
    ...checkRuns.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.completed_at || run.started_at || "",
    })),
    ...statuses.map((entry) => ({
      name: entry.context,
      status: entry.state === "pending" ? "pending" : "completed",
      conclusion: entry.state === "error" ? "failure" : entry.state,
      completedAt: entry.updated_at || entry.created_at || "",
    })),
  ];
  return {
    number,
    url: pull.html_url,
    title: pull.title,
    draft: pull.draft,
    baseRef: pull.base.ref,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    sameRepository: pull.head.repo?.full_name === pull.base.repo.full_name,
    mergeableState: pull.mergeable_state,
    // The files API stops at 3000 files; a shorter list than GitHub's count is treated as unknown.
    files: files.length === pull.changed_files ? files.map((file) => ({
      filename: file.filename,
      previousFilename: file.previous_filename || "",
      patch: file.patch || "",
      patchMissing: file.patch === undefined && file.changes > 0,
    })) : null,
    checks,
    reviews: reviews.map((review) => ({
      author: login(review.user),
      bot: review.user?.type === "Bot",
      state: review.state,
      commitSha: review.commit_id,
      submittedAt: review.submitted_at,
    })),
    threads: await collectThreads(number),
    codex: parseCodexState(codexComment?.body || ""),
    reviewRounds: countReviewRounds(ownComments.map((comment) => comment.body || "")),
    comments: ownComments,
  };
};

// The workflow checks out main, so this reads main's source to find what the money paths import.
const readSources = async () => {
  const sources = new Map();
  for (const root of ["app", "src", "lib"]) {
    let entries;
    try {
      entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const filePath = path.relative(process.cwd(), path.join(entry.parentPath ?? entry.path, entry.name)).split(path.sep).join("/");
      sources.set(filePath, await fs.readFile(filePath, "utf8"));
    }
  }
  for (const filePath of ["middleware.js", "middleware.ts"]) {
    try {
      sources.set(filePath, await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return sources;
};

const ensureLabel = async () => {
  try {
    await api(readToken, `repos/${repo}/labels/needs-owner`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await api(readToken, `repos/${repo}/labels`, {
      method: "POST",
      body: { name: "needs-owner", color: "b60205", description: "Held for the owner. The auto-merge gate will not merge this pull request." },
    });
  }
};

const setOwnerLabel = async (number, flagged) => {
  await ensureLabel();
  if (flagged) {
    await api(readToken, `repos/${repo}/issues/${number}/labels`, { method: "POST", body: { labels: ["needs-owner"] } });
    return;
  }
  try {
    await api(readToken, `repos/${repo}/issues/${number}/labels/needs-owner`, { method: "DELETE" });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
};

const writeGateComment = async (snapshot, body) => {
  const existing = snapshot.comments.find((comment) => comment.body?.includes(GATE_MARKER));
  if (existing?.body === body) return;
  if (existing) {
    await api(readToken, `repos/${repo}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
    return;
  }
  await api(readToken, `repos/${repo}/issues/${snapshot.number}/comments`, { method: "POST", body: { body } });
};

const recordReviewRound = async (snapshot) => {
  await api(readToken, `repos/${repo}/issues/${snapshot.number}/comments`, {
    method: "POST",
    body: {
      body: `${REVIEW_ROUND_PREFIX}${snapshot.headSha} -->\nReview round on \`${snapshot.headRef}\`. The owning agent's pull request watch picks up the open findings, fixes them, and pushes. It does not merge.\n`,
    },
  });
};

const requestReviews = async (snapshot) => {
  await api(readToken, `repos/${repo}/issues/${snapshot.number}/comments`, {
    method: "POST",
    body: {
      body: `@coderabbitai review\n@codex review\n${REVIEW_REQUEST_PREFIX}${snapshot.headSha} -->\n`,
    },
  });
};

const mergePullRequest = async (number, sha) => {
  try {
    await api(mergeToken, `repos/${repo}/pulls/${number}/merge`, { method: "PUT", body: { merge_method: "squash", sha } });
    return { error: "", headMoved: false };
  } catch (error) {
    return { error: error.message, headMoved: error.status === 409 };
  }
};

const pullNumbers = async () => {
  if (!process.env.GITHUB_EVENT_PATH || !process.env.GITHUB_EVENT_NAME) return [];
  const payload = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const event = process.env.GITHUB_EVENT_NAME;
  if (event === "pull_request_target") return [payload.pull_request.number];
  if (event === "workflow_run") {
    if (payload.workflow_run?.head_branch === "main" && payload.workflow_run?.event === "push") return [];
    const attached = (payload.workflow_run?.pull_requests || []).map((pull) => pull.number);
    if (attached.length) return attached;
    const sha = payload.workflow_run?.head_sha;
    const open = await paginate(`repos/${repo}/pulls?state=open`);
    return open.filter((pull) => pull.head?.sha === sha).map((pull) => pull.number);
  }
  if (event === "schedule" || event === "workflow_dispatch") {
    const open = await paginate(`repos/${repo}/pulls?state=open`);
    return open.map((pull) => pull.number);
  }
  return [];
};

const applyOne = async (number, dependencies) => {
  const snapshot = { ...(await collectSnapshot(number)), moneyDependencies: dependencies };
  if (!snapshot.sameRepository) {
    console.log(`#${number} fork, skipped`);
    return;
  }
  const decision = decide(snapshot);
  console.log(`#${number} ${decision.action} wake=${decision.wake} ${decision.reasons.join(",")}`);
  if (decision.requestReviews) {
    const requested = snapshot.comments.some((comment) => String(comment.body).includes(`${REVIEW_REQUEST_PREFIX}${snapshot.headSha}`));
    if (!requested) await requestReviews(snapshot);
  }
  if (decision.reviewRound) {
    const counted = snapshot.comments.some((comment) => String(comment.body).includes(`${REVIEW_ROUND_PREFIX}${snapshot.headSha}`));
    if (!counted) await recordReviewRound(snapshot);
  }
  if (decision.action === "merge") {
    // The merge call can pin only the head, so re-read the base right before it and defer if main moved.
    const { payload: latest } = await api(readToken, `repos/${repo}/pulls/${number}`);
    const baseMoved = latest.base.sha !== snapshot.baseSha || latest.head.sha !== snapshot.headSha || latest.mergeable_state !== "clean";
    const { error: mergeError, headMoved } = baseMoved
      ? { error: "", headMoved: true }
      : await mergePullRequest(number, snapshot.headSha);
    if (headMoved) {
      decision.action = "wait";
      decision.reasons = [...decision.reasons, "head-moved"];
      decision.lines = [`The branch or main moved while the merge was being prepared, so nothing merged. The next run decides again.`];
    } else if (mergeError) {
      decision.action = "flag";
      decision.reasons = [...decision.reasons, "merge-rejected"];
      decision.lines = [
        ...decision.lines.filter((line) => !line.startsWith("Every check on")),
        `GitHub rejected the merge: ${mergeError}`,
        "Branch protection or a ruleset can block the GitHub Actions token. This workflow does not change those settings. A personal access token in the AUTO_MERGE_TOKEN secret merges as a user, which also lets the Tests workflow run on the merge commit.",
      ];
    } else {
      decision.merged = true;
    }
  }
  const body = gateComment({
    decision,
    headSha: snapshot.headSha,
  });
  await setOwnerLabel(number, decision.action === "flag");
  await writeGateComment(snapshot, body);
};

const main = async () => {
  if (!repo || !readToken) throw new Error("REPO and GH_TOKEN are required");
  const numbers = await pullNumbers();
  const dependencies = numbers.length ? moneyDependencies(await readSources()) : [];
  const failures = [];
  for (const number of numbers) {
    try {
      await applyOne(number, dependencies);
    } catch (error) {
      failures.push(`#${number}: ${error.message}`);
      console.error(`#${number} ${error.message}`);
    }
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  }
};

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) await main();
