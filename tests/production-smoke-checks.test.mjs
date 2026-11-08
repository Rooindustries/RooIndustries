import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startSite } from "./fixtures/fake-site.mjs";

const smoke = async (options, extra = {}) => {
  const site = await startSite(options);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-check-"));
  const report = path.join(directory, "report.json");
  try {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [...(extra.FIXTURE_SMOKE_FAULT ? ["--import", path.resolve("tests/fixtures/smoke-browser-faults.mjs")] : []),
        "scripts/production-smoke.mjs", "--base", site.base, "--report", report], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
          SMOKE_RETRY_MS: "10", SMOKE_MARKER_TIMEOUT_MS: "800", SMOKE_REQUEST_TIMEOUT_MS: "1500", ...extra },
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("close", code => resolve({ code, output }));
    });
    assert.ok(fs.existsSync(report), result.output);
    return { ...result, report: JSON.parse(fs.readFileSync(report, "utf8")), requests: site.requests };
  } finally {
    await site.close();
    fs.rmSync(directory, { recursive: true });
  }
};

test("a required script blocked by the smoke's CI policy makes the check inconclusive", async () => {
  const result = await smoke({ scriptSources: { "/booking": "https://fixture.invalid/optional.js" } }, {
    GITHUB_ACTIONS: "true",
  });
  assert.equal(result.code, 1, result.output);
  const booking = result.report.results.find(row => row.name === "booking page renders");
  assert.equal(booking.couldNotRun, true);
  assert.match(booking.detail, /smoke request policy/);
  assert.ok(result.requests.every(row => row.method === "GET"));
});

