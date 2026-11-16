import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packages, startSite } from "./fixtures/fake-site.mjs";
import { DOMAIN, TOKEN, startVercel } from "./fixtures/fake-vercel.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/production-smoke.mjs");

const run = (args, onSpawn, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_RETRY_MS: "50", SMOKE_MARKER_TIMEOUT_MS: "400", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, ...env },
  });
  onSpawn?.(child);
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});

const withSite = async (overrides, body) => {
  const site = await startSite(overrides);
  try {
    await body(site, await run(["--base", site.base]));
  } finally {
    await site.close();
  }
};

const stopChildren = parentPid => {
  const output = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" });
  const pids = output.trim().split("\n")
    .map(row => row.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === parentPid)
    .map(([pid]) => pid);
  assert.ok(pids.length, `No child processes found for ${parentPid}`);
  for (const pid of pids) process.kill(pid, "SIGKILL");
};

test("a healthy site passes every money-path check with GET requests only", () => withSite({ packages: { postOnLoad: true } }, (site, result) => {
  assert.equal(result.code, 0, result.output);
  for (const name of ["page /", "page /packages", "page /booking", "page /payment", "booking availability", "package prices", "referral capture", "booking page renders", "payment page renders"]) {
    assert.match(result.output, new RegExp(`ok\\s+${name.replace("/", "\\/")}`));
  }
  assert.deepEqual(site.requests.filter(request => request.method !== "GET"), []);
}));

test("a hung money page that times out is a money-path failure inside the smoke deadline", async () => {
  const site = await startSite({ hang: ["/"] });
  try {
    const started = Date.now();
    const result = await run(["--base", site.base], null, { SMOKE_DEADLINE_MS: "5000", SMOKE_REQUEST_TIMEOUT_MS: "300" });
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /FAIL\s+page \/:/);
    assert.ok(Date.now() - started < 15000, `took ${Date.now() - started}ms`);
  } finally {
    await site.close();
  }
});

test("running out of the smoke's own time budget is a smoke that could not run", async () => {
  const site = await startSite({ dropNonBrowser: true });
  try {
    const result = await run(["--base", site.base], null, { SMOKE_DEADLINE_MS: "400" });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /smoke deadline/);
    assert.doesNotMatch(result.output, /money-path check\(s\) failed/);
  } finally {
    await site.close();
  }
});

test("a money page that fails is a money-path failure", () => withSite({ status: { "/payment": 500 } }, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+page \/payment.*500/);
}));

test("a payment redirect loop is a money-path failure", () => withSite({ redirectLoop: ["/payment"] }, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+payment page renders/);
}));

test("booking availability that isn't ok is a money-path failure", () => withSite({ availability: { ok: false, error: "unavailable" } }, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+booking availability/);
}));

test("booking availability without the occupied-slot list is a money-path failure", () => withSite({
  availability: { ok: true, settings: { dateSlots: [{ date: "2026-11-01", times: ["2", "3"] }] } },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+booking availability: has no bookedSlots list/);
}));

test("package cards without a price are a money-path failure", () => withSite({
  packages: { cards: [{ name: "Vertex Essentials", price: "" }, packages[1]] },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+package prices/);
}));

test("structured data prices that disagree with the cards are a money-path failure", () => withSite({
  packages: { offers: [{ name: "Vertex Essentials", price: "$19.95" }, packages[1]] },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+package prices/);
}));

test("a booking page that shows the slot picker after the calendar loads still passes", () => withSite({
  bodies: {
    "/booking": "<p>Fixture page loading the calendar for this session.</p><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<h3>Select a Date and Time for Your Session</h3>'), 150)</script>",
  },
}, (site, result) => {
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /ok\s+booking page renders/);
}));

test("a booking page without the slot picker is a money-path failure", () => withSite({
  bodies: { "/booking": "<p>Fixture page /booking with its usual content.</p>" },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+booking page renders: \/booking is missing "Select a Date and Time for Your Session"/);
}));

