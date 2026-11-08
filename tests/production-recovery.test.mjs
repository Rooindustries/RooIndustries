import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMAIN } from "./fixtures/fake-vercel.mjs";
import { changes, execute, withRecovery, LIVE_URL } from "./fixtures/production-recovery.mjs";

const broken = { status: { "/payment": 500 } };

test("recovery confirms the same regression twice against the previous passed gate", () => withRecovery({ site: broken }, async ({ exec, vercel, site, previous }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  const previousQuotes = previous.requests.filter(row => row.path === "/api/payment/quote");
  assert.equal(previousQuotes.length, 2, result.output);
  assert.ok(previousQuotes[1].at - previousQuotes[0].at >= 40);
  assert.ok(site.requests.filter(row => row.path === "/payment").length >= 4);
  assert.match(result.output, /production was rolled back/);
}));

for (const [name, incident] of Object.entries({
  "quote failure": { quote: { status: 503 } },
  "package failure": { status: { "/packages": 503 } },
  "shared backend failure": { availability: { ok: false } },
})) {
  test(`a shared ${name} cannot authorize rollback`, () => withRecovery({ site: incident, previous: incident }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }));
}

test("a release that recovers between comparisons stays live", async () => {
  const site = { status: { "/payment": 500 } };
  const previous = { onRequest: pathname => { if (pathname === "/payment") delete site.status["/payment"]; } };
  await withRecovery({ site, previous }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  });
});

test("different failures in the two comparisons cannot authorize rollback", async () => {
  const site = { status: { "/payment": 500 } };
  const previous = { onRequest: pathname => {
    if (pathname === "/payment") {
      delete site.status["/payment"];
      site.availability = { ok: false };
    }
  } };
  await withRecovery({ site, previous }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /comparisons changed/);
    assert.equal(changes(vercel).length, 0, result.output);
  });
});

for (const [name, history] of Object.entries({
  "missing history": state => { state.history = []; },
  "failed gate": state => { state.historyStatuses[41][0].state = "failure"; },
  "different epoch": state => { state.history[0].payload.epoch = "fixture-v0"; },
  "incomplete smoke": state => { state.history[0].payload.checks = 9; },
  "missing alias history": state => { state.project.lastAliasRequest = null; },
})) {
  test(`automatic recovery refuses ${name}`, () => withRecovery({ site: broken, history }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }));
}

for (const changedPath of ["supabase/migrations/999_contract.sql", "app/api/payment/webhook/dodo/route.js", "src/server/api/payment/flow.js"]) {
  test(`recovery cannot cross a contract change in ${changedPath}`, () => withRecovery({ site: broken, changedPath }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.match(result.output, /contract changed/);
  }));
}

test("a healthy current release records a durable passed gate", () => withRecovery({}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.history[0].payload.deploymentId, "dpl_live");
  const status = vercel.state.historyStatuses[vercel.state.history[0].id][0];
  assert.equal(status.state, "success");
  assert.equal(status.auto_inactive, false);
  assert.equal(changes(vercel).length, 0, result.output);
}));

test("an unrecorded passing gate cannot authorize later rollback", () => withRecovery({ vercel: { historyWriteError: true } }, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /history/);
  assert.equal(changes(vercel).length, 0);
}));

test("automatic rollback requires comparison evidence at the command entry point", () => withRecovery({}, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", ["--if-live", LIVE_URL], env);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /requires repeated differential-smoke evidence/);
  assert.equal(changes(vercel).length, 0);
}));

for (const packages of [{ cards: [] }, { offers: [] }]) {
  test(`package failure ${JSON.stringify(packages)} can recover without inventing initialization uncertainty`, () => withRecovery({ site: { packages } }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  }));
}

for (const failing of [false, true]) {
  test(`protected immutable probes ${failing ? "recover" : "record history"} with the configured bypass`, () => withRecovery({
    site: { protection: "fixture-bypass-4567", ...(failing ? broken : {}) }, previous: { protection: "fixture-bypass-4567" },
  }, async ({ exec, vercel, site, previous }) => {
    const result = await exec({ GITHUB_ACTIONS: "true", VERCEL_AUTOMATION_BYPASS_SECRET: "fixture-bypass-4567" });
    assert.equal(result.code, failing ? 1 : 0, result.output);
    assert.equal(changes(vercel).length, failing ? 1 : 0, result.output);
    assert.ok(site.requests.every(row => row.bypass === "fixture-bypass-4567"));
    assert.ok(previous.requests.every(row => row.bypass === "fixture-bypass-4567"));
    assert.doesNotMatch(result.output, /fixture-bypass-4567/);
  }));
}

test("slow initialization cannot cause a rollback to a warm release", () => withRecovery({
  site: { startup: { "/booking": { initializeDelay: 5000 } } },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

for (const stage of ["planning", "final revalidation"]) {
  test(`automatic recovery leaves a newer READY release waiting during ${stage}`, () => withRecovery({
    site: broken, vercel: { swapNewestOnDeploymentRead: stage === "planning" ? 1 : 4 },
  }, async ({ exec, env, vercel }) => {
    const result = stage === "planning"
      ? await execute("deploy-rollback.mjs", ["--plan", "--if-live", LIVE_URL], env)
      : await exec();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /not the newest/);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
    assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  }));
}
