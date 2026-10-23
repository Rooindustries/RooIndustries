import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  GATE_MARKER,
  REQUIRED_CHECKS,
  REVIEW_REQUEST_PREFIX,
  REVIEW_ROUND_PREFIX,
  countReviewRounds,
  decide,
  gateComment,
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

const paginate = async (path, collection) => {
  const items = [];
  let next = `https://api.github.com/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  while (next) {
    const { payload, headers } = await api(readToken, next);
    if (collection && !Array.isArray(payload?.[collection])) throw new Error(`GitHub returned invalid ${collection} history.`);
    items.push(...(collection ? payload[collection] : Array.isArray(payload) ? payload : payload.check_runs || payload.statuses || payload.workflow_runs || []));
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
const REVIEW_MENTIONS = { coderabbit: "@coderabbitai review", seer: "@sentry review" };
const fingerprint = (state) => createHash("sha256").update(JSON.stringify(state)).digest("hex");
const reviewRequest = (comments, headSha, reviewer, generation) => [...comments].reverse().find((comment) => {
  const body = String(comment.body || "");
  if (body.includes(`${REVIEW_REQUEST_PREFIX}${headSha}:${reviewer}:${generation} -->`)) return true;
  if (generation !== "initial") return false;
  return body.includes(`${REVIEW_REQUEST_PREFIX}${headSha}:${reviewer} -->`) ||
    (body.includes(`${REVIEW_REQUEST_PREFIX}${headSha} -->`) &&
      (body.includes(REVIEW_MENTIONS[reviewer]) || (reviewer !== "seer" && body.includes("Requested both reviews with the user credential."))));
});

// A finished response retires the request that led to it. Pending updates to the same
// response keep its generation, so scheduling another gate run does not request it again.
const reviewGenerations = ({ reviews, seerChecks, headSha }) => {
  const rabbit = reviews.filter((review) => botNamed(review.user, "coderabbitai") && review.commit_id === headSha &&
    ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
    .sort((left, right) => String(left.submitted_at).localeCompare(String(right.submitted_at)) || left.id - right.id).at(-1);
  const seer = seerChecks.find((check) => check.status === "completed");
  return {
    coderabbit: rabbit ? fingerprint([rabbit.id, rabbit.state, rabbit.submitted_at]) : "initial",
    seer: seer ? fingerprint([seer.id, seer.conclusion, seer.completed_at]) : "initial",
  };
};

const unstartedTests = async ({ runsBySuite, checkRuns, testsWorkflowId, headSha }) => {
  const runs = [...runsBySuite.values()].filter(run => run.workflow_id === testsWorkflowId);
  const histories = await Promise.all(runs.map(async run => ({
    run, jobs: await paginate(`repos/${repo}/actions/runs/${run.id}/jobs?filter=all`, "jobs"),
  })));
  if (histories.some(({ run, jobs }) => jobs.some(job => !Number.isSafeInteger(job.id) || job.id <= 0 ||
    typeof job.name !== "string" || !job.name || job.run_id !== run.id || job.head_sha !== headSha))) return [];
  const jobs = histories.flatMap(history => history.jobs);
  const neverStarted = job => job.runner_id === 0 && ["queued", "pending", "waiting", "requested", "completed"].includes(job.status) &&
    Array.isArray(job.steps) && job.steps.every(step => !step.started_at && ["pending", "queued", "waiting", "skipped"].includes(step.status));
  return REQUIRED_CHECKS.filter(name => {
    const namedJobs = jobs.filter(job => job.name === name);
    const namedChecks = checkRuns.filter(check => check.name === name && check.app?.slug === "github-actions" &&
      runsBySuite.get(check.check_suite?.id)?.workflow_id === testsWorkflowId);
    return namedJobs.every(neverStarted) && namedChecks.every(check => check.status !== "in_progress" &&
      namedJobs.some(job => job.id === check.id));
  });
};

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
  const [reviews, checkRuns, commentPage, statuses, base, testsWorkflow, workflowRuns] = await Promise.all([
    paginate(`repos/${repo}/pulls/${number}/reviews`),
    paginate(`repos/${repo}/commits/${pull.head.sha}/check-runs?filter=all`),
    paginate(`repos/${repo}/issues/${number}/comments`),
    paginate(`repos/${repo}/commits/${pull.head.sha}/statuses`),
    api(readToken, `repos/${repo}/git/ref/heads/main`),
    api(readToken, `repos/${repo}/actions/workflows/tests.yml`),
    paginate(`repos/${repo}/actions/runs?head_sha=${pull.head.sha}`),
  ]);
  const baseSha = base.payload?.object?.sha;
  if (!baseSha) throw new Error("GitHub did not return the main branch tip.");
  const testsWorkflowId = testsWorkflow.payload?.id;
  if (!Number.isSafeInteger(testsWorkflowId) || testsWorkflowId <= 0 || testsWorkflow.payload.path !== ".github/workflows/tests.yml") {
    throw new Error("GitHub did not identify the Tests workflow.");
  }
  const runsBySuite = new Map(workflowRuns
    .filter((run) => run.head_sha === pull.head.sha && Number.isSafeInteger(run.id) && run.id > 0 &&
      Number.isSafeInteger(run.check_suite_id) && run.check_suite_id > 0 &&
      Number.isSafeInteger(run.workflow_id) && run.workflow_id > 0)
    .map((run) => [run.check_suite_id, run]));
  const { payload: comparison } = await api(readToken, `repos/${repo}/compare/${baseSha}...${pull.head.sha}?per_page=1`);
  const baseIsAncestor = comparison?.base_commit?.sha === baseSha && comparison?.merge_base_commit?.sha === baseSha &&
    comparison?.behind_by === 0 && ["ahead", "identical"].includes(comparison?.status);
  const comments = Array.isArray(commentPage) ? commentPage : [];
  const ownComments = comments.filter((comment) => botNamed(comment.user, "github-actions"));
  // This repository's installed Sentry integration publishes this check. Other apps,
  // old heads and skipped/neutral results cannot establish a clean Seer review.
  const seerChecks = checkRuns.filter((run) => run.app?.id === 12637 && run.app?.slug === "sentry" &&
    run.name === "Seer Code Review" && run.head_sha === pull.head.sha).sort((left, right) => right.id - left.id);
  const generations = reviewGenerations({ reviews, seerChecks, headSha: pull.head.sha });
  const unstartedChecks = statuses.some(status => status.context === "local-ci" && status.state === "success")
    ? await unstartedTests({ runsBySuite, checkRuns, testsWorkflowId, headSha: pull.head.sha }) : [];
  const reviewWaitExpired = Object.fromEntries(Object.keys(REVIEW_MENTIONS).map((reviewer) => {
    const requested = reviewRequest(ownComments, pull.head.sha, reviewer, generations[reviewer]);
    const requestedAt = Date.parse(requested?.created_at);
    return [reviewer, Boolean(requested) && (!Number.isFinite(requestedAt) || Date.now() - requestedAt >= 24 * 3600000)];
  }));
  const checks = [
    ...checkRuns.filter((run) => {
      const workflow = runsBySuite.get(run.check_suite?.id);
      const workflowPath = typeof workflow?.path === "string" ? workflow.path.split("@", 1)[0] : "";
      return !(run.app?.slug === "github-actions" && run.name === "auto-merge-gate" &&
        String(workflow?.id) === process.env.GITHUB_RUN_ID && workflowPath === ".github/workflows/auto-merge.yml");
    }).map((run) => ({
      source: "check-run",
      app: run.app?.slug || "",
      workflowId: runsBySuite.get(run.check_suite?.id)?.workflow_id || null,
      checkSuiteId: run.check_suite?.id || null,
      order: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      completedAt: run.completed_at || run.started_at || "",
    })),
    ...statuses.map((entry) => ({
      source: "status",
      order: entry.id,
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
    state: pull.state,
    draft: pull.draft,
    baseRef: pull.base.ref,
    baseSha,
    baseIsAncestor,
    testsWorkflowId,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    sameRepository: pull.head.repo?.full_name === pull.base.repo.full_name,
    mergeableState: pull.mergeable_state,
    checks,
    unstartedChecks,
    reviews: reviews.map((review) => ({
      id: review.id,
      author: login(review.user),
      bot: review.user?.type === "Bot",
      state: review.state,
      commitSha: review.commit_id,
      submittedAt: review.submitted_at,
    })),
    threads: await collectThreads(number),
    seer: seerChecks[0] || null,
    reviewGenerations: generations,
    reviewRoundId: fingerprint([pull.head.sha, generations]),
    reviewRounds: countReviewRounds(ownComments.map((comment) => comment.body || "")),
    reviewWaitExpired,
    comments: ownComments,
  };
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
      body: `${REVIEW_ROUND_PREFIX}${snapshot.headSha}:${snapshot.reviewRoundId} -->\nReview round on \`${snapshot.headRef}\`. The owning agent's pull request watch picks up the open findings, fixes them, and requests another review. It does not merge.\n`,
    },
  });
};