test("a payment page without the booking summary is a money-path failure", () => withSite({
  bodies: { "/payment": "<p>Fixture page /payment with its usual content.</p>" },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+payment page renders: \/payment is missing "Booking Summary"/);
}));

test("a ?ref link that isn't remembered is a money-path failure", () => withSite({ packages: { storeReferral: false } }, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL\s+referral capture/);
}));

test("a brief outage on one page is retried before it counts", () => withSite({ failFirst: { "/booking": 1 } }, (site, result) => {
  assert.equal(result.code, 0, result.output);
  assert.equal(site.requests.filter(request => request.path === "/booking").length, 3);
}));

for (const base of ["https://example.com", "https://rooindustries.com.attacker.example", "ftp://127.0.0.1"]) {
  test(`refuses to smoke ${base}`, async () => {
    const result = await run(["--base", base]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Refusing/);
  });
}

test("a confirmed page failure still counts when the browser later disconnects", async () => {
  let smokePid;
  const site = await startSite({
    status: { "/": 500 },
    onRequest: (pathname) => {
      if (pathname === "/packages" && smokePid) stopChildren(smokePid);
    },
  });
  try {
    const result = await run(["--base", site.base], (child) => { smokePid = child.pid; });
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /FAIL\s+page \/.*500/);
    assert.match(result.output, /money-path check\(s\) failed/);
    assert.doesNotMatch(result.output, /Smoke could not run/);
  } finally {
    await site.close();
  }
});

test("a browser that dies mid-run means the smoke could not run, not a money-path failure", async () => {
  let smokePid;
  const site = await startSite({
    onRequest: (pathname) => {
      if (pathname === "/packages" && smokePid) stopChildren(smokePid);
    },
  });
  try {
    const result = await run(["--base", site.base], (child) => { smokePid = child.pid; });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Smoke could not run/);
    assert.doesNotMatch(result.output, /money-path check\(s\) failed/);
  } finally {
    await site.close();
  }
});

test("a booking page that renders nothing is a money-path failure even with a 200", () => withSite({ bodies: { "/booking": "" } }, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL  booking page renders: \/booking rendered no visible content/);
}));

test("a payment page that shows an application error is a money-path failure", () => withSite({
  bodies: { "/payment": "<h1>Application error</h1><p>a client-side exception has occurred</p>" },
}, (site, result) => {
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /FAIL  payment page renders: \/payment shows an application error/);
}));

test("refuses unknown options", async () => {
  const result = await run(["--bse", "https://www.rooindustries.com"]);
  assert.equal(result.code, 1, result.output);
});

const gate = path.join(root, "scripts/production-deploy-gate.mjs");
const LIVE_URL = "https://rooindustries-live-roo-industries.vercel.app";
const PREVIOUS_URL = "https://rooindustries-previous-roo-industries.vercel.app";

const runGate = (env) => new Promise(resolve => {
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    SMOKE_RETRY_MS: "50",
    GATE_LIVE_ATTEMPTS: "2",
    GATE_LIVE_WAIT_MS: "20",
    ROLLBACK_VERIFY_INTERVAL_MS: "20",
    ROLLBACK_VERIFY_TIMEOUT_MS: "400",
    ...env,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const child = spawn(process.execPath, [gate], { cwd: root, env: childEnv });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});

