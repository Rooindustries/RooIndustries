import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOMAIN, TOKEN, startVercel } from "./fixtures/fake-vercel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/deploy-rollback.mjs");
const LIVE_URL = "https://rooindustries-live-roo-industries.vercel.app";
const TEAM_ID = "team_rooFixture";
const PROJECT_ID = "prj_rooFixture";

const run = (args, env) => new Promise(resolve => {
  const childEnv = { PATH: process.env.PATH, ROLLBACK_VERIFY_INTERVAL_MS: "20", ROLLBACK_VERIFY_TIMEOUT_MS: "400", ...env };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env: childEnv });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});

const withVercel = async (options, body) => {
  const vercel = await startVercel(options);
  try {
    const exec = async (args, env = {}) => {
      const result = await run(args, { VERCEL_TOKEN: TOKEN, VERCEL_API_URL: vercel.origin, ...env });
      assert.doesNotMatch(result.output, new RegExp(TOKEN));
      return result;
    };
    await body(vercel, exec);
  } finally {
    await vercel.close();
  }
};

const mutations = requests => requests.filter(request => request.method !== "GET");
const invalidations = requests => requests.filter(request => request.path === "/v1/edge-cache/invalidate-by-tags");
const rebuildMessage = reason => `The page rebuild did not run: ${reason}. Production has moved: see the lines above, or run \`npm run deploy:rollback -- --status\`, for what it serves. Its pages can be stale until their timer expires (at most an hour). Finish with: npm run deploy:rollback -- --rebuild-pages`;
const expectInvalidate = request => {
  assert.equal(request.method, "POST");
  assert.deepEqual(request.query, { projectIdOrName: PROJECT_ID, teamId: TEAM_ID });
  assert.deepEqual(request.body, { tags: "_N_T_/layout" });
};

for (const undo of [false, true]) {
  test(`confirmed ${undo ? "undo" : "rollback"} marks pages stale once after the alias moves`, () => withVercel({
    tweak: undo ? state => { state.aliases[DOMAIN].deploymentId = "dpl_previous"; state.project.autoAssignCustomDomains = false; } : undefined,
  }, async (vercel, exec) => {
    const result = await exec(undo ? ["--undo"] : []);
    assert.equal(result.code, 0, result.output);
    const changes = mutations(vercel.requests);
    assert.equal(changes.length, 2);
    assert.match(changes[0].path, undo ? /\/promote\/dpl_live$/ : /\/rollback\/dpl_previous$/);
    expectInvalidate(changes[1]);
    const alias = vercel.requests.find(request => request.index > changes[0].index && request.index < changes[1].index && request.path === `/v4/aliases/${DOMAIN}` && request.response?.deploymentId === (undo ? "dpl_live" : "dpl_previous"));
    assert.ok(alias, "the target alias must be confirmed before invalidation");
    assert.match(result.output, /Production pages marked stale; each rebuilds on its next visit\./);
    assert.ok(result.output.indexOf("now serves") < result.output.indexOf("Production pages marked stale"));
  }));
}

for (const undo of [false, true]) {
  test(`${undo ? "undo" : "rollback"} reports an invalidation error after the confirmed move`, () => withVercel({
    invalidateError: { status: 503, message: "cache unavailable" },
    tweak: undo ? state => { state.aliases[DOMAIN].deploymentId = "dpl_previous"; state.project.autoAssignCustomDomains = false; } : undefined,
  }, async (vercel, exec) => {
    const result = await exec(undo ? ["--undo"] : [], { GITHUB_ACTIONS: "true", VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID });
    assert.equal(result.code, 3, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, undo ? "dpl_live" : "dpl_previous");
    assert.equal(invalidations(vercel.requests).length, 1);
    expectInvalidate(invalidations(vercel.requests)[0]);
    assert.ok(result.output.includes(rebuildMessage("Vercel answered 503: cache unavailable")));
    assert.ok(result.output.includes(`::error::${rebuildMessage("Vercel answered 503: cache unavailable")}`));
  }));
}

test("rollback reports a lost invalidation answer after the confirmed move", () => withVercel({ invalidateDropWithoutApply: true }, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 3, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.equal(invalidations(vercel.requests).length, 1);
  assert.ok(result.output.includes(rebuildMessage("the call got no answer (fetch failed), so whether Vercel applied it is unknown")));
}));