const requestReviews = async (snapshot, reviewers) => {
  const mentions = reviewers.map((reviewer) => REVIEW_MENTIONS[reviewer]).join("\n");
  const receipts = reviewers.map((reviewer) => `${REVIEW_REQUEST_PREFIX}${snapshot.headSha}:${reviewer}:${snapshot.reviewGenerations[reviewer]} -->`).join("\n");
  if (process.env.AUTO_MERGE_TOKEN) {
    await api(mergeToken, `repos/${repo}/issues/${snapshot.number}/comments`, {
      method: "POST",
      body: { body: mentions },
    });
  }
  await api(readToken, `repos/${repo}/issues/${snapshot.number}/comments`, {
    method: "POST",
    body: {
      body: `${process.env.AUTO_MERGE_TOKEN ? "Requested reviews with the user credential." : mentions}\n${receipts}\n`,
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

const applyOne = async (number) => {
  const snapshot = await collectSnapshot(number);
  if (snapshot.state !== "open") {
    console.log(`#${number} closed, skipped`);
    return;
  }
  if (!snapshot.sameRepository) {
    console.log(`#${number} fork, skipped`);
    return;
  }
  const decision = decide(snapshot);
  console.log(`#${number} ${decision.action} wake=${decision.wake} ${decision.reasons.join(",")}`);
  if (decision.requestReviews) {
    const reviewers = decision.reviewers.filter((reviewer) => !reviewRequest(snapshot.comments, snapshot.headSha, reviewer, snapshot.reviewGenerations[reviewer]));
    if (reviewers.length) await requestReviews(snapshot, reviewers);
  }
  if (decision.reviewRound) {
    const counted = snapshot.comments.some((comment) => String(comment.body).includes(`${REVIEW_ROUND_PREFIX}${snapshot.headSha}:${snapshot.reviewRoundId} -->`));
    if (!counted) await recordReviewRound(snapshot);
  }
  if (decision.action === "merge") {
    // The merge call can pin only the head, so run the whole gate again on fresh data right before it:
    // reviews, threads, checks, the base branch and both SHAs can all change while the first pass runs.
    const latest = await collectSnapshot(number);
    const baseMoved = latest.state !== "open" || decide(latest).action !== "merge" || latest.headSha !== snapshot.headSha ||
      latest.baseSha !== snapshot.baseSha || latest.baseRef !== "main" || !latest.sameRepository;
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
        ...decision.lines.filter((line) => !line.startsWith("Required checks for")),
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
  const failures = [];
  for (const number of numbers) {
    try {
      await applyOne(number);
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
