import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = http.createServer((request, response) => {
  fixtureRequests++;
  if (["/redirect-budget", "/budget-landing", "/redirect-unending"].includes(request.url)) {
    setTimeout(() => {
      if (request.url === "/budget-landing") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<p>fixture-ok</p>"); }
      else { response.writeHead(302, { Location: request.url === "/redirect-unending" ? "/unending" : "/budget-landing" }); response.end(); }
    }, 650).unref();
  } else if (request.url === "/unending") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.write("<p>Waiting");
  } else if (request.method === "GET" && ["/", "/landing"].includes(request.url)) {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<p>fixture-ok</p>' + (request.url === "/landing" ? '<img src="/delayed.svg" alt="Delayed fixture">' : ""));
  } else if (request.url.startsWith("/redirect")) {
    const url = new URL(request.url, "http://fixture.invalid");
    const targets = {
      "/redirect-local": "/landing#fixture",
      "/redirect-local-hop": "/redirect-local",
      "/redirect-hop": "/redirect?status=307",
      "/redirect-loop": "/redirect-loop#fixture",
      "/redirect-invalid": "http://[",
      "/redirect-credentials": `http://fixture:fixture@127.0.0.1:${fixture.address().port}/`,
      "/redirect-scheme": "data:text/html,refused",
      "/redirect-slow": "/slow",
    };
    const location = targets[url.pathname] || `http://127.0.0.1:${sink.address().port}/`;
    response.writeHead(Number(url.searchParams.get("status") || 302), { Location: location });
    response.end();
  } else if (request.url === "/delayed.svg" || request.url === "/slow") {
    setTimeout(() => { response.setHeader("Content-Type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }, request.url === "/slow" ? 5000 : 250).unref();
  } else if (request.url === "/echo") {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ method: request.method, body })); });
  } else if (request.url === "/failure") {
    response.writeHead(503);
    response.end("fixture-unavailable");
  } else {
    response.writeHead(404);
    response.end();
  }
});
const sink = http.createServer((_request, response) => {
  sinkRequests++;
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.end("sink");
});
const redirect = http.createServer();
let assetOutsideRequests = 0;
const assets = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/stream") {
    streamRequests++;
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": fixtureOrigin, "Access-Control-Allow-Credentials": "true" });
    response.write('{"ok":');
  }
  else if (request.url === "/storage/v1/redirect") { response.writeHead(307, { Location: `http://127.0.0.1:${sink.address().port}/` }); response.end(); }
  else if (request.url === "/storage/v1/path-redirect") { response.writeHead(302, { Location: "/outside.svg" }); response.end(); }
  else { if (request.url === "/outside.svg") assetOutsideRequests++; response.setHeader("Content-Type", "image/svg+xml"); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); }
});
const standIn = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
let standInBytes = 0;
const standInUpgrades = [];
let standInWire = "";
let standInFrames = 0;
const standInSockets = new Set();
standIn.on("connection", socket => {
  standInSockets.add(socket);
  socket.on("close", () => standInSockets.delete(socket));
  socket.on("data", chunk => { standInBytes += chunk.length; standInWire += chunk.toString("latin1"); });
});
standIn.on("upgrade", (request, socket) => {
  socket.on("error", () => {});
  if (request.headers["x-stand-in-reply"] === "200") return socket.resume().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
  if (request.headers["x-stand-in-reply"] === "keep-alive") return socket.resume().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
  if (request.headers["x-stand-in-reply"] === "stall") return socket.resume();
  standInUpgrades.push({ method: request.method, url: request.url, upgrade: request.headers.upgrade, connection: request.headers.connection });
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.on("data", chunk => { standInFrames += chunk.length; socket.end(); });
  socket.on("end", () => socket.end());
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
let fixtureRequests = 0;
let fixtureUpgrades = 0;
let sinkRequests = 0;
let sinkBytes = 0;
let sinkConnections = 0;
let streamRequests = 0;
let fixtureOrigin;
let endpoint;
let redirectEndpoint;
let browserServer;

fixture.on("upgrade", (_request, socket) => {
  fixtureUpgrades++;
  socket.destroy();
});
sink.on("connection", socket => {
  sinkConnections++;
  socket.on("data", chunk => { sinkBytes += chunk.length; });
});
redirect.on("upgrade", (_request, socket) => {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${sink.address().port}/\r\nContent-Length: 0\r\n\r\n`);
});

const listen = server => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const close = server => new Promise((resolve, reject) => {
  if (!server.listening) return resolve();
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections();
});

before(async () => {
  await Promise.all([listen(fixture), listen(sink), listen(redirect), listen(standIn), listen(assets)]);
  fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  if (process.env.PW_TEST_CONNECT_WS_ENDPOINT) endpoint = process.env.PW_TEST_CONNECT_WS_ENDPOINT;
  else {
    browserServer = await chromium.launchServer({ host: "127.0.0.1" });
    const url = new URL(browserServer.wsEndpoint());
    url.hostname = "127.0.0.1";
    endpoint = url.href;
  }
  redirectEndpoint = `ws://127.0.0.1:${redirect.address().port}/`;
});

after(async () => {
  await browserServer?.close();
  for (const socket of standInSockets) socket.destroy();
  await Promise.all([close(fixture), close(sink), close(redirect), close(standIn), close(assets)]);
});

const runChild = (code, endpointEnv) => new Promise((resolve, reject) => {
  const caseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_OPTIONS: "--import=" + pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")),
    ROO_TEST_NETWORK_ORIGINS: JSON.stringify([fixtureOrigin]),
    ...(endpointEnv ? { PW_TEST_CONNECT_WS_ENDPOINT: endpointEnv } : {}),
  };
  const child = spawn("/usr/bin/env", ["-i", ...Object.entries(caseEnv).map(([key, value]) => `${key}=${value}`), process.execPath, "--input-type=module", "-e", code], {
    cwd: root,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => { stdout += value; });
  child.stderr.on("data", value => { stderr += value; });
  child.once("error", reject);
  child.once("close", code => resolve({ code, stdout, stderr }));
});

const result = child => {
  assert.equal(child.code, 0, child.stderr);
  return JSON.parse(child.stdout.trim());
};
const attemptConnect = url => `
  import { chromium } from "@playwright/test";
  let browser;
  let error = null;
  try { browser = await chromium.connect(${JSON.stringify(url)}); }
  catch (failure) { error = failure.message; }
  finally { await browser?.close(); }
  console.log(JSON.stringify({ error }));
`;

test("native browser and API requests load the allowed fixture under the Node guard", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const page = await context.newPage();
      const outcome = {};
      try {
        const response = await context.request.get("/");
        outcome.api = { status: response.status(), body: await response.text(), error: null };
        await response.dispose();
      } catch (error) { outcome.api = { error: String(error) }; }
      try {
        const response = await page.goto("/");
        outcome.navigation = { status: response.status(), body: await page.textContent("body"), error: null };
        outcome.post = await page.evaluate(async () => {
          const response = await fetch("/echo", { method: "POST", body: "native-fixture-body" });
          return { status: response.status, body: await response.json() };
        });
        outcome.failure = await page.evaluate(async () => {
          const response = await fetch("/failure");
          return { status: response.status, body: await response.text() };
        });
      } catch (error) { outcome.navigation = { error: String(error) }; }
      console.log(JSON.stringify({ outcome, guard }));
      await context.close();
    } finally { await browser.close(); }
  `);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.equal(value.outcome.api.error, null);
  assert.equal(value.outcome.api.status, 200);
  assert.match(value.outcome.api.body, /fixture-ok/);
  assert.equal(value.outcome.navigation.error, null);
  assert.equal(value.outcome.navigation.status, 200);
  assert.match(value.outcome.navigation.body, /fixture-ok/);
  assert.deepEqual(value.outcome.post, { status: 200, body: { method: "POST", body: "native-fixture-body" } });
  assert.deepEqual(value.outcome.failure, { status: 503, body: "fixture-unavailable" });
  assert.deepEqual(value.guard.unexpectedRequests, []);
});

test("guarded native pages receive allowed local streaming headers before the body completes", { timeout: 65_000 }, async t => {
  const beforeRequests = streamRequests;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, ${JSON.stringify([fixtureOrigin, `http://127.0.0.1:${assets.address().port}`])});
      const page = await context.newPage();
      const errors = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.route("**/echo", route => route.continue({ url: ${JSON.stringify(`http://127.0.0.1:${assets.address().port}/stream`)} }));
      await page.goto("/");
      await page.evaluate(() => {
        window.streamController = new AbortController();
        window.streamState = { status: null, bodyCompleted: false, error: null };
        window.streamResult = fetch("/echo", { method: "POST", body: "fixture-body", signal: window.streamController.signal })
          .then(async response => { window.streamState.status = response.status; await response.json(); window.streamState.bodyCompleted = true; })
          .catch(error => { window.streamState.error = error.name; });
      });
      await page.waitForFunction(() => window.streamState.status !== null || window.streamState.error !== null, undefined, { timeout: 10000 });
      const beforeAbort = await page.evaluate(() => window.streamState);
      await page.evaluate(async () => { window.streamController.abort(); await window.streamResult; });
      const afterAbort = await page.evaluate(() => window.streamState);
      console.log(JSON.stringify({ beforeAbort, afterAbort, errors, guard }));
      await context.close();
    } finally { await browser.close(); }
  `);
  t.diagnostic(JSON.stringify({ child, streamRequests: streamRequests - beforeRequests }));
  const value = result(child);
  assert.deepEqual(value.beforeAbort, { status: 200, bodyCompleted: false, error: null });
  assert.deepEqual(value.afterAbort, { status: 200, bodyCompleted: false, error: "AbortError" });
  assert.equal(streamRequests - beforeRequests, 1);
  assert.deepEqual(value.errors, []);
  assert.deepEqual(value.guard.unexpectedRequests, []);
});

test("native browser redirects remain guarded with the Node guard active", { timeout: 65_000 }, async t => {
  const beforeRequests = sinkRequests;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const refusals = [];
    process.on("unhandledRejection", error => {
      if (!String(error).includes("[test-target]")) throw error;
      refusals.push(String(error));
    });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const outcome = {};
      try {
        const response = await context.request.get("/redirect?status=307", { maxRedirects: 0 });
        outcome.raw = { status: response.status(), location: response.headers().location, error: null };
        await response.dispose();
      } catch (error) { outcome.raw = { error: String(error) }; }
      try { await context.request.get("/redirect"); outcome.apiRefusal = null; }
      catch (error) { outcome.apiRefusal = String(error); }
      const page = await context.newPage();
      try {
        await page.goto("/");
        const response = await page.goto("/redirect-local-hop");
        outcome.local = { status: response.status(), url: page.url(), body: await page.textContent("body"), error: null };
        await page.goBack();
        outcome.back = page.url();
        await page.goForward();
        outcome.forward = page.url();
      } catch (error) { outcome.local = { error: String(error) }; }
      outcome.forbidden = [];
      for (const mode of ["fetch", "navigation"]) for (const status of [301, 302, 303, 307, 308]) {
        const attemptPage = await context.newPage();
        await attemptPage.goto("/");
        const target = "/redirect?status=" + status;
        let error = null;
        if (mode === "fetch") error = await attemptPage.evaluate(async target => {
          try { await fetch(target); return null; } catch (error) { return String(error); }
        }, target);
        else {
          try { await attemptPage.goto(target); } catch (failure) { error = String(failure); }
        }
        outcome.forbidden.push({ mode, status, error });
        await attemptPage.close();
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      console.log(JSON.stringify({ outcome, guard, refusals }));
      await context.close();
    } finally { await browser.close(); }
  `);
  t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests }));
  const value = result(child);
  assert.deepEqual(value.outcome.raw, { status: 307, location: `http://127.0.0.1:${sink.address().port}/`, error: null });
  assert.match(value.outcome.apiRefusal, /HTTP redirects are refused/);
  assert.equal(value.outcome.local.error, null);
  assert.equal(value.outcome.local.status, 200);
  assert.match(value.outcome.local.body, /fixture-ok/);
  assert.equal(value.outcome.local.url, fixtureOrigin + "/landing#fixture");
  assert.equal(value.outcome.back, fixtureOrigin + "/");
  assert.equal(value.outcome.forward, fixtureOrigin + "/landing#fixture");
  assert.equal(value.outcome.forbidden.length, 10);
  for (const attempt of value.outcome.forbidden) assert.ok(attempt.error, `${attempt.mode} ${attempt.status}`);
  assert.equal(value.guard.unexpectedRequests.length, 10);
  for (const entry of value.guard.unexpectedRequests) {
    assert.equal(entry.action, "unexpected-nonlocal-redirect");
    assert.equal(entry.url, `http://127.0.0.1:${sink.address().port}/`);
    assert.ok(entry.redirectedFrom.startsWith(fixtureOrigin + "/redirect?status="));
  }
  assert.equal(sinkRequests, beforeRequests);
});

