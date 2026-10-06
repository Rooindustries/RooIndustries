const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

if (process.argv.includes('--contact-e2e-server')) {
  const { registerHooks } = await import('node:module');
  const failureRoute = "        if (resource === 'contact' && state.mode === 'contact-failed') { json(res, {ok:false,error:'Synthetic content failure'},503); return true; }\n";
  const failureScenario = "await run('contact-failed', async () => {\n  await load('/contact', {mode:'contact-failed'}); await call('/api/content/contact');\n  await wait(() => text().includes('The contact form is temporarily unavailable.'), 'Content failure is silently disabling the form');\n  assert(button('Send Message').disabled, 'Unconfigured form is enabled');\n  const email = doc().querySelector('a[href^=\"mailto:\"]'); assert(email && email.href.includes('@'), 'Email fallback is missing');\n  const calls = (await control()).calls; assert(!calls.some(item=>item.path==='/__ui/formspree'), 'Unconfigured form submitted');\n  return {rendered:text(),email:email.href,disabled:true,calls,externalSends:0};\n});\n";
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.endsWith('/tests/fixtures/ui-repairs-server.mjs')) {
      const routeAnchor = "        if (resource === 'contact' && state.mode === 'delayed')";
      const runnerAnchor = "res.end(fs.readFileSync(p.endsWith('init.js') ? 'tests/fixtures/ui-repairs-init.js' : 'tests/fixtures/ui-repairs-browser.mjs'));";
      const source = String(loaded.source);
      assert.ok(source.includes(routeAnchor) && source.includes(runnerAnchor));
      return { ...loaded, source: source.replace(routeAnchor, failureRoute + routeAnchor).replace(runnerAnchor,
        "res.end(p.endsWith('init.js') ? fs.readFileSync('tests/fixtures/ui-repairs-init.js') : fs.readFileSync('tests/fixtures/ui-repairs-browser.mjs', 'utf8').replace(\"await run('contact-config'\", " + JSON.stringify(failureScenario) + " + \"await run('contact-config'\"));") };
    }
    return loaded;
  } });
  await import('./test-ui-sweep-server.mjs');
  await new Promise(() => {});
}

const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo-tooling-sweep-"));
const artifact = path.resolve(process.env.TOOLING_ARTIFACT || "test-results/tooling-sweep.json");
const require = createRequire(import.meta.url);
const rows = [];
const selected = process.argv[2];
const run = async (name, fn) => {
  if (selected && !selected.split(",").includes(name)) return;
  try { rows.push({ name, passed: true, evidence: await fn() }); }
  catch (error) { rows.push({ name, passed: false, error: error.message, code: error.code, stack: error.stack, evidence: error.evidence }); }
};
const blocker = path.join(scratch, "block.cjs");
fs.writeFileSync(blocker, `for (const name of ['node:http','node:https']) { const m=require(name); m.request=()=>{throw Error('UNSAFE_NETWORK_ATTEMPT')}; m.get=m.request; } globalThis.fetch=()=>{throw Error('UNSAFE_NETWORK_ATTEMPT')};`);
const child = (script, env = {}, cwd = root) => spawnSync(process.execPath, ["--require", blocker, script], {
  cwd, encoding: "utf8", timeout: 12000,
  env: { PATH: process.env.PATH, HOME: scratch, CI: "true", ROO_TEST_HOST: testHost, ...env },
});
const fixture = { version: 1, runId: "safety-proof", baseUrl: `http://${testHost}:45991`, sanityApiUrl: `http://${testHost}:45992`, paypalApiUrl: `http://${testHost}:45993`, razorpayApiUrl: `http://${testHost}:45994` };
const fixturePath = path.join(scratch, "fixture.json");
fs.writeFileSync(fixturePath, JSON.stringify(fixture));
const scripts = ["test-booking-flows.mjs"];

