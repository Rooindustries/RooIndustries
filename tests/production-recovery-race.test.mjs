import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { withNodeOption } from "../scripts/lib/node-options.mjs";
import { DOMAIN } from "./fixtures/fake-vercel.mjs";
import { changes, withRecovery, withLockTools, execute, LIVE_URL, root } from "./fixtures/production-recovery.mjs";

const broken = { status: { "/payment": 500 } };

const addKnownBadRelease = state => {
  const live = state.deployments.find(item => item.uid === "dpl_live");
  state.deployments.unshift({ ...structuredClone(live), uid: "dpl_newer",
    url: "rooindustries-newer-roo-industries.vercel.app", created: live.created + 1000,
    createdAt: live.created + 1000, ready: live.ready + 1000 });
};

for (const omitted of [false, true]) {
  test(`a newer release in the final rollback race is restored even when source metadata is ${omitted ? "missing" : "present"}`, () => withRecovery({
    site: broken, vercel: { swapLiveBeforeMutation: true, omitFromDeployment: omitted },
  }, async ({ exec, vercel, restored }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
    assert.equal(vercel.state.project.autoAssignCustomDomains, true);
    assert.deepEqual(changes(vercel).map(row => row.path.split("/").slice(-2).join("/")), ["rollback/dpl_previous", "promote/dpl_newer"]);
    assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
    assert.equal(vercel.state.history[0].payload.deploymentId, "dpl_newer");
    assert.match(result.output, /restored dpl_newer.*own gate \(passed\)/);
    assert.doesNotMatch(result.output, /so production was rolled back/);
  }));
}

test("a lost rollback response still restores a newer release", () => withRecovery({
  site: broken, vercel: { swapLiveBeforeMutation: true, dropAcceptedRollback: true, aliasSettlePolls: 2 },
}, async ({ exec, vercel, restored }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
}));

test("a newer ready release appearing only in the deployment list is promoted and gated", () => withRecovery({
  site: broken, vercel: { swapNewestOnDeploymentRead: 5, omitFromDeployment: true },
}, async ({ exec, vercel, restored }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
  assert.match(result.output, /restored dpl_newer/);
}));

test("a newer release seen just before rollback is preserved without mutation", () => withRecovery({
  site: broken, vercel: { swapLiveOnAliasRead: 4 },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer");
}));

test("failed restoration is reported without claiming recovery", () => withRecovery({
  site: broken, vercel: { swapLiveBeforeMutation: true, restoreError: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 2, result.output);
  assert.match(result.output, /rollback was sent, but production was not confirmed/);
  assert.doesNotMatch(result.output, /own gate \(passed\)|so production was rolled back/);
}));

test("a restored release receives a failing gate when it has a real regression", () => withRecovery({
  site: broken, restored: { quote: { status: 503 } }, vercel: { swapLiveBeforeMutation: true },
}, async ({ exec, vercel, restored }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
  assert.match(result.output, /restored dpl_newer.*own gate \(failed\)/);
}));

for (const perl of [false, true]) {
  test(`concurrent gates perform one recovery ${perl ? "through native Perl locking" : "through flock"}`, async () => {
    const check = toolPath => withRecovery({ site: broken }, async ({ exec, vercel }) => {
      const results = await Promise.all([exec(toolPath ? { PATH: toolPath } : {}), exec(toolPath ? { PATH: toolPath } : {})]);
      assert.ok(results.every(row => row.code === 1));
      assert.equal(changes(vercel).length, 1, results.map(row => row.output).join("\n"));
      assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    });
    if (perl) await withLockTools(["perl", "git"], check);
    else await check();
  });
}