test("caller HTTP Agents cannot redirect an allowed request to another origin", { timeout: 65_000 }, async t => {
  const beforeRequests = sinkRequests;
  const child = await runChild(`
    import http from "node:http";
    import net from "node:net";
    let connections = 0;
    const agent = new (class extends http.Agent {
      createConnection(_options, callback) {
        connections++;
        return net.createConnection({ host: "127.0.0.1", port: ${sink.address().port} }, callback);
      }
    })();
    const read = (...args) => new Promise((resolve, reject) => {
      http.get(...args, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }).on("error", reject);
    });
    try {
      const responses = [];
      responses.push(await read(${JSON.stringify(fixtureOrigin)}, { agent }));
      responses.push(await read(new URL(${JSON.stringify(fixtureOrigin)}), { agent }));
      responses.push(await read({ hostname: "127.0.0.1", port: ${fixture.address().port}, path: "/", agent }));
      const overrides = [];
      for (const options of [{ createConnection: () => agent.createConnection() }, { socketPath: "/fixture-only-unused.sock" }]) {
        try { await read(${JSON.stringify(fixtureOrigin)}, options); overrides.push(null); }
        catch (error) { overrides.push(String(error)); }
      }
      let redirectError = null;
      try { await read(${JSON.stringify(fixtureOrigin + "/redirect")}, { agent }); }
      catch (error) { redirectError = String(error); }
      console.log(JSON.stringify({ responses, connections, overrides, redirectError }));
    } finally { agent.destroy(); }
  `);
  t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests }));
  const value = result(child);
  assert.equal(value.responses.length, 3);
  for (const response of value.responses) { assert.equal(response.status, 200); assert.match(response.body, /fixture-ok/); }
  assert.equal(value.connections, 0);
  assert.equal(value.overrides.length, 2);
  for (const error of value.overrides) assert.match(error, /Custom network transports are refused/);
  assert.match(value.redirectError, /HTTP redirects are refused/);
  assert.equal(sinkRequests, beforeRequests);
});