for (const [label, options, code, reason] of [
  ["success", {}, 0, null],
  ["503", { invalidateError: { status: 503, message: "cache unavailable" } }, 3, "Vercel answered 503: cache unavailable"],
  ["lost answer", { invalidateDropWithoutApply: true }, 3, "the call got no answer (fetch failed), so whether Vercel applied it is unknown"],
]) {
  test(`rebuild-pages ${label} makes exactly one scoped request`, () => withVercel(options, async (vercel, exec) => {
    const result = await exec(["--rebuild-pages"], { VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID });
    assert.equal(result.code, code, result.output);
    assert.equal(vercel.requests.length, 1);
    expectInvalidate(vercel.requests[0]);
    if (reason) assert.ok(result.output.includes(rebuildMessage(reason)));
    else assert.match(result.output, /Production pages marked stale; each rebuilds on its next visit\./);
  }));
}

for (const [missing, reason] of [["VERCEL_TOKEN", "VERCEL_TOKEN is not set"], ["VERCEL_TEAM_ID", "VERCEL_PROJECT_ID and VERCEL_TEAM_ID are not set"], ["VERCEL_PROJECT_ID", "VERCEL_PROJECT_ID and VERCEL_TEAM_ID are not set"]]) {
  test(`rebuild-pages refuses missing ${missing} without a request`, () => withVercel({}, async (vercel, exec) => {
    const result = await exec(["--rebuild-pages"], { CI: "true", VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID, [missing]: undefined });
    assert.equal(result.code, 1, result.output);
    assert.ok(result.output.includes(rebuildMessage(reason)));
    assert.deepEqual(vercel.requests, []);
  }));
}

for (const action of [["--undo"], ["--status"], ["--dry-run"], ["--if-live", LIVE_URL], ["--reason", "failure"]]) {
  test(`rebuild-pages refuses ${action[0]} without a request`, () => withVercel({}, async (vercel, exec) => {
    const result = await exec(["--rebuild-pages", ...action]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /--rebuild-pages can't be combined with other actions\./);
    assert.deepEqual(vercel.requests, []);
  }));
}

for (const action of ["--status", "--dry-run"]) {
  test(`configured scope works with a project-scoped token for ${action}`, () => withVercel({ forbidTeams: true }, async (vercel, exec) => {
    const result = await exec([action], { CI: "true", VERCEL_TEAM_ID: ` ${TEAM_ID} `, VERCEL_PROJECT_ID: ` ${PROJECT_ID} ` });
    assert.equal(result.code, 0, result.output);
    if (action === "--status") assert.equal(JSON.parse(result.output).live.id, "dpl_live");
    else assert.match(result.output, /Target:\s+dpl_previous/);
    assert.ok(vercel.requests.length > 0);
    assert.ok(vercel.requests.every(request => request.path !== "/v2/teams" && request.query.teamId === TEAM_ID));
    assert.ok(vercel.requests.some(request => request.path === `/v9/projects/${PROJECT_ID}`));
    assert.deepEqual(mutations(vercel.requests), []);
  }));
}

for (const ci of ["CI", "GITHUB_ACTIONS"]) {
  for (const missing of ["VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]) {
    for (const value of [undefined, "  "]) {
      test(`${ci} refuses ${value === undefined ? "an unset" : "a blank"} ${missing} before contacting Vercel`, () => withVercel({}, async (vercel, exec) => {
        const result = await exec(["--status"], {
          [ci]: "true",
          VERCEL_TEAM_ID: TEAM_ID,
          VERCEL_PROJECT_ID: PROJECT_ID,
          [missing]: value,
        });
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, new RegExp(missing));
        assert.match(result.output, /repository variable/i);
        assert.deepEqual(vercel.requests, []);
      }));
    }
  }
}

test("CI names both missing repository variables before contacting Vercel", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--status"], { CI: "true" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /VERCEL_TEAM_ID/);
  assert.match(result.output, /VERCEL_PROJECT_ID/);
  assert.match(result.output, /repository variables/i);
  assert.deepEqual(vercel.requests, []);
}));

for (const [name, value] of [
  ["VERCEL_TEAM_ID", "team_bad-id"], ["VERCEL_TEAM_ID", "team_"],
  ["VERCEL_PROJECT_ID", "prj_bad_id"], ["VERCEL_PROJECT_ID", "prj_"],
]) {
  test(`refuses malformed ${name} ${value} before contacting Vercel`, () => withVercel({}, async (vercel, exec) => {
    const result = await exec(["--dry-run"], { [name]: value });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, new RegExp(name));
    assert.deepEqual(vercel.requests, []);
  }));
}