test("a production event gates the restored release while retaining the original event identity", () => withRecovery({
  site: broken, vercel: { swapLiveBeforeMutation: true },
}, async ({ exec, vercel, site, previous, restored, scratch }) => {
  const event = path.join(scratch, "event.json");
  fs.writeFileSync(event, JSON.stringify({ repository: { full_name: "Rooindustries/RooIndustries" },
    deployment: { environment: "Production" }, deployment_status: { state: "success", environment_url: LIVE_URL } }));
  const env = withNodeOption({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "deployment_status",
    GITHUB_EVENT_PATH: event, PRODUCTION_EVENT_URL: LIVE_URL,
    GITHUB_WORKFLOW_REF: "Rooindustries/RooIndustries/.github/workflows/production-smoke.yml@refs/heads/main",
    ROO_TEST_MONITOR_ORIGIN: site.base, ROO_TEST_PREVIOUS_ORIGIN: previous.base,
    ROO_TEST_RESTORED_ORIGIN: restored.base, SMOKE_RESTORED_BASE_URL: undefined,
  }, "--import", path.join(root, "tests/fixtures/production-monitor-loader.mjs"));
  const result = await exec(env);
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
  assert.match(result.output, /restored dpl_newer.*own gate \(passed\)/);
}));

test("a second newer release racing restoration is itself restored and gated", () => withRecovery({
  site: broken, vercel: { swapLiveBeforeMutation: true, swapLiveBeforePromote: true },
}, async ({ exec, vercel, restored }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newest", result.output);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.equal(changes(vercel).length, 3, result.output);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
  assert.match(result.output, /restored dpl_newest.*own gate \(passed\)/);
}));

test("a newer release appearing while rollback confirmation runs is restored", () => withRecovery({
  site: broken, vercel: { swapLiveOnAliasRead: 6, omitFromDeployment: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.match(result.output, /restored dpl_newer.*own gate \(passed\)/);
}));

test("manual rollback and undo retain native locking when flock is absent", () => withRecovery({}, async ({ env, vercel }) => {
  await withLockTools(["perl"], async toolPath => {
    const rollback = await execute("deploy-rollback.mjs", [], { ...env, PATH: toolPath });
    assert.equal(rollback.code, 0, rollback.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    const undo = await execute("deploy-rollback.mjs", ["--undo"], { ...env, PATH: toolPath });
    assert.equal(undo.code, 0, undo.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
    assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  });
}));

test("manual C to B to A rollback keeps the newer known-bad release pinned out until undo", () => withRecovery({
  vercel: { tweak: state => {
    addKnownBadRelease(state);
    state.aliases[DOMAIN].deploymentId = "dpl_newer";
    state.project.lastAliasRequest = { type: "promote", jobStatus: "succeeded",
      fromDeploymentId: "dpl_live", toDeploymentId: "dpl_newer" };
  } },
}, async ({ env, vercel }) => {
  for (const target of ["dpl_live", "dpl_previous"]) {
    const result = await execute("deploy-rollback.mjs", [], env);
    assert.equal(result.code, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, target, result.output);
    assert.equal(vercel.state.project.autoAssignCustomDomains, false);
  }
  assert.deepEqual(changes(vercel).map(row => row.path.split("/").slice(-2).join("/")),
    ["rollback/dpl_live", "rollback/dpl_previous"]);
  const undo = await execute("deploy-rollback.mjs", ["--undo"], env);
  assert.equal(undo.code, 0, undo.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer");
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
}));

test("manual rollback restores a known release only when this rollback displaced it", () => withRecovery({
  vercel: { swapLiveBeforeMutation: true, tweak: state => {
    addKnownBadRelease(state);
    state.project.autoAssignCustomDomains = false;
    state.project.lastAliasRequest = { type: "rollback", jobStatus: "succeeded",
      fromDeploymentId: "dpl_newer", toDeploymentId: "dpl_live" };
  } },
}, async ({ env, vercel, restored }) => {
  const result = await execute("deploy-rollback.mjs", [], env);
  assert.equal(result.code, 2, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer", result.output);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.deepEqual(changes(vercel).map(row => row.path.split("/").slice(-2).join("/")),
    ["rollback/dpl_previous", "promote/dpl_newer"]);
  assert.ok(restored.requests.some(row => row.path === "/api/payment/quote"));
  assert.match(result.output, /restored dpl_newer.*own gate \(passed\)/);
}));
