import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { request } from "@playwright/test";
import { freeTcpPort, freeTcpPorts, listenOnPort, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { createToolingContentFixture } from "./fixtures/tooling-content.mjs";

const host = "127.0.0.1";

test("each port stays held until the whole set is reserved", async () => {
  const [port] = await freeTcpPorts(host, [0]);
  await assert.rejects(freeTcpPorts(host, [port, port]), { code: "EADDRINUSE" });
});

test("a requested port is bound before any free pick can take it", async () => {
  const [wanted] = await freeTcpPorts(host, [0]);
  const ports = await freeTcpPorts(host, [0, 0, 0, wanted]);
  assert.equal(ports[3], wanted);
  assert.equal(new Set(ports).size, ports.length, ports.join(", "));
});

test("ports reserved together are distinct", async () => {
  const ports = await freeTcpPorts(host, [0, 0, 0, 0]);
  assert.equal(new Set(ports).size, ports.length, ports.join(", "));
});

test("reserved ports are released for the fixture to bind", async () => {
  const [port] = await freeTcpPorts(host, [0]);
  const server = net.createServer().listen(port, host);
  await once(server, "listening");
  await new Promise((resolve) => server.close(resolve));
});

test("a requested port that is taken fails and releases the others", async () => {
  const holder = net.createServer().listen(0, host);
  await once(holder, "listening");
  try {
    const taken = holder.address().port;
    const [free] = await freeTcpPorts(host, [0]);
    await assert.rejects(freeTcpPorts(host, [free, taken]), { code: "EADDRINUSE" });
    assert.equal(await freeTcpPort(host, free), free);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("an invalid port is refused", async () => {
  await assert.rejects(freeTcpPorts(host, [80]), /Invalid fixture port/);
  await assert.rejects(reserveTcpPorts(host, [Number("not-a-port")]), /Invalid fixture port/);
});

const hold = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(null));
  server.listen(port, host, () => resolve(server));
});
const release = (servers) => Promise.all(servers.filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
const bindable = async (port) => {
  const server = await hold(port);
  await release([server]);
  return Boolean(server);
};

test("a reserved port stays held until its binder releases it", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  assert.equal(await bindable(port), false);
  await releaseTcpPorts(host, [port]);
  assert.equal(await bindable(port), true);
});

test("reserving a port already held in this process adopts it", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  try {
    const [adopted, other] = await reserveTcpPorts(host, [port, 0]);
    assert.equal(adopted, port);
    assert.notEqual(other, port);
    await releaseTcpPorts(host, [other]);
    await assert.rejects(reserveTcpPorts(host, [port, port]), /Fixture ports must differ/);
  } finally {
    await releaseTcpPorts(host, [port]);
  }
});

test("a free pick never takes a port held for a later binder", async () => {
  const [later] = await reserveTcpPorts(host, [0]);
  try {
    const picks = await reserveTcpPorts(host, Array.from({ length: 40 }, () => 0));
    await releaseTcpPorts(host, picks);
    assert.ok(!picks.includes(later));
  } finally {
    await releaseTcpPorts(host, [later]);
  }
});

