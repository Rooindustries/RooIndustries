import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freeTcpPort, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { execFileSync, startChildOnPorts, stopChild } from "../scripts/lib/fixture-tools.mjs";

const host = "127.0.0.1";
const fixture = fileURLToPath(new URL("./fixtures/port-reservation.mjs", import.meta.url));
const probe = (port) => JSON.parse(execFileSync(process.execPath,
  [fixture, "reserve", host, String(port)], { encoding: "utf8" }));

test("allocation stays reserved while PostgreSQL could still be initializing", async () => {
  const port = await freeTcpPort(host);
  try {
    assert.equal(fs.statSync("/tmp/roo-fixture-ports").mode & 0o7777, 0o1777);
    assert.equal(fs.statSync(`/tmp/roo-fixture-ports/${port}`).mode & 0o777, 0o666);
    assert.deepEqual(probe(port), { code: "EADDRINUSE" });
  } finally {
    await releaseTcpPorts(host, [port]);
  }
  assert.deepEqual(probe(port), { port });
});

test("a socket passed directly to another process keeps its reservation after handoff", { timeout: 15000 }, async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  const held = passHeldTcpPorts(host, [port]);
  const library = new URL("../scripts/lib/free-tcp-port.mjs", import.meta.url).href;
  const program = `const { adoptHeldTcpPorts, releaseTcpSockets, releaseTcpPorts } = await import(${JSON.stringify(library)});
await adoptHeldTcpPorts(); await releaseTcpSockets(${JSON.stringify(host)}, [${port}]);
console.log("ready"); await new Promise((resolve) => process.stdin.once("data", resolve));
await releaseTcpPorts(${JSON.stringify(host)}, [${port}]);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    env: { PATH: process.env.PATH, ...held.env }, stdio: ["pipe", "pipe", "inherit", ...held.stdio],
  });
  const ready = once(child.stdout, "data");
  try {
    await held.handOver(child);
    await ready;
    assert.deepEqual(probe(port), { code: "EADDRINUSE" });
    child.stdin.end("stop");
    await once(child, "exit");
    assert.deepEqual(probe(port), { port });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await releaseTcpPorts(host, [port]);
  }
});

test("the reservation spans socket handoff and ends only after stopChild drains the fixture", { timeout: 15000 }, async () => {
  let child, port, ready;
  const waiting = new Promise((resolve) => { ready = resolve; });
  const starting = startChildOnPorts({
    host, requested: [0], output: () => "",
    spawnChild: ([picked], launch) => {
      port = picked;
      child = launch.spawn(process.execPath, [fixture, "bind-later", host, String(port)], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      once(child.stdout, "data").then(ready);
      return child;
    },
  });
  try {
    await waiting;
    assert.deepEqual(probe(port), { code: "EADDRINUSE" });
    child.stdin.end("bind");
    await starting;
    assert.equal(await (await fetch(`http://${host}:${port}`)).text(), "owner");
    await stopChild(child, 100);
    assert.deepEqual(probe(port), { port });
  } finally {
    if (child) await stopChild(child, 0);
    await starting.catch(() => {});
  }
});
