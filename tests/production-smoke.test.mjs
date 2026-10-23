import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
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
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SMOKE_RETRY_MS: "50", SMOKE_MARKER_TIMEOUT_MS: "2000", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, ...env },
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

test("a healthy site passes every money-path check with GET requests only", () => withSite({ packages: { postOnLoad: true } }, (site, result) => {
  assert.equal(result.code, 0, result.output);
  for (const name of ["page /", "page /packages", "page /booking", "page /payment", "booking availability", "package prices", "referral capture", "home page renders", "booking page renders", "payment page renders"]) {
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
      if (pathname === "/packages" && smokePid) execFileSync("pkill", ["-KILL", "-P", String(smokePid)]);
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
      if (pathname === "/packages" && smokePid) execFileSync("pkill", ["-KILL", "-P", String(smokePid)]);
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

for (const [name, body] of Object.entries({
  "application error": "<h1>Application error</h1><p>The homepage cannot render.</p>",
  "empty document": "",
  "navigation shell": "<nav>Roo Industries <a href='/packages'>Packages</a></nav>",
})) {
  test(`a 200 homepage with ${name} fails the smoke`, () => withSite({ bodies: { "/": body } }, (site, result) => {
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /FAIL\s+home page renders/);
    assert.deepEqual(site.requests.filter(request => request.method !== "GET"), []);
  }));
}

for (const [name, body] of Object.entries({
  "transparent heading": '<header id="top"><h1 style="opacity:0">PC performance optimization</h1><a href="/#packages">Book an optimization</a></header>',
  "hidden booking link": '<header id="top"><h1>PC performance optimization</h1><a href="/#packages" style="visibility:hidden">Book an optimization</a></header>',
  "transparent ancestor": '<div style="opacity:0"><header id="top"><h1>PC performance optimization</h1><a href="/#packages">Book an optimization</a></header></div>',
})) {
  test(`homepage visibility rejects a ${name}`, () => withSite({ bodies: { "/": body } }, (site, result) => {
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /FAIL\s+home page renders/);
  }));
}

for (const pathname of ["/", "/booking", "/payment"]) {
  test(`client readiness rejects a late startup failure on ${pathname}`, () => withSite({
    startup: { [pathname]: { delay: 500, error: true } },
  }, (site, result) => {
    assert.equal(result.code, 2, result.output);
    assert.ok(result.output.includes(`${pathname} has a rendering error: Fixture client startup failed`), result.output);
  }));
}

test("client readiness accepts a healthy delayed startup", () => withSite({
  startup: { "/booking": { delay: 500 } },
}, (site, result) => {
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(site.requests.filter(request => request.method !== "GET"), []);
}));

test("refuses unknown options", async () => {
  const result = await run(["--bse", "https://www.rooindustries.com"]);
  assert.equal(result.code, 1, result.output);
});

test("CI refuses the production smoke target before sending a request", async () => {
  const result = await run(["--base", "https://www.rooindustries.com"], null, { GITHUB_ACTIONS: "true" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /CI requires an explicit loopback smoke target/);
});

for (const scenario of ["image", "redirect", "redirect chain"]) {
  test(`CI blocks a browser ${scenario} to a destination outside its allowlist`, async () => {
    let escaped = 0;
    const external = http.createServer((request, response) => {
      escaped += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h3>Booking Summary</h3><p>The fixture payment page works.</p>");
    });
    await new Promise(resolve => external.listen(0, "127.0.0.2", resolve));
    const target = `http://127.0.0.2:${external.address().port}/outside`;
    let site;
    try {
      site = await startSite(scenario === "image" ? { bodies: {
        "/payment": `<h3>Booking Summary</h3><p>The payment page works.</p><img src="${target}" alt="Optional image">`,
      } } : { browserRedirects: {
        "/payment": scenario === "redirect" ? target : "/redirect-hop",
        "/redirect-hop": target,
      } });
      const result = await run(["--base", site.base], null, { GITHUB_ACTIONS: "true" });
      assert.equal(escaped, 0, result.output);
      assert.equal(result.code, scenario === "image" ? 0 : 2, result.output);
    } finally {
      await site?.close();
      external.closeAllConnections();
      await new Promise(resolve => external.close(resolve));
    }
  });
}

test("CI keeps a reset required script classified as a runner connection failure", async () => {
  const site = await startSite({ packages: { externalReferral: true }, resetReferralScript: true });
  try {
    const result = await run(["--base", site.base], null, { GITHUB_ACTIONS: "true" });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /couldn't load \/referral\.js/);
    assert.doesNotMatch(result.output, /money-path check\(s\) failed/);
  } finally {
    await site.close();
  }
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
  const vercel = await startVercel(vercelOptions);
  try {
    const exec = (env = {}) => runGate({ VERCEL_TOKEN: TOKEN, VERCEL_API_URL: vercel.origin, SMOKE_BASE_URL: site.base, DEPLOYMENT_URL: LIVE_URL, ...env });
    await body({ site, vercel, exec });
  } finally {
    await site.close();
    await vercel.close();
  }
};

const vercelChanges = vercel => vercel.requests.filter(request => request.method !== "GET");

for (const ci of [false, true]) {
  test(`deploy gate: a stalled decorative image leaves a healthy deployment live${ci ? " in a CI fixture" : ""}`, async () => {
    let imageRequests = 0;
    const external = http.createServer(() => { imageRequests += 1; });
    await new Promise(resolve => external.listen(0, "127.0.0.1", resolve));
    const imageUrl = `http://127.0.0.1:${external.address().port}/payment-logo.svg`;
    try {
      await withGate({ site: { bodies: {
        "/payment": `<h3>Booking Summary</h3><p>The payment page works.</p><img src="${imageUrl}" alt="Payment provider logo">`,
      } } }, async ({ vercel, exec }) => {
        const result = await exec(ci ? { GITHUB_ACTIONS: "true" } : {});
        assert.equal(result.code, 0, result.output);
        assert.ok(imageRequests > 0, "The browser must request the independent image origin.");
        assert.deepEqual(vercelChanges(vercel), []);
        assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
      });
    } finally {
      external.closeAllConnections();
      await new Promise(resolve => external.close(resolve));
    }
  });
}

test("deploy gate: CI rejects a nonlocal smoke before contacting the deployment provider", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec({ GITHUB_ACTIONS: "true", SMOKE_BASE_URL: "https://example.com" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /CI requires an explicit loopback SMOKE_BASE_URL/);
  assert.deepEqual(vercel.requests, []);
  assert.deepEqual(site.requests, []);
}));

test("deploy gate: a healthy live deployment passes and nothing is rolled back", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec({ GITHUB_ACTIONS: "true" });
  assert.equal(result.code, 0, result.output);
  assert.ok(site.requests.length > 0);
  assert.deepEqual(vercelChanges(vercel), []);
}));

test("deploy gate: a money-path failure is reported without unsafe automatic rollback", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.match(result.output, /FAIL\s+page \/payment/);
  assert.match(result.output, /Automatic rollback is disabled/);
}));

