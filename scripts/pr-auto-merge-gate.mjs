export const REQUIRED_CHECKS = [
  "Jest",
  "Playwright navigation",
  "Playwright booking",
  "Playwright rest-1",
  "Playwright rest-2",
  "Playwright rest-3",
  "Playwright rest-4",
  "Playwright creator portal and API routes",
  "Native PostgreSQL 17 suites",
  "Playwright revalidation",
];

export const MAX_REVIEW_ROUNDS = 8;
export const GATE_MARKER = "<!-- pr-auto-merge-gate -->";
export const REVIEW_ROUND_PREFIX = "<!-- pr-review-round:";
export const REVIEW_REQUEST_PREFIX = "<!-- pr-review-request:";

const CODERABBIT = "coderabbitai";
const CODEX = "chatgpt-codex-connector";
const GREEN = new Set(["success", "skipped", "neutral"]);
const RED = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "startup_failure"]);

const login = (author) => String(author || "").replace(/\[bot\]$/, "");
const shortSha = (sha) => String(sha || "").slice(0, 7);

export const parseCodexState = (body) => {
  const match = String(body || "").match(/<!-- codex-review-state:v1 (\{.*?\}) -->/);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]).code_review;
    if (!state || typeof state !== "object" || typeof state.has_unresolved_findings !== "boolean") return null;
    return {
      commitSha: state.commit_sha || "",
      status: state.status || "",
      hasUnresolvedFindings: state.has_unresolved_findings,
      hasAnyFindings: state.has_any_findings === true,
    };
  } catch {
    return null;
  }
};

export const countReviewRounds = (bodies) => bodies.filter((body) => String(body).includes(REVIEW_ROUND_PREFIX)).length;

const worse = (left, right) => {
  const rank = (check) => {
    if (!check || check.status !== "completed") return 1;
    if (RED.has(check.conclusion)) return 2;
    if (GREEN.has(check.conclusion)) return 0;
    return 1;
  };
  return rank(right) > rank(left) ? right : left;
};

// Each source keeps only its newest record per name: GitHub ids grow with every check run and status, so a
// queued rerun outranks an older success and a newer success outranks an older pending status. When both
// a check run and a commit status carry the same name, the worse of the two counts.
const newer = (left, right) => {
  if (Number.isFinite(left.order) && Number.isFinite(right.order)) return right.order > left.order ? right : left;
  return right.completedAt > left.completedAt ? right : left;
};

export const latestChecks = (checks) => {
  const bySource = new Map();
  for (const check of checks || []) {
    if (!check?.name) continue;
    const current = {
      name: check.name,
      source: check.source || "",
      app: check.app || "",
      workflowId: check.workflowId || "",
      checkSuiteId: check.checkSuiteId || "",
      order: Number(check.order),
      status: check.status || "completed",
      conclusion: check.conclusion || "",
      completedAt: check.completedAt || check.startedAt || "",
    };
    const unidentifiedActionsSuite = current.app === "github-actions" && !current.workflowId ? current.checkSuiteId : "";
    const key = JSON.stringify([current.source, current.app, current.workflowId, unidentifiedActionsSuite, current.name]);
    const previous = bySource.get(key);
    if (!previous) bySource.set(key, current);
    else if (current.completedAt === previous.completedAt && !Number.isFinite(current.order)) bySource.set(key, worse(previous, current));
    else bySource.set(key, newer(previous, current));
  }
  const byName = new Map();
  for (const check of bySource.values()) {
    const previous = byName.get(check.name);
    byName.set(check.name, previous ? worse(previous, check) : check);
  }
  return [...byName.values()];
};

const assessChecks = (checks, testsWorkflowId) => {
  const latest = latestChecks(checks);
  const actionsChecks = new Set((checks || [])
    .filter((check) => check?.source === "check-run" && check.app === "github-actions" &&
      Number.isSafeInteger(testsWorkflowId) && testsWorkflowId > 0 && check.workflowId === testsWorkflowId)
    .map((check) => check.name));
  const red = [];
  const pending = [];
  for (const check of latest) {
    if (check.status !== "completed" || (!GREEN.has(check.conclusion) && !RED.has(check.conclusion))) pending.push(check.name);
    else if (RED.has(check.conclusion)) red.push(check.name);
  }
  const missing = REQUIRED_CHECKS.filter((name) => !actionsChecks.has(name));
  return { red, pending, missing };
};

const reviewOnHead = (reviews, author, headSha) => (reviews || [])
  .filter((review) => review.bot === true && login(review.author) === author && review.commitSha === headSha)
  .sort((left, right) => String(left.submittedAt).localeCompare(String(right.submittedAt)) || left.id - right.id);