test("page and context API requests cannot escape the fixture on a connected browser", { timeout: 65_000 }, async t => {
  const beforeRequests = sinkRequests;
  const child = await runChild(`
    import assert from "node:assert/strict";
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const page = await context.newPage();
      const refusals = [];
      let rawRedirect;
      for (const api of [page.request, context.request]) {
        for (const method of ["get", "post", "put", "patch", "delete", "head", "fetch"]) {
          await assert.rejects(api[method](${JSON.stringify(`http://127.0.0.1:${sink.address().port}/`)}), /outside the local fixture/);
          refusals.push(method);
        }
        await assert.rejects(api.get("/redirect"), /redirects are refused/);
        const redirect = await api.get("/redirect", { maxRedirects: 0 });
        assert.equal(redirect.status(), 302);
        rawRedirect = { url: redirect.url(), status: redirect.status(), headers: redirect.headers(), body: await redirect.text() };
        await redirect.dispose();
        const response = await api.get("/");
        assert.equal(response.status(), 200);
        assert.match(await response.text(), /fixture-ok/);
      }
      console.log(JSON.stringify({ refusals, fixtureStatus: 200, rawRedirect }));
      await context.close();
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests }));
  const value = result(child);
  assert.equal(value.refusals.length, 14);
  assert.equal(sinkRequests, beforeRequests);
});

for (const mode of ["fetch", "navigation"]) {
  for (const target of ["/redirect?status=301", "/redirect?status=302", "/redirect?status=303", "/redirect?status=307", "/redirect?status=308", "/redirect-hop", "/redirect-invalid", "/redirect-credentials", "/redirect-scheme", "/redirect-loop", ...(mode === "fetch" ? ["/redirect-local"] : [])]) {
    test(`browser ${mode} refuses and records the fixture redirect ${target}`, { timeout: 65_000 }, async t => {
      const beforeRequests = sinkRequests;
      const child = await runChild(`
        import { chromium } from "@playwright/test";
        const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
        const refusals = [];
        process.on("unhandledRejection", error => {
          if (!String(error).includes("[test-target]")) throw error;
          refusals.push(String(error));
        });
        const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
        try {
          const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
          const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
          const page = await context.newPage();
          await page.goto(${JSON.stringify(fixtureOrigin)});
          let outcome;
          if (${JSON.stringify(mode)} === "fetch") {
            outcome = await page.evaluate(async target => {
              try { const response = await fetch(target); return { status: response.status, body: await response.text(), error: null }; }
              catch (error) { return { error: String(error) }; }
            }, ${JSON.stringify(target)});
          } else {
            try { await page.goto(${JSON.stringify(fixtureOrigin + target)}); outcome = { url: page.url(), error: null }; }
            catch (error) { outcome = { error: String(error) }; }
          }
          await context.close();
          console.log(JSON.stringify({ outcome, guard, refusals }));
        } finally { await browser.close(); }
      `, endpoint);
      t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests }));
      const value = result(child);
      assert.equal(sinkRequests, beforeRequests, "The forbidden redirect destination received a request.");
      assert.ok(value.outcome.error, "The browser followed a forbidden redirect.");
      const action = target === "/redirect-invalid" ? "invalid-browser-redirect" : target === "/redirect-loop" || target === "/redirect-local" || mode === "fetch" && target === "/redirect-hop" ? "unexpected-browser-redirect" : "unexpected-nonlocal-redirect";
      assert.ok(value.guard.unexpectedRequests.some(entry => entry.action === action && entry.status >= 300 && entry.status < 400 && entry.redirectedFrom.startsWith(fixtureOrigin)));
      if (target.startsWith("/redirect?")) assert.equal(value.guard.unexpectedRequests[0].url, `http://127.0.0.1:${sink.address().port}/`);
    });
  }
  if (mode === "navigation") test("browser navigation retains an allowed fixture redirect", { timeout: 65_000 }, async t => {
    const child = await runChild(`
      import { chromium } from "@playwright/test";
      const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
      const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
      try {
        const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
        const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
        const page = await context.newPage();
        await page.goto(${JSON.stringify(fixtureOrigin)});
        const response = await page.goto(${JSON.stringify(fixtureOrigin + "/redirect-local-hop")});
        const outcome = { status: response.status(), body: await page.textContent("body"), url: page.url() };
        outcome.imageLoaded = await page.getByAltText("Delayed fixture").evaluate(image => image.complete && image.naturalWidth === 1);
        await page.goBack();
        outcome.back = page.url();
        await page.goForward();
        outcome.forward = page.url();
        await page.goto(${JSON.stringify(fixtureOrigin)});
        await page.evaluate(() => { const link = document.createElement("a"); link.href = "/redirect-local-hop"; link.textContent = "Fixture redirect"; document.body.append(link); });
        await Promise.all([page.waitForURL(${JSON.stringify(fixtureOrigin + "/landing#fixture")}), page.getByRole("link", { name: "Fixture redirect" }).click()]);
        outcome.clicked = page.url();
        await context.close();
        console.log(JSON.stringify({ outcome, guard }));
      } finally { await browser.close(); }
    `, endpoint);
    t.diagnostic(JSON.stringify({ child }));
    const value = result(child);
    assert.equal(value.outcome.status, 200);
    assert.match(value.outcome.body, /fixture-ok/);
    assert.deepEqual(value.guard.unexpectedRequests, []);
    assert.equal(value.outcome.url, fixtureOrigin + "/landing#fixture");
    assert.equal(value.outcome.back, fixtureOrigin + "/");
    assert.equal(value.outcome.forward, fixtureOrigin + "/landing#fixture");
    assert.equal(value.outcome.clicked, fixtureOrigin + "/landing#fixture");
    assert.equal(value.outcome.imageLoaded, true);
  });
}

