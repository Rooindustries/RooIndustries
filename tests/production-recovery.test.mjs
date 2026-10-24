import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DOMAIN, TOKEN, HISTORY_TOKEN } from "./fixtures/fake-vercel.mjs";
import { changes, execute, withLockTools, withRecovery, LIVE_URL, root } from "./fixtures/production-recovery.mjs";
import { startSite } from "./fixtures/fake-site.mjs";
import { execFileSync } from "node:child_process";

const proof = path.join(root, "test-results", "roo702-r3", process.env.ROO702_PROOF_PHASE || "latest");
fs.mkdirSync(proof, { recursive: true });

for (const pathname of ["/", "/booking", "/payment"]) {
  test(`round 3: a late application error on ${pathname} overrides unfinished initialization and resources`, () => withRecovery({
    site: {
      hang: ["/pending.js"], startup: { [pathname]: { requiresExternalReady: true } },
      bodies: { [pathname]: '<div id="app">Preparing the page. Please wait.</div><script>setTimeout(() => { document.getElementById("app").innerHTML = "<h1>Application error</h1><p>A client-side exception has occurred.</p>"; }, 400);</script><script async src="/pending.js"></script>' },
    },
  }, async ({ site, env, exec, vercel, previous }) => {
    const report = path.join(proof, `late-${pathname.slice(1) || "home"}.json`);
    const smoke = await execute("production-smoke.mjs", ["--base", site.base, "--report", report], { ...env, SMOKE_MARKER_TIMEOUT_MS: "1200" });
    const row = JSON.parse(fs.readFileSync(report, "utf8")).results.find(row => row.name === `${pathname === "/" ? "home" : pathname.slice(1)} page renders`);
    assert.equal(smoke.code, 2, smoke.output);
    assert.equal(row.ok, false);
    assert.equal(row.couldNotRun, undefined, smoke.output);
    assert.equal(row.initializationIncomplete, undefined, smoke.output);
    assert.match(row.detail, /application error/);
    const gate = await exec({ SMOKE_MARKER_TIMEOUT_MS: "1200" });
    assert.equal(gate.code, 1, gate.output);
    assert.equal(previous.requests.filter(request => request.path === "/api/payment/quote").length, 2, gate.output);
    assert.equal(changes(vercel).length, 1, gate.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    assert.match(gate.output, /production was rolled back/);
  }));
}

test("round 3: an error observed before readiness cannot disappear into a later healthy render", () => withRecovery({
  site: { startup: { "/payment": { initializeDelay: 800 } }, bodies: {
    "/payment": '<div id="app"><h3>Booking Summary</h3><p>Preparing the checkout.</p></div><script>setTimeout(() => { app.innerHTML = "<h1>Application error</h1>"; }, 200); setTimeout(() => { app.innerHTML = "<h3>Booking Summary</h3><p>Recovered checkout.</p>"; }, 450);</script>',
  } },
}, async ({ site, env }) => {
  const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, SMOKE_MARKER_TIMEOUT_MS: "1200" });
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /payment page renders.*application error/);
}));

test("round 3: late errors during the usable-control wait remain application failures", () => withRecovery({
  site: { bodies: { "/payment": '<div id="app" style="opacity:0"><h3>Booking Summary</h3><p>Preparing the checkout.</p></div><script>setTimeout(() => { app.style.opacity = 1; app.innerHTML = "<h1>Application error</h1>"; }, 400);</script>' } },
}, async ({ site, env }) => {
  const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, SMOKE_MARKER_TIMEOUT_MS: "1200" });
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /payment page renders.*application error/);
}));

test("round 3: healthy slow initialization with unfinished resources never rolls back", () => withRecovery({
  site: { hang: ["/pending.js"], startup: { "/payment": { initializeDelay: 1800 } }, bodies: {
    "/payment": '<h3>Booking Summary</h3><p>A healthy checkout is still starting.</p><script async src="/pending.js"></script>',
  } },
}, async ({ exec, vercel }) => {
  const result = await exec({ SMOKE_MARKER_TIMEOUT_MS: "1200" });
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.doesNotMatch(result.output, /production was rolled back/);
}));