// A person's request for changes stands, on any commit, until that person approves or the review is dismissed.
const peopleRequestingChanges = (reviews) => {
  const latest = new Map();
  const ordered = [...(reviews || [])]
    .filter((review) => review.bot !== true && login(review.author))
    .sort((left, right) => String(left.submittedAt).localeCompare(String(right.submittedAt)));
  for (const review of ordered) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(login(review.author), review.state);
  }
  return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED").map(([who]) => who);
};

const coderabbitVerdict = (reviews, headSha) => {
  const latest = reviewOnHead(reviews, CODERABBIT, headSha)
    .filter((review) => ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)).at(-1);
  if (!latest || latest.state === "DISMISSED") return "pending";
  return latest.state === "APPROVED" ? "approve" : "hold";
};

const codexVerdict = (codex, headSha) => {
  if (!codex || codex.commitSha !== headSha || codex.status !== "completed") return "pending";
  return codex.hasUnresolvedFindings === false ? "approve" : "hold";
};

const seerVerdict = (seer) => {
  if (!seer || seer.status !== "completed") return "pending";
  return seer.conclusion === "success" ? "approve" : "hold";
};

const openFindings = (threads) => (threads || []).filter((thread) => thread && thread.isResolved !== true);

const findingLine = (threads) => {
  const labels = threads.map((thread) => {
    const who = login(thread.author) || "a reviewer";
    return thread.path ? `${who} on ${thread.path}` : who;
  });
  return `Open review findings remain (${labels.join("; ")}).`;
};

