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

const alive = (pid) => {
  try {
    return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
  } catch {
    return false;
  }
};
const waitUntilGone = async (pids, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (pids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return pids.filter(alive);
};
const familyScript = (detachGrandchild) => `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: ${detachGrandchild} });
console.log(grandchild.pid);
setInterval(() => {}, 1000);`;
const spawnFamily = (detached, detachGrandchild, pids) => {
  const child = spawn(process.execPath, ["-e", familyScript(detachGrandchild)], { stdio: ["ignore", "pipe", "ignore"], detached });
  pids.push(child.pid);
  child.stdout.once("data", (chunk) => pids.push(Number(chunk)));
  return child;
};

for (const [label, detached] of [["an ordinary child", false], ["a detached child with a detached grandchild", true]]) {
  test(`a failed start stops ${label} and every descendant`, async () => {
    const pids = [];
    await assert.rejects(startChildOnPorts({ host, requested: [0], timeout: 1500, output: () => "", spawnChild: () => spawnFamily(detached, detached, pids) }), /not ready/);
    assert.equal(pids.length, 2);
    assert.deepEqual(await waitUntilGone(pids), []);
  });
}

for (const [label, ending] of [["is killed by SIGTERM", "kill"], ["exits", "exit"]]) {
  test(`children are stopped when their parent ${label}`, async () => {
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `const { spawn } = await import("node:child_process");
const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
const family = ${familyScript.toString()};
startChildOnPorts({ host: "127.0.0.1", requested: [0], timeout: 60000, output: () => "", spawnChild: () => {
  const child = spawn(process.execPath, ["-e", family(true)], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  child.stdout.once("data", (chunk) => {
    console.log(JSON.stringify([child.pid, Number(chunk)]));
    if (${JSON.stringify(ending)} === "exit") setTimeout(() => process.exit(0), 100);
  });
  return child;
} });`], { stdio: ["ignore", "pipe", "inherit"] });
    const [line] = await once(parent.stdout, "data");
    const pids = JSON.parse(String(line));
    if (ending === "kill") parent.kill("SIGTERM");
    await once(parent, "exit");
    assert.deepEqual(await waitUntilGone(pids), []);
  });
}

test("a spawn that throws releases the held ports", async () => {
  let picked;
  await assert.rejects(startChildOnPorts({ host, requested: [0], passHeld: true, output: () => "", spawnChild: ([port]) => {
    picked = port;
    throw new Error("spawn failed");
  } }), /spawn failed/);
  const server = await competitor(picked);
  await close(server);
});

test("a listener on another host never counts as the child's port", async () => {
  let thief;
  try {
    await assert.rejects(startChildOnPorts({
      host,
      requested: [0],
      timeout: 1500,
      output: () => "",
      isReady: answers,
      spawnChild: ([port]) => {
        thief = competitor(port);
        return spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.2")`], { stdio: "ignore", detached: true });
      },
    }), /not ready/);
  } finally {
    await close(await thief);
  }
});

test("a child that dies during the readiness probe is not accepted", async () => {
  let child;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    output: () => "",
    isReady: async () => {
      child.kill("SIGKILL");
      await once(child, "exit");
      return true;
    },
    spawnChild: ([port]) => {
      child = httpChild(port, []);
      return child;
    },
  }), /exited before it was ready/);
});