test("a client-cancelled required request cannot fail an initialized page", async () => {
  let release;
  const started = new Promise(resolve => { release = resolve; });
  const result = await smoke({
    onRequest: (pathname, request, response) => {
      if (request.url === "/api/payment/providers?cancelled=1") {
        release();
        return true;
      }
      if (pathname === "/__fixture/cancel-ready") {
        started.then(() => response.end("ready"));
        return true;
      }
    },
    bodies: { "/booking": `<h1>Select a Date and Time for Your Session</h1><script>
      const cancelled = new AbortController();
      fetch('/api/payment/providers?cancelled=1', { signal: cancelled.signal }).catch(() => {});
      fetch('/__fixture/cancel-ready').then(() => cancelled.abort());
    </script>` },
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.requests.some(row => row.path === "/__fixture/cancel-ready"));
  assert.equal(result.report.results.find(row => row.name === "booking page renders").ok, true);
});

for (const quote of [{ status: 503 }, { body: { ok: true } }, { body: { ok: false, error: "Unavailable" } }]) {
  test(`a real quote failure ${JSON.stringify(quote)} is a regression`, async () => {
    const result = await smoke({ quote });
    assert.equal(result.code, 2, result.output);
    assert.ok(result.requests.some(row => row.method === "GET" && row.path === "/api/payment/quote"));
    const row = result.report.results.find(row => row.name === "payment page renders");
    assert.equal(row.ok, false);
    assert.equal(row.couldNotRun, undefined);
    assert.match(row.detail, /quote/);
  });
}

test("a hung quote is a money-path regression", async () => {
  const result = await smoke({ hang: ["/api/payment/quote"] }, {
    SMOKE_REQUEST_TIMEOUT_MS: "250", SMOKE_MARKER_TIMEOUT_MS: "1500",
  });
  assert.equal(result.code, 2, result.output);
  const payment = result.report.results.find(row => row.name === "payment page renders");
  assert.equal(payment.ok, false);
  assert.equal(payment.couldNotRun, undefined);
  assert.match(payment.detail, /quote.*timed out/);
});

for (const resource of ["/__fixture/client-start.js", "/api/payment/providers"]) {
  for (const status of [404, 503]) {
    test(`required resource ${resource} answering ${status} is a money-path regression`, async () => {
      const result = await smoke({ status: { [resource]: status } });
      assert.equal(result.code, 2, result.output);
      const failures = result.report.results.filter(row => !row.ok);
      assert.ok(failures.length > 0);
      assert.ok(failures.every(row => !row.couldNotRun), result.output);
      assert.ok(failures.some(row => row.detail.includes(resource) && row.detail.includes(String(status))), result.output);
      assert.ok(result.requests.every(row => row.method === "GET"));
    });
  }
}

for (const resource of ["/api/payment/providers", "/api/payment/quote", "/api/bookingAvailability"]) {
  test(`a connection reset on required resource ${resource} is a money-path regression`, async () => {
    const result = await smoke({ reset: [resource] });
    assert.equal(result.code, 2, result.output);
    assert.ok(result.report.results.some(row => !row.ok && !row.couldNotRun), result.output);
    assert.ok(result.report.results.every(row => !row.couldNotRun), result.output);
  });
}

test("a required stylesheet failure cannot pass with initialized content", async () => {
  const result = await smoke({ bodies: {
    "/booking": '<link rel="stylesheet" href="/required.css"><h1>Select a Date and Time for Your Session</h1>',
  } });
  assert.equal(result.code, 2, result.output);
  const booking = result.report.results.find(row => row.name === "booking page renders");
  assert.equal(booking.couldNotRun, undefined);
  assert.match(booking.detail, /required\.css.*404/);
});

test("a hung required script cannot pass after checkout initializes", async () => {
  const result = await smoke({ hang: ["/required.js"], bodies: {
    "/payment": '<h3>Booking Summary</h3><script async src="/required.js"></script>',
  } }, { SMOKE_REQUEST_TIMEOUT_MS: "500" });
  assert.equal(result.code, 2, result.output);
  const payment = result.report.results.find(row => row.name === "payment page renders");
  assert.equal(payment.couldNotRun, undefined);
  assert.match(payment.detail, /required\.js.*timed out/);
});

for (const pathname of ["/", "/booking", "/payment"]) {
  test(`hidden initialized content on ${pathname} is a regression`, async () => {
    const result = await smoke({ bodies: { [pathname]: '<div style="opacity:0"><header id="top"><h1>PC game optimization</h1><a href="/#packages">Book a session</a></header><h1>Select a Date and Time for Your Session</h1><h3>Booking Summary</h3></div>' } });
    assert.equal(result.code, 2, result.output);
    assert.ok(result.report.results.some(row => !row.ok && !row.couldNotRun && row.name.endsWith("page renders")));
  });
}

test("unfinished checkout initialization is a money-path regression", async () => {
  const result = await smoke({ startup: { "/payment": { initializeDelay: 5000 } } });
  assert.equal(result.code, 2, result.output);
  assert.equal(result.report.results.find(row => row.name === "payment page renders").couldNotRun, undefined);
});

test("a late application error remains a regression while resources are unfinished", async () => {
  const result = await smoke({
    hang: ["/pending.js"], startup: { "/payment": { requiresExternalReady: true } },
    bodies: { "/payment": '<h3>Booking Summary</h3><div id="error">Preparing checkout</div><script>setTimeout(() => { error.textContent = "Application error"; }, 250)</script><script async src="/pending.js"></script>' },
  });
  assert.equal(result.code, 2, result.output);
  assert.match(result.report.results.find(row => row.name === "payment page renders").detail, /application error/);
});

for (const packages of [{ cards: [] }, { cards: [{ name: "Broken", price: "" }] }, { offers: [] }]) {
  test(`package failure ${JSON.stringify(packages)} preserves its cause for checkout`, async () => {
    const result = await smoke({ packages });
    assert.equal(result.code, 2, result.output);
    const row = result.report.results.find(row => row.name === "payment page renders");
    assert.equal(row.couldNotRun, undefined);
    assert.equal(row.initializationIncomplete, undefined);
    if (packages.offers) assert.equal(row.ok, true, result.output);
    else assert.match(row.detail, /no usable checkout package/);
  });
}

test("protected deployments accept only the configured origin's bypass", async () => {
  const protection = "fixture-protection-1234";
  const result = await smoke({ protection }, { VERCEL_AUTOMATION_BYPASS_SECRET: protection });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.requests.every(row => row.bypass === protection));
  assert.doesNotMatch(JSON.stringify(result.report), new RegExp(protection));
});

test("required resources refusing access are a money-path regression", async () => {
  const result = await smoke({ protection: "fixture-protection-1234" });
  assert.equal(result.code, 2, result.output);
  assert.ok(result.report.results.every(row => !row.ok && !row.couldNotRun), result.output);
});

 test("a loaded checkout with no payment provider is a money-path regression", async () => {
  const result = await smoke({ providersDisabled: true });
  assert.equal(result.code, 2, result.output);
  const payment = result.report.results.find(row => row.name === "payment page renders");
  assert.equal(payment.couldNotRun, undefined);
  assert.match(payment.detail, /no usable payment provider/);
});

