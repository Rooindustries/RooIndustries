import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_CHECKS,
  decide,
  gateComment,
  isMoneyPath,
  isProductionMutator,
  isSecretPath,
  latestChecks,
  parseCodexState,
} from "../scripts/pr-auto-merge-gate.mjs";

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const checks = () => REQUIRED_CHECKS.map((name) => ({ name, status: "completed", conclusion: "success", completedAt: "2026-10-22T00:00:00Z" }));
const approved = (author) => ({ author, state: "APPROVED", commitSha: head, submittedAt: "2026-10-22T00:00:00Z" });
const safe = (overrides = {}) => ({
  draft: false,
  sameRepository: true,
  baseRef: "main",
  headSha: head,
  mergeableState: "clean",
  files: [{ filename: "src/components/Footer.jsx", patch: "+export const footer = true;\n" }],
  checks: checks(),
  reviews: [approved("coderabbitai")],
  threads: [],
  codex: { commitSha: head, status: "completed", hasUnresolvedFindings: false, hasAnyFindings: false },
  repairWakes: 0,
  ...overrides,
});

test("a green, safe, agreed pull request merges", () => {
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

test("a skipped extra check stays green and a later success replaces an older failure", () => {
  const decision = decide(safe({
    checks: [
      ...checks(),
      { name: "Jest", status: "completed", conclusion: "failure", completedAt: "2026-10-21T00:00:00Z" },
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
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("coderabbit-pending"));
});

test("a later CodeRabbit request for changes overrides an approval", () => {
  const decision = decide(safe({
    reviews: [
      approved("coderabbitai"),
      { author: "coderabbitai", state: "CHANGES_REQUESTED", commitSha: head, submittedAt: "2026-10-22T01:00:00Z" },
    ],
  }));
  assert.notEqual(decision.action, "merge");
  assert.ok(decision.reasons.includes("models-disagree"));
  assert.equal(decision.action, "flag");
});

test("Codex approves from its review-state comment, and unresolved findings disagree", () => {
  const clean = parseCodexState('<!-- codex-review-state:v1 {"code_review":{"commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->');
  assert.equal(clean.hasUnresolvedFindings, false);
  assert.equal(decide(safe({ codex: clean })).action, "merge");
  const open = { ...clean, hasUnresolvedFindings: true, hasAnyFindings: true };
  const decision = decide(safe({ codex: open }));
  assert.equal(decision.action, "flag");
  assert.ok(decision.reasons.includes("models-disagree"));
  assert.equal(decision.wake, true);
});

test("an open Seer thread blocks a merge that both models approved", () => {
  const decision = decide(safe({
    threads: [{ author: "sentry", path: "src/components/Footer.jsx", isResolved: false, isOutdated: false }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("open-findings"));
  assert.equal(decision.reasons.includes("risky-money"), false);
});

test("an outdated thread does not block", () => {
  const decision = decide(safe({
    threads: [{ author: "chatgpt-codex-connector", path: "README.md", isResolved: false, isOutdated: true }],
  }));
  assert.equal(decision.action, "merge");
});

test("money, secret, migration, workflow, and production-rollback diffs are held", () => {
  const held = (filename, patch = "+ok\n") => decide(safe({ files: [{ filename, patch }] }));
  assert.equal(held("src/components/Payment.jsx").action, "flag");
  assert.ok(held("app/api/razorpay/[action]/route.js").reasons.includes("risky-money"));
  assert.ok(held("middleware.js").reasons.includes("risky-money"));
  assert.ok(held(".env.production").reasons.includes("risky-secret"));
  assert.ok(held("src/lib/notes.js", "+-----BEGIN OPENSSH PRIVATE KEY-----\n").reasons.includes("risky-secret"));
  assert.ok(held("supabase/migrations/20261022000000_drop_bookings.sql", "+DROP TABLE bookings;\n").reasons.includes("risky-migration"));
  assert.ok(held("scripts/cleanup.sql", "+TRUNCATE TABLE bookings;\n").reasons.includes("risky-sql"));
  assert.ok(held(".github/workflows/tests.yml").reasons.includes("risky-workflow"));
  assert.ok(held("scripts/pr-auto-merge-gate.mjs").reasons.includes("risky-workflow"));
  assert.ok(held("scripts/deploy-rollback.mjs").reasons.includes("risky-production-script"));
  assert.equal(held("src/components/Payment.jsx").wake, false);
  assert.equal(isMoneyPath("src/components/Payment.jsx"), true);
  assert.equal(isMoneyPath("src/components/Footer.jsx"), false);
  assert.equal(isSecretPath("src/lib/checkoutStorage.js"), false);
  assert.equal(isProductionMutator("scripts/deploy-rollback.mjs"), true);
});

test("a money-path pull request with red checks is flagged and still wakes the agent", () => {
  const decision = decide(safe({
    files: [{ filename: "src/lib/checkoutStorage.js", patch: "+export const keep = true;\n" }],
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check),
    codex: { commitSha: head, status: "completed", hasUnresolvedFindings: true, hasAnyFindings: true },
    threads: [{ author: "sentry", path: "src/lib/checkoutStorage.js", isResolved: false, isOutdated: false }],
  }));
  assert.equal(decision.action, "flag");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("risky-money"));
  assert.ok(decision.reasons.includes("checks-red"));
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

test("the repair loop stops with the owner after the wake cap", () => {
  const decision = decide(safe({
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check),
    repairWakes: 8,
  }));
  assert.equal(decision.action, "flag");
  assert.equal(decision.wake, false);
  assert.ok(decision.reasons.includes("repair-cap"));
});

test("the gate comment names the owner once and tells them when the repair secret is missing", () => {
  const decision = decide(safe({
    checks: checks().map((check) => check.name === "Jest" ? { ...check, conclusion: "failure" } : check),
  }));
  const body = gateComment({ decision, headSha: head, keyConfigured: false, wakeError: "" });
  assert.match(body, /<!-- pr-auto-merge-gate -->/);
  assert.match(body, /CURSOR_API_KEY/);
  assert.doesNotMatch(body, /@serviroo/);
  const held = gateComment({
    decision: decide(safe({ files: [{ filename: "vercel.json", patch: "+{}\n" }] })),
    headSha: head,
    keyConfigured: true,
    wakeError: "",
  });
  assert.match(held, /@serviroo/);
  assert.match(held, /needs you/);
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
  assert.match(apply, /workOnCurrentBranch: true/);
  assert.match(apply, /merge_method: "squash"/);
  const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  assert.match(agents, /Grok Bot assistant does not merge/);
  assert.match(agents, /CodeRabbit and Codex both approve/);
  assert.match(agents, /CURSOR_API_KEY/);
});