test("a server takes over a held port without it ever being free", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  let stolen = false;
  let competing = true;
  const competitor = (async () => {
    while (competing) {
      const server = await hold(port);
      if (server) { stolen = true; await release([server]); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const server = http.createServer((request, response) => response.end("owner"));
  await listenOnPort(server, host, port);
  assert.equal(await (await fetch(`http://${host}:${port}/`)).text(), "owner");
  competing = false;
  await competitor;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(stolen, false);
});

test("fixture connections stay open across the default keep-alive timeout", async () => {
  const defaults = http.createServer();
  const pause = defaults.keepAliveTimeout + (defaults.keepAliveTimeoutBuffer ?? 0);
  const server = http.createServer((request, response) => response.end("[]"));
  const contexts = [];
  try {
    await listenOnPort(server, host, 0);
    const url = `http://${host}:${server.address().port}/`;
    contexts.push(...await Promise.all(Array.from({ length: 50 }, () => request.newContext())));
    const results = await Promise.allSettled(contexts.map(async (context) => {
      await context.get(url);
      await new Promise((resolve) => setTimeout(resolve, pause));
      await context.get(url);
    }));
    const errors = results.filter((result) => result.status === "rejected").map((result) => String(result.reason));
    assert.deepEqual(errors, [], errors.join("\n"));
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test("a held port passes to a child process without ever being free", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  const passed = passHeldTcpPorts(host, [port]);
  const program = `import net from "node:net";
const { adoptHeldTcpPorts, releaseTcpPorts } = await import(${JSON.stringify(new URL("../scripts/lib/free-tcp-port.mjs", import.meta.url).href)});
await adoptHeldTcpPorts();
process.stdout.write("adopted\\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
await releaseTcpPorts(${JSON.stringify(host)}, [${port}]);
process.stdout.write("released\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env: { PATH: process.env.PATH, ...passed.env }, stdio: ["pipe", "pipe", "inherit", ...passed.stdio] });
  await passed.handOver(child);
  await releaseTcpPorts(host, [port]);
  const lines = [];
  const next = () => new Promise((resolve) => child.stdout.once("data", (chunk) => { lines.push(String(chunk).trim()); resolve(); }));
  await next();
  assert.equal(await bindable(port), false, "the port opened up between parent and child");
  child.stdin.end("go\n");
  await next();
  await once(child, "exit");
  assert.deepEqual(lines, ["adopted", "released"]);
  assert.equal(await bindable(port), true);
});

test("a child that releases an adopted port can bind it even when the parent is slow to let go", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  const passed = passHeldTcpPorts(host, [port]);
  const program = `import net from "node:net";
const { adoptHeldTcpPorts, releaseTcpPorts } = await import(${JSON.stringify(new URL("../scripts/lib/free-tcp-port.mjs", import.meta.url).href)});
await adoptHeldTcpPorts();
await releaseTcpPorts(${JSON.stringify(host)}, [${port}]);
const server = net.createServer();
server.once("error", (error) => { console.log(error.code); process.exit(0); });
server.listen(${port}, ${JSON.stringify(host)}, () => { console.log("bound"); server.close(); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { env: { PATH: process.env.PATH, ...passed.env }, stdio: ["ignore", "pipe", "inherit", ...passed.stdio] });
  const emit = child.emit.bind(child);
  child.emit = (event, message, ...rest) => {
    if (event === "message" && message?.ROO_HELD_TCP_PORTS === "adopted") {
      setTimeout(() => emit(event, message, ...rest), 400);
      return true;
    }
    return emit(event, message, ...rest);
  };
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  try {
    const handed = passed.handOver(child).catch((error) => error);
    await once(child, "exit");
    assert.equal(output.trim(), "bound");
    assert.equal(await handed, undefined);
  } finally {
    await releaseTcpPorts(host, [port]);
  }
});

test("the content fixture can share a server that keeps its port", async () => {
  const shared = http.createServer();
  await new Promise((resolve) => shared.listen(0, host, resolve));
  const origin = `http://${host}:${shared.address().port}`;
  try {
    const fixture = await createToolingContentFixture({ origin, server: shared });
    const response = await fetch(`${origin}/rest/v1/rpc/roo_fetch_shadow_documents_targeted`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ p_document_types: ["faq"], p_filters: [], p_limit: 10, p_ids: null }) });
    assert.equal(response.status, 200);
    await fixture.close();
    assert.equal(shared.listening, true);
    assert.equal(await bindable(shared.address().port), false);
  } finally {
    shared.closeAllConnections();
    await new Promise((resolve) => shared.close(resolve));
  }
});

const startUiSweep = (env) => new Promise((resolve) => {
  const dist = `.next-e2e-free-ports-${process.pid}-${Date.now()}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo-free-ports-"));
  const child = spawn(process.execPath, ["scripts/test-ui-sweep-server.mjs"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: scratch, ROO_TEST_HOST: host, NEXT_DIST_DIR: dist, UI_ARTIFACT: path.join(scratch, "ui-sweep.json"), ...env },
  });
  let stdout = "", stderr = "", finished = false;
  const finish = async (result) => {
    if (finished) return;
    finished = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    resolve({ ...result, stderr });
  };
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const line = stdout.split("\n").find((value) => value.startsWith("{"));
    if (line) finish({ started: JSON.parse(line) });
  });
  child.once("exit", (code) => finish({ code }));
});

test("the UI sweep server starts while its old fixed ports are taken", async () => {
  const holders = await Promise.all([45980, 45981].map(hold));
  try {
    const result = await startUiSweep({});
    assert.ok(result.started, result.stderr);
    assert.notEqual(new URL(result.started.url).port, "45981");
  } finally {
    await release(holders);
  }
});

test("the UI sweep server still binds an explicit port", async () => {
  const holder = await hold(0);
  try {
    const result = await startUiSweep({ UI_PORT: String(holder.address().port) });
    assert.equal(result.started, undefined);
    assert.match(result.stderr, /EADDRINUSE/);
  } finally {
    await release([holder]);
  }
});
