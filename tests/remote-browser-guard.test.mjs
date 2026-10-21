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
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<p>fixture-ok</p>");
  } else {
    response.writeHead(404);
    response.end();
  }
});
const sink = http.createServer((_request, response) => {
  sinkRequests++;
  response.end("sink");
});
const redirect = http.createServer();
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
  standInUpgrades.push({ method: request.method, url: request.url, upgrade: request.headers.upgrade, connection: request.headers.connection });
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.on("data", chunk => { standInFrames += chunk.length; socket.end(); });
  socket.on("end", () => socket.end());
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
});
let fixtureRequests = 0;
let fixtureUpgrades = 0;
let sinkRequests = 0;
let fixtureOrigin;
let endpoint;
let redirectEndpoint;
let browserServer;

fixture.on("upgrade", (_request, socket) => {
  fixtureUpgrades++;
  socket.destroy();
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
  await Promise.all([listen(fixture), listen(sink), listen(redirect), listen(standIn)]);
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
  await Promise.all([close(fixture), close(sink), close(redirect), close(standIn)]);
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
    req.end();
    await new Promise(resolve => setTimeout(resolve, 1000));
    req.destroy();
    console.log(JSON.stringify(seen));
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
  assert.equal(sinkRequests, beforeSink);
});

test("keeps the original transport refusal when the endpoint environment is unset", { timeout: 65_000 }, async () => {
  const value = result(await runChild(attemptConnect(endpoint)));
  assert.match(value.error, /Custom network transports are refused/);
});
