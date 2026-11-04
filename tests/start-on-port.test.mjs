import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { startChildOnPorts, stopChild } from "../scripts/lib/start-on-port.mjs";

const host = "127.0.0.1";
const library = (name) => JSON.stringify(new URL(`../scripts/lib/${name}`, import.meta.url).href);

const competitor = async (port) => {
  const server = http.createServer((request, response) => response.end("competitor"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return server;
};
const close = (server) => new Promise((resolve) => server.close(resolve));
const httpChild = (launch, port, output = []) => {
  const child = launch.spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.1")`], { stdio: ["ignore", "ignore", "pipe"] });
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
const within = (promise, timeout) => {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${timeout} ms`)), timeout); })]).finally(() => clearTimeout(timer));
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
        const child = launch.spawn(process.execPath, ["-e", `process.stdin.once("data", () => require("http").createServer((q, s) => s.end("child")).listen(${candidate}, "127.0.0.1"))`], { stdio: ["pipe", "ignore", "pipe"] });
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

const handoffChild = `const { adoptHeldTcpPorts, releaseTcpPorts } = await import(${library("free-tcp-port.mjs")});
const http = await import("node:http");
const port = Number(process.argv[1]);
await adoptHeldTcpPorts();
await releaseTcpPorts("127.0.0.1", [port]);
console.log("released");
process.stdin.once("data", () => http.createServer((q, s) => s.end("child")).listen(port, "127.0.0.1"));`;

test("a held port lost between the child's release and its own bind is retried on fresh ports", async () => {
  const output = [];
  const thieves = [];
  let started;
  try {
    started = await startChildOnPorts({
      host,
      requested: [0],
      passHeld: true,
      output: () => output.join(""),
      isReady: answers,
      spawnChild: ([candidate], launch) => {
        output.length = 0;
        const child = launch.spawn(process.execPath, ["--input-type=module", "-e", handoffChild, String(candidate)], { stdio: ["pipe", "pipe", "pipe"] });
        child.stderr.on("data", (chunk) => output.push(String(chunk)));
        child.stdout.once("data", async () => {
          if (!thieves.length) thieves.push(await competitor(candidate));
          child.stdin.end("go\n");
        });
        return child;
      },
    });
    assert.equal(thieves.length, 1);
    assert.notEqual(started.ports[0], thieves[0].address().port);
    assert.equal(await (await fetch(`http://${host}:${started.ports[0]}/`)).text(), "child");
  } finally {
    if (started) await stopChild(started.child);
    await Promise.all(thieves.map(close));
  }
});

test("a held explicit port lost before the child binds fails without trying another", async () => {
  const port = await freeTcpPort(host);
  const thieves = [];
  let attempts = 0;
  try {
    await assert.rejects(startChildOnPorts({
      host,
      requested: [port],
      passHeld: true,
      output: () => "EADDRINUSE",
      isReady: answers,
      spawnChild: ([candidate], launch) => {
        attempts += 1;
        const child = launch.spawn(process.execPath, ["--input-type=module", "-e", handoffChild, String(candidate)], { stdio: ["pipe", "pipe", "ignore"] });
        child.stdout.once("data", async () => {
          thieves.push(await competitor(candidate));
          child.stdin.end("go\n");
        });
        return child;
      },
    }), /exited before it was ready/);
    assert.equal(attempts, 1);
  } finally {
    await Promise.all(thieves.map(close));
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
      output: () => "EADDRINUSE",
      isReady: answers,
      spawnChild: ([candidate], launch) => {
        attempts += 1;
        return httpChild(launch, candidate);
      },
    }), /exited before it was ready/);
    assert.equal(attempts, 1);
  } finally {
    await close(thief);
  }
});

test("a preferred default that is taken moves to a free port", async () => {
  const thief = await competitor(0);
  try {
    const { ports: [port], child } = await startChildOnPorts({
      host,
      requested: [0],
      preferred: [thief.address().port],
      isReady: answers,
      output: () => "",
      spawnChild: ([candidate], launch) => httpChild(launch, candidate),
    });
    assert.notEqual(port, thief.address().port);
    assert.equal(await (await fetch(`http://${host}:${port}/`)).text(), "child");
    await stopChild(child);
  } finally {
    await close(thief);
  }
});

test("a child started outside launch.spawn is refused", async () => {
  let child;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    output: () => "",
    spawnChild: () => {
      child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      return child;
    },
  }), /launch\.spawn/);
  await once(child, "exit");
});