for (const [name, options, hasPackage] of [
  ["package HTTP failure", { status: { "/packages": 500 } }, false],
  ["missing cards", { packages: { cards: [] } }, false],
  ["invalid prices", { packages: { cards: [{ name: "Vertex Essentials", price: "Unavailable" }] } }, false],
  ["structured price mismatch", { packages: { offers: [] } }, true],
  ["a malformed card beside a priced package", { packages: { cards: [{ name: "Malformed package", price: "Unavailable" }, { name: "Vertex Essentials", price: "$29.95" }] } }, true],
]) {
  test(`round 3: ${name} recovers without a fabricated payment cold start`, () => withRecovery({ site: options }, async ({ exec, vercel, site, previous }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    assert.match(result.output, /production was rolled back/);
    assert.equal(site.requests.filter(request => request.path === "/api/payment/quote").length, hasPackage ? 2 : 0);
    assert.equal(previous.requests.filter(request => request.path === "/api/payment/quote").length, 2);
  }));
}

const bypass = "fixture-automation-bypass-4c2a";
for (const failing of [false, true]) {
  test(`round 3: protected immutable probes ${failing ? "recover a confirmed regression" : "record passing history"} with real quotes`, () => withRecovery({
    site: { protection: bypass, ...(failing ? { status: { "/payment": 500 } } : {}) }, previous: { protection: bypass },
  }, async ({ exec, vercel, site, previous }) => {
    const result = await exec({ GITHUB_ACTIONS: "true", VERCEL_AUTOMATION_BYPASS_SECRET: bypass });
    assert.equal(result.code, failing ? 1 : 0, result.output);
    assert.equal(changes(vercel).length, failing ? 1 : 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, failing ? "dpl_previous" : "dpl_live");
    assert.ok(site.requests.length > 5);
    assert.ok(site.requests.every(request => request.bypass === bypass), JSON.stringify(site.requests));
    const quoted = failing ? previous : site;
    assert.equal(quoted.requests.filter(request => request.path === "/api/payment/quote").length, failing ? 2 : 1);
    assert.ok(quoted.requests.every(request => request.bypass === bypass));
    assert.doesNotMatch(result.output, new RegExp(bypass));
    if (!failing) assert.ok(vercel.requests.some(request => request.method === "POST" && request.path.endsWith("/deployments")));
  }));
}

test("round 3: a manual protected smoke keeps its bypass off foreign origins and redirects", async () => {
  const external = await startSite();
  try {
    await withRecovery({ site: { protection: bypass, scriptSources: { "/booking": `${external.base}/referral.js`, "/payment": "/redirect.js" }, browserRedirects: { "/redirect.js": `${external.base}/redirected.js` } } }, async ({ site, env }) => {
      const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: bypass });
      assert.equal(result.code, 0, result.output);
      assert.ok(site.requests.some(request => request.path === "/api/payment/quote" && request.bypass === bypass));
      assert.ok(external.requests.some(request => request.path === "/referral.js"));
      assert.ok(external.requests.every(request => !request.bypass), JSON.stringify(external.requests));
      assert.ok(external.requests.every(request => request.path !== "/redirected.js"), JSON.stringify(external.requests));
    });
  } finally { await external.close(); }
});

test("round 3: missing or wrong protection bypass never triggers recovery", () => withRecovery({
  site: { protection: bypass }, previous: { protection: bypass },
}, async ({ exec, vercel }) => {
  for (const value of ["", "fixture-wrong-bypass"]) {
    const result = await exec({ VERCEL_AUTOMATION_BYPASS_SECRET: value, SMOKE_MARKER_TIMEOUT_MS: "100" });
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }
}));

