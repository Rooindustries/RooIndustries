import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_CHECKS,
  decide,
  gateComment,
  latestChecks,
  parseCodexState,
} from "../scripts/pr-auto-merge-gate.mjs";

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const checks = () => REQUIRED_CHECKS.map((name) => ({ name, source: "check-run", app: "github-actions", status: "completed", conclusion: "success", completedAt: "2026-10-22T00:00:00Z" }));
const approved = (author) => ({ author, bot: true, state: "APPROVED", commitSha: head, submittedAt: "2026-10-22T00:00:00Z" });
const safe = (overrides = {}) => ({
  draft: false,
  sameRepository: true,
  baseRef: "main",
  headSha: head,
  mergeableState: "clean",
  checks: checks(),
  reviews: [approved("coderabbitai")],
  threads: [],
  codex: { commitSha: head, status: "completed", hasUnresolvedFindings: false, hasAnyFindings: false },
  ...overrides,
});

test("a green, agreed pull request merges", () => {
  const decision = decide(safe());
  assert.equal(decision.action, "merge");
  assert.equal(decision.wake, false);
  assert.equal(decision.reasons.length, 0);
});

test("failed and cancelled checks wait and wake the owning agent", () => {
  const decision = decide(safe({
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check.name === "Playwright rest-2" ? { ...check, conclusion: "cancelled" } : check),
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("checks-red"));
  assert.match(decision.lines.join("\n"), /Jest/);
  assert.match(decision.lines.join("\n"), /Playwright rest-2/);
});

test("missing checks wait without waking before CI has reported", () => {
  const decision = decide(safe({ checks: [] }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, false);
  assert.ok(decision.reasons.includes("checks-missing"));
});

test("required Tests jobs: green commit statuses cannot replace GitHub Actions check runs", () => {
  const decision = decide(safe({
    checks: REQUIRED_CHECKS.map((name) => ({ name, source: "status", status: "completed", conclusion: "success" })),
  }));
  assert.equal(decision.action, "wait");
  assert.deepEqual(decision.reasons, ["checks-missing"]);
  assert.deepEqual(decision.lines, [`Required checks have not reported on ${head.slice(0, 7)}: ${REQUIRED_CHECKS.join(", ")}.`]);
});

test("required Tests jobs: another app's green check runs cannot replace GitHub Actions check runs", () => {
  const decision = decide(safe({
    checks: checks().map((check) => ({ ...check, app: "some-other-app" })),
  }));
  assert.equal(decision.action, "wait");
  assert.deepEqual(decision.reasons, ["checks-missing"]);
  assert.deepEqual(decision.lines, [`Required checks have not reported on ${head.slice(0, 7)}: ${REQUIRED_CHECKS.join(", ")}.`]);
});

test("required Tests jobs: a failing status still blocks a GitHub Actions check run with the same name", () => {
  const decision = decide(safe({
    checks: [...checks(), { name: "Jest", source: "status", status: "completed", conclusion: "failure" }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.deepEqual(decision.reasons, ["checks-red"]);
  assert.deepEqual(decision.lines, [`Checks failed or were cancelled on ${head.slice(0, 7)}: Jest.`]);
});

test("required Tests jobs: another app's newer green check run cannot hide a failed GitHub Actions run", () => {
  const decision = decide(safe({
    checks: [
      ...checks().map((check, index) => ({ ...check, order: 100 + index, conclusion: check.name === "Jest" ? "failure" : "success" })),
      { name: "Jest", source: "check-run", app: "some-other-app", order: 900, status: "completed", conclusion: "success", completedAt: "2026-10-22T01:00:00Z" },
    ],
  }));
  assert.equal(decision.action, "wait");
  assert.deepEqual(decision.reasons, ["checks-red"]);
});

test("a skipped extra check stays green and a later success replaces an older failure", () => {
  const decision = decide(safe({
    checks: [
      ...checks(),
      { name: "Jest", source: "check-run", app: "github-actions", status: "completed", conclusion: "failure", completedAt: "2026-10-21T00:00:00Z" },
      { name: "Seer Code Review", status: "completed", conclusion: "skipped", completedAt: "2026-10-22T00:00:00Z" },
    ],
  }));
  assert.equal(decision.action, "merge");
  const latest = latestChecks([
    { name: "Jest", status: "completed", conclusion: "success", completedAt: "2026-10-21T00:00:00Z" },
    { name: "Jest", status: "completed", conclusion: "failure", completedAt: "2026-10-22T00:00:00Z" },
  ]);
  assert.equal(latest[0].conclusion, "failure");
});

test("CodeRabbit approval of an older commit does not approve the head", () => {
  const decision = decide(safe({
    reviews: [{ author: "coderabbitai[bot]", state: "APPROVED", commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", submittedAt: "2026-10-22T00:00:00Z" }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, false);
  assert.equal(decision.requestReviews, true);
  assert.ok(decision.reasons.includes("coderabbit-pending"));
});

test("a later CodeRabbit request for changes overrides an approval", () => {
  const decision = decide(safe({
    reviews: [
      approved("coderabbitai"),
      { author: "coderabbitai", bot: true, state: "CHANGES_REQUESTED", commitSha: head, submittedAt: "2026-10-22T01:00:00Z" },
    ],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.equal(decision.requestReviews, false);
  assert.equal(decision.reviewRound, true);
  assert.ok(decision.reasons.includes("models-disagree"));
});

test("Codex approves from its review-state comment, and unresolved findings disagree", () => {
  const clean = parseCodexState('<!-- codex-review-state:v1 {"code_review":{"commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->');
  assert.equal(clean.hasUnresolvedFindings, false);
  assert.equal(decide(safe({ codex: clean })).action, "merge");
  const open = { ...clean, hasUnresolvedFindings: true, hasAnyFindings: true };
  const decision = decide(safe({ codex: open }));
  assert.equal(decision.action, "wait");
  assert.ok(decision.reasons.includes("models-disagree"));
  assert.equal(decision.wake, true);
  assert.equal(decision.reviewRound, true);
});

test("a Codex review-state comment edited by someone else does not approve the head", () => {
  const decision = decide(safe({ codexEditor: "someone" }));
  assert.equal(decision.action, "wait");
  assert.ok(decision.reasons.includes("codex-edited"));
  assert.ok(decision.reasons.includes("codex-pending"));
  assert.ok(decision.lines.includes("Codex's review comment was last edited by someone, so it doesn't count as Codex's review."));
  assert.equal(decision.requestReviews, true);
  for (const codexEditor of ["chatgpt-codex-connector[bot]", "chatgpt-codex-connector", ""]) {
    assert.equal(decide(safe({ codexEditor })).action, "merge");
  }
});

test("an open Seer thread blocks a merge that both models approved", () => {
  const decision = decide(safe({
    threads: [{ author: "sentry", path: "src/components/Footer.jsx", isResolved: false, isOutdated: false }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("open-findings"));
});

test("an outdated thread still blocks until someone resolves it", () => {
  const decision = decide(safe({
    threads: [{ author: "chatgpt-codex-connector", path: "README.md", isResolved: false, isOutdated: true }],
  }));
  assert.equal(decision.action, "wait");
  assert.ok(decision.reasons.includes("open-findings"));
  const resolved = decide(safe({
    threads: [{ author: "chatgpt-codex-connector", path: "README.md", isResolved: true, isOutdated: true }],
  }));
  assert.equal(resolved.action, "merge");
});

test("a red money-path pull request waits for its owning agent, never for the owner", () => {
  const decision = decide(safe({
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check),
    codex: { commitSha: head, status: "completed", hasUnresolvedFindings: true, hasAnyFindings: true },
    threads: [{ author: "sentry", path: "src/lib/checkoutStorage.js", isResolved: false, isOutdated: false }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("checks-red"));
  assert.equal(decision.reasons.some((reason) => reason.startsWith("risky-")), false);
});
test("behind and conflicting branches wait for a rebase", () => {
  assert.equal(decide(safe({ mergeableState: "behind" })).wake, true);
  assert.equal(decide(safe({ mergeableState: "behind" })).action, "wait");
  assert.equal(decide(safe({ mergeableState: "dirty" })).action, "wait");
  assert.ok(decide(safe({ mergeableState: "dirty" })).reasons.includes("conflicts"));
});

test("GitHub blocking an otherwise ready pull request is flagged for the owner", () => {
  const decision = decide(safe({ mergeableState: "blocked" }));
  assert.equal(decision.action, "flag");
  assert.equal(decision.wake, false);
  assert.ok(decision.reasons.includes("github-blocked"));
});

test("drafts, forks, and non-main bases never merge or wake", () => {
  for (const input of [
    safe({ draft: true }),
    safe({ sameRepository: false }),
    safe({ baseRef: "develop" }),
  ]) {
    const decision = decide(input);
    assert.equal(decision.action, "wait");
    assert.equal(decision.wake, false);
  }
});

test("disagreement keeps looping and flags the owner only after eight review rounds", () => {
  const open = {
    reviews: [
      approved("coderabbitai"),
      { author: "coderabbitai", bot: true, state: "CHANGES_REQUESTED", commitSha: head, submittedAt: "2026-10-22T02:00:00Z" },
    ],
  };
  const looping = decide(safe({ ...open, reviewRounds: 7 }));
  assert.equal(looping.action, "wait");
  assert.equal(looping.wake, true);
  const capped = decide(safe({ ...open, reviewRounds: 8 }));
  assert.equal(capped.action, "flag");
  assert.equal(capped.wake, false);
  assert.equal(capped.requestReviews, false);
  assert.ok(capped.reasons.includes("review-cap"));
  const agreed = decide(safe({ reviewRounds: 8 }));
  assert.equal(agreed.action, "merge");
  const pending = decide(safe({ reviews: [], codex: null, reviewRounds: 1 }));
  assert.equal(pending.action, "wait");
  assert.equal(pending.wake, false);
  assert.equal(pending.requestReviews, true);
});

test("the workflow calls no agent API and the owning agent's watch does the waking", () => {
  const apply = readFileSync(new URL("../scripts/pr-auto-merge-apply.mjs", import.meta.url), "utf8");
  const workflow = readFileSync(new URL("../.github/workflows/auto-merge.yml", import.meta.url), "utf8");
  assert.doesNotMatch(apply, /api\.cursor\.com|CURSOR_API_KEY/);
  assert.doesNotMatch(workflow, /CURSOR_API_KEY/);
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(agents, /pull request watch/);
  assert.doesNotMatch(agents, /CURSOR_API_KEY/);
});

test("the gate comment names the owner only on a hold", () => {
  const decision = decide(safe({
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check),
  }));
  const body = gateComment({ decision, headSha: head });
  assert.match(body, /<!-- pr-auto-merge-gate -->/);
  assert.doesNotMatch(body, /@serviroo/);
  const held = gateComment({
    decision: decide(safe({ mergeableState: "blocked" })),
    headSha: head,
  });
  assert.match(held, /@serviroo/);
  assert.match(held, /needs you/);
});

test("a person's request for changes blocks the merge until they approve or it is dismissed", () => {
  const person = (state, submittedAt, commitSha = head) => ({ author: "serviroo", bot: false, state, commitSha, submittedAt });
  const blocked = decide(safe({ reviews: [approved("coderabbitai"), person("CHANGES_REQUESTED", "2026-10-22T01:00:00Z", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")] }));
  assert.equal(blocked.action, "wait");
  assert.ok(blocked.reasons.includes("changes-requested"));
  assert.match(blocked.lines.join("\n"), /serviroo requested changes/);
  assert.equal(decide(safe({ reviews: [approved("coderabbitai"), person("CHANGES_REQUESTED", "2026-10-22T01:00:00Z"), person("COMMENTED", "2026-10-22T02:00:00Z")] })).action, "wait");
  assert.equal(decide(safe({ reviews: [approved("coderabbitai"), person("CHANGES_REQUESTED", "2026-10-22T01:00:00Z"), person("APPROVED", "2026-10-22T02:00:00Z")] })).action, "merge");
  assert.equal(decide(safe({ reviews: [approved("coderabbitai"), person("CHANGES_REQUESTED", "2026-10-22T01:00:00Z"), person("DISMISSED", "2026-10-22T02:00:00Z")] })).action, "merge");
});

test("only the real review bots count: a human named like one approves nothing", () => {
  const human = { ...approved("coderabbitai"), bot: false };
  assert.equal(decide(safe({ reviews: [human] })).action, "wait");
});

test("the merge is bound to the head that was reviewed, and runs serialize", () => {
  const apply = readFileSync(new URL("../scripts/pr-auto-merge-apply.mjs", import.meta.url), "utf8");
  assert.match(apply, /editor \{ login \}/);
  assert.match(apply, /merge_method: "squash", sha/);
  assert.match(apply, /mergePullRequest\(number, snapshot\.headSha\)/);
  assert.match(apply, /botNamed\(comment\.user, "github-actions"\)/);
  assert.match(apply, /paginate\(`repos\/\$\{repo\}\/commits\/\$\{pull\.head\.sha\}\/statuses`\)/);
  assert.match(apply, /decide\(latest\)\.action !== "merge"/);
  assert.match(apply, /latest\.baseRef !== "main"/);
  assert.match(apply, /order: run\.id/);
  assert.match(apply, /order: entry\.id/);
  const workflow = readFileSync(new URL("../.github/workflows/auto-merge.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: auto-merge\n/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("the newest record per check decides: a queued rerun is pending, a newer success clears an older pending status", () => {
  const rerun = [
    ...checks().map((check, index) => ({ ...check, source: "check-run", order: 100 + index })),
    { name: "Jest", source: "check-run", app: "github-actions", order: 500, status: "queued", conclusion: null, completedAt: "" },
  ];
  assert.ok(decide(safe({ checks: rerun })).reasons.includes("checks-pending"));
  const statusHistory = [
    ...checks().map((check, index) => ({ ...check, source: "check-run", order: 100 + index })),
    { name: "Vercel", source: "status", order: 900, status: "completed", conclusion: "success", completedAt: "2026-10-22T00:05:00Z" },
    { name: "Vercel", source: "status", order: 800, status: "pending", conclusion: "pending", completedAt: "2026-10-22T00:01:00Z" },
  ];
  assert.equal(decide(safe({ checks: statusHistory })).action, "merge");
  const split = [
    ...checks().map((check, index) => ({ ...check, source: "check-run", order: 100 + index })),
    { name: "Jest", source: "status", order: 50, status: "completed", conclusion: "failure", completedAt: "2026-10-22T00:00:00Z" },
  ];
  assert.ok(decide(safe({ checks: split })).reasons.includes("checks-red"));
});

test("the required check names are the jobs the Tests workflow runs", () => {
  const yaml = readFileSync(new URL("../.github/workflows/tests.yml", import.meta.url), "utf8");
  for (const name of ["Jest", "navigation", "booking", "rest-1", "rest-2", "rest-3", "rest-4", "Playwright creator portal and API routes", "Native PostgreSQL 17 suites", "Playwright revalidation"]) {
    assert.ok(yaml.includes(name), name);
  }
  const workflow = readFileSync(new URL("../.github/workflows/auto-merge.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /workflows: \["Tests"\]/);
  assert.doesNotMatch(workflow, /pull_request:\s*$/m);
  const apply = readFileSync(new URL("../scripts/pr-auto-merge-apply.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(apply, /child_process|execSync|execFile/);
  assert.match(apply, /merge_method: "squash"/);
  assert.match(apply, /@coderabbitai review/);
  assert.match(apply, /@codex review/);
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(agents, /Grok Bot assistant does not merge/);
  assert.match(agents, /CodeRabbit and Codex both approve/);
  assert.match(agents, /After 8 review rounds/);
  assert.doesNotMatch(agents, /Stop and flag the owner instead of merging/);
  const gate = readFileSync(new URL("../scripts/pr-auto-merge-gate.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(gate, /risky-/);
  assert.doesNotMatch(agents, /disagree on the current head/);
});