test("browser redirect guard preserves request bodies, HTTP failures and static images", { timeout: 65_000 }, async t => {
  const beforeRequests = sinkRequests;
  const beforeOutside = assetOutsideRequests;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const refusals = [];
    process.on("unhandledRejection", error => {
      if (!String(error).includes("[test-target]")) throw error;
      refusals.push(String(error));
    });
    process.env.TOOLING_CONTENT_PORT = ${JSON.stringify(String(assets.address().port))};
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const page = await context.newPage();
      await page.goto(${JSON.stringify(fixtureOrigin)});
      const body = await page.evaluate(async () => (await fetch("/echo", { method: "POST", body: "guarded-body" })).json());
      const failure = await page.evaluate(async () => { const response = await fetch("/failure"); return { status: response.status, body: await response.text() }; });
      const images = [];
      for (const url of ${JSON.stringify([`http://127.0.0.1:${assets.address().port}/storage/v1/image.svg`, "https://razorpay.com/assets/razorpay-logo.svg", "https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-100px.png", `http://127.0.0.1:${assets.address().port}/storage/v1/redirect`, `http://127.0.0.1:${assets.address().port}/storage/v1/path-redirect`])}) {
        images.push(await page.evaluate(url => new Promise(resolve => {
          const image = new Image();
          image.onload = () => resolve({ loaded: true, width: image.naturalWidth });
          image.onerror = () => resolve({ loaded: false });
          image.src = url;
        }), url));
      }
      await context.close();
      console.log(JSON.stringify({ body, failure, images, guard, refusals }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests, assetOutsideRequests: assetOutsideRequests - beforeOutside }));
  const value = result(child);
  assert.deepEqual(value.body, { method: "POST", body: "guarded-body" });
  assert.deepEqual(value.failure, { status: 503, body: "fixture-unavailable" });
  assert.deepEqual(value.images.map(image => image.loaded), [true, true, true, false, false]);
  assert.equal(value.guard.staticAssets.length, 2);
  assert.equal(value.guard.unexpectedRequests.length, 2);
  assert.ok(value.guard.unexpectedRequests.every(entry => entry.resourceType === "image" && entry.action === "unexpected-nonlocal-redirect"));
  assert.equal(sinkRequests, beforeRequests);
  assert.equal(assetOutsideRequests, beforeOutside);
});

test("browser redirect guard refuses a form navigation without replaying its body", { timeout: 65_000 }, async t => {
  const beforeRequests = fixtureRequests;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const refusals = [];
    process.on("unhandledRejection", error => {
      if (!String(error).includes("[test-target]")) throw error;
      refusals.push(String(error));
    });
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const page = await context.newPage();
      await page.goto(${JSON.stringify(fixtureOrigin)});
      const failed = page.waitForEvent("requestfailed", request => request.isNavigationRequest() && request.method() === "POST");
      await page.evaluate(() => { const form = document.createElement("form"); form.method = "POST"; form.action = "/redirect-local?status=307"; document.body.append(form); form.submit(); });
      await failed;
      await context.close();
      console.log(JSON.stringify({ guard, refusals }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child, fixtureRequests: fixtureRequests - beforeRequests }));
  const value = result(child);
  assert.ok(value.guard.unexpectedRequests.some(entry => entry.action === "unexpected-browser-redirect" && entry.method === "POST" && entry.status === 307));
  assert.equal(fixtureRequests - beforeRequests, 2);
});