test("refuses a live deployment from a different configured project", () => withVercel({
  tweak: state => {
    state.aliases[DOMAIN].projectId = "prj_other";
    state.deployments.find(item => item.uid === "dpl_live").projectId = "prj_other";
  },
}, async (vercel, exec) => {
  const result = await exec(["--status"], { VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /prj_other/);
  assert.match(result.output, /prj_rooFixture/);
  assert.ok(vercel.requests.some(request => request.path === "/v13/deployments/dpl_live"));
  assert.ok(vercel.requests.every(request => !request.path.startsWith("/v9/projects/")));
  assert.deepEqual(mutations(vercel.requests), []);
}));

for (const args of [[], ["--undo"]]) {
  test(`${args.length ? "undo" : "rollback"} refuses a project change before the mutation`, () => withVercel({
    swapLiveOnAliasRead: 2,
    swapLiveTo: "dpl_otherProject",
    tweak: state => {
      const live = state.deployments.find(item => item.uid === "dpl_live");
      state.deployments.push({ ...structuredClone(live), uid: "dpl_otherProject", projectId: "prj_other" });
      if (args.length) {
        state.aliases[DOMAIN].deploymentId = "dpl_previous";
        state.project.autoAssignCustomDomains = false;
      }
    },
  }, async (vercel, exec) => {
    const result = await exec(args, { VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /prj_other/);
    assert.match(result.output, /prj_rooFixture/);
    assert.deepEqual(mutations(vercel.requests), []);
  }));
}

test("a configured team is the only scope tried outside CI", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--status"], { VERCEL_TEAM_ID: "team_wrong" });
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.requests.length, 1);
  assert.equal(vercel.requests[0].path, `/v4/aliases/${DOMAIN}`);
  assert.equal(vercel.requests[0].query.teamId, "team_wrong");
}));

test("a configured team works without a configured project outside CI", () => withVercel({ forbidTeams: true }, async (vercel, exec) => {
  const result = await exec(["--status"], { VERCEL_TEAM_ID: TEAM_ID });
  assert.equal(result.code, 0, result.output);
  assert.ok(vercel.requests.every(request => request.path !== "/v2/teams" && request.query.teamId === TEAM_ID));
}));

test("a configured project still permits team discovery outside CI", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--status"], { VERCEL_PROJECT_ID: PROJECT_ID });
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.requests[0].path, "/v2/teams");
  assert.ok(vercel.requests.some(request => request.path === `/v9/projects/${PROJECT_ID}`));
}));

test("configured scope is retained through automatic rollback and undo", () => withVercel({ forbidTeams: true }, async (vercel, exec) => {
  const env = { GITHUB_ACTIONS: "true", VERCEL_TEAM_ID: TEAM_ID, VERCEL_PROJECT_ID: PROJECT_ID };
  const rollback = await exec(["--if-live", LIVE_URL], env);
  assert.equal(rollback.code, 0, rollback.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  const undo = await exec(["--undo"], env);
  assert.equal(undo.code, 0, undo.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.ok(vercel.requests.every(request => request.path !== "/v2/teams" && request.query.teamId === TEAM_ID));
  assert.equal(mutations(vercel.requests).length, 4);
}));

test("dry run shows the live and previous production deployments and changes nothing", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--dry-run"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Live:\s+dpl_live .*11111111/);
  assert.match(result.output, /Target:\s+dpl_previous .*44444444/);
  assert.match(result.output, /Dry run/);
  assert.deepEqual(mutations(vercel.requests), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.ok(vercel.requests.every(request => request.auth === `Bearer ${TOKEN}`));
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
}));

test("rollback moves production to the previous ready production deployment and says how to undo", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--reason", "smoke failed on /packages"]);
  assert.equal(result.code, 0, result.output);
  const [post] = mutations(vercel.requests);
  assert.equal(post.path, "/v1/projects/prj_rooFixture/rollback/dpl_previous");
  assert.equal(post.body && typeof post.body, "object");
  assert.deepEqual(post.body, {});
  assert.equal(post.query.teamId, "team_rooFixture");
  assert.equal(post.query.description, "smoke failed on /packages");
  assert.equal(mutations(vercel.requests).length, 2);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.match(result.output, /now serves dpl_previous/);
  assert.match(result.output, /deploy:rollback -- --undo/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
}));