const rollingJob = job => ({ ...job, fromDeploymentId: "dpl_live", fromRollingReleaseId: "dpl_newer" });
for (const [name, options] of [
  ["succeeded", {}], ["failed", { aliasJobStatus: "failed" }], ["lost response", { dropMutationResponse: true }],
]) {
  test(`round 3: ${name} rolling-source recovery never confirms or promotes the canary`, () => withRecovery({
    site: { status: { "/payment": 500 } }, vercel: { swapLiveBeforeMutation: true, mutationJob: rollingJob, ...options },
  }, async ({ exec, vercel }) => {
    const result = await exec();
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    assert.equal(vercel.state.project.lastAliasRequest.fromRollingReleaseId, "dpl_newer");
    assert.match(result.output, /rolling release.*not confirmed|rolling.*cannot.*restor/i);
    assert.doesNotMatch(result.output, /production was rolled back|now serves dpl_previous|restored dpl_/);
  }));
}

for (const args of [[], ["--undo"]]) {
  test(`round 3: manual ${args.length ? "undo" : "rollback"} reports an interrupted rolling source`, () => withRecovery({
    vercel: { mutationJob: job => ({ ...job, fromRollingReleaseId: "dpl_newer" }) },
  }, async ({ env, vercel }) => {
    if (args.length) {
      vercel.state.aliases[DOMAIN].deploymentId = "dpl_previous";
      vercel.state.project.autoAssignCustomDomains = false;
    }
    const result = await execute("deploy-rollback.mjs", args, env);
    assert.equal(result.code, 2, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.match(result.output, /rolling release.*not confirmed|rolling.*cannot.*restor/i);
    assert.doesNotMatch(result.output, /now serves/);
  }));
}

test("round 3: a rolling source during race repair cannot be reported as restored", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: {
    swapLiveBeforeMutation: true,
    mutationJob: job => job.type === "promote" ? { ...job, fromRollingReleaseId: "dpl_newest" } : job,
  },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 2, result.output);
  assert.doesNotMatch(result.output, /production was rolled back|restored dpl_/);
  assert.match(result.output, /rolling release.*not confirmed|rolling.*cannot.*restor/i);
}));

for (const value of [null, "", 0, {}]) {
  test(`round 3: malformed rolling-source ${JSON.stringify(value)} never confirms a mutation`, () => withRecovery({
    vercel: { mutationJob: job => ({ ...job, fromRollingReleaseId: value }) },
  }, async ({ env, vercel }) => {
    const result = await execute("deploy-rollback.mjs", [], env);
    assert.equal(result.code, 2, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.doesNotMatch(result.output, /now serves/);
  }));
}

test("round 3: a displaced rolling deployment is never promoted to invent a full-traffic restoration", async () => {
  let state;
  await withRecovery({ site: { status: { "/payment": 500 } }, vercel: {
    swapLiveBeforeMutation: true,
    mutationJob: job => {
      if (job.type === "rollback") state.deployments.find(item => item.uid === "dpl_newer").readySubstate = "ROLLING";
      return job;
    },
  } }, async ({ exec, vercel }) => {
    state = vercel.state;
    const result = await exec();
    assert.equal(changes(vercel).length, 1, result.output);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /safe restoration cannot be established/);
    assert.doesNotMatch(result.output, /restored dpl_|production was rolled back/);
  });
});

test("round 3: manual undo refuses a rolling candidate before mutation", () => withRecovery({ vercel: { tweak: state => {
  state.aliases[DOMAIN].deploymentId = "dpl_previous";
  state.project.autoAssignCustomDomains = false;
  state.deployments.find(item => item.uid === "dpl_live").readySubstate = "ROLLING";
} } }, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", ["--undo"], env);
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
}));

