import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fixturePorts, freeTcpPort, freeTcpPorts } from "../scripts/lib/free-tcp-port.mjs";

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
  await assert.rejects(fixturePorts(host, "not-a-port", 2), /Invalid fixture port/);
});

const hold = async (port) => {
  const server = net.createServer();
  server.listen(port, host);
  const [event] = await Promise.race([once(server, "listening").then(() => ["listening"]), once(server, "error")]);
  return event === "listening" ? server : null;
};
const release = (servers) => Promise.all(servers.filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));

test("fixture ports follow an explicit first port and are free otherwise", async () => {
  const [first] = await freeTcpPorts(host, [0]);
  assert.deepEqual(await fixturePorts(host, String(first), 1), [first]);
  const holder = await hold(first);
  try {
    await assert.rejects(fixturePorts(host, String(first), 3), { code: "EADDRINUSE" });
    const picked = await fixturePorts(host, undefined, 3);
    assert.equal(new Set([...picked, first]).size, 4, picked.join(", "));
  } finally {
    await release([holder]);
  }
});

const startUiSweep = (env) => new Promise((resolve) => {
  const dist = `.next-e2e-free-ports-${process.pid}-${Date.now()}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo-free-ports-"));
  const child = spawn(process.execPath, ["scripts/test-ui-sweep-server.mjs"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: scratch, ROO_TEST_HOST: host, NEXT_DIST_DIR: dist, UI_ARTIFACT: path.join(scratch, "ui-sweep.json"), ...env },
  });
  let stdout = "", stderr = "";
  const finish = (result) => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
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