const withGate = async ({ site: siteOverrides, vercel: vercelOptions } = {}, body) => {
  const site = await startSite(siteOverrides);
  let smokeRequestsAtInvalidation = null;
  const vercel = await startVercel({ ...vercelOptions, onInvalidate: info => { smokeRequestsAtInvalidation = site.requests.length; vercelOptions?.onInvalidate?.(info); } });
  try {
    const exec = async (env = {}) => {
      const result = await runGate({ VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_rooFixture", VERCEL_API_URL: vercel.origin, SMOKE_BASE_URL: site.base, DEPLOYMENT_URL: LIVE_URL, ...env });
      assert.doesNotMatch(result.output, new RegExp(TOKEN));
      return result;
    };
    await body({ site, vercel, exec, smokeRequestsAtInvalidation: () => smokeRequestsAtInvalidation });
  } finally {
    await site.close();
    await vercel.close();
  }
};

const vercelChanges = vercel => vercel.requests.filter(request => request.method !== "GET" && request.path !== "/v1/edge-cache/invalidate-by-tags");
const invalidations = vercel => vercel.requests.filter(request => request.path === "/v1/edge-cache/invalidate-by-tags");
const rebuildMessage = reason => `The page rebuild did not run: ${reason}. Production has moved: see the lines above, or run \`npm run deploy:rollback -- --status\`, for what it serves. Its pages can be stale until their timer expires (at most an hour). Finish with: npm run deploy:rollback -- --rebuild-pages`;
const expectRebuildMessage = (output, reason, annotated = false) => {
  const lines = output.split("\n").filter(line => line.startsWith("The page rebuild did not run:") || line.startsWith("::error::The page rebuild did not run:"));
  const expected = rebuildMessage(reason);
  assert.deepEqual(lines.sort(), (annotated ? [expected, `::error::${expected}`] : [expected]).sort());
  for (const line of lines) {
    assert.doesNotMatch(line, /\bdpl_[a-zA-Z0-9]+\b|https?:\/\/\S+|\b[a-zA-Z0-9.-]+\.vercel\.app\b/);
    assert.ok(line.endsWith("npm run deploy:rollback -- --rebuild-pages"));
  }
};
const expectSuccess = output => {
  const lines = output.split("\n").filter(line => line.startsWith("Production pages marked stale"));
  assert.deepEqual(lines, ["Production pages marked stale; each rebuilds on its next visit."]);
  assert.doesNotMatch(lines[0], /\bdpl_[a-zA-Z0-9]+\b|https?:\/\/\S+|\b[a-zA-Z0-9.-]+\.vercel\.app\b/);
};
const expectMovedWithoutRebuild = (output, annotated = false) => {
  const lines = output.split("\n").filter(line => line.startsWith("error: The money-path smoke failed, production was rolled back") || line.startsWith("::error::The money-path smoke failed, production was rolled back"));
  const prefix = annotated ? "::error::" : "error: ";
  assert.deepEqual(lines, [`${prefix}The money-path smoke failed, production was rolled back, but the page rebuild did not run. Fix forward, then run npm run deploy:rollback -- --undo so new deployments go live again.`]);
  assert.doesNotMatch(lines[0], /\bdpl_[a-zA-Z0-9]+\b|https?:\/\/\S+|\b[a-zA-Z0-9.-]+\.vercel\.app\b/);
  assert.doesNotMatch(output, /automatic rollback did not run/);
};
const expectInvalidate = request => {
  assert.equal(request.method, "POST");
  assert.deepEqual(request.query, { projectIdOrName: "prj_rooFixture", teamId: "team_rooFixture" });
  assert.deepEqual(request.body, { tags: "_N_T_/layout" });
};

test("deploy gate: a passing smoke marks pages stale once after its last request", () => withGate({}, async ({ site, vercel, exec, smokeRequestsAtInvalidation }) => {
  const result = await exec();
  assert.equal(result.code, 0, result.output);
  assert.equal(invalidations(vercel).length, 1);
  expectInvalidate(invalidations(vercel)[0]);
  assert.equal(vercelChanges(vercel).length, 0);
  assert.ok(smokeRequestsAtInvalidation() > 0);
  assert.equal(smokeRequestsAtInvalidation(), site.requests.length);
  expectSuccess(result.output);
}));

test("deploy gate: a passing smoke fails on an invalidation error without rolling back", () => withGate({ vercel: { invalidateError: { status: 503, message: "cache unavailable" } } }, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(invalidations(vercel).length, 1);
  expectInvalidate(invalidations(vercel)[0]);
  assert.equal(vercelChanges(vercel).length, 0);
  expectRebuildMessage(result.output, "Vercel answered 503: cache unavailable");
}));

for (const failed of [false, true]) {
  test(`deploy gate: a failed smoke rolls back and ${failed ? "reports the child's failed rebuild without repeating it" : "rebuilds once in the rollback child"}`, () => withGate({
    site: { status: { "/payment": 500 } },
    vercel: failed ? { invalidateError: { status: 503, message: "cache unavailable" } } : {},
  }, async ({ vercel, exec }) => {
    const result = await exec(failed ? { GITHUB_ACTIONS: "true" } : {});
    assert.equal(result.code, 1, result.output);
    assert.equal(vercelChanges(vercel).length, 1);
    assert.match(vercelChanges(vercel)[0].path, /\/rollback\/dpl_previous$/);
    assert.equal(invalidations(vercel).length, 1);
    expectInvalidate(invalidations(vercel)[0]);
    assert.ok(invalidations(vercel)[0].index > vercelChanges(vercel)[0].index);
    if (failed) {
      expectRebuildMessage(result.output, "Vercel answered 503: cache unavailable", true);
      expectMovedWithoutRebuild(result.output, true);
    } else assert.ok(result.output.split("\n").includes(`error: The money-path smoke failed on ${LIVE_URL}, so production was rolled back. Fix forward, then run npm run deploy:rollback -- --undo so new deployments go live again.`));
  }));
}

test("deploy gate: a rollback followed by a lost rebuild answer reports the move", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { invalidateDropWithoutApply: true },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.equal(vercelChanges(vercel).length, 1);
  assert.equal(invalidations(vercel).length, 1);
  expectRebuildMessage(result.output, "the call got no answer (fetch failed), so whether Vercel applied it is unknown");
  expectMovedWithoutRebuild(result.output);
}));

