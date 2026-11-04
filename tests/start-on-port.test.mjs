import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { addressInUse, signalIfUnchanged, startChildOnPorts, stopChild } from "../scripts/lib/start-on-port.mjs";

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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const httpChild = (port, output, launch) => {
  const child = spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.1")`], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...launch.env } });
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
  let started;
  try {
    started = await startChildOnPorts({
      host,
      requested: [0],
      output: () => output.join(""),
      isReady: answers,
      spawnChild: ([candidate], launch) => {
        output.length = 0;
        const child = spawn(process.execPath, ["-e", `process.stdin.once("data", () => require("http").createServer((q, s) => s.end("child")).listen(${candidate}, "127.0.0.1"))`], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, ...launch.env } });
        child.stderr.on("data", (chunk) => output.push(String(chunk)));
        const release = () => child.stdin.end("go\n");
        if (stolen) release();
        else stolen = competitor(candidate).finally(release);
        return child;
      },
    });
    const thief = await stolen;
    assert.notEqual(started.ports[0], thief.address().port);
    assert.equal(await (await fetch(`http://${host}:${started.ports[0]}/`)).text(), "child");
    assert.equal(started.child.exitCode, null);
  } finally {
    if (started) await stopChild(started.child);
    const thief = await stolen?.catch(() => null);
    if (thief) await close(thief);
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
      spawnChild: ([candidate], launch) => {
        attempts += 1;
        return httpChild(candidate, [], launch);
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
    spawnChild: (ports, launch) => {
      child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env: { ...process.env, ...launch.env } });
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
      spawnChild: ([candidate], launch) => httpChild(candidate, [], launch),
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
const spawnFamily = (detached, detachGrandchild, pids, launch) => {
  const child = spawn(process.execPath, ["-e", familyScript(detachGrandchild)], { stdio: ["ignore", "pipe", "ignore"], detached, env: { ...process.env, ...launch.env } });
  pids.push(child.pid);
  child.stdout.once("data", (chunk) => pids.push(Number(chunk)));
  return child;
};

for (const [label, detached] of [["an ordinary child", false], ["a detached child with a detached grandchild", true]]) {
  test(`a failed start stops ${label} and every descendant`, async () => {
    const pids = [];
    await assert.rejects(startChildOnPorts({ host, requested: [0], timeout: 1500, output: () => "", spawnChild: (ports, launch) => spawnFamily(detached, detached, pids, launch) }), /not ready/);
    assert.equal(pids.length, 2);
    assert.deepEqual(await waitUntilGone(pids), []);
  });
}

for (const [label, ending] of [["is killed by SIGTERM", "kill"], ["exits", "exit"]]) {
  test(`children are stopped when their parent ${label}`, async () => {
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `const { spawn } = await import("node:child_process");
const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
const family = ${familyScript.toString()};
startChildOnPorts({ host: "127.0.0.1", requested: [0], timeout: 60000, output: () => "", spawnChild: (ports, launch) => {
  const child = spawn(process.execPath, ["-e", family(true)], { stdio: ["ignore", "pipe", "ignore"], detached: true, env: { ...process.env, ...launch.env } });
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
      spawnChild: ([port], launch) => {
        thief = competitor(port);
        return spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.2")`], { stdio: "ignore", detached: true, env: { ...process.env, ...launch.env } });
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
    spawnChild: ([port], launch) => {
      child = httpChild(port, [], launch);
      return child;
    },
  }), /exited before it was ready/);
});

