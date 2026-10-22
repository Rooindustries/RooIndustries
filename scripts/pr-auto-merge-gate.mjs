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

const MONEY_PREFIXES = [
  "app/api/payment/",
  "app/api/holdSlot/",
  "app/api/releaseHold/",
  "app/api/ref/",
  "app/api/razorpay/",
  "app/api/admin/referral-creators/",
  "src/server/api/payment/",
  "src/server/booking/",
  "src/server/api/ref/",
  "src/server/referrals/",
  "src/server/commerce/",
  "src/server/supabase/",
  "src/server/cms/",
  "app/api/admin/content/",
  "supabase/migrations/",
];

const MONEY_FILES = new Set([
  "src/server/data/documentClient.js",
  "src/lib/cms/contentSchema.js",
  "src/lib/cms/contentPreservation.js",
  "src/lib/packagePricing.js",
  "src/lib/checkoutStorage.js",
  "src/lib/checkoutCodes.js",
  "src/lib/salesAttribution.ts",
  "src/lib/useUpgradeEligibility.js",
  "src/components/admin/ReferralCreatorEditor.jsx",
  "src/components/admin/referralDraftStore.js",
  "src/next/AppClientRuntime.jsx",
  "middleware.js",
  "vercel.json",
]);

const MONEY_COMPONENTS = new Set([
  "BookingForm.jsx",
  "BookingModal.jsx",
  "Packages.jsx",
  "Payment.jsx",
  "PaymentSuccess.jsx",
  "ReservationBanner.jsx",
  "UpgradeLink.jsx",
  "UpgradeXoc.jsx",
  "RefDashboard.jsx",
]);

const GATE_FILES = new Set([
  ".github/workflows/auto-merge.yml",
  "scripts/pr-auto-merge-gate.mjs",
  "scripts/pr-auto-merge-apply.mjs",
]);

const login = (author) => String(author || "").replace(/\[bot\]$/, "");
const shortSha = (sha) => String(sha || "").slice(0, 7);
const unique = (values) => [...new Set(values)];

// A shipped file whose path names a money concept is a money path even when no list names it yet.
const MONEY_WORDS = new Set([
  "booking", "checkout", "commission", "coupon", "discount", "dodo", "hold", "invoice", "order", "pay", "payment",
  "payout", "price", "pricing", "quote", "razorpay", "referral", "refund", "reservation", "slot", "stripe", "upgrade",
]);
const pathWords = (filePath) => filePath
  .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/)
  .map((word) => word.toLowerCase().replace(/s$/, ""))
  .filter(Boolean);
const isTestOrDoc = (filePath) => /\.(?:md|mdx|txt)$/i.test(filePath) || /(?:^|\/)(?:tests?|__tests__)\//.test(filePath) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);

export const isMoneyPath = (filePath) => {
  if (MONEY_FILES.has(filePath) || MONEY_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  const base = filePath.split("/").pop();
  if (filePath.startsWith("src/components/") && MONEY_COMPONENTS.has(base)) return true;
  return !isTestOrDoc(filePath) && pathWords(filePath).some((word) => MONEY_WORDS.has(word));
};

export const isSecretPath = (filePath) => {
  const base = filePath.split("/").pop();
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (/\.(pem|p12|pfx)$/i.test(base) || /\.key$/i.test(base)) return true;
  return /(^|[._/-])(secrets?|credentials|service-account)([._/-]|$)/i.test(filePath);
};

export const isProductionMutator = (filePath) => /scripts\/.*(?:deploy|rollback|delete|drop|purge|wipe|truncate|destroy|repair|migrate)/i.test(filePath);

// DROP covers every object kind PostgreSQL can drop (and ALTER ... DROP COLUMN/CONSTRAINT).
const DESTRUCTIVE_SQL = /\b(?:DROP\s+(?:ACCESS\s+METHOD|AGGREGATE|CAST|COLLATION|COLUMN|CONSTRAINT|CONVERSION|DATABASE|DOMAIN|EVENT\s+TRIGGER|EXTENSION|FOREIGN\s+(?:DATA\s+WRAPPER|TABLE)|FUNCTION|GROUP|INDEX|LANGUAGE|MATERIALIZED\s+VIEW|OPERATOR|OWNED|POLICY|PROCEDURE|PUBLICATION|ROLE|ROUTINE|RULE|SCHEMA|SEQUENCE|SERVER|STATISTICS|SUBSCRIPTION|TABLE|TABLESPACE|TEXT\s+SEARCH|TRANSFORM|TRIGGER|TYPE|USER|VIEW)\b|TRUNCATE\s+(?:TABLE\s+|ONLY\s+)?["\w.]+|DELETE\s+FROM\s+["\w.]+)/i;
// Test suites only talk to local fixtures and docs never run, so their SQL does not hold a pull request.
const runsSql = (filePath) => !isTestOrDoc(filePath);

// Added and unchanged context lines: an edit under an existing DELETE still shows the DELETE.
const hunkText = (patch) => String(patch || "").split("\n").filter((line) => !/^(?:-|@@|\\)/.test(line)).join("\n");
const addedLines = (patch) => String(patch || "").split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).join("\n");