test("deploy gate: a rejected rollback keeps the existing failure message", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { rollbackError: { status: 400, message: "rollback rejected" } },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.equal(vercelChanges(vercel).length, 1);
  assert.equal(invalidations(vercel).length, 1);
  assert.ok(result.output.split("\n").includes(`error: The money-path smoke failed on ${LIVE_URL} and the automatic rollback did not run (see above).`));
  assert.doesNotMatch(result.output, /production was rolled back, but the page rebuild did not run/);
}));

test("deploy gate: a failed smoke on another deployment still marks pages stale", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 1, result.output);
  assert.equal(vercelChanges(vercel).length, 0);
  assert.equal(invalidations(vercel).length, 1);
  expectInvalidate(invalidations(vercel)[0]);
}));

test("deploy gate: a smoke that cannot run still marks pages stale", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ SMOKE_BASE_URL: "https://example.com" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /The money-path smoke could not run/);
  assert.equal(vercelChanges(vercel).length, 0);
  assert.equal(invalidations(vercel).length, 1);
  expectInvalidate(invalidations(vercel)[0]);
}));

test("deploy gate: a failed live lookup with a passing smoke still marks pages stale", () => withGate({
  vercel: { tweak: state => { state.aliases[DOMAIN].projectId = "prj_other"; } },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Automatic rollback was unavailable because the live deployment could not be read/);
  assert.equal(vercelChanges(vercel).length, 0);
  assert.equal(invalidations(vercel).length, 1);
  expectInvalidate(invalidations(vercel)[0]);
}));

test("deploy gate: a healthy live deployment passes and nothing is rolled back", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 0, result.output);
  assert.ok(site.requests.length > 0);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a money-path failure on the live deployment rolls production back once", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { forbidTeams: true },
}, async ({ vercel, exec }) => {
  const result = await exec({ CI: "true", VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_rooFixture" });
  assert.equal(result.code, 1, result.output);
  const changes = vercelChanges(vercel);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "/v1/projects/prj_rooFixture/rollback/dpl_previous");
  assert.ok(vercel.requests.every(request => request.path !== "/v2/teams" && request.query.teamId === "team_rooFixture"));
  assert.match(changes[0].query.description, /Money-path smoke failed/);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.match(result.output, /--undo/);
}));

test("deploy gate: a CSP-blocked referral script rolls production back once", () => withGate({
  site: { packages: { externalReferral: true }, cspScriptBlock: true },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL  referral capture/);
  const changes = vercelChanges(vercel);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].path, "/v1/projects/prj_rooFixture/rollback/dpl_previous");
  assert.match(changes[0].query.description, /Money-path smoke failed/);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.match(result.output, /--undo/);
}));