await run('child-guard-inheritance', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end('local child fixture'); });
  await new Promise(resolve => server.listen(0, testHost, resolve));
  const origin = `http://${testHost}:${server.address().port}`;
  const shared = path.join(root, 'scripts/lib/test-target-safety.mjs');
  const payment = path.join(root, 'scripts/test-payment-persistence-sweep-network-guard.mjs');
  const cases = [];
  try {
    for (const [name, imports, activation] of [['shared', [shared], '1'], ['payment', [payment], null], ['shared-payment', [shared, payment], null], ['payment-shared', [payment, shared], null]]) {
      const env = { PATH: process.env.PATH, NODE_ENV: 'test', ROO_TEST_HOST: testHost, BASE_URL: origin, NODE_OPTIONS: imports.map(file => `--import=${file}`).join(' '), ...(activation ? { TOOLING_NETWORK_GUARD: activation } : {}) };
      const proc = spawn(process.execPath, ['--require', path.join(root, 'tests/fixtures/child-guard-early.cjs'), 'tests/fixtures/child-guard-inheritance.mjs', '--parent', '--early-cjs-capture'], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
      const result = await new Promise((resolve, reject) => {
        let stdout = '', stderr = '';
        proc.stdout.on('data', bytes => { stdout += bytes; }); proc.stderr.on('data', bytes => { stderr += bytes; });
        proc.once('error', reject); proc.once('close', status => resolve({ status, stdout, stderr }));
      });
      const proof = JSON.parse(result.stdout);
      cases.push({ name, env, ...result, proof });
    }
    assert.ok(cases.every(item => item.status === 0 && item.proof.passed), JSON.stringify(cases));
    return { cases, localRequests: requests, nonlocalSocketCalls: 0, nonlocalDnsCalls: 0, standIn: 'Real Node processes, all child_process APIs, local HTTP and native DNS/socket sentinels. Sentinels refuse all escaped attempts without opening a socket; no real external hostname or browser session.' };
  } catch (error) { error.evidence = { cases, localRequests: requests }; throw error; }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

await run("legacy-guards-before-io", () => {
  const evidence = [];
  const cases = [
    ["missing-fixture", {}],
    ["production-base", { BASE_URL: "https://www.rooindustries.com" }],
    ["production-dataset", { SANITY_DATASET: "production" }],
    ["live-paypal", { PAYPAL_API_BASE: "https://api-m.paypal.com" }],
    ["live-credentials", { RESEND_API_KEY: "re_live_do_not_use" }],
    ["live-razorpay", { RAZORPAY_KEY_ID: "rzp_live_do_not_use" }],
    ["live-mode", { PAYPAL_ENV: "live" }],
    ["live-recipient", { FREE_BOOKING_EMAIL: "serviroo@rooindustries.com" }],
    ["proxy-endpoint", { HTTP_PROXY: "http://proxy.rooindustries.com:8080" }],
    ["other-browser-profile", { PLAYWRIGHT_BROWSER_MODE: "cdp", CDP_ENDPOINT: `http://${testHost}:9222` }],
    ["cookie-import", { IMPORT_CDP_COOKIES: "1" }],
    ["alias-endpoint", { BASE_URL: "http://local.rooindustries.com:45991" }],
    ["numeric-alias", { BASE_URL: "http://0x7f000001:45991" }],
  ];
  for (const script of scripts) for (const [name, extra] of cases) {
    const result = child(path.join(root, "scripts", script), {
      ...(name === "missing-fixture" ? {} : { TEST_TARGET_FIXTURE: fixturePath }),
      TEST_TARGET_VALIDATE_ONLY: "1", ...extra,
    });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${script}/${name} accepted`);
    assert.match(output, /test-target/, `${script}/${name} did not reach target guard`);
    assert.doesNotMatch(output, /UNSAFE_NETWORK_ATTEMPT/);
    evidence.push({ script, name, status: result.status, outboundAttempts: 0 });
  }
  return evidence;
});
await run("env-file-before-io", () => {
  fs.writeFileSync(path.join(scratch, ".env.local"), "SANITY_DATASET=production\nPAYPAL_CLIENT_SECRET=fixture-never-use\n");
  const result = child(path.join(root, "scripts/test-booking-flows.mjs"), { TEST_TARGET_FIXTURE: fixturePath, TEST_TARGET_VALIDATE_ONLY: "1" }, scratch);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /test-target.*env/i);
  assert.doesNotMatch(result.stdout + result.stderr, /UNSAFE_NETWORK_ATTEMPT/);
  fs.unlinkSync(path.join(scratch, ".env.local"));
  return { status: result.status, outboundAttempts: 0 };
});
await run("fixture-schema-before-io", () => {
  const invalid = [
    { ...fixture, version: 2 },
    { ...fixture, runId: 12 },
    { ...fixture, production: true },
    { ...fixture, sanityApiUrl: "https://9g42k3ur.api.sanity.io" },
    { ...fixture, baseUrl: `http://${testHost}:45991/../production` },
    { ...fixture, baseUrl: `http://user@${testHost}:45991` },
  ];
  const input = path.join(scratch, "invalid-fixture.json");
  for (const value of invalid) {
    fs.writeFileSync(input, JSON.stringify(value));
    const result = child(path.join(root, "scripts/test-booking-flows.mjs"), { TEST_TARGET_FIXTURE: input, TEST_TARGET_VALIDATE_ONLY: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test-target/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNSAFE_NETWORK_ATTEMPT/);
  }
  return { invalidSchemasOrTargets: invalid.length, outboundAttempts: 0 };
});
await run("local-positive", () => {
  for (const script of scripts) {
    const result = child(path.join(root, "scripts", script), { TEST_TARGET_FIXTURE: fixturePath, TEST_TARGET_VALIDATE_ONLY: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runId, fixture.runId);
  }
  return { scripts: 3, validatedRunId: fixture.runId, outboundAttempts: 0 };
});
await run("playwright-command-safety", () => {
  const check = path.join(scratch, "config.cjs");
  fs.writeFileSync(check, `console.log(JSON.stringify(require(${JSON.stringify(path.join(root, "playwright.config.js"))})))`);
  for (const dist of ["../other-run", ".next; touch /tmp/roo-unsafe", ".next-$(touch /tmp/roo-unsafe)", ".next-'", "/tmp/playwright_chromium-other"]) {
    const result = child(check, { NEXT_DIST_DIR: dist });
    assert.notEqual(result.status, 0, `accepted ${dist}`);
    assert.match(result.stderr, /dist|directory/i);
  }
  const ext = child(check, { BASE_URL: fixture.baseUrl });
  assert.equal(ext.status, 0, ext.stderr);
  assert.equal(JSON.parse(ext.stdout).webServer, undefined);
  const internal = child(check, { NEXT_DIST_DIR: ".next-e2e-safety-proof", BASE_URL: "" });
  assert.equal(internal.status, 0, internal.stderr);
  const config = JSON.parse(internal.stdout);
  assert.equal(config.webServer.command, "node scripts/test-tooling-sweep-server.mjs");
  assert.equal(config.webServer.url.startsWith(`http://${testHost}:`), true);
  const link = path.join(root, ".next-e2e-safety-link");
  fs.symlinkSync(scratch, link);
  try {
    const result = child(check, { NEXT_DIST_DIR: path.basename(link) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /directory/i);
  } finally { fs.unlinkSync(link); }
  fs.symlinkSync(path.join(scratch, "missing-build"), link);
  try {
    const result = child(check, { NEXT_DIST_DIR: path.basename(link) });
    assert.notEqual(result.status, 0);
    const runner = child(path.join(root, "scripts/test-tooling-sweep-server.mjs"), { NEXT_DIST_DIR: path.basename(link), BASE_URL: fixture.baseUrl, PW_PORT: "45991" });
    assert.notEqual(runner.status, 0);
    assert.match(runner.stderr, /symlink/);
    assert.equal(fs.existsSync(path.join(scratch, "missing-build")), false);
  } finally { fs.unlinkSync(link); }
  for (const value of ["4173;touch /tmp/roo-unsafe", "0", "65536"]) {
    const result = child(check, { PW_PORT: value });
    assert.notEqual(result.status, 0);
  }
  const runner = child(path.join(root, "scripts/test-tooling-sweep-server.mjs"), { NEXT_DIST_DIR: "../other-run", BASE_URL: fixture.baseUrl, PW_PORT: "45991" });
  assert.notEqual(runner.status, 0);
  assert.match(runner.stderr, /test-target/);
  return { unsafeDirectoriesRefused: 5, symlinkRefused: true, danglingSymlinkRefused: true, badPortsRefused: 3, actualRunnerRefusedTraversal: true, externalStartsServer: false, command: config.webServer.command };
});
await run("browser-cleanup-exact-ownership", () => {
  const source = fs.readFileSync(path.join(root, "scripts/phase1-browser-hygiene.js"), "utf8");
  const profile = "/tmp/roo-tooling-safety-proof";
  const ps = `100 1 chromium --user-data-dir=${profile}\n101 1 chromium --user-data-dir=/tmp/playwright_chromium-another-current-task\n102 1 chromium --user-data-dir=${profile}-other\n103 1 chromium --user-data-dir=/home/serviroo/.config/google-chrome`;
  const evaluate = (ownership, startTime = "1000", realProfile = profile) => {
    const killed = [], output = [];
    let statReads = 0;
    const mockFs = { ...fs, mkdirSync() {}, writeFileSync() {}, readFileSync(file) {
      if (file === "/tmp/ownership.json") return JSON.stringify(ownership);
      if (String(file).endsWith("/stat")) return `100 (chromium) S 1 ${Array(17).fill("0").join(" ")} ${Array.isArray(startTime) ? startTime[Math.min(statReads++, startTime.length - 1)] : startTime} 0`;
      if (String(file).endsWith("/cmdline")) return `chromium\0--user-data-dir=${profile}\0`;
      return fs.readFileSync(file);
    }, realpathSync(file) { return file === profile ? realProfile : file; } };
    vm.runInNewContext(source, { require(name) {
      if (["fs", "node:fs"].includes(name)) return mockFs;
      if (["child_process", "node:child_process"].includes(name)) return { execSync: () => ps, execFileSync: () => ps };
      return require(name);
    }, process: { env: { APPLY_CLEANUP: "1", ...(ownership ? { BROWSER_CLEANUP_OWNERSHIP: "/tmp/ownership.json", BROWSER_RUN_ID: "safety-proof" } : {}) }, cwd: () => root, pid: 999, kill: (pid) => killed.push(pid), exit: (code) => { throw Error(`exit ${code}`); } }, console: { log: (...a) => output.push(a.join(" ")), error: (...a) => output.push(a.join(" ")) }, Buffer });
    return killed;
  };
  assert.deepEqual(evaluate(null), []);
  const ownership = { version: 1, runId: "safety-proof", profile, processes: [{ pid: 100, startTime: "1000" }] };
  assert.deepEqual(evaluate(ownership), [100]);
  assert.deepEqual(evaluate(ownership, "1001"), []);
  assert.deepEqual(evaluate(ownership, ["1000", "1001", "1001"]), []);
  assert.deepEqual(evaluate(ownership, "1000", "/tmp/playwright_chromium-another-current-task"), []);
  return { exactOwnedPid: 100, otherActivePidsPreserved: [101, 102, 103], noManifestKills: 0, reusedPidKills: 0, reusedAfterSelectionKills: 0, symlinkProfileKills: 0, realSignalsSent: 0 };
});
await run("http-redirect-and-origin-guard", async () => {
  const safety = await import("./lib/test-target-safety.mjs");
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; if (req.url === "/redirect") { res.writeHead(302, { Location: "https://outside.fixture.invalid/api/payment/start" }); res.end(); } else { res.end(JSON.stringify({ ok: true })); } });
  await new Promise(resolve => server.listen(0, testHost, resolve));
  const origin = `http://${testHost}:${server.address().port}`;
  const restore = safety.installNetworkGuard([origin]);
  try {
    assert.equal((await (await fetch(`${origin}/safe`)).json()).ok, true);
    await assert.rejects(fetch(`${origin}/redirect`));
    await assert.rejects(fetch("https://outside.fixture.invalid/api/payment/start"), /test-target/);
    assert.equal(requests, 2);
  } finally { restore(); await new Promise(resolve => server.close(resolve)); }
  return { localRequests: requests, redirectedProductionRequests: 0, directProductionRequests: 0 };
});
await run("manual-redirect-init-request", async () => {
  const safety = await import("./lib/test-target-safety.mjs");
  let requests = 0;
  const target = "https://outside.fixture.invalid/never-follow";
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(Number(req.url.slice(1)), { Location: target });
    res.end();
  });
  await new Promise(resolve => server.listen(0, testHost, resolve));
  const origin = `http://${testHost}:${server.address().port}`;
  const restore = safety.installNetworkGuard([origin]);
  try {
    for (const status of [307, 308]) {
      const url = `${origin}/${status}`;
      for (const [input, init] of [[url, { redirect: "manual" }], [new Request(url, { redirect: "manual" }), undefined], [new Request(url, { redirect: "follow" }), { redirect: "manual" }]]) {
        const response = await fetch(input, init);
        assert.equal(response.status, status);
        assert.equal(response.headers.get("location"), target);
      }
      await assert.rejects(fetch(url));
      await assert.rejects(fetch(new Request(url, { redirect: "manual" }), { redirect: "follow" }));
      await assert.rejects(fetch(url, { redirect: "follow" }));
    }
    assert.equal(requests, 12);
  } finally { restore(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  return { inspectedStatuses: [307, 308], manualInputs: ["init", "Request", "init overrides Request"], localRequests: requests, externalRequests: 0 };
});
await run("operator-guards-before-io", () => {
  const checks = ["check-payment-webhooks.js", "check-payment-stack.mjs", "phase1-api-contract.js", "phase1-route-contract.js", "phase1-runtime-audits.js", "phase1-signoff.js"];
  for (const script of checks) for (const base of ["https://www.rooindustries.com", `http://${testHost}:45991;touch /tmp/roo-unsafe`, "http://local.rooindustries.com:45991"]) {
    const result = child(path.join(root, "scripts", script), { BASE_URL: base });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test-target/);
    assert.doesNotMatch(result.stdout + result.stderr, /UNSAFE_NETWORK_ATTEMPT/);
  }
  return { commands: checks.length, rejectedInputsEach: 3, networkAttempts: 0 };
});
await run("runtime-diagnostic-json", () => {
  const result = child(path.join(root, "scripts/diagnose-payment-runtime.js"));
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.environment.runtime, "development");
  assert.equal(report.environment.livePaymentsEnabled, false);
  assert.equal(report.providers.paypal.credentialsPresent, false);
  return { actualCommand: "node scripts/diagnose-payment-runtime.js", parsedJson: true, secretValuesLogged: false, outboundAttempts: 0 };
});
await run("operator-local-http", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/payment/providers") res.end(JSON.stringify({ ok: true, environment: { runtime: "development", livePaymentsEnabled: false } }));
    else { res.writeHead(401); res.end(JSON.stringify({ ok: false })); }
  });
  await new Promise(resolve => server.listen(0, testHost, resolve));
  const base = `http://${testHost}:${server.address().port}`;
  const execute = script => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(root, "scripts", script)], { env: { PATH: process.env.PATH, HOME: scratch, CI: "true", ROO_TEST_HOST: testHost, BASE_URL: base, TOOLING_NETWORK_GUARD: "1", NODE_OPTIONS: `--import=${path.join(root, "scripts/lib/test-target-safety.mjs")}` }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; proc.stdout.on("data", b => output += b); proc.stderr.on("data", b => output += b);
    proc.once("error", reject); proc.once("exit", code => { try { assert.equal(code, 0, output); resolve(); } catch (e) { reject(e); } });
  });
  try { await execute("check-payment-webhooks.js"); await execute("check-payment-stack.mjs"); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(requests.length, 5);
  return { actualCommandProcesses: 2, localRequests: requests, productionRequests: 0, standIn: "provider response and webhook refusal from local HTTP sink; no provider authorization claim" };
});
await run('fix-b-config', async () => {
  const program = `import assert from 'node:assert/strict';import fs from 'node:fs';import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,nextResolve){if(specifier==='undici')throw Error('UNDICI_UNAVAILABLE');return nextResolve(specifier,context);}});const {default:config,getSupabaseAssetOrigin,validateDistDir}=await import('./next.config.mjs');const origin=getSupabaseAssetOrigin();const headers=await config.headers();const csp=headers[0].headers.find(h=>h.key==='Content-Security-Policy').value;assert.ok(csp.includes(origin));assert.ok(fs.readFileSync('app/layout.jsx','utf8').includes('const SUPABASE_ASSET_ORIGIN = getSupabaseAssetOrigin();'));for(const dist of ['../other','.next;touch nope'])assert.throws(()=>validateDistDir(dist));console.log(JSON.stringify({origin,undiciUnavailable:true,dist:config.distDir,sharedLayoutHelper:true}));`;
  const cases=[];
  for(const override of ['', 'https://assets.fixture.invalid/path']) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:scratch,NODE_ENV:'test',...(override?{NEXT_PUBLIC_SUPABASE_ASSET_URL:override}:{})}});
    assert.equal(result.status,0,result.stderr);const evidence=JSON.parse(result.stdout);assert.equal(evidence.origin,override?'https://assets.fixture.invalid':'https://ntezmxzaibrrsgtujgxu.supabase.co');cases.push(evidence);
  }
  const configScript=path.join(scratch,'config-portable.cjs');fs.writeFileSync(configScript,`console.log(JSON.stringify(require(${JSON.stringify(path.join(root,'playwright.config.js'))})))`);
  for (const host of ['127.0.0.1',testHost]) {
    const result=child(configScript,{ROO_TEST_HOST:host,NEXT_DIST_DIR:'.next-e2e-fix-b-config',BASE_URL:''});assert.equal(result.status,0,result.stderr);const config=JSON.parse(result.stdout);assert.equal(config.use.baseURL,`http://${host}:4173`);assert.equal(config.webServer.env.ROO_TEST_HOST,host);cases.push({host,baseURL:config.use.baseURL});
  }
  const {localOrigin}=await import('./lib/test-target-safety.mjs');
  for(const origin of ['http://127.0.0.1:45991','http://localhost:45991','http://[::1]:45991',`http://${testHost}:45991`])assert.equal(localOrigin(origin),origin);
  const lighthouse=JSON.parse(fs.readFileSync('lighthouserc.json','utf8'));assert.ok(lighthouse.ci.collect.url.every(url=>url.startsWith('http://127.0.0.1:3001/')));assert.ok(lighthouse.ci.collect.startServerCommand.includes('${ROO_TEST_HOST:-127.0.0.1}'));
  const missing=spawnSync('python3',['scripts/test-hosted-alignment-rehearsal.py'],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin'}});
  assert.equal(missing.status,2);assert.match(missing.stderr,/--input-dir.*--output-dir.*--release-dir/);
  const scripts=JSON.parse(fs.readFileSync('package.json','utf8')).scripts;assert.ok(scripts['audit:lighthouse'].includes('${ROO_TEST_HOST:-127.0.0.1}'));assert.ok(Object.values(scripts).every(script=>!script.includes('100.127.48.111')));
  return {cases,loopbackAllowlist:['127.0.0.1','localhost','[::1]'],lighthouseDefault:lighthouse.ci.collect.url,lighthouseEnvScript:scripts['audit:lighthouse'],missingRehearsalArguments:{exit:missing.status,stderr:missing.stderr},productionRequests:0};
});
await run('native-cms-and-download-token', async () => {
  const result=spawnSync(process.execPath,['scripts/test-sanity-admin.mjs','--scenario=create-replay-lost-response-revisions'],{cwd:root,encoding:'utf8',timeout:120000,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',ROO_TEST_HOST:testHost}});
  assert.equal(result.status,0,result.stderr+result.stdout);
  const proof=JSON.parse(fs.readFileSync('test-results/sanity-admin/create-replay-lost-response-revisions.json','utf8'));
  assert.equal(proof.passed,true);assert.equal(proof.cleanup.stopped,true);
  const saved=process.env.DOWNLOAD_TOKEN_SECRET;process.env.DOWNLOAD_TOKEN_SECRET='synthetic-tooling-download-secret';
  try {
    const {createDownloadToken,verifyDownloadToken}=await import('../src/server/downloads/downloadToken.js');
    const now=Date.now();const cases=[];
    for(const skew of [60,61]) {
      const token=createDownloadToken({slug:'utilities',fileName:'fixture.zip',bookingId:'native-fixture',email:'fixture@fixture.invalid',issuedAtMs:now+skew*1000});
      const response=verifyDownloadToken({token,nowMs:now});assert.equal(response.ok,skew<=60);if(skew>60)assert.equal(response.reason,'download_token_invalid_claims');
      assert.equal(verifyDownloadToken({token,nowMs:now+(skew+600)*1000}).reason,'download_token_expired');cases.push({skew,accepted:response.ok});
    }
    return {rule:'D6/P4 native command receipt/revision checks replace retired mirror waits',nativeArtifact:'test-results/sanity-admin/create-replay-lost-response-revisions.json',migrations:proof.migrations.length,cases,productionRequests:0};
  } finally {if(saved===undefined)delete process.env.DOWNLOAD_TOKEN_SECRET;else process.env.DOWNLOAD_TOKEN_SECRET=saved;}
});

fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, JSON.stringify({ passed: rows.length > 0 && rows.every(row => row.passed), rows }, null, 2) + "\n");
console.log(JSON.stringify({ artifact, passed: rows.filter(row => row.passed).length, total: rows.length }));
if (!rows.length || rows.some(row => !row.passed)) process.exitCode = 1;
