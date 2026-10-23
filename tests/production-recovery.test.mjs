import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DOMAIN, TOKEN } from "./fixtures/fake-vercel.mjs";
import { changes, execute, withRecovery, LIVE_URL } from "./fixtures/production-recovery.mjs";
import { startSite } from "./fixtures/fake-site.mjs";

test("round 2: a shared backend outage alerts without rolling back either release", () => withRecovery({
  site: { status: { "/api/bookingAvailability": 503 } },
  previous: { status: { "/api/bookingAvailability": 503 } },
}, async ({ exec, vercel, previous }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.ok(previous.requests.some(request => request.path === "/api/bookingAvailability"));
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("round 2: missing passed-gate history refuses automatic recovery", () => withRecovery({
  site: { status: { "/payment": 500 } }, history: state => { state.history = []; },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.match(result.output, /history/i);
}));

test("round 2: recovery immediately restores the exact newer deployment displaced in the final race", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { swapLiveBeforeMutation: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.deepEqual(changes(vercel).map(request => request.path), [
    "/v1/projects/prj_rooFixture/rollback/dpl_previous", "/v10/projects/prj_rooFixture/promote/dpl_newer",
  ]);
  assert.match(result.output, /restored.*dpl_newer/i);
}));

test("round 2: a confirmed application error still fails while an unrelated async script is unfinished", () => withRecovery({
  site: { hang: ["/pending.js"], bodies: { "/payment": '<h3>Application error</h3><p>A client-side exception has occurred.</p><script async src="/pending.js"></script>' } },
}, async ({ site, env }) => {
  const result = await execute("production-smoke.mjs", ["--base", site.base], env);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+payment page renders.*application error/);
}));

test("round 2: credential-bearing deployment URLs are refused before provider access and never printed", () => withRecovery({}, async ({ exec, vercel, site }) => {
  const result = await exec({ GITHUB_ACTIONS: "true", DEPLOYMENT_URL: "https://fixture-user:fixture-password@rooindustries-live-roo-industries.vercel.app" });
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /fixture-user|fixture-password/);
  assert.equal(vercel.requests.length, 0);
  assert.equal(site.requests.length, 0);
}));

test("differential recovery confirms the same regression twice with a separated healthy previous release", () => withRecovery({
  site: { status: { "/payment": 500 } },
}, async ({ exec, vercel, site, previous }) => {
  const result = await exec({ GATE_CONFIRM_WAIT_MS: "150" });
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.match(result.output, /production was rolled back/);
  const starts = site.requests.filter(request => request.path === "/" && !request.method.includes("POST"));
  const previousQuotes = previous.requests.filter(request => request.path === "/api/payment/quote");
  assert.equal(previousQuotes.length, 2);
  assert.ok(starts.some(request => request.at - previousQuotes[0].at >= 150));
  assert.ok(previousQuotes[1].at > previousQuotes[0].at + 150);
}));

for (const [name, incident] of Object.entries({
  "package rate limit": { status: { "/packages": 429 } },
  "quote rate limit": { quote: { status: 429, body: { ok: false } } },
  "quote backend failure": { quote: { status: 503, body: { ok: false } } },
  "payment provider unavailable": { quote: { body: { ok: false, error: "Fixture Dodo test provider unavailable" } } },
  "initialization after download": { startup: { "/booking": { initializeDelay: 1500 } } },
})) {
  test(`differential recovery leaves production live during a shared ${name}`, () => withRecovery({ site: incident, previous: incident }, async ({ exec, vercel, previous }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
    assert.ok(previous.requests.length > 0);
  }));
}

test("a new release that recovers during the confirmation interval is not rolled back", async () => {
  const current = { status: { "/payment": 500 } };
  const previous = { onRequest: pathname => { if (pathname === "/payment") delete current.status["/payment"]; } };
  await withRecovery({ site: current, previous }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  });
});

test("a slow new-release initialization after its script finishes never rolls back to a warm previous release", () => withRecovery({
  site: { startup: { "/booking": { initializeDelay: 1500 } } },
}, async ({ exec, vercel, previous }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /cold start/);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.ok(previous.requests.some(request => request.path === "/booking"));
}));