test("deploy gate: a CSP-blocked referral script fails without unsafe automatic rollback", () => withGate({
  site: { packages: { externalReferral: true }, cspScriptBlock: true },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /FAIL  referral capture/);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
  assert.match(result.output, /Automatic rollback is disabled/);
}));

test("deploy gate: a deployment that never serves production still gets production smoked, without a rollback", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ site, vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not serving production/);
  assert.match(result.output, /nothing was rolled back/);
  assert.ok(site.requests.length > 0);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("deploy gate: a healthy production passes even when this deployment isn't the live one", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: PREVIOUS_URL });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
}));

test("deploy gate: without VERCEL_TOKEN a failure is reported but nothing is rolled back", () => withGate({ site: { status: { "/payment": 500 } } }, async ({ vercel, exec }) => {
  const result = await exec({ VERCEL_TOKEN: undefined });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /not rolled back/);
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
  });
});

test("deploy gate: a runner that can't reach production rolls nothing back", () => withGate({ site: { dropNonBrowser: true } }, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
}));

test("deploy gate: a smoke that can't run doesn't roll anything back", () => withGate({}, async ({ vercel, exec }) => {
  const result = await exec({ SMOKE_BASE_URL: "https://example.com" });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
}));

test("deploy gate: an already rolled-back production is never rolled back further", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { tweak: state => { state.project.autoAssignCustomDomains = false; } },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.equal(vercel.state.aliases[DOMAIN].deploymentId, "dpl_live");
}));

test("deploy gate: an unconfirmable automatic rollback is never sent", () => withGate({
  site: { status: { "/payment": 500 } },
  vercel: { freezeAlias: true },
}, async ({ vercel, exec }) => {
  const result = await exec();
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(vercelChanges(vercel), []);
  assert.match(result.output, /automatic rollback did not run/);
  assert.doesNotMatch(result.output, /rollback was sent/);
}));

test("deploy gate: refuses to run without the deployment URL", () => withGate({}, async ({ site, vercel, exec }) => {
  const result = await exec({ DEPLOYMENT_URL: undefined });
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(site.requests, []);
  assert.deepEqual(vercel.requests, []);
}));