test("browser redirect guard preserves CORS refusal between permitted fixtures", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      const guard = await guardBrowserContext(context, ${JSON.stringify([fixtureOrigin, `http://127.0.0.1:${assets.address().port}`])});
      const page = await context.newPage();
      await page.goto(${JSON.stringify(fixtureOrigin)});
      const outcome = await page.evaluate(async url => {
        try { const response = await fetch(url); return { status: response.status, error: null }; }
        catch (error) { return { error: String(error) }; }
      }, ${JSON.stringify(`http://127.0.0.1:${assets.address().port}/outside.svg`)});
      await context.close();
      console.log(JSON.stringify({ outcome, guard }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.ok(value.outcome.error);
  assert.deepEqual(value.guard.unexpectedRequests, []);
});

test("browser navigation keeps its timeout after an allowed redirect", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      const page = await context.newPage();
      await page.goto(${JSON.stringify(fixtureOrigin)});
      const requests = [];
      page.on("request", request => requests.push(request.url()));
      const started = Date.now();
      let failure;
      try { await page.goto(${JSON.stringify(fixtureOrigin + "/redirect-slow")}, { timeout: 500 }); }
      catch (error) { failure = { name: error.name, message: error.message }; }
      const elapsed = Date.now() - started;
      await context.close();
      console.log(JSON.stringify({ failure, elapsed, requests }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.equal(value.failure?.name, "TimeoutError");
  assert.ok(value.requests.includes(fixtureOrigin + "/slow"));
  assert.ok(value.elapsed < 2000);
});

test("browser redirects preserve inherited navigation deadlines", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    const cases = [
      { name: "page navigation", pageNavigation: 1000 },
      { name: "context navigation", contextNavigation: 1000 },
      { name: "page general", pageGeneral: 1000 },
      { name: "context general", contextGeneral: 1000 },
      { name: "page priority", contextNavigation: 5000, pageGeneral: 1000 },
      { name: "existing page", pageNavigation: 1000, existingPage: true },
      { name: "explicit control", pageNavigation: 5000, options: { timeout: 1000 } },
      { name: "navigation waiter", pageNavigation: 1000, method: "waitForNavigation" },
      { name: "URL waiter", pageNavigation: 1000, method: "waitForURL" },
      { name: "unfinished body", pageNavigation: 1000, target: "/redirect-unending" },
    ];
    const outcomes = [];
    try {
      for (const item of cases) {
        const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
        if (item.contextNavigation !== undefined) context.setDefaultNavigationTimeout(item.contextNavigation);
        if (item.contextGeneral !== undefined) context.setDefaultTimeout(item.contextGeneral);
        let page = item.existingPage ? await context.newPage() : null;
        if (page) page.setDefaultNavigationTimeout(item.pageNavigation);
        const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
        page ||= await context.newPage();
        if (item.pageNavigation !== undefined && !item.existingPage) page.setDefaultNavigationTimeout(item.pageNavigation);
        if (item.pageGeneral !== undefined) page.setDefaultTimeout(item.pageGeneral);
        await page.goto(${JSON.stringify(fixtureOrigin)});
        const requests = [];
        page.on("request", request => requests.push(new URL(request.url()).pathname));
        const started = Date.now();
        let error, status;
        try {
          if (item.method) {
            const navigation = item.method === "waitForNavigation" ? page.waitForNavigation() : page.waitForURL(${JSON.stringify(fixtureOrigin + "/budget-landing")});
            await page.evaluate(() => { location.href = "/redirect-budget"; });
            await navigation;
          } else status = (await page.goto(${JSON.stringify(fixtureOrigin)} + (item.target || "/redirect-budget"), item.options)).status();
        } catch (failure) { error = { name: failure.name, message: failure.message }; }
        outcomes.push({ name: item.name, error, status, elapsed: Date.now() - started, requests, guard });
        await context.close();
      }
      console.log(JSON.stringify({ outcomes }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.equal(value.outcomes.length, 10);
  for (const outcome of value.outcomes) {
    assert.equal(outcome.error?.name, "TimeoutError", outcome.name);
    assert.equal(outcome.status, undefined, outcome.name);
    assert.ok(outcome.elapsed >= 900 && outcome.elapsed < 1800, JSON.stringify(outcome));
    assert.ok(outcome.requests.includes(outcome.name === "unfinished body" ? "/unending" : "/budget-landing"), outcome.name);
    assert.deepEqual(outcome.guard.unexpectedRequests, []);
  }
});

test("browser redirects retain explicit and inherited unlimited navigation", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    const outcomes = [];
    try {
      for (const mode of ["explicit zero", "page zero", "explicit longer"]) {
        const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
        context.setDefaultNavigationTimeout(1000);
        const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
        const page = await context.newPage();
        if (mode === "page zero") page.setDefaultNavigationTimeout(0);
        else page.setDefaultNavigationTimeout(1000);
        const response = await page.goto(${JSON.stringify(fixtureOrigin + "/redirect-budget")}, mode === "page zero" ? {} : { timeout: mode === "explicit zero" ? 0 : 5000 });
        outcomes.push({ mode, status: response.status(), url: page.url(), guard });
        await context.close();
      }
      console.log(JSON.stringify({ outcomes }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.equal(value.outcomes.length, 3);
  for (const outcome of value.outcomes) {
    assert.equal(outcome.status, 200);
    assert.equal(outcome.url, fixtureOrigin + "/budget-landing");
    assert.deepEqual(outcome.guard.unexpectedRequests, []);
  }
});

test("browser redirect recovery propagates navigation cancellation", { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    const outcomes = [];
    try {
      for (const mode of ["closed page", "superseded navigation"]) {
        const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
        await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
        const page = await context.newPage();
        const landing = page.waitForRequest(${JSON.stringify(fixtureOrigin + "/budget-landing")});
        const navigation = page.goto(${JSON.stringify(fixtureOrigin + "/redirect-budget")}).then(response => ({ status: response.status() }), error => ({ error: String(error) }));
        await landing;
        if (mode === "closed page") await page.close();
        else await page.goto(${JSON.stringify(fixtureOrigin)});
        outcomes.push({ mode, ...await navigation });
        await context.close();
      }
      console.log(JSON.stringify({ outcomes }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.equal(value.outcomes.length, 2);
  for (const outcome of value.outcomes) {
    assert.ok(outcome.error, outcome.mode);
    assert.equal(outcome.status, undefined, outcome.mode);
  }
});

for (const mode of ["window.open", "target=_blank"]) for (const redirect of [false, true]) {
  test(`browser popup ${mode} ${redirect ? "records a forbidden redirect" : "loads its allowed initial request"}`, { timeout: 65_000 }, async t => {
    const beforeRequests = sinkRequests;
    const target = fixtureOrigin + (redirect ? "/redirect?status=307" : "/landing");
    const child = await runChild(`
      import { chromium } from "@playwright/test";
      const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
      const errors = [];
      let observed;
      const failed = new Promise(resolve => { observed = resolve; });
      process.on("unhandledRejection", error => { errors.push(String(error)); observed({ error: String(error) }); });
      const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
      try {
        const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
        const missingFrames = [];
        context.on("request", request => {
          if (!request.isNavigationRequest()) return;
          try { request.frame(); } catch (error) { missingFrames.push({ url: request.url(), error: String(error) }); }
        });
        const guard = await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
        const page = await context.newPage();
        await page.goto(${JSON.stringify(fixtureOrigin)});
        const opened = ${JSON.stringify(redirect)} ? null : context.waitForEvent("page", { timeout: 10000 }).then(async popup => {
          await popup.waitForLoadState("load", { timeout: 10000 });
          return { url: popup.url(), body: await popup.textContent("body") };
        }).catch(error => ({ error: String(error) }));
        await page.evaluate(({ mode, target }) => {
          if (mode === "window.open") window.open(target, "_blank", "noopener,noreferrer");
          else {
            const link = document.createElement("a");
            link.href = target; link.target = "_blank"; link.rel = "noopener noreferrer";
            document.body.append(link); link.click();
          }
        }, { mode: ${JSON.stringify(mode)}, target: ${JSON.stringify(target)} });
        const outcome = await Promise.race([opened || new Promise(() => {}), failed]);
        await context.close();
        console.log(JSON.stringify({ outcome, errors, missingFrames, guard }));
      } finally { await browser.close(); }
    `, endpoint);
    t.diagnostic(JSON.stringify({ child, sinkRequests: sinkRequests - beforeRequests }));
    const value = result(child);
    assert.ok(value.missingFrames.some(row => row.url === target && row.error.includes("Frame for this navigation request is not available")));
    assert.equal(sinkRequests, beforeRequests);
    if (redirect) {
      assert.ok(value.outcome.error);
      assert.ok(value.errors.every(error => error.includes("[test-target] Browser redirect refused")));
      assert.ok(value.guard.unexpectedRequests.some(row => row.action === "unexpected-nonlocal-redirect" && row.status === 307 && row.redirectedFrom === target));
    } else {
      assert.equal(value.outcome.url, target);
      assert.match(value.outcome.body, /fixture-ok/);
      assert.deepEqual(value.errors, []);
      assert.deepEqual(value.guard.unexpectedRequests, []);
    }
  });
}

for (const phase of ["fulfillment", "disposal", "active disposal"]) test(`browser response ${phase} follows the context lifetime`, { timeout: 65_000 }, async t => {
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { guardBrowserContext } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    const lateErrors = [];
    let observed;
    const failed = new Promise(resolve => { observed = resolve; });
    process.on("unhandledRejection", error => { lateErrors.push(String(error)); observed(); });
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    let closures = 0;
    let closing;
    try {
      const context = await browser.newContext({ baseURL: ${JSON.stringify(fixtureOrigin)} });
      await guardBrowserContext(context, [${JSON.stringify(fixtureOrigin)}]);
      await context.route("**/*", async route => {
        const fetch = route.fetch.bind(route);
        route.fetch = async options => {
          const response = await fetch(options);
          if (${JSON.stringify(phase)} === "fulfillment") {
            let finish;
            let disposed;
            const pause = new Promise(resolve => { finish = resolve; });
            const disposal = new Promise(resolve => { disposed = resolve; });
            const dispose = context.request.dispose.bind(context.request);
            context.request.dispose = async options => { await dispose(options); disposed(); await pause; };
            closing = context.close().catch(error => lateErrors.push(String(error)));
            await disposal;
            closures++;
            setTimeout(finish, 100);
          } else if (${JSON.stringify(phase)} === "active disposal") { await response.dispose(); closures++; }
          else {
            const dispose = response.dispose.bind(response);
            response.dispose = async () => { await context.close(); closures++; return dispose(); };
          }
          return response;
        };
        await route.fallback();
      });
      const page = await context.newPage();
      const navigation = page.goto(${JSON.stringify(fixtureOrigin)}).catch(() => {});
      if (${JSON.stringify(phase)} === "active disposal") {
        await Promise.race([failed, navigation]);
        await context.close();
      }
      await navigation;
      await closing;
      await new Promise(resolve => setTimeout(resolve, 50));
      console.log(JSON.stringify({ closures, lateErrors }));
    } finally { await browser.close(); }
  `, endpoint);
  t.diagnostic(JSON.stringify({ child }));
  const value = result(child);
  assert.ok(value.closures > 0);
  if (phase === "active disposal") assert.ok(value.lateErrors.some(error => error.includes("Response has been disposed")));
  else assert.deepEqual(value.lateErrors, []);
});
const requestHelpers = `
  import http from "node:http";
  import https from "node:https";
  import net from "node:net";
  const attempt = async callback => {
    try { return { value: await callback(), error: null }; }
    catch (failure) { return { error: failure.message }; }
  };
  const request = (module, options, get = false) => new Promise((resolve, reject) => {
    const req = module[get ? "get" : "request"](options, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.on("upgrade", (_response, socket) => { socket.destroy(); resolve("upgraded"); });
    req.setTimeout(5000, () => req.destroy(new Error("request timed out")));
    if (!get) req.end();
  });
`;
const tunnelHelpers = () => `
  ${requestHelpers}
  const defaultHeaders = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
  const header = "GET /stand-in-path HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n";
  const tunnelOptions = (headers = defaultHeaders) => ({
    host: "127.0.0.1", port: ${JSON.stringify(String(standIn.address().port))}, path: "/stand-in-path", method: "GET",
    createConnection: net.createConnection, agent: new (class extends http.Agent {})(), headers,
  });
  const tunnelAttempt = (headers, mutate = () => {}, finish = req => req.end()) => attempt(() => new Promise((resolve, reject) => {
    const req = http.request(tunnelOptions(headers), response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
    req.on("upgrade", (_response, socket) => { socket.destroy(); resolve("upgraded"); });
    req.setTimeout(5000, () => req.destroy(new Error("request timed out")));
    mutate(req);
    finish(req);
  }));
`;

test("stand-in: an altered tunnel request sends no bytes", { timeout: 65_000 }, async t => {
  standInBytes = 0;
  standInWire = "";
  standInUpgrades.length = 0;
  const value = result(await runChild(`
    ${tunnelHelpers()}
    const cases = [
      ["path", undefined, req => { req.path = "/other"; }],
      ["method", undefined, req => { req.method = "POST"; }],
      ["remove-upgrade", undefined, req => req.removeHeader("upgrade")],
      ["replace-upgrade", undefined, req => req.setHeader("Upgrade", "h2c")],
      ["remove-connection", undefined, req => req.removeHeader("connection")],
      ["replace-connection", undefined, req => req.setHeader("Connection", "keep-alive")],
      ["flush-headers", undefined, req => { req.path = "/other"; }, req => req.flushHeaders()],
      ["write", undefined, req => { req.path = "/other"; }, req => req.write("x")],
      ["body-smuggling", undefined, undefined, req => req.end("GET /other HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n")],
      ["prototype-end", undefined, undefined, req => http.ClientRequest.prototype.end.call(req, "x")],
      ["duplicate-upgrade", { Connection: "Upgrade", Upgrade: "websocket", upgrade: "h2c" }],
      ["missing-connection", { Upgrade: "websocket" }],
      ["expect", { ...defaultHeaders, Expect: "100-continue" }],
      ["raw-array", ["Connection", "Upgrade", "Upgrade", "websocket"]],
      ["content-length", undefined, req => req.setHeader("Content-Length", "5")],
      ["content-length-option", { ...defaultHeaders, "Content-Length": "5" }],
      ["transfer-encoding", { ...defaultHeaders, "Transfer-Encoding": "chunked" }],
      ["socket-before", undefined, req => req.on("socket", socket => socket.write("GET /other-before HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n")), () => {}],
    ];
    const values = [];
    for (const [name, headers, mutate, finish] of cases) values.push({ name, ...await tunnelAttempt(headers, mutate, finish) });
    console.log(JSON.stringify(values));
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`));
  await new Promise(resolve => setTimeout(resolve, 300));
  t.diagnostic(JSON.stringify({ cases: value, bytes: standInBytes, upgrades: standInUpgrades, wire: standInWire.length, other: standInWire.match(/GET \/other[^ ]*/g) ?? [] }));
  for (const response of value) {
    assert.match(response.error, /Remote browser requests must stay a websocket upgrade|Custom network transports are refused/, response.name);
  }
  assert.equal(standInBytes, 0);
  assert.equal(standInUpgrades.length, 0);
  assert.ok(!standInWire.includes("/other"), standInWire);
});

test("stand-in: the legitimate handshake reaches the endpoint exactly once", { timeout: 65_000 }, async () => {
  const beforeBytes = standInBytes;
  const beforeUpgrades = standInUpgrades.length;
  const value = result(await runChild(`
    ${tunnelHelpers()}
    console.log(JSON.stringify(await tunnelAttempt()));
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`));
  assert.equal(value.value, "upgraded");
  assert.deepEqual(standInUpgrades.slice(beforeUpgrades), [{ method: "GET", url: "/stand-in-path", upgrade: "websocket", connection: "Upgrade" }]);
  assert.ok(standInBytes > beforeBytes);
});

test("stand-in: the socket carries nothing after a non-101 answer", { timeout: 65_000 }, async t => {
  const start = standInWire.length;
  const value = result(await runChild(`
    ${tunnelHelpers()}
    const seen = {};
    const req = http.request(tunnelOptions({ ...defaultHeaders, "X-Stand-In-Reply": "200" }), response => {
      seen.status = response.statusCode;
      response.resume();
      req.socket.write("GET /other-response HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n", error => { seen.writeError = error?.message ?? null; });
    });
    req.on("error", error => { seen.requestError = error.message; });
    process.once("beforeExit", () => console.log(JSON.stringify(seen)));
    req.end();
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`));
  await new Promise(resolve => setTimeout(resolve, 300));
  t.diagnostic(JSON.stringify({ ...value, wire: standInWire.slice(start) }));
  assert.equal(value.status, 200);
  assert.match(value.writeError, /Remote browser requests must stay a websocket upgrade/);
  assert.ok(standInWire.slice(start).startsWith("GET /stand-in-path HTTP/1.1\r\n"));
  assert.ok(!standInWire.slice(start).includes("/other-response"));
});

test("stand-in: Playwright's real client passes the guard and sends frames after 101", { timeout: 65_000 }, async t => {
  const beforeUpgrades = standInUpgrades.length;
  const beforeFrames = standInFrames;
  const url = `ws://127.0.0.1:${standIn.address().port}/stand-in-path`;
  const value = result(await runChild(`
    import { chromium } from "@playwright/test";
    let error = null;
    try { await (await chromium.connect(${JSON.stringify(url)}, { timeout: 5000 })).close(); }
    catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ error }));
  `, url));
  const upgrades = standInUpgrades.slice(beforeUpgrades);
  t.diagnostic(JSON.stringify({ ...value, upgrades, frames: standInFrames - beforeFrames }));
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].url, "/stand-in-path");
  assert.equal(upgrades[0].method, "GET");
  assert.ok(standInFrames > beforeFrames);
  assert.doesNotMatch(value.error ?? "", /\[test-target\]/);
});

test("stand-in: a non-101 keep-alive answer releases the socket", { timeout: 65_000 }, async () => {
  const child = await runChild(`
    ${tunnelHelpers()}
    const seen = {};
    const req = http.request(tunnelOptions({ ...defaultHeaders, "X-Stand-In-Reply": "keep-alive" }), response => {
      seen.status = response.statusCode;
      response.setEncoding("latin1");
      response.on("data", chunk => { seen.body = (seen.body ?? "") + chunk; });
    });
    req.on("error", error => { seen.error = error.message; });
    req.on("close", () => { seen.closed = true; });
    process.once("beforeExit", () => console.log(JSON.stringify(seen)));
    req.end();
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`);
  assert.deepEqual(result(child), { status: 200, body: "ok", closed: true });
});

test("stand-in: request timeouts and abort signals still reach the tunnel", { timeout: 65_000 }, async () => {
  const child = await runChild(`
    ${tunnelHelpers()}
    const stalled = ({ options = () => {}, request = () => {} } = {}) => new Promise(resolve => {
      const settings = tunnelOptions({ ...defaultHeaders, "X-Stand-In-Reply": "stall" });
      options(settings);
      const req = http.request(settings);
      const watchdog = setTimeout(() => req.destroy(new Error("watchdog")), 3000);
      const finish = value => { clearTimeout(watchdog); resolve(value); };
      req.on("timeout", () => req.destroy(new Error("own-timeout")));
      req.on("error", error => finish(error.code === "ABORT_ERR" ? "ABORT_ERR" : error.message));
      req.on("upgrade", (_response, socket) => { socket.destroy(); finish("upgraded"); });
      request(req);
      req.end();
    });
    const controller = new AbortController();
    const values = {
      "timeout-option": await stalled({ options: settings => { settings.timeout = 40; } }),
      "set-timeout": await stalled({ request: req => req.setTimeout(40) }),
      "abort-before": await stalled({ options: settings => { settings.signal = AbortSignal.abort(); } }),
      "abort-during": await stalled({ options: settings => { settings.signal = controller.signal; }, request: () => setTimeout(() => controller.abort(), 40) }),
    };
    console.log(JSON.stringify(values));
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`);
  assert.deepEqual(result(child), { "timeout-option": "own-timeout", "set-timeout": "own-timeout", "abort-before": "ABORT_ERR", "abort-during": "ABORT_ERR" });
});

test("stand-in: bytes changed after a write never reach the endpoint", { timeout: 65_000 }, async t => {
  const start = standInWire.length;
  const beforeUpgrades = standInUpgrades.length;
  const value = result(await runChild(`
    ${tunnelHelpers()}
    const modes = {
      "unaltered": (socket, bytes, done) => socket.write(bytes, done),
      "write-mutate": (socket, bytes, done) => { socket.write(bytes, done); bytes.write("/other", 4, "latin1"); },
      "end-mutate": (socket, bytes, done) => { socket.end(bytes, done); bytes.write("/other", 4, "latin1"); },
      "writev-mutate": (socket, bytes, done) => { socket.cork(); socket.write(bytes.subarray(0, 12), done); socket.write(bytes.subarray(12), done); socket.uncork(); bytes.write("/other", 4, "latin1"); },
    };
    const values = [];
    for (const [name, mode] of Object.entries(modes)) values.push(await new Promise(resolve => {
      const seen = { name, writeError: null };
      const req = http.request(tunnelOptions());
      const timer = setTimeout(() => req.destroy(), 1000);
      req.on("error", error => { seen.error = error.message; });
      req.on("upgrade", (_response, socket) => { seen.upgraded = true; socket.destroy(); });
      req.on("close", () => { clearTimeout(timer); resolve(seen); });
      req.on("socket", socket => mode(socket, Buffer.from(header, "latin1"), error => { seen.writeError ??= error?.message ?? null; }));
    }));
    console.log(JSON.stringify(values));
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`));
  await new Promise(resolve => setTimeout(resolve, 300));
  t.diagnostic(JSON.stringify({ values: value, upgrades: standInUpgrades.slice(beforeUpgrades), wire: standInWire.slice(start) }));
  for (const row of value) {
    assert.equal(row.upgraded, true, row.name);
    assert.equal(row.writeError, null, row.name);
  }
  assert.deepEqual(standInUpgrades.slice(beforeUpgrades).map(upgrade => upgrade.url), ["/stand-in-path", "/stand-in-path", "/stand-in-path", "/stand-in-path"]);
  assert.ok(!standInWire.slice(start).includes("/other"), standInWire.slice(start));
});

test("stand-in: the tunnel socket can't reconnect elsewhere before or after 101", { timeout: 65_000 }, async t => {
  const beforeSinkBytes = sinkBytes;
  const beforeSinkConnections = sinkConnections;
  const beforeUpgrades = standInUpgrades.length;
  const seen = result(await runChild(`
    ${tunnelHelpers()}
    const seen = { before: {}, after: {} };
    const reconnect = (socket, record, send) => {
      try { socket.connect({ host: "127.0.0.1", port: ${sink.address().port} }, send); }
      catch (error) { record.connectError = error.message; }
    };
    await new Promise(resolve => {
      const req = http.request(tunnelOptions());
      req.on("error", error => { seen.before.error = error.message; });
      req.on("socket", socket => {
        socket.once("close", () => { reconnect(socket, seen.before, () => socket.write(header)); resolve(); });
        socket.destroy();
      });
      req.end();
    });
    await new Promise(resolve => {
      const req = http.request(tunnelOptions());
      req.on("error", error => { seen.after.error = error.message; });
      req.on("upgrade", (_response, socket) => {
        seen.after.upgraded = true;
        socket.once("close", () => { reconnect(socket, seen.after, () => socket.end("GET /other-reconnect HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n")); resolve(); });
        socket.destroy();
      });
      req.end();
    });
    process.once("beforeExit", () => console.log(JSON.stringify(seen)));
  `, `ws://127.0.0.1:${standIn.address().port}/stand-in-path`));
  await new Promise(resolve => setTimeout(resolve, 300));
  t.diagnostic(JSON.stringify({ ...seen, upgrades: standInUpgrades.slice(beforeUpgrades), sinkBytes: sinkBytes - beforeSinkBytes, sinkConnections: sinkConnections - beforeSinkConnections }));
  assert.match(seen.before.connectError, /Remote browser requests must stay a websocket upgrade/);
  assert.match(seen.after.connectError, /Remote browser requests must stay a websocket upgrade/);
  assert.equal(seen.after.upgraded, true);
  assert.equal(standInUpgrades.length - beforeUpgrades, 1);
  assert.equal(sinkBytes, beforeSinkBytes);
  assert.equal(sinkConnections, beforeSinkConnections);
});

test("stand-in: a second guard install still lets Playwright's client through", { timeout: 65_000 }, async t => {
  const beforeUpgrades = standInUpgrades.length;
  const beforeFrames = standInFrames;
  const url = `ws://127.0.0.1:${standIn.address().port}/stand-in-path`;
  const value = result(await runChild(`
    import { chromium } from "@playwright/test";
    const { installNetworkGuard } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    installNetworkGuard([${JSON.stringify(fixtureOrigin)}]);
    let error = null;
    try { await (await chromium.connect(${JSON.stringify(url)}, { timeout: 5000 })).close(); }
    catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ error }));
  `, url));
  const upgrades = standInUpgrades.slice(beforeUpgrades);
  t.diagnostic(JSON.stringify({ ...value, upgrades, frames: standInFrames - beforeFrames }));
  assert.equal(upgrades.length, 1);
  assert.equal(upgrades[0].url, "/stand-in-path");
  assert.equal(upgrades[0].method, "GET");
  assert.ok(standInFrames > beforeFrames);
  assert.doesNotMatch(value.error ?? "", /\[test-target\]|Cannot redefine/);
});

test("stand-in: a second guard install fails cleanly when the endpoint is down", { timeout: 65_000 }, async () => {
  const spare = http.createServer();
  await listen(spare);
  const closedPort = spare.address().port;
  await close(spare);
  const url = `ws://127.0.0.1:${closedPort}/closed-path`;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const { installNetworkGuard } = await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/lib/test-target-safety.mjs")).href)});
    installNetworkGuard([${JSON.stringify(fixtureOrigin)}]);
    let error = null;
    try { await (await chromium.connect(${JSON.stringify(url)}, { timeout: 5000 })).close(); }
    catch (failure) { error = failure.message; }
    console.log(JSON.stringify({ error }));
  `, url);
  const value = result(child);
  assert.match(value.error, /ECONNREFUSED/);
  assert.doesNotMatch(value.error, /\[test-target\]|Cannot redefine/);
});

test("connects through the guard while fixture and outside fetch rules remain enforced", { timeout: 65_000 }, async () => {
  const beforeRequests = fixtureRequests;
  const child = await runChild(`
    import { chromium } from "@playwright/test";
    const browser = await chromium.connect(${JSON.stringify(endpoint)}, { exposeNetwork: "<loopback>" });
    try {
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(fixtureOrigin)});
      const text = (await page.locator("body").textContent()).trim();
      let outsideError = null;
      try { await fetch("http://192.0.2.1:9/"); }
      catch (error) { outsideError = error.message; }
      const fixtureStatus = (await fetch(${JSON.stringify(fixtureOrigin)})).status;
      console.log(JSON.stringify({ text, outsideError, fixtureStatus }));
    } finally { await browser.close(); }
  `, endpoint);
  const value = result(child);
  assert.equal(value.text, "fixture-ok");
  assert.match(value.outsideError, /outside the local fixture/);
  assert.equal(value.fixtureStatus, 200);
  assert.ok(fixtureRequests >= beforeRequests + 2);
});

test("refuses another path on the endpoint port", { timeout: 65_000 }, async () => {
  const other = new URL(endpoint);
  other.pathname = other.pathname.replace(/\/$/, "") + "/other-path";
  const value = result(await runChild(attemptConnect(other.href), endpoint));
  assert.match(value.error, /Custom network transports are refused/);
});

test("refuses upgrade requests on another port and through the localhost alias", { timeout: 65_000 }, async () => {
  const beforeUpgrades = fixtureUpgrades;
  const url = new URL(endpoint);
  const value = result(await runChild(`
    ${requestHelpers}
    const headers = { Connection: "Upgrade", Upgrade: "websocket" };
    const other = await attempt(() => request(http, {
      host: "127.0.0.1", port: ${fixture.address().port}, path: ${JSON.stringify(url.pathname)}, method: "GET",
      createConnection: net.createConnection, headers,
    }));
    const alias = await attempt(() => request(http, {
      host: "localhost", port: ${JSON.stringify(url.port)}, path: ${JSON.stringify(url.pathname)}, method: "GET",
      createConnection: net.createConnection, headers,
    }));
    console.log(JSON.stringify({ other, alias }));
  `, endpoint));
  assert.match(value.other.error, /Custom network transports are refused/);
  assert.match(value.alias.error, /Custom network transports are refused/);
  assert.equal(fixtureUpgrades, beforeUpgrades);
});

test("refuses plain fetch, http.get, POST upgrade and HTTPS requests to the endpoint", { timeout: 65_000 }, async () => {
  const url = new URL(endpoint);
  const asHttp = new URL(url);
  asHttp.protocol = "http:";
  const value = result(await runChild(`
    ${requestHelpers}
    const options = {
      host: "127.0.0.1", port: ${JSON.stringify(url.port)}, path: ${JSON.stringify(url.pathname)},
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    };
    const fetched = await attempt(async () => (await fetch(${JSON.stringify(asHttp.href)})).status);
    const got = await attempt(() => request(http, ${JSON.stringify(asHttp.href)}, true));
    const posted = await attempt(() => request(http, { ...options, method: "POST" }));
    const secured = await attempt(() => request(https, { ...options, method: "GET" }));
    console.log(JSON.stringify({ fetched, got, posted, secured }));
  `, endpoint));
  for (const response of Object.values(value)) {
    assert.match(response.error, /outside the local fixture|Custom network transports are refused/);
  }
});

test("rejects bad endpoint values before child code starts", { timeout: 65_000 }, async () => {
  const port = new URL(endpoint).port;
  const invalid = [
    `wss://127.0.0.1:${port}/`,
    `ws://localhost:${port}/`,
    `ws://10.0.0.5:${port}/`,
    `ws://user:pw@127.0.0.1:${port}/`,
    "ws://127.0.0.1/",
    `ws://127.0.0.1:${port}/?x=1`,
    `ws://127.0.0.1:${port}/#h`,
    "not a url",
  ];
  for (const bad of invalid) {
    const child = await runChild('console.log("started")', bad);
    assert.notEqual(child.code, 0, `${bad}: ${child.stdout}`);
    assert.match(child.stderr, /Remote browser endpoint must be a local tunnel/);
    assert.doesNotMatch(child.stdout, /started/);
  }
});

test("refuses redirects from the remote browser endpoint", { timeout: 65_000 }, async () => {
  const beforeSink = sinkRequests;
  const value = result(await runChild(attemptConnect(redirectEndpoint), redirectEndpoint));
  assert.match(value.error, /HTTP redirects are refused/);
  const raw = result(await runChild(`
    ${requestHelpers}
    const response = await attempt(() => request(http, {
      hostname: "127.0.0.1", port: ${redirect.address().port}, path: "/", maxRedirects: -1,
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    }));
    console.log(JSON.stringify(response));
  `, redirectEndpoint));
  assert.match(raw.error, /HTTP redirects are refused/);
  assert.equal(sinkRequests, beforeSink);
});

test("keeps the original transport refusal when the endpoint environment is unset", { timeout: 65_000 }, async () => {
  const value = result(await runChild(attemptConnect(endpoint)));
  assert.match(value.error, /Custom network transports are refused/);
});
