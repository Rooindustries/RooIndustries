import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { addressInUse, startChildOnPorts } from "../scripts/lib/start-on-port.mjs";
import { lockBuildDirectory } from "../scripts/lib/build-lock.mjs";

const host = "127.0.0.1";
const library = (name) => JSON.stringify(new URL(`../scripts/lib/${name}`, import.meta.url).href);

const capturedBindFailures = {
  postgres: 'LOG:  could not bind IPv4 address "127.0.0.1": Address already in use\nFATAL:  could not create any TCP/IP sockets',
  postgrest: "postgrest: Uncaught exception ghc-internal:GHC.Internal.IO.Exception.IOException:\n\nNetwork.Socket.bind: resource busy (Address in use)",
  node: "Error: listen EADDRINUSE: address already in use 127.0.0.1:32851",
  nextDev: " ⨯ Failed to start server\nError: listen EADDRINUSE: address already in use 127.0.0.1:38117",
};

test("every retried program's real bind failure is recognised", () => {
  for (const [program, output] of Object.entries(capturedBindFailures)) assert.ok(addressInUse(output), program);
  assert.equal(addressInUse("FATAL:  could not open file"), false);
});

const competitor = async (port) => {
  const server = http.createServer((request, response) => response.end("competitor"));
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const httpChild = (port, output) => {
  const child = spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.1")`], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  return child;
};
const answers = async ([port]) => {
  try {
    return (await fetch(`http://${host}:${port}/`)).ok;
  } catch {
    return false;
  }
};

test("a stolen automatic port is retried and a competitor's answer never counts as ready", async () => {
  const output = [];
  let stolen;
  const { ports: [port], child } = await startChildOnPorts({
    host,
    requested: [0],
    output: () => output.join(""),
    isReady: answers,
    spawnChild: ([candidate]) => {
      output.length = 0;
      if (!stolen) stolen = competitor(candidate);
      return httpChild(candidate, output);
    },
  });
  const thief = await stolen;
  try {
    assert.notEqual(port, thief.address().port);
    assert.equal(await (await fetch(`http://${host}:${port}/`)).text(), "child");
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
    await close(thief);
  }
});

test("an explicit port that is taken fails without trying another", async () => {
  const port = await freeTcpPort(host);
  const thief = await competitor(port);
  let attempts = 0;
  try {
    await assert.rejects(startChildOnPorts({
      host,
      requested: [port],
      output: () => "",
      isReady: answers,
      spawnChild: ([candidate]) => {
        attempts += 1;
        return httpChild(candidate, []);
      },
    }), /exited before it was ready/);
    assert.equal(attempts, 1);
  } finally {
    await close(thief);
  }
});

test("a child that never becomes ready is stopped", async () => {
  let child;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 1000,
    output: () => "",
    spawnChild: () => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      return child;
    },
  }), /not ready within 1000 ms/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("held ports reach the child without ever being free", async () => {
  const program = `const { adoptHeldTcpPorts, listenOnPort } = await import(${library("free-tcp-port.mjs")});
const http = await import("node:http");
await adoptHeldTcpPorts();
await new Promise((resolve) => setTimeout(resolve, 300));
await listenOnPort(http.createServer((q, s) => s.end("child")), "127.0.0.1", Number(process.argv[1]));`;
  let stolen = false;
  let competing = true;
  let port;
  const race = (async () => {
    while (competing) {
      if (port) {
        const server = await new Promise((resolve) => {
          const attempt = http.createServer();
          attempt.once("error", () => resolve(null));
          attempt.listen(port, host, () => resolve(attempt));
        });
        if (server) { stolen = true; await close(server); }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  const { ports, child } = await startChildOnPorts({
    host,
    requested: [0],
    passHeld: true,
    output: () => "",
    isReady: answers,
    spawnChild: ([candidate], held) => {
      port = candidate;
      return spawn(process.execPath, ["--input-type=module", "-e", program, String(candidate)], { stdio: ["ignore", "ignore", "inherit", ...held.stdio], env: { PATH: process.env.PATH, ...held.env } });
    },
  });
  competing = false;
  await race;
  try {
    assert.equal(await (await fetch(`http://${host}:${ports[0]}/`)).text(), "child");
    assert.equal(stolen, false);
  } finally {
    child.kill();
  }
});

test("a build directory is locked against other runs and freed when the run ends", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roo-build-lock-")), ".next-e2e-lock");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `const { lockBuildDirectory } = await import(${library("build-lock.mjs")});
await lockBuildDirectory(${JSON.stringify(dir)});
process.stdout.write("locked\\n");
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(holder.stdout, "data");
    await assert.rejects(lockBuildDirectory(dir), { code: "ELOCKED" });
    const next = await lockBuildDirectory(dir, { slots: 3 });
    assert.equal(next.dir, `${dir}-2`);
    await next.release();
  } finally {
    holder.kill();
    await once(holder, "exit");
  }
  const reclaimed = await lockBuildDirectory(dir);
  assert.equal(reclaimed.dir, dir);
  await reclaimed.release();
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("explicit ports reserved for later binders are skipped by automatic starts", async () => {
  const [later] = await reserveTcpPorts(host, [0]);
  const picked = [];
  for (let run = 0; run < 20; run += 1) {
    const { ports: [port], child } = await startChildOnPorts({
      host,
      requested: [0],
      output: () => "",
      spawnChild: ([candidate]) => httpChild(candidate, []),
    });
    picked.push(port);
    child.kill();
    await once(child, "exit");
  }
  assert.ok(!picked.includes(later));
});