test("round 3: rollback selection refuses a rolling candidate before mutation", () => withRecovery({ vercel: { tweak: state => {
  state.deployments.find(item => item.uid === "dpl_previous").readySubstate = "ROLLING";
} } }, async ({ env, vercel }) => {
  const result = await execute("deploy-rollback.mjs", [], env);
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
}));

test("round 3: rolling alias history cannot authorize an ordinary automatic source", () => withRecovery({
  site: { status: { "/payment": 500 } }, vercel: { tweak: state => { state.project.lastAliasRequest.fromRollingReleaseId = "dpl_newer"; } },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.doesNotMatch(result.output, /production was rolled back/);
}));

test("round 3: the protected smoke keeps credentials out of the real browser environment", async () => {
  let smokePid;
  let inspected = 0;
  const leaked = [];
  await withRecovery({ site: { protection: bypass, onRequest: () => {
    if (!smokePid || inspected) return;
    const children = execFileSync("ps", ["-o", "pid=", "--ppid", String(smokePid)], { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    for (const pid of children) {
      const environment = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
      inspected += 1;
      for (const marker of [bypass, TOKEN, HISTORY_TOKEN]) if (environment.includes(marker)) leaked.push(pid);
    }
  } } }, async ({ site, env }) => {
    const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: bypass }, child => { smokePid = child.pid; });
    assert.equal(result.code, 0, result.output);
    assert.ok(inspected > 0, "the actual smoke browser must be inspected");
    assert.deepEqual(leaked, []);
  });
});

test("round 3: a reflected automation credential is redacted from smoke diagnostics", () => withRecovery({ site: {
  protection: bypass, bodies: { "/payment": `<h3>Booking Summary</h3><p>Checkout is starting.</p><script>throw new Error(${JSON.stringify(bypass)});</script>` },
} }, async ({ site, env }) => {
  const result = await execute("production-smoke.mjs", ["--base", site.base], { ...env, VERCEL_AUTOMATION_BYPASS_SECRET: bypass });
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /rendering error: \[redacted\]/);
  assert.doesNotMatch(result.output, new RegExp(bypass));
}));

for (const automatic of [false, true]) {
  test(`round 3: an available rolling canary stops ${automatic ? "automatic" : "manual"} rollback before mutation`, () => withRecovery({
    site: { status: { "/payment": 500 } }, vercel: { tweak: state => {
      const live = state.deployments.find(item => item.uid === "dpl_live");
      state.deployments.unshift({ ...structuredClone(live), uid: "dpl_newer", url: "newer.vercel.app", readySubstate: "ROLLING", created: live.created + 1000, createdAt: live.created + 1000 });
    } },
  }, async ({ exec, env, vercel }) => {
    const result = automatic ? await exec() : await execute("deploy-rollback.mjs", [], env);
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 0, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  }));
}

test("round 3: an unconfirmed deployment event never receives the automation credential", async () => {
  const unconfirmed = await startSite({ protection: bypass });
  try {
    await withRecovery({ site: { protection: bypass } }, async ({ exec, scratch, site, previous, vercel }) => {
      const deployment = "https://unconfirmed.vercel.app";
      const eventPath = path.join(scratch, "event.json");
      fs.writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "Rooindustries/RooIndustries" },
        deployment: { environment: "Production" }, deployment_status: { state: "success", environment_url: deployment } }));
      const result = await exec({ DEPLOYMENT_URL: deployment, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "deployment_status",
        GITHUB_EVENT_PATH: eventPath, GITHUB_WORKFLOW_REF: "Rooindustries/RooIndustries/.github/workflows/production-smoke.yml@refs/heads/main",
        ROO_TEST_MONITOR_ORIGIN: site.base, ROO_TEST_PREVIOUS_ORIGIN: previous.base, ROO_TEST_UNCONFIRMED_ORIGIN: unconfirmed.base,
        SMOKE_BASE_URL: undefined, VERCEL_AUTOMATION_BYPASS_SECRET: bypass,
        NODE_OPTIONS: `--import=${path.join(root, "tests/fixtures/production-monitor-loader.mjs")}` });
      fs.writeFileSync(path.join(proof, "unconfirmed-event.json"), JSON.stringify({ result, site: site.requests, unconfirmed: unconfirmed.requests }, null, 2));
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(unconfirmed.requests, []);
      assert.equal(site.requests.filter(request => request.path === "/api/payment/quote").length, 1);
      assert.ok(site.requests.every(request => request.bypass === bypass));
      assert.equal(changes(vercel).length, 0);
    });
  } finally { await unconfirmed.close(); }
});