test("deploy gate: a deployment that never serves production still gets production smoked, without a rollback", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ site, vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not serving production/);
  assert.match(result.output, /nothing was rolled back/);
  assert.ok(site.requests.length > 0);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("deploy gate: a healthy production passes even when this deployment isn't the live one", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /not serving production/);
  assert.equal(vercel.requests.filter(request => request.path === `/v4/aliases/${DOMAIN}`).length, 2);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a later lookup can confirm the deployment went live", () => withGate({
  vercel: { swapLiveOnAliasRead: 2, swapLiveTo: "dpl_previous" },
}, async ({ vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /not serving production/);
  assert.equal(vercel.requests.filter(request => request.path === `/v4/aliases/${DOMAIN}`).length, 2);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a passing smoke fails the gate when the live deployment lookup fails", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec({ GITHUB_ACTIONS: "true", VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_wrong" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /::error::Automatic rollback was unavailable because the live deployment could not be read: Refusing: VERCEL_PROJECT_ID is prj_wrong, but the live deployment belongs to prj_rooFixture\./);
  assert.match(result.output, /ok\s+payment page renders/);
  assert.doesNotMatch(result.output, /not serving production/);
  assert.ok(site.requests.length > 0);
  assert.equal(vercel.requests.filter(request => request.path === `/v4/aliases/${DOMAIN}`).length, 2);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a failed smoke and failed live lookup both report errors without a rollback", () => withGate({
  site: { status: { "/payment": 500 } },
}, async ({ site, vercel, exec }) => {
  const result = await exec({ GITHUB_ACTIONS: "true", VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_wrong" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL\s+page \/payment.*500/);
  assert.match(result.output, /::error::The money-path smoke failed on .*nothing was rolled back/);
  assert.match(result.output, /::error::Automatic rollback was unavailable because the live deployment could not be read: Refusing: VERCEL_PROJECT_ID is prj_wrong/);
  assert.doesNotMatch(result.output, /not serving production/);
  assert.ok(site.requests.length > 0);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a failed final lookup takes precedence over an earlier different live deployment", () => withGate({
  vercel: {
    swapLiveOnAliasRead: 2,
    swapLiveTo: "dpl_previous",
    tweak: state => { state.deployments.find(deployment => deployment.uid === "dpl_previous").projectId = "prj_other"; },
  },
}, async ({ vercel, exec }) => {
  const result = await exec({ CI: "true", VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_rooFixture", DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Automatic rollback was unavailable.*VERCEL_PROJECT_ID is prj_rooFixture, but the live deployment belongs to prj_other/);
  assert.match(result.output, /ok\s+payment page renders/);
  assert.doesNotMatch(result.output, /not serving production/);
  assert.equal(vercel.requests.filter(request => request.path === `/v4/aliases/${DOMAIN}`).length, 2);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a successful final lookup clears an earlier lookup failure", () => withGate({
  vercel: {
    swapLiveOnAliasRead: 2,
    swapLiveTo: "dpl_previous",
    tweak: state => { state.deployments.find(deployment => deployment.uid === "dpl_live").projectId = "prj_other"; },
  },
}, async ({ vercel, exec }) => {
  const result = await exec({ CI: "true", VERCEL_TEAM_ID: "team_rooFixture", VERCEL_PROJECT_ID: "prj_rooFixture" });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /not serving production/);
  assert.doesNotMatch(result.output, /Automatic rollback was unavailable/);
  assert.equal(vercel.requests.filter(request => request.path === `/v4/aliases/${DOMAIN}`).length, 2);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: a failed lookup is reported even when the smoke cannot run", async () => {
  const result = await runGate({
    GITHUB_ACTIONS: "true",
    VERCEL_TOKEN: TOKEN,
    VERCEL_TEAM_ID: "team_rooFixture",
    VERCEL_PROJECT_ID: "invalid",
    DEPLOYMENT_URL: LIVE_URL,
    SMOKE_BASE_URL: "https://example.com",
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /The money-path smoke could not run, so nothing was rolled back/);
  assert.match(result.output, /::error::Automatic rollback was unavailable because the live deployment could not be read: Refusing: VERCEL_PROJECT_ID must start with prj_/);
  assert.doesNotMatch(result.output, /not serving production/);
});

test("deploy gate: without VERCEL_TOKEN a healthy smoke reports that the rebuild did not run", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ VERCEL_TOKEN: undefined });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /warning: VERCEL_TOKEN is not set/);
  expectRebuildMessage(result.output, "VERCEL_TOKEN is not set");
  assert.deepEqual(vercel.requests, []);
}));