test("an orphan left by a child that exits early is still stopped", async () => {
  let orphan;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 3000,
    output: () => "",
    spawnChild: (ports, launch) => {
      const child = spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process");
const orphan = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
orphan.unref();
console.log(orphan.pid);`], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...launch.env }, detached: true });
      child.stdout.once("data", (chunk) => { orphan = Number(chunk); });
      return child;
    },
  }), /exited before it was ready/);
  assert.ok(orphan);
  assert.deepEqual(await waitUntilGone([orphan]), []);
});

const moduleSetup = `const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
const start = () => startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: ([port], launch) => spawn(process.execPath, ["-e", "require('http').createServer().listen(" + port + ", '127.0.0.1')"], { stdio: "ignore", env: { ...process.env, ...launch.env }, detached: true }) });`;
const parentScript = (body, withModule = true, before = "") => spawn(process.execPath, ["--input-type=module", "-e", `const { spawn } = await import("node:child_process");
${before}
${withModule ? moduleSetup : ""}
${body}
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
const lines = (child) => {
  const seen = [];
  child.stdout.on("data", (chunk) => seen.push(...String(chunk).trim().split("\n")));
  return seen;
};
const waitForLine = async (seen, match) => {
  const deadline = Date.now() + 10000;
  while (!seen.some((line) => match.test(line))) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${match}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return seen.find((line) => match.test(line));
};

test("no child starts once shutdown has begun", async () => {
  const parent = parentScript(`const first = await start();
process.on("SIGTERM", async () => {
  const outcome = await start().then((late) => \`started \${late.child.pid}\`, (error) => \`refused: \${error.message}\`);
  console.log(outcome);
  process.exit(0);
});
console.log(\`first \${first.child.pid}\`);`);
  const seen = lines(parent);
  const first = Number((await waitForLine(seen, /^first /)).split(" ")[1]);
  parent.kill("SIGTERM");
  const [code] = await once(parent, "exit");
  assert.equal(code, 0);
  assert.match(await waitForLine(seen, /^(started|refused)/), /^refused: This process is shutting down/);
  assert.deepEqual(await waitUntilGone([first]), []);
});

for (const [label, prelude, withModule] of [["without the module", "", false], ["with the module imported", "", true], ["with a child running", "await start();", true]]) {
  test(`a script's own one-shot SIGTERM handler keeps its async cleanup and exit code ${label}`, async () => {
    const parent = parentScript(`${prelude}
console.log("ready");`, withModule, `process.once("SIGTERM", async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("cleaned up");
  process.exit(0);
});`);
    const seen = lines(parent);
    await waitForLine(seen, /^ready$/);
    parent.kill("SIGTERM");
    const [code, signal] = await once(parent, "exit");
    assert.equal(signal, null);
    assert.equal(code, 0);
    assert.ok(seen.includes("cleaned up"));
  });
}

test("a script with no handler of its own still dies by SIGTERM and takes its children with it", async () => {
  const parent = parentScript('const started = await start();\nconsole.log(`child ${started.child.pid}`);');
  const seen = lines(parent);
  const child = Number((await waitForLine(seen, /^child /)).split(" ")[1]);
  parent.kill("SIGTERM");
  const [, signal] = await once(parent, "exit");
  assert.equal(signal, "SIGTERM");
  assert.deepEqual(await waitUntilGone([child]), []);
});

const ipv6Child = (port, launch, ipv6Only) => spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen({ host: "::", port: ${port}, ipv6Only: ${ipv6Only} })`], { stdio: "ignore", detached: true, env: { ...process.env, ...launch.env } });

test("an IPv6-only wildcard listener never counts as owning the IPv4 port", async () => {
  let thief;
  try {
    await assert.rejects(startChildOnPorts({
      host,
      requested: [0],
      timeout: 1500,
      output: () => "",
      isReady: answers,
      spawnChild: ([port], launch) => {
        thief = competitor(port);
        return ipv6Child(port, launch, true);
      },
    }), /not ready/);
  } finally {
    await close(await thief);
  }
});

test("a dual-stack wildcard listener does own the IPv4 port", async () => {
  const { child } = await startChildOnPorts({ host, requested: [0], isReady: answers, output: () => "", spawnChild: ([port], launch) => ipv6Child(port, launch, false) });
  await stopChild(child);
});

test("signal handlers are removed once the last orphan exits on its own", async () => {
  const baseline = process.listenerCount("SIGTERM");
  const { child } = await startChildOnPorts({
    host,
    requested: [0],
    output: () => "",
    spawnChild: ([port], launch) => spawn(process.execPath, ["-e", `const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore", detached: true }).unref();
require("http").createServer().listen(${port}, "127.0.0.1", () => setTimeout(() => process.exit(0), 300));`], { stdio: "ignore", env: { ...process.env, ...launch.env } }),
  });
  assert.equal(process.listenerCount("SIGTERM"), baseline + 1);
  await once(child, "exit");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(process.listenerCount("SIGTERM"), baseline + 1);
  const deadline = Date.now() + 5000;
  while (process.listenerCount("SIGTERM") !== baseline && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(process.listenerCount("SIGTERM"), baseline);
});

test("a process whose start time changed is never signalled", async () => {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const startTime = fs.readFileSync(`/proc/${sleeper.pid}/stat`, "utf8").split(") ")[1].split(" ")[19];
  assert.equal(signalIfUnchanged(sleeper.pid, String(Number(startTime) + 1), "SIGKILL"), false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(alive(sleeper.pid));
  assert.equal(signalIfUnchanged(sleeper.pid, startTime, "SIGKILL"), true);
  await once(sleeper, "exit");
});

test("a grandchild started with a scrubbed environment keeps the marker through childTreeEnv", async () => {
  let grandchild;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 3000,
    output: () => "",
    spawnChild: (ports, launch) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `const { spawn } = await import("node:child_process");
const { childTreeEnv } = await import(${library("start-on-port.mjs")});
const orphan = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, env: { PATH: process.env.PATH, ...childTreeEnv() } });
orphan.unref();
console.log(orphan.pid);`], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...launch.env }, detached: true });
      child.stdout.once("data", (chunk) => { grandchild = Number(chunk); });
      return child;
    },
  }), /exited before it was ready/);
  assert.ok(grandchild);
  assert.deepEqual(await waitUntilGone([grandchild]), []);
});