test("round 3: a transient quote response followed by lost connections remains inconclusive", () => withRecovery({
  site: { failFirst: { "/api/payment/quote": 1 }, resetQuote: true },
}, async ({ exec, vercel }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

for (const [pathname, heading] of [["/booking", "Select a Date and Time for Your Session"], ["/payment", "Booking Summary"]]) {
  test(`round 3: initialized but invisible ${pathname} UI cannot hide behind a pending script`, () => withRecovery({
    site: { hang: ["/pending.js"], bodies: { [pathname]: `<section style="opacity:0"><h3>${heading}</h3><p>The initialized page is invisible.</p></section><script async src="/pending.js"></script>` } },
  }, async ({ exec, vercel, previous }) => {
    const result = await exec({ SMOKE_MARKER_TIMEOUT_MS: "300" });
    assert.equal(result.code, 1, result.output);
    assert.equal(changes(vercel).length, 1, result.output);
    assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
    assert.equal(previous.requests.filter(request => request.path === "/api/payment/quote").length, 2);
    assert.match(result.output, /production was rolled back/);
  }));
}

test("round 3: a readiness marker without a real quote is an application failure despite pending resources", () => withRecovery({
  site: { hang: ["/pending.js"], startup: { "/payment": { requiresExternalReady: true } }, bodies: {
    "/payment": '<h3>Booking Summary</h3><p>Checkout incorrectly marked itself ready.</p><script>document.body.dataset.rooFlowReady="payment";</script><script async src="/pending.js"></script>',
  } },
}, async ({ exec, vercel, previous, site }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 1, result.output);
  assert.equal(site.requests.filter(request => request.path === "/api/payment/quote").length, 0);
  assert.equal(previous.requests.filter(request => request.path === "/api/payment/quote").length, 2);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
}));

test("round 3: healthy UI delayed until initialization cannot trigger recovery after downloads finish", () => withRecovery({
  site: { startup: { "/": { initializeDelay: 1500 } }, bodies: {
    "/": '<div id="app">Preparing the homepage. Please wait.</div><script>setTimeout(() => { app.innerHTML = "<header id=top><h1>PC optimization</h1><a href=/#packages>Book an optimization</a></header>"; }, 1500);</script>',
  } },
}, async ({ exec, vercel, site, env }) => {
  const healthy = await execute("production-smoke.mjs", ["--base", site.base], { ...env, SMOKE_MARKER_TIMEOUT_MS: "2500" });
  assert.equal(healthy.code, 0, healthy.output);
  const result = await exec({ SMOKE_MARKER_TIMEOUT_MS: "250" });
  assert.equal(result.code, 1, result.output);
  assert.equal(changes(vercel).length, 0, result.output);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("without flock, concurrent gates recover once while sharing the inherited lock", () => withLockTools(["perl", "git"], toolPath => withRecovery({
  site: { status: { "/payment": 500 } },
}, async ({ exec, vercel }) => {
  const results = await Promise.all([exec({ PATH: toolPath }), exec({ PATH: toolPath })]);
  assert.ok(results.every(result => result.code === 1), JSON.stringify(results));
  assert.equal(changes(vercel).length, 1, JSON.stringify(results));
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_previous");
  assert.ok(results.some(result => /production was rolled back/.test(result.output)), JSON.stringify(results));
})));

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