for (const resource of ["/booking", "/__fixture/client-start.js", "/api/payment/quote",
  "/api/payment/providers", "/api/bookingAvailability"]) {
  test(`a redirect to a healthy final response passes for ${resource}`, async () => {
    const result = await smoke({ onRequest: (pathname, request, response) => {
      const url = new URL(request.url, "http://fixture");
      if (pathname !== resource || url.searchParams.has("redirected")) return;
      url.searchParams.set("redirected", "1");
      response.writeHead(302, { Location: url.pathname + url.search });
      response.end();
      return true;
    } });
    assert.equal(result.code, 0, result.output);
    assert.ok(result.requests.every(row => row.method === "GET"));
  });
}

test("a required script redirect loop fails even after the page initializes", async () => {
  const result = await smoke({ redirectLoop: ["/loop.js"], bodies: {
    "/booking": '<h1>Select a Date and Time for Your Session</h1><script async src="/loop.js"></script>',
  } });
  assert.equal(result.code, 2, result.output);
  const booking = result.report.results.find(row => row.name === "booking page renders");
  assert.equal(booking.couldNotRun, undefined);
  assert.match(booking.detail, /redirect/i);
});

test("browser launch time belongs to the smoke before site requests start", async () => {
  const result = await smoke({}, { FIXTURE_SMOKE_FAULT: "launch", SMOKE_DEADLINE_MS: "200" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /browser launch/i);
  assert.deepEqual(result.requests, []);
});

test("a deadline without an outstanding site request names the smoke phase", async () => {
  const result = await smoke({}, { FIXTURE_SMOKE_FAULT: "navigation", SMOKE_DEADLINE_MS: "500" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /deadline.*package prices/i);
  assert.equal(result.report.results.find(row => row.name === "package prices").couldNotRun, true);
});

test("unexpected response handler errors report their cause and cannot pass", async () => {
  const result = await smoke({}, { FIXTURE_SMOKE_FAULT: "handler" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /fixture response handler failed/);
  assert.match(result.output, /fixture handler cause/);
});

test("redirects cannot take ordinary CI requests outside the local fixture", async () => {
  const result = await smoke({ onRequest: (pathname, request, response) => {
    if (pathname !== "/booking") return;
    response.writeHead(302, { Location: "https://fixture.invalid/booking" });
    response.end();
    return true;
  } }, { GITHUB_ACTIONS: "true" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /smoke request policy/);
});

test("a handler waiting after the site responds cannot spend the site's deadline", async () => {
  const result = await smoke({}, {
    FIXTURE_SMOKE_FAULT: "handler-wait", SMOKE_DEADLINE_MS: "3000", SMOKE_MARKER_TIMEOUT_MS: "5000",
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /deadline.*home page renders/i);
  assert.equal(result.report.results.find(row => row.name === "home page renders").couldNotRun, true);
});

test("unexpected body reader errors remain smoke failures with their cause", async () => {
  const result = await smoke({}, { FIXTURE_SMOKE_FAULT: "body" });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /fixture body reader failed/);
  assert.match(result.output, /fixture reader cause/);
});

for (const resource of ["/api/payment/quote", "/api/payment/providers", "/api/bookingAvailability"]) {
  test(`a failed redirected API still fails initialized booking for ${resource}`, async () => {
    const target = await startSite({ status: { "/final-api": 503 } });
    try {
      const result = await smoke({
        onRequest: (pathname, request, response) => {
          if (pathname !== resource) return;
          response.writeHead(302, { Location: `${target.base}/final-api` });
          response.end();
          return true;
        },
        bodies: { "/booking": `<h1>Select a Date and Time for Your Session</h1>
          <script>fetch('${resource}').catch(() => {});</script>` },
      });
      const booking = result.report.results.find(row => row.name === "booking page renders");
      assert.equal(booking.ok, false, result.output);
      assert.equal(booking.couldNotRun, undefined);
      assert.match(booking.detail, /final-api.*503/);
      assert.ok(target.requests.every(row => row.method === "GET"));
    } finally {
      await target.close();
    }
  });
}