test("a child that never becomes ready is stopped", async () => {
  let child;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 1000,
    output: () => "",
    spawnChild: (ports, launch) => {
      child = launch.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
      return child;
    },
  }), /not ready within 1000 ms/);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("a failed start kills the child and its descendants, even ones that ignore SIGTERM", async () => {
  let closed;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 1000,
    output: () => "",
    spawnChild: (ports, launch) => {
      const child = launch.spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {});
require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] });
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.resume();
      closed = once(child.stdout, "close");
      return child;
    },
  }), /not ready/);
  await within(closed, 3000);
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
    spawnChild: ([candidate], launch) => {
      port = candidate;
      return launch.spawn(process.execPath, ["--input-type=module", "-e", program, String(candidate)], { stdio: ["ignore", "ignore", "inherit"], env: { PATH: process.env.PATH } });
    },
  });
  competing = false;
  await race;
  try {
    assert.equal(await (await fetch(`http://${host}:${ports[0]}/`)).text(), "child");
    assert.equal(stolen, false);
  } finally {
    await stopChild(child);
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
      spawnChild: ([candidate], launch) => httpChild(launch, candidate),
    });
    picked.push(port);
    await stopChild(child);
  }
  assert.ok(!picked.includes(later));
});

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
        return launch.spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen(${port}, "127.0.0.2")`]);
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
      child = httpChild(launch, port);
      return child;
    },
  }), /exited before it was ready/);
});

const ipv6Child = (launch, port, ipv6Only) => launch.spawn(process.execPath, ["-e", `require("http").createServer((q, s) => s.end("child")).listen({ host: "::", port: ${port}, ipv6Only: ${ipv6Only} })`]);

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
        return ipv6Child(launch, port, true);
      },
    }), /not ready/);
  } finally {
    await close(await thief);
  }
});

test("a dual-stack wildcard listener does own the IPv4 port", async () => {
  const { child } = await startChildOnPorts({ host, requested: [0], isReady: answers, output: () => "", spawnChild: ([port], launch) => ipv6Child(launch, port, false) });
  await stopChild(child);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = (port, ignoreTerm) => `${ignoreTerm ? "process.on(\"SIGTERM\", () => {});" : ""}require("http").createServer((q, s) => { s.end("alive"); if (q.url === "/exit") process.exit(0); }).listen(${port}, "127.0.0.1");`;
const answering = (port) => fetch(`http://${host}:${port}/`).then((response) => response.ok, () => false);
const silenced = async (port, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (await answering(port)) {
    if (Date.now() > deadline) return false;
    await pause(50);
  }
  return true;
};
const dismiss = (port) => fetch(`http://${host}:${port}/exit`).catch(() => {});

test("a double-forked daemon with a scrubbed environment is stopped with its child", async () => {
  const daemonPort = await freeTcpPort(host);
  const intermediate = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(server(daemonPort, true))}], { stdio: "ignore", detached: true, env: {} }).unref();`;
  try {
    const { child } = await startChildOnPorts({
      host,
      requested: [0],
      isReady: answers,
      output: () => "",
      spawnChild: ([port], launch) => launch.spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(intermediate)}], { stdio: "ignore", detached: true, env: {} }).unref();
${server(port, false)}`]),
    });
    const deadline = Date.now() + 5000;
    while (!await answering(daemonPort)) {
      assert.ok(Date.now() < deadline, "the daemon never started");
      await pause(50);
    }
    await stopChild(child);
    assert.ok(await silenced(daemonPort), "the daemon outlived its fixture child");
  } finally {
    await dismiss(daemonPort);
  }
});

test("a grandchild accepted as the port owner is stopped with the child", async () => {
  let port;
  try {
    const { child } = await startChildOnPorts({
      host,
      requested: [0],
      isReady: answers,
      output: () => "",
      spawnChild: ([candidate], launch) => {
        port = candidate;
        return launch.spawn(process.execPath, ["-e", `process.on("SIGTERM", () => process.exit(0));
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(server(candidate, true))}], { stdio: "ignore", env: {} });
setInterval(() => {}, 1000);`]);
      },
    });
    await stopChild(child);
    assert.ok(await silenced(port), "the grandchild that owned the port outlived stopChild");
  } finally {
    if (port) await dismiss(port);
  }
});

test("children die with a fixture process that is killed outright", async () => {
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
const server = ${server.toString()};
const { ports } = await startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: ([port], launch) => launch.spawn(process.execPath, ["-e", server(port, true)]) });
console.log(ports[0]);
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(parent.stdout, "data");
  const port = Number(line);
  try {
    assert.ok(await answering(port));
    parent.kill("SIGKILL");
    await once(parent, "exit");
    assert.ok(await silenced(port), "the child outlived its killed fixture process");
  } finally {
    await dismiss(port);
  }
});

test("stopping a child never signals a process whose PID was reused", async () => {
  const program = `import fs from "node:fs";
import { spawn } from "node:child_process";
const { startChildOnPorts, stopChild } = await import(${library("start-on-port.mjs")});
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const signal = process.kill.bind(process);
let started, victim, reused = false;
process.kill = (pid, name) => {
  const target = Math.abs(pid);
  const held = started && target === started.child.pid && started.child.exitCode === null && started.child.signalCode === null;
  if (!victim && name && !held) {
    signal(target, "SIGKILL");
    for (let tries = 0; tries < 300 && fs.existsSync("/proc/" + target); tries += 1) wait(10);
    fs.writeFileSync("/proc/sys/kernel/ns_last_pid", String(target - 1));
    victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    reused = victim.pid === target;
  }
  return signal(pid, name);
};
started = await startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: ([port], launch) => launch.spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:child_process").spawn(process.execPath, ["-e", "process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); require("http").createServer().listen(' + port + ', "127.0.0.1");']) });
await stopChild(started.child);
await new Promise((resolve) => setTimeout(resolve, 300));
console.log(JSON.stringify({ signalledOther: Boolean(victim), reused, victimAlive: victim ? victim.exitCode === null && victim.signalCode === null : null }));
victim?.kill("SIGKILL");
process.exit(0);`;
  const run = spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--", process.execPath, "--input-type=module", "-e", program], { encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.signalledOther, false, `stopChild signalled a PID it does not hold (reused by another process: ${result.reused}, that process survived: ${result.victimAlive})`);
});

test("a machine that refuses PID namespaces stops the start with a clear error", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "roo-no-userns-"));
  fs.writeFileSync(path.join(bin, "unshare"), "#!/bin/sh\necho 'unshare: unshare failed: Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
  try {
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
await startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: (ports, launch) => launch.spawn(process.execPath, ["-e", ""]) });`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /refused to create one: unshare: unshare failed: Operation not permitted/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