for (const [name, history] of Object.entries({
  "pending history": state => { state.historyStatuses[41] = []; },
  "failed gate": state => { state.historyStatuses[41][0].state = "failure"; },
  "inactive gate": state => { state.historyStatuses[41][0].state = "inactive"; },
  "different project": state => { state.history[0].payload.projectId = "prj_other"; },
  "different domain": state => { state.history[0].payload.domain = "other.example"; },
  "different commit": state => { state.history[0].sha = "8".repeat(40); state.history[0].payload.sha = "8".repeat(40); },
  "different epoch": state => { state.history[0].payload.epoch = "fixture-v0"; },
  "incomplete smoke": state => { state.history[0].payload.checks = 9; },
  "newer known-good floor": state => { state.history[0].payload.deploymentId = "dpl_live"; },
  "old floor and missing alias history": state => {
    const older = state.deployments.find(item => item.uid === "dpl_older");
    older.meta.githubCommitSha = state.history[0].sha;
    Object.assign(state.history[0].payload, { deploymentId: older.uid, url: `https://${older.url}`, createdAt: older.created });
    state.project.lastAliasRequest = null;
    state.deployments.find(item => item.uid === "dpl_previous").isRollbackCandidate = false;
  },
})) {
  test(`automatic recovery refuses ${name} without choosing an older target`, () => withRecovery({
    site: { status: { "/payment": 500 } }, history,
  }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }));
}

for (const changedPath of ["supabase/migrations/999_contract.sql", "app/api/payment/webhook/dodo/route.js", "src/server/api/payment/flow.js"]) {
  test(`automatic recovery cannot cross a contract change in ${changedPath}`, () => withRecovery({
    site: { status: { "/payment": 500 } }, changedPath,
  }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.match(result.output, /contract changed/);
  }));
}

test("healthy live gates create durable history and the next failing deployment returns to that exact record", () => withRecovery({}, async ({ exec, vercel, site, liveSha }) => {
  const healthy = await exec();
  assert.equal(healthy.code, 0, healthy.output);
  assert.equal(vercel.state.history[0].payload.deploymentId, "dpl_live");
  assert.equal(vercel.state.historyStatuses[vercel.state.history[0].id][0].state, "success");
  assert.equal(vercel.state.historyStatuses[vercel.state.history[0].id][0].auto_inactive, false);
  const next = { ...structuredClone(vercel.state.deployments.find(item => item.uid === "dpl_live")), uid: "dpl_next",
    url: "rooindustries-next-roo-industries.vercel.app" };
  next.created += 1000;
  next.createdAt += 1000;
  next.meta.githubCommitSha = liveSha;
  vercel.state.deployments.unshift(next);
  vercel.state.aliases[DOMAIN].deploymentId = next.uid;
  vercel.state.project.lastAliasRequest = { type: "promote", jobStatus: "succeeded", fromDeploymentId: "dpl_live", toDeploymentId: next.uid };
  const failedSite = await startSite({ status: { "/payment": 500 } });
  try {
    const result = await exec({ SMOKE_BASE_URL: failedSite.base, SMOKE_PREVIOUS_BASE_URL: site.base, DEPLOYMENT_URL: `https://${next.url}` });
    assert.equal(result.code, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live", result.output);
    assert.equal(changes(vercel).length, 1);
    assert.ok(changes(vercel)[0].path.endsWith("/rollback/dpl_live"));
  } finally { await failedSite.close(); }
}));

test("a history write failure is an alert and cannot authorize a later rollback", () => withRecovery({ vercel: { historyWriteError: true } }, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0);
  assert.match(result.output, /history/);
}));

test("the automatic CLI requires comparison evidence even with valid passed-gate history", () => withRecovery({}, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", ["--if-live", LIVE_URL], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /requires repeated differential-smoke evidence/);
  assert.equal(changes(vercel).length, 0);
}));

test("manual one-command rollback still works without passed-gate history or an epoch", () => withRecovery({ history: state => { state.history = []; } }, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", [], { ...env, GITHUB_TOKEN: undefined, PRODUCTION_RECOVERY_EPOCH: undefined });
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.equal(changes(vercel).length, 1);
}));

test("failed restoration of a newer deployment alerts without claiming confirmed recovery", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { swapLiveBeforeMutation: true, restoreError: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 2);
  assert.ok(changes(vercel)[1].path.endsWith("/promote/dpl_newer"));
  assert.match(result.output, /restoration refused/);
  assert.doesNotMatch(result.output, /production was rolled back|restored dpl_newer/);
}));