export const parseCodexState = (body) => {
  const match = String(body || "").match(/<!-- codex-review-state:v1 (\{.*?\}) -->/);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]).code_review;
    if (!state || typeof state !== "object") return null;
    return {
      commitSha: state.commit_sha || "",
      status: state.status || "",
      hasUnresolvedFindings: state.has_unresolved_findings === true,
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

export const latestChecks = (checks) => {
  const byName = new Map();
  for (const check of checks || []) {
    if (!check?.name) continue;
    const current = {
      name: check.name,
      status: check.status || "completed",
      conclusion: check.conclusion || "",
      completedAt: check.completedAt || check.startedAt || "",
    };
    const previous = byName.get(check.name);
    // A queued or running attempt has no finish time; it outranks any earlier finished attempt.
    if (previous && previous.status !== "completed") continue;
    if (!previous || current.status !== "completed" || current.completedAt > previous.completedAt) byName.set(check.name, current);
    else if (current.completedAt === previous.completedAt) byName.set(check.name, { ...worse(previous, current), completedAt: current.completedAt });
  }
  return [...byName.values()];
};

const assessChecks = (checks) => {
  const latest = latestChecks(checks);
  const byName = new Map(latest.map((check) => [check.name, check]));
  const red = [];
  const pending = [];
  for (const check of latest) {
    if (check.status !== "completed" || (!GREEN.has(check.conclusion) && !RED.has(check.conclusion))) pending.push(check.name);
    else if (RED.has(check.conclusion)) red.push(check.name);
  }
  const missing = REQUIRED_CHECKS.filter((name) => !byName.has(name));
  return { red, pending, missing };
};

const reviewOnHead = (reviews, author, headSha) => (reviews || [])
  .filter((review) => review.bot === true && login(review.author) === author && review.commitSha === headSha)
  .sort((left, right) => String(left.submittedAt).localeCompare(String(right.submittedAt)));

const coderabbitVerdict = (reviews, headSha) => {
  const mine = reviewOnHead(reviews, CODERABBIT, headSha);
  let approved = false;
  let reviewed = false;
  for (const review of mine) {
    if (review.state === "APPROVED") {
      approved = true;
      reviewed = true;
    } else if (review.state === "CHANGES_REQUESTED") {
      approved = false;
      reviewed = true;
    } else if (review.state === "DISMISSED") {
      approved = false;
    }
  }
  if (!reviewed) return "pending";
  return approved ? "approve" : "hold";
};

const codexVerdict = (codex, headSha) => {
  if (!codex || codex.commitSha !== headSha || codex.status !== "completed") return "pending";
  return codex.hasUnresolvedFindings ? "hold" : "approve";
};

const openFindings = (threads) => (threads || []).filter((thread) => thread && thread.isResolved !== true);

const CODE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

const resolveImport = (fromFile, specifier, known) => {
  let base;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parts = fromFile.split("/").slice(0, -1);
    for (const part of specifier.split("/")) {
      if (part === "..") parts.pop();
      else if (part !== ".") parts.push(part);
    }
    base = parts.join("/");
  } else {
    return null;
  }
  const candidates = [base, ...CODE_EXTENSIONS.map((ext) => base + ext), ...CODE_EXTENSIONS.map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => known.has(candidate)) || null;
};