export const decide = (input) => {
  const reasons = [];
  const lines = [];
  const add = (reason, line) => {
    if (!reasons.includes(reason)) reasons.push(reason);
    if (line && !lines.includes(line)) lines.push(line);
  };

  const idle = (reasons, lines) => ({ action: "wait", wake: false, requestReviews: false, reviewers: [], reviewRound: false, reasons, lines });
  if (input.draft) return idle(["draft"], ["This pull request is still a draft."]);
  if (input.sameRepository === false) return idle(["fork"], ["Fork pull requests are outside this workflow."]);
  if (input.baseRef !== "main") return idle(["base"], [`The base branch is ${input.baseRef}. This workflow only merges into main.`]);

  const checks = assessChecks(input.checks, input.testsWorkflowId);
  const rabbit = coderabbitVerdict(input.reviews, input.headSha);
  const codexEdited = Boolean(input.codexEditor) && login(input.codexEditor) !== CODEX;
  const codex = codexEdited ? "pending" : codexVerdict(input.codex, input.headSha);
  const seer = seerVerdict(input.seer);
  const verdicts = { coderabbit: rabbit, codex, seer };
  const findings = openFindings(input.threads);
  const changesRequestedBy = peopleRequestingChanges(input.reviews);
  const git = input.mergeableState || "unknown";
  const reviewRounds = Number(input.reviewRounds) || 0;
  const reviewTimedOut = Object.entries(verdicts).some(([reviewer, verdict]) =>
    verdict !== "approve" && input.reviewWaitExpired?.[reviewer] === true);
  const sha = shortSha(input.headSha);

  if (checks.missing.length) add("checks-missing", `Required checks have not reported on ${sha}: ${checks.missing.join(", ")}.`);
  if (checks.pending.length) add("checks-pending", `Checks are still running on ${sha}: ${checks.pending.join(", ")}.`);
  if (checks.red.length) add("checks-red", `Checks failed or were cancelled on ${sha}: ${checks.red.join(", ")}.`);
  if (git === "behind" || input.baseIsAncestor !== true) add("behind", "The branch has not been proven to contain current main. Rebase it and resolve the result.");
  if (git === "dirty") add("conflicts", "The branch conflicts with main. Resolve the conflicts.");
  if (git === "unknown" || git === "draft" || !["clean", "behind", "dirty", "blocked", "unstable"].includes(git)) {
    add("merge-state-unknown", "GitHub has not finished computing whether the branch merges.");
  }
  if (findings.length) add("open-findings", findingLine(findings));
  if (changesRequestedBy.length) add("changes-requested", `${changesRequestedBy.join(", ")} requested changes. That stands until they approve or the review is dismissed.`);
  if (rabbit === "pending") add("coderabbit-pending", `CodeRabbit has not approved ${sha}.`);
  if (rabbit === "hold") add("coderabbit-hold", `CodeRabbit has not approved ${sha}.`);
  if (codexEdited) add("codex-edited", `Codex's review comment was last edited by ${input.codexEditor}, so it doesn't count as Codex's review.`);
  if (codex === "pending") add("codex-pending", `Codex has not completed a review of ${sha} with no unresolved findings.`);
  if (codex === "hold") add("codex-hold", `Codex still has unresolved findings on ${sha}.`);
  if (seer === "pending") add("seer-pending", `Sentry Seer has not completed a review of ${sha}.`);
  if (seer === "hold") add("seer-hold", `Sentry Seer has not returned a clean review of ${sha}.`);
  if (reviewTimedOut) add("review-timeout", "A requested review has not completed after 24 hours. Check the review integration before continuing.");

  const checksGreen = checks.red.length === 0 && checks.pending.length === 0 && checks.missing.length === 0;
  const disagree = new Set(Object.values(verdicts).filter((verdict) => verdict !== "pending")).size > 1;
  const allApprove = Object.values(verdicts).every((verdict) => verdict === "approve");
  const clean = git === "clean" && input.baseIsAncestor === true;
  const canMerge = checksGreen && clean && allApprove && findings.length === 0 && changesRequestedBy.length === 0;
  const reviewWork = findings.length > 0 || changesRequestedBy.length > 0 || Object.values(verdicts).includes("hold");
  const reviewCapped = reviewWork && reviewRounds >= MAX_REVIEW_ROUNDS;

  if (disagree && !reviewCapped) {
    add("models-disagree", "CodeRabbit, Codex and Sentry Seer do not all approve this head. The owning agent addresses the findings and requests a fresh review from eligible reviewers without approval on that head.");
  }
  if (reviewCapped) {
    add("review-cap", `Review work remains after ${MAX_REVIEW_ROUNDS} review rounds. The pull request stays open for the owner.`);
  }
  if (git === "blocked" && input.baseIsAncestor === true && checksGreen && allApprove && findings.length === 0 && changesRequestedBy.length === 0) {
    add("github-blocked", "The pull request meets the repo bar, and GitHub is still blocking the merge. Branch protection or a ruleset is the likely hold. This workflow does not change those settings.");
  }
  if (git === "unstable" && checksGreen && allApprove && findings.length === 0) {
    add("merge-state-unstable", "GitHub still reports the merge state as unstable. The workflow will look again when that clears.");
  }

  const repairWork = checks.red.length > 0 || git === "behind" || git === "dirty" || input.baseIsAncestor !== true;
  const needsReviewAgent = reviewWork && !reviewCapped;

  const hold = reasons.some((reason) => reason === "github-blocked" || reason === "review-cap" || reason === "review-timeout");
  let action = "wait";
  if (canMerge) action = "merge";
  else if (hold) action = "flag";
  // `wake` means the owning agent has work. The owning T3 thread's pull request watch delivers it; the workflow calls no agent.
  const wake = action !== "merge" && (repairWork || needsReviewAgent);
  const reviewers = reviewCapped ? [] : Object.entries(verdicts)
    .filter(([reviewer, verdict]) => verdict !== "approve" && input.reviewWaitExpired?.[reviewer] !== true &&
      (verdict === "pending" || (findings.length === 0 && changesRequestedBy.length === 0)))
    .map(([reviewer]) => reviewer);
  const requestReviews = reviewers.length > 0;
  if (action === "merge") lines.unshift(`Every check on ${sha} is green, the branch is up to date, and CodeRabbit, Codex and Sentry Seer all approve with no open findings.`);
  return { action, wake, requestReviews, reviewers, reviewRound: needsReviewAgent && wake, reasons, lines };
};

export const gateComment = ({ decision, headSha }) => {
  const head = [
    GATE_MARKER,
    `<!-- pr-auto-merge-head:${headSha} -->`,
    `<!-- pr-auto-merge-action:${decision.action} -->`,
    `<!-- pr-auto-merge-reasons:${decision.reasons.join(",")} -->`,
  ];
  const prose = [...decision.lines];
  if (decision.action === "merge") {
    prose.push(decision.merged
      ? "Squash-merged into main. Production verification is still pending. The owning agent checks the Vercel deployment and production smoke result, and handles any failure or rollback before finishing."
      : "Squash-merging into main. The owning agent then verifies the production deployment and smoke result before finishing.");
  } else if (decision.action === "flag") {
    prose.push(decision.wake
      ? "Not merged. @serviroo this one needs you. The owning agent still clears failing checks and open findings."
      : "Not merged. @serviroo this one needs you.");
  } else {
    prose.push("Not merged. The owning agent keeps this branch until every check is green, the branch is up to date, and CodeRabbit, Codex and Sentry Seer all approve with no open findings. Ownership continues through production verification after merge.");
  }
  return `${head.join("\n")}\n\n${prose.join("\n\n")}\n`;
};