test("deploy gate: without VERCEL_TOKEN a failure is reported but nothing is rolled back", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ vercel, exec }) => {
  const result = await exec({ VERCEL_TOKEN: undefined });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not rolled back/);
  expectRebuildMessage(result.output, "VERCEL_TOKEN is not set");
  assert.deepEqual(vercel.requests, []);
}));

test("a runner that can't reach the site is a smoke that could not run, not a money-path failure", () => withSite({ dropNonBrowser: true }, (site, result) => {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Smoke could not run/);
  assert.doesNotMatch(result.output, /money-path check\(s\) failed/);
}));

test("a connection that drops mid-page is a smoke that could not run, not a money-path failure", () => withSite({ resetFetchMidBody: ["/booking"] }, (site, result) => {
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Smoke could not run/);
  assert.doesNotMatch(result.output, /money-path check\(s\) failed/);
}));

test("deploy gate: a connection that drops mid-page rolls nothing back", () => withGate({ site: { resetFetchMidBody: ["/booking"] } }, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("a page script the runner couldn't download is a smoke that could not run, and the gate rolls nothing back", async () => {
  const healthy = await startSite({ packages: { externalReferral: true } });
  try {
    const result = await run(["--base", healthy.base]);
    assert.equal(result.code, 0, result.output);
  } finally {
    await healthy.close();
  }
  await withGate({ site: { packages: { externalReferral: true }, resetReferralScript: true } }, async ({ vercel, exec }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /couldn't load \/referral\.js/);
    assert.deepEqual(vercelChanges(vercel), []);
    assert.equal(invalidations(vercel).length, 1);
  });
});

test("deploy gate: a runner that can't reach production rolls nothing back", () => withGate({ site: { dropNonBrowser: true } }, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("only successful Production deployments share the smoke queue, so a Preview event can't replace a pending Production smoke", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-smoke.yml", import.meta.url), "utf8");
  assert.match(workflow, /group: production-smoke-\$\{\{ github\.event\.deployment\.environment \}\}-\$\{\{ github\.event\.deployment_status\.state \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("every queued production smoke waits its turn without cancelling another deployment's smoke", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-smoke.yml", import.meta.url), "utf8");
  const concurrency = workflow.match(/^concurrency:\s*\n(?:[ \t]+[^\n]*\n)*/m)?.[0];
  assert.ok(concurrency, "The production smoke workflow must define concurrency.");
  assert.match(concurrency, /^  queue: max\s*$/m);
  assert.match(concurrency, /^  cancel-in-progress: false\s*$/m);
});

test("deploy gate: a smoke that can't run doesn't roll anything back", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ SMOKE_BASE_URL: "https://example.com" });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
}));

test("deploy gate: an already rolled-back production is never rolled back further", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { tweak: state => { state.project.autoAssignCustomDomains = false; } },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(invalidations(vercel).length, 1);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("deploy gate: an accepted rollback that is not confirmed says the request was sent", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { freezeAlias: true },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(vercelChanges(vercel).length, 1);
  assert.equal(invalidations(vercel).length, 1);
  assert.match(result.output, /rollback was sent, but production was not confirmed/);
  assert.doesNotMatch(result.output, /did not run/);
}));

test("deploy gate: refuses to run without the deployment URL", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: undefined });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(site.requests, []);
  assert.deepEqual(vercel.requests, []);
}));