// Files that a money-path file imports directly carry the same risk, e.g. a storage helper behind the booking form.
export const moneyDependencies = (sources) => {
  const known = new Set(sources.keys());
  const found = new Set();
  for (const [filePath, source] of sources) {
    if (!isMoneyPath(filePath)) continue;
    for (const match of String(source).matchAll(IMPORT_PATTERN)) {
      const target = resolveImport(filePath, match[1], known);
      if (target && !isMoneyPath(target)) found.add(target);
    }
  }
  return [...found].sort();
};

const fileRisks = (files, dependencies = new Set()) => {
  const reasons = [];
  for (const file of files) {
    const added = addedLines(file.patch);
    // A rename carries its old path: moving a file out of a risky path must not hide it.
    const paths = [file.filename || file.path || "", file.previousFilename || ""].filter(Boolean);
    if (paths.some((filePath) => isMoneyPath(filePath) || dependencies.has(filePath))) reasons.push("risky-money");
    if (paths.some(isSecretPath) || /BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY/.test(added)) reasons.push("risky-secret");
    if (paths.some((filePath) => filePath.startsWith("supabase/migrations/"))) reasons.push("risky-migration");
    if (paths.some((filePath) => filePath.startsWith(".github/workflows/") || GATE_FILES.has(filePath))) reasons.push("risky-workflow");
    if (paths.some(runsSql) && DESTRUCTIVE_SQL.test(hunkText(file.patch))) reasons.push("risky-sql");
    if (file.patchMissing) reasons.push("risky-unreadable-diff");
    if (paths.some(isProductionMutator)) reasons.push("risky-production-script");
  }
  return unique(reasons);
};

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

  const idle = (reasons, lines) => ({ action: "wait", wake: false, requestReviews: false, reviewRound: false, reasons, lines });
  if (input.draft) return idle(["draft"], ["This pull request is still a draft."]);
  if (input.sameRepository === false) return idle(["fork"], ["Fork pull requests are outside this workflow."]);
  if (input.baseRef !== "main") return idle(["base"], [`The base branch is ${input.baseRef}. This workflow only merges into main.`]);
  if (!Array.isArray(input.files)) return idle(["files-unknown"], ["The changed-file list was unavailable, so this pull request was not merged."]);

  if (!Array.isArray(input.moneyDependencies)) return idle(["money-map-unknown"], ["The list of files the money paths import was unavailable, so this pull request was not merged."]);
  const risks = fileRisks(input.files, new Set(input.moneyDependencies));
  const checks = assessChecks(input.checks);
  const rabbit = coderabbitVerdict(input.reviews, input.headSha);
  const codex = codexVerdict(input.codex, input.headSha);
  const findings = openFindings(input.threads);
  const git = input.mergeableState || "unknown";
  const reviewRounds = Number(input.reviewRounds) || 0;
  const sha = shortSha(input.headSha);

  if (risks.includes("risky-money")) add("risky-money", "The diff touches payments, checkout, bookings, holds, pricing, referral credit, refunds, or payouts. It stays with the owner.");
  if (risks.includes("risky-secret")) add("risky-secret", "The diff touches a secret or a private key. It stays with the owner.");
  if (risks.includes("risky-migration")) add("risky-migration", "The diff edits a database migration. It stays with the owner.");
  if (risks.includes("risky-sql")) add("risky-sql", "The diff includes SQL that drops, truncates, or deletes data. It stays with the owner.");
  if (risks.includes("risky-workflow")) add("risky-workflow", "The diff edits the CI workflows or the merge gate. It stays with the owner.");
  if (risks.includes("risky-unreadable-diff")) add("risky-unreadable-diff", "GitHub did not return the diff for at least one changed file, so the gate cannot check it. It stays with the owner.");
  if (risks.includes("risky-production-script")) add("risky-production-script", "The diff edits a script that deploys, rolls back, or deletes production data. It stays with the owner.");

  if (checks.missing.length) add("checks-missing", `Required checks have not reported on ${sha}: ${checks.missing.join(", ")}.`);
  if (checks.pending.length) add("checks-pending", `Checks are still running on ${sha}: ${checks.pending.join(", ")}.`);
  if (checks.red.length) add("checks-red", `Checks failed or were cancelled on ${sha}: ${checks.red.join(", ")}.`);
  if (git === "behind") add("behind", "The branch is behind main. Rebase it and resolve the result.");
  if (git === "dirty") add("conflicts", "The branch conflicts with main. Resolve the conflicts.");
  if (git === "unknown" || git === "draft" || !["clean", "behind", "dirty", "blocked", "unstable"].includes(git)) {
    add("merge-state-unknown", "GitHub has not finished computing whether the branch merges.");
  }
  if (findings.length) add("open-findings", findingLine(findings));
  if (rabbit === "pending") add("coderabbit-pending", `CodeRabbit has not approved ${sha}.`);
  if (rabbit === "hold") add("coderabbit-hold", `CodeRabbit has not approved ${sha}.`);
  if (codex === "pending") add("codex-pending", `Codex has not completed a review of ${sha} with no unresolved findings.`);
  if (codex === "hold") add("codex-hold", `Codex still has unresolved findings on ${sha}.`);

  const checksGreen = checks.red.length === 0 && checks.pending.length === 0 && checks.missing.length === 0;
  const disagree = rabbit !== "pending" && codex !== "pending" && rabbit !== codex;
  const bothApprove = rabbit === "approve" && codex === "approve";
  const safe = risks.length === 0;
  const clean = git === "clean";
  const canMerge = checksGreen && clean && bothApprove && safe && findings.length === 0;
  const reviewWork = disagree || findings.length > 0 || rabbit === "hold" || codex === "hold";
  const reviewCapped = reviewWork && reviewRounds >= MAX_REVIEW_ROUNDS;

  if (disagree && !reviewCapped) {
    add("models-disagree", "CodeRabbit and Codex do not both approve this head. The owning agent addresses the disagreeing model's findings, pushes, and both reviews are requested again.");
  }
  if (reviewCapped) {
    add("review-cap", `CodeRabbit and Codex have not both approved, with no open threads, after ${MAX_REVIEW_ROUNDS} review rounds. It stays with the owner.`);
  }
  if (git === "blocked" && checksGreen && bothApprove && safe && findings.length === 0) {
    add("github-blocked", "The pull request meets the repo bar, and GitHub is still blocking the merge. Branch protection or a ruleset is the likely hold. This workflow does not change those settings.");
  }
  if (git === "unstable" && checksGreen && bothApprove && safe && findings.length === 0) {
    add("merge-state-unstable", "GitHub still reports the merge state as unstable. The workflow will look again when that clears.");
  }

  const repairWork = checks.red.length > 0 || git === "behind" || git === "dirty";
  const needsReviewAgent = reviewWork && !reviewCapped;

  const hold = reasons.some((reason) => reason.startsWith("risky-") || reason === "github-blocked" || reason === "review-cap");
  let action = "wait";
  if (canMerge) action = "merge";
  else if (hold) action = "flag";
  // `wake` means the owning agent has work. The owning T3 thread's pull request watch delivers it; the workflow calls no agent.
  const wake = action !== "merge" && (repairWork || needsReviewAgent);
  const requestReviews = !reviewCapped && (rabbit === "pending" || codex === "pending");
  if (action === "merge") lines.unshift(`Every check on ${sha} is green, the branch is up to date, the diff is safe, and CodeRabbit and Codex both approve with no open findings.`);
  return { action, wake, requestReviews, reviewRound: needsReviewAgent && wake, reasons, lines };
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
      ? "Squash-merged into main. Vercel deploys production from main."
      : "Squash-merging into main. Vercel deploys production from main.");
  } else if (decision.action === "flag") {
    prose.push(decision.wake
      ? "Not merged. @serviroo this one needs you. The owning agent still clears failing checks and open findings."
      : "Not merged. @serviroo this one needs you.");
  } else {
    prose.push("Not merged. The owning agent keeps this branch until every check is green, the branch is up to date, the diff is safe, and both models approve with no open findings.");
  }
  return `${head.join("\n")}\n\n${prose.join("\n\n")}\n`;
};