test("a second external promotion racing restoration is itself restored and verified", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { swapLiveBeforeMutation: true, swapLiveBeforePromote: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newest", result.output);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.equal(changes(vercel).length, 3);
  assert.ok(changes(vercel)[2].path.endsWith("/promote/dpl_newest"));
  assert.match(result.output, /restored dpl_newest/);
}));

test("a reflected provider token and URL credentials are redacted from rollback errors", () => withRecovery({
  vercel: { rollbackError: { status: 409, code: "fixture", message: `Reflected ${TOKEN} https://fixture-user:fixture-pass@example.invalid/api?token=fixture-query https://safe.invalid/?next=https%3A%2F%2Fextra-user%3Aextra-pass%40nested.invalid` } },
}, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", [], env);
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, new RegExp(`${TOKEN}|fixture-user|fixture-pass|fixture-query|extra-user|extra-pass`));
  assert.equal(changes(vercel).length, 1);
}));

test("application errors redact raw and encoded URL credentials in logs and the Actions summary", () => withRecovery({
  site: { startup: { "/payment": { error: true } }, bodies: { "/payment": '<h3>Booking Summary</h3><script>throw new Error("https://fixture-user:fixture-pass@example.invalid/error?api_key=fixture-key https://encoded%2Duser:encoded%2Dpass@example.invalid/")</script>' } },
}, async ({ site, env, scratch }) => {
  const summary = path.join(scratch, "summary.md");
  const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, GITHUB_STEP_SUMMARY: summary });
  assert.equal(result.code, 2, result.output);
  assert.doesNotMatch(result.output + fs.readFileSync(summary, "utf8"), /fixture-user|fixture-pass|fixture-key|encoded%2Duser|encoded%2Dpass/);
}));

test("automatic recovery refuses missing provider alias history even when build order agrees", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { tweak: state => { state.project.lastAliasRequest = null; } },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.match(result.output, /alias history/);
}));

test("a newer build that has never served production cannot prevent recovery of the failing live release", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { swapNewestOnDeploymentRead: 1 },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
}));

test("rollback refuses credentials in a domain argument before provider access", () => withRecovery({}, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", ["--domain", "https://fixture-user:fixture-pass@example.invalid"], env);
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /fixture-user|fixture-pass/);
  assert.equal(vercel.requests.length, 0, result.output);
}));

test("rollback refuses credential-bearing provider deployment URLs without logging them", () => withRecovery({
  vercel: { tweak: state => { state.deployments.find(item => item.uid === "dpl_live").url = "fixture-user:fixture-pass@example.invalid"; } },
}, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", ["--status"], env);
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, /fixture-user|fixture-pass/);
  assert.equal(changes(vercel).length, 0);
}));

test("credential redaction preserves parseable smoke reports containing quoted URLs", () => withRecovery({
  site: { bodies: { "/payment": `<h3>Booking Summary</h3><script>throw new Error('Failed "https://fixture-user:fixture-pass@example.invalid/?token=fixture-query"')</script>` } },
}, async ({ site, env, scratch }) => {
  const report = path.join(scratch, "report.json");
  const result = await execute("production-smoke.mjs", ["--base", site.base, "--report", report], env);
  assert.equal(result.code, 2, result.output);
  const text = fs.readFileSync(report, "utf8");
  assert.ok(JSON.parse(text).results.some(row => !row.ok));
  assert.doesNotMatch(text + result.output, /fixture-user|fixture-pass|fixture-query/);
}));

test("credential redaction preserves parseable rollback status containing quoted URLs", () => withRecovery({
  vercel: { tweak: state => { state.project.lastAliasRequest.description = 'See "https://fixture-user:fixture-pass@example.invalid/?token=fixture-query"'; } },
}, async ({ env }) => {
  const result = await execute("deploy-rollback.mjs", ["--status"], env);
  assert.equal(result.code, 0, result.output);
  assert.equal(JSON.parse(result.output).live.id, "dpl_live");
  assert.doesNotMatch(result.output, /fixture-user|fixture-pass|fixture-query/);
}));

test("a normalized Vercel credential stays redacted when the exported token has whitespace", () => withRecovery({
  vercel: { rollbackError: { status: 409, code: "fixture", message: `Reflected normalized ${TOKEN}` } },
}, async ({ env }) => {
  const result = await execute("deploy-rollback.mjs", [], { ...env, VERCEL_TOKEN: `  ${TOKEN}  ` });
  assert.equal(result.code, 1, result.output);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
}));