test("undo waits to report success until automatic assignment is back on", () => withVercel({
  promoteAssignPolls: 3,
  tweak: state => {
    state.project.autoAssignCustomDomains = false;
    state.project.lastAliasRequest = {
      type: "promote",
      jobStatus: "succeeded",
      fromDeploymentId: "dpl_previous",
      toDeploymentId: "dpl_live",
      requestedAt: Date.now(),
    };
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.equal(result.code, 0, result.output);
  const postAt = vercel.requests.findIndex(request => request.method === "POST" && request.path.includes("/promote/"));
  const projectReads = vercel.requests.slice(postAt + 1).filter(request => request.path.startsWith("/v9/projects/"));
  assert.ok(projectReads.length >= 3, `${projectReads.length} project reads after promote\n${result.output}`);
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.match(result.output, /go live automatically/);
}));

test("undo after a rollback promotes the newest ready production deployment and turns auto-assignment back on", () => withVercel({}, async (vercel, exec) => {
  assert.equal((await exec([])).code, 0);
  const result = await exec(["--undo"]);
  assert.equal(result.code, 0, result.output);
  const posts = mutations(vercel.requests);
  assert.equal(posts.length, 4);
  assert.equal(posts[2].path, "/v10/projects/prj_rooFixture/promote/dpl_live");
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.equal(vercel.state.project.autoAssignCustomDomains, true);
  assert.match(result.output, /now serves dpl_live/);
}));

test("undo accepts Vercel's asynchronous 202 promote answer and still verifies the domain", () => withVercel({
  promoteStatus: 202,
  tweak: state => {
    state.aliases[DOMAIN].deploymentId = "dpl_previous";
    state.project.autoAssignCustomDomains = false;
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("undo with the newest deployment live and auto-assignment on changes nothing", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Nothing to undo/);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("undo leaves production alone when a newer deployment becomes ready before the request", () => withVercel({
  swapNewestOnDeploymentRead: 2,
  tweak: state => {
    state.aliases[DOMAIN].deploymentId = "dpl_previous";
    state.project.autoAssignCustomDomains = false;
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /undo target changed from dpl_live to dpl_newer/);
  assert.deepEqual(mutations(vercel.requests), []);
  assert.equal(invalidations(vercel.requests).length, 0);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
}));

test("a dropped rollback response exits 2 when Vercel already accepted it", () => withVercel({
  dropAcceptedRollback: true,
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 2, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.equal(mutations(vercel.requests).length, 1);
}));

test("a 5xx answer to the rollback leaves production's state unknown even when nothing has moved yet", () => withVercel({
  rollbackError: { status: 500, code: "internal_error", message: "temporarily unavailable" },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /500/);
  assert.match(result.output, /state is unknown/);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("a newer deployment that goes live right before the rollback is reported, not silently replaced", () => withVercel({
  swapLiveBeforeMutation: true,
}, async (vercel, exec) => {
  const result = await exec(["--if-live", LIVE_URL]);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /moved it away from dpl_newer, not dpl_live/);
  assert.match(result.output, /--undo/);
}));

test("a rollback Vercel records without its source deployment is unconfirmed, even when a newer deploy slipped in", () => withVercel({
  swapLiveBeforeMutation: true,
  omitFromDeployment: true,
}, async (vercel, exec) => {
  const result = await exec(["--if-live", LIVE_URL]);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /didn't record which deployment it replaced/);
}));

test("rollback returns to the deployment that served production before the live one, not to a newer bad one", () => withVercel({
  tweak: state => {
    state.project.lastAliasRequest = { type: "promote", jobStatus: "succeeded", fromDeploymentId: "dpl_older", toDeploymentId: "dpl_live", requestedAt: 1760995000000 };
  },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_older");
}));

test("rollback finds the deployment that served production before the live one past the first page of candidates", () => withVercel({
  tweak: state => {
    const older = state.deployments.find(item => item.uid === "dpl_older");
    for (let index = 1; index <= 25; index += 1) {
      state.deployments.push({ ...structuredClone(older), uid: `dpl_mid${index}`, url: `rooindustries-mid${index}-roo-industries.vercel.app`, created: older.created + index * 100, createdAt: older.created + index * 100, ready: older.created + index * 100 });
    }
    state.project.lastAliasRequest = { type: "promote", jobStatus: "succeeded", fromDeploymentId: "dpl_older", toDeploymentId: "dpl_live", requestedAt: 1760995000000 };
  },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_older");
}));

test("rollback never returns to a deployment an earlier rollback moved away from", () => withVercel({
  tweak: state => {
    state.project.lastAliasRequest = { type: "rollback", jobStatus: "succeeded", fromDeploymentId: "dpl_previous", toDeploymentId: "dpl_older", requestedAt: 1760985000000 };
  },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_older");
}));

test("dry run of undo shows the deployment it would promote and changes nothing", () => withVercel({
  tweak: state => {
    state.aliases[DOMAIN].deploymentId = "dpl_previous";
    state.project.autoAssignCustomDomains = false;
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo", "--dry-run"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Target:\s+dpl_live/);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("status prints the live deployment and the auto-assignment state as JSON without changing anything", () => withVercel({
  tweak: state => { state.project.autoAssignCustomDomains = false; },
}, async (vercel, exec) => {
  const result = await exec(["--status"]);
  assert.equal(result.code, 0, result.output);
  const status = JSON.parse(result.output);
  assert.equal(status.live.id, "dpl_live");
  assert.equal(status.live.url, "rooindustries-live-roo-industries.vercel.app");
  assert.equal(status.newest.id, "dpl_live");
  assert.equal(status.autoAssignCustomDomains, false);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("refuses without VERCEL_TOKEN and sends nothing", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--dry-run"], { VERCEL_TOKEN: undefined });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /VERCEL_TOKEN/);
  assert.deepEqual(vercel.requests, []);
}));

for (const args of [["--dryrun"], ["--dry-run", "extra"], ["--reason"], ["--status", "--undo"], ["--undo", "--if-live", LIVE_URL]]) {
  test(`refuses ${args.join(" ")} before contacting Vercel`, () => withVercel({}, async (vercel, exec) => {
    const result = await exec(args);
    assert.notEqual(result.code, 0);
    assert.deepEqual(vercel.requests, []);
  }));
}

test("refuses an API base other than Vercel or loopback and never sends the token there", async () => {
  const result = await run(["--dry-run"], { VERCEL_TOKEN: TOKEN, VERCEL_API_URL: "http://api.vercel.com.attacker.example" });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /VERCEL_API_URL/);
});

const badTargets = {
  "another project": deployment => { deployment.projectId = "prj_someoneElse"; },
  "a preview deployment": deployment => { deployment.target = null; },
  "a deployment that is not ready": deployment => { deployment.readyState = "ERROR"; deployment.state = "ERROR"; },
  "a deployment Vercel marks as not eligible": deployment => { deployment.isRollbackCandidate = false; },
  "a deployment removed by retention": deployment => { deployment.softDeletedByRetention = true; },
};
for (const [name, spoil] of Object.entries(badTargets)) {
  test(`refuses when the previous deployment is ${name}, even if the API returns it`, () => withVercel({
    ignoreFilters: true,
    tweak: state => {
      state.deployments = state.deployments.filter(item => !["dpl_error", "dpl_preview"].includes(item.uid));
      spoil(state.deployments.find(item => item.uid === "dpl_previous"));
    },
  }, async (vercel, exec) => {
    const result = await exec([]);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /Refusing/);
    assert.deepEqual(mutations(vercel.requests), []);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }));
}

test("refuses when there is no earlier production deployment to roll back to", () => withVercel({
  tweak: state => { state.deployments = state.deployments.filter(item => item.uid === "dpl_live"); },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /No earlier/);
  assert.deepEqual(mutations(vercel.requests), []);
}));

for (const jobStatus of ["pending", "in-progress"]) {
  test(`refuses while a previous promote or rollback is ${jobStatus}`, () => withVercel({
    tweak: state => { state.project.lastAliasRequest.jobStatus = jobStatus; },
  }, async (vercel, exec) => {
    const result = await exec([]);
    assert.notEqual(result.code, 0);
    assert.match(result.output, new RegExp(jobStatus));
    assert.deepEqual(mutations(vercel.requests), []);
  }));
}

test("refuses while a rolling release is moving traffic", () => withVercel({
  tweak: state => { state.deployments.find(item => item.uid === "dpl_live").readySubstate = "ROLLING"; },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /rolling/i);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("automatic rollback leaves production alone when a newer deployment goes live before the request", () => withVercel({
  swapLiveOnAliasRead: 2,
  swapLiveTo: "dpl_newer",
}, async (vercel, exec) => {
  const result = await exec(["--if-live", LIVE_URL]);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /no longer live/);
  assert.deepEqual(mutations(vercel.requests), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_newer");
}));

test("rollback waits until the alias job succeeds even after the domain already points at the target", () => withVercel({
  aliasSettlePolls: 3,
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 0, result.output);
  const postAt = vercel.requests.findIndex(request => request.method === "POST");
  const projectReads = vercel.requests.slice(postAt + 1).filter(request => request.path.startsWith("/v9/projects/"));
  assert.ok(projectReads.length >= 3, `${projectReads.length} project reads after rollback\n${result.output}`);
  assert.equal(vercel.state.project.lastAliasRequest.jobStatus, "succeeded");
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
}));

test("rollback fails when the alias job fails even if the domain already moved", () => withVercel({
  aliasJobStatus: "failed",
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 2);
  assert.match(result.output, /failed/);
  assert.equal(mutations(vercel.requests).length, 1);
  assert.doesNotMatch(result.output, /now serves/);
}));

test("automatic rollback acts when the failing deployment is live and the newest", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--if-live", LIVE_URL, "--reason", "money-path smoke failed"]);
  assert.equal(result.code, 0, result.output);
  assert.equal(mutations(vercel.requests).length, 2);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
}));

const autoRefusals = {
  "a different deployment is live": { arg: "https://rooindustries-previous-roo-industries.vercel.app" },
  "the failing deployment is not the newest production deployment": {
    arg: "https://rooindustries-previous-roo-industries.vercel.app",
    tweak: state => { state.aliases[DOMAIN].deploymentId = "dpl_previous"; },
  },
  "production is already rolled back": { tweak: state => { state.project.autoAssignCustomDomains = false; } },
  "the deployment URL is unknown": { arg: "https://rooindustries-unknown-roo-industries.vercel.app" },
};
for (const [name, { arg = LIVE_URL, tweak }] of Object.entries(autoRefusals)) {
  test(`automatic rollback does nothing when ${name}`, () => withVercel({ tweak }, async (vercel, exec) => {
    const result = await exec(["--if-live", arg]);
    assert.notEqual(result.code, 0, result.output);
    assert.deepEqual(mutations(vercel.requests), []);
  }));
}

test("reports Vercel's refusal of the rollback and exits non-zero", () => withVercel({
  rollbackError: { status: 409, code: "conflict", message: "A rollback is already in progress" },
}, async (vercel, exec) => {
  const result = await exec([]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /409/);
  assert.match(result.output, /already in progress/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
}));

test("a rollback request whose answer is lost reports production's state as unknown and exits 2", () => withVercel({ dropMutationResponse: true }, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /state is unknown/);
  assert.match(result.output, /--status/);
  assert.equal(mutations(vercel.requests).length, 1);
}));

test("an undo request whose answer is lost reports production's state as unknown and exits 2", () => withVercel({
  dropMutationResponse: true,
  tweak: state => {
    state.aliases[DOMAIN].deploymentId = "dpl_previous";
    state.project.autoAssignCustomDomains = false;
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /state is unknown/);
}));

test("undo leaves production alone when a newer deployment goes live before the promote request", () => withVercel({
  swapLiveOnAliasRead: 2,
  swapLiveTo: "dpl_newer",
  tweak: state => {
    state.aliases[DOMAIN].deploymentId = "dpl_previous";
    state.project.autoAssignCustomDomains = false;
  },
}, async (vercel, exec) => {
  const result = await exec(["--undo"]);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /no longer live|target changed/);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("fails loudly when the domain does not move to the target after the rollback call", () => withVercel({ freezeAlias: true }, async (vercel, exec) => {
  const result = await exec([]);
  assert.equal(result.code, 2);
  assert.match(result.output, /not confirmed/);
  assert.equal(mutations(vercel.requests).length, 1);
  assert.equal(invalidations(vercel.requests).length, 0);
}));

test("finds the domain in the right team when the token sees several teams", () => withVercel({
  tweak: state => { state.teams.unshift({ id: "team_other", slug: "other", name: "Other" }); },
}, async (vercel, exec) => {
  const result = await exec(["--dry-run"]);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Target:\s+dpl_previous/);
}));

test("refuses when no team the token can see serves the domain", () => withVercel({}, async (vercel, exec) => {
  const result = await exec(["--dry-run", "--domain", "www.example.com"]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /www\.example\.com/);
  assert.deepEqual(mutations(vercel.requests), []);
}));

test("a rejected token stops before any change", () => withVercel({}, async (vercel, exec) => {
  const result = await exec([], { VERCEL_TOKEN: "wrong-token" });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /403/);
  assert.deepEqual(mutations(vercel.requests), []);
}));
