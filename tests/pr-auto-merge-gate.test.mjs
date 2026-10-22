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
const approved = (author) => ({ author, bot: true, state: "APPROVED", commitSha: head, submittedAt: "2026-10-22T00:00:00Z" });
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

test("an open Seer thread blocks a merge that both models approved", () => {
  const decision = decide(safe({
    threads: [{ author: "sentry", path: "src/components/Footer.jsx", isResolved: false, isOutdated: false }],
  }));
  assert.equal(decision.action, "wait");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("open-findings"));
  assert.equal(decision.reasons.includes("risky-money"), false);
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

test("money, secret, migration, workflow, and production-rollback diffs are held", () => {
  const held = (filename, patch = "+ok\n") => decide(safe({ files: [{ filename, patch }] }));
  assert.equal(held("src/components/Payment.jsx").action, "flag");
  assert.ok(held("app/api/razorpay/[action]/route.js").reasons.includes("risky-money"));
  assert.ok(held("middleware.js").reasons.includes("risky-money"));
  assert.ok(held(".env.production").reasons.includes("risky-secret"));
  assert.ok(held("src/lib/notes.js", "+-----BEGIN OPENSSH PRIVATE KEY-----\n").reasons.includes("risky-secret"));
  assert.ok(held("supabase/migrations/20261022000000_drop_bookings.sql", "+DROP TABLE bookings;\n").reasons.includes("risky-migration"));
  assert.ok(held("scripts/cleanup.sql", "+TRUNCATE TABLE bookings;\n").reasons.includes("risky-sql"));
  assert.ok(held("scripts/cleanup.sql", "+TRUNCATE bookings;\n").reasons.includes("risky-sql"));
  assert.ok(held("scripts/cleanup.sql", "+DELETE FROM bookings;\n").reasons.includes("risky-sql"));
  for (const statement of ["DROP SEQUENCE commerce.booking_ids;", "drop extension pgcrypto;", "DROP MATERIALIZED VIEW stats;", "alter table bookings drop constraint bookings_pkey;", "DROP OWNED BY app_user;"]) {
    assert.ok(held("scripts/cleanup.sql", `+${statement}\n`).reasons.includes("risky-sql"), statement);
  }
  assert.equal(held("src/components/Menu.jsx", "+// drop down the menu when the user clicks\n").reasons.includes("risky-sql"), false);
  assert.ok(held("scripts/archive-old-bookings.mjs", "+await sql`drop table commerce.bookings`;\n").reasons.includes("risky-sql"));
  assert.ok(held("src/server/cleanup.js", "+await sql`delete from commerce.bookings where true`;\n").reasons.includes("risky-sql"));
  assert.equal(held("tests/booking-emails.mjs", "+await sql`delete from commerce.bookings`;\n").reasons.includes("risky-sql"), false);
  assert.equal(held("src/lib/format.js", "+export const short = (text) => truncate(text, 20);\n").action, "merge");
  assert.ok(held("scripts/archive-old-bookings.mjs", "@@ -10,3 +10,3 @@\n   await sql`\n     DELETE FROM commerce.bookings\n-    WHERE created_at < now() - interval '2 years'\n+    WHERE true\n   `;\n").reasons.includes("risky-sql"));
  assert.equal(held("scripts/archive-old-bookings.mjs", "@@ -1,2 +1,2 @@\n-await sql`DELETE FROM commerce.bookings`;\n+console.log(\"kept\");\n").reasons.includes("risky-sql"), false);
  const unreadable = decide(safe({ files: [{ filename: "src/lib/big.js", patch: "", patchMissing: true }] }));
  assert.equal(unreadable.action, "flag");
  assert.ok(unreadable.reasons.includes("risky-unreadable-diff"));
  assert.equal(decide(safe({ files: null })).action, "wait");
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

test("a money-path disagreement stays with the owner and still dispatches the agent", () => {
  const decision = decide(safe({
    files: [{ filename: "src/components/Payment.jsx", patch: "+export const price = 1;\n" }],
    reviews: [
      approved("coderabbitai"),
      { author: "coderabbitai", bot: true, state: "CHANGES_REQUESTED", commitSha: head, submittedAt: "2026-10-22T02:00:00Z" },
    ],
  }));
  assert.equal(decision.action, "flag");
  assert.equal(decision.wake, true);
  assert.ok(decision.reasons.includes("risky-money"));
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
    decision: decide(safe({ files: [{ filename: "vercel.json", patch: "+{}\n" }] })),
    headSha: head,
  });
  assert.match(held, /@serviroo/);
  assert.match(held, /needs you/);
});

test("a rename out of a money, secret, or migration path is held by its old path", () => {
  const renamed = (previousFilename) => decide(safe({ files: [{ filename: "src/lib/pricing2.js", previousFilename, patch: "+export const price = 1;\n" }] }));
  assert.ok(renamed("app/api/payment/route.js").reasons.includes("risky-money"));
  assert.ok(renamed(".env.production").reasons.includes("risky-secret"));
  assert.ok(renamed("supabase/migrations/20260101_x.sql").reasons.includes("risky-migration"));
  assert.equal(renamed("src/lib/other.js").action, "merge");
});

test("scripts that delete or drop production data are held", () => {
  for (const filename of ["scripts/delete-production-data.mjs", "scripts/purge-bookings.mjs", "scripts/repair-supabase-commerce-integrity.mjs"]) {
    const decision = decide(safe({ files: [{ filename, patch: "+console.log(1);\n" }] }));
    assert.equal(decision.action, "flag", filename);
    assert.ok(decision.reasons.includes("risky-production-script"), filename);
  }
});

test("only the real review bots count: a human named like one approves nothing", () => {
  const human = { ...approved("coderabbitai"), bot: false };
  assert.equal(decide(safe({ reviews: [human] })).action, "wait");
});

test("the merge is bound to the head that was reviewed, and runs serialize", () => {
  const apply = readFileSync(new URL("../scripts/pr-auto-merge-apply.mjs", import.meta.url), "utf8");
  assert.match(apply, /merge_method: "squash", sha/);
  assert.match(apply, /mergePullRequest\(number, snapshot\.headSha\)/);
  assert.match(apply, /botNamed\(comment\.user, "github-actions"\)/);
  assert.match(apply, /paginate\(`repos\/\$\{repo\}\/commits\/\$\{pull\.head\.sha\}\/statuses`\)/);
  assert.match(apply, /files\.length === pull\.changed_files/);
  const workflow = readFileSync(new URL("../.github/workflows/auto-merge.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: auto-merge\n/);
  assert.match(workflow, /cancel-in-progress: false/);
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
  assert.doesNotMatch(agents, /disagree on the current head/);
});
