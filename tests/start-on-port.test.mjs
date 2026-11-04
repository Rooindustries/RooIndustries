import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
  const { spawn } = await import("node:child_process");
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

test("a failed start kills the child's whole process group, even members that ignore SIGTERM", async () => {
  const pids = [];
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    timeout: 1000,
    output: () => "",
    spawnChild: (ports, launch) => {
      const child = launch.spawn(process.execPath, ["-e", `process.on("SIGTERM", () => {});
const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(grandchild.pid);
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
      pids.push(child.pid);
      child.stdout.once("data", (chunk) => pids.push(Number(chunk)));
      return child;
    },
  }), /not ready/);
  assert.equal(pids.length, 2);
  assert.deepEqual(await waitUntilGone(pids), []);
});

test("once the leader has exited, its process group number is never signalled again", async (t) => {
  let reported;
  const { child } = await startChildOnPorts({
    host,
    requested: [0],
    isReady: answers,
    output: () => "",
    spawnChild: ([candidate], launch) => {
      const child = launch.spawn(process.execPath, ["-e", `const grandchild = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => console.log('TERM')); console.log(process.pid); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] });
const server = require("http").createServer((q, s) => s.end("child")).listen(${candidate}, "127.0.0.1");
process.stdin.once("data", () => { server.close(); process.exit(0); });`], { stdio: ["pipe", "pipe", "ignore"] });
      const lines = [];
      child.stdout.on("data", (chunk) => lines.push(...String(chunk).split("\n").filter(Boolean)));
      reported = { lines, pid: once(child.stdout, "data").then(([chunk]) => Number(String(chunk).split("\n")[0])) };
      return child;
    },
  });
  const grandchild = await reported.pid;
  try {
    child.stdin.end("exit\n");
    await once(child, "exit");
    const kill = t.mock.method(process, "kill");
    await stopChild(child, 500);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(kill.mock.calls.filter(({ arguments: [pid] }) => pid === -child.pid || pid === child.pid), []);
    kill.mock.restore();
    assert.ok(alive(grandchild));
    assert.deepEqual(reported.lines.slice(1), []);
  } finally {
    if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
    await waitUntilGone([grandchild]);
  }
});

test("a leader reaped alongside another is never signalled by number while its exit is still pending", async (t) => {
  const start = () => startChildOnPorts({ host, requested: [0], isReady: answers, output: () => "", spawnChild: ([port], launch) => httpChild(launch, port) });
  const { child: first } = await start();
  const { child: second } = await start();
  const zombie = (pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
    } catch {
      return false;
    }
  };
  const startedAt = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch {
      return undefined;
    }
  };
  const secondStart = startedAt(second.pid);
  process.kill(first.pid, "SIGKILL");
  process.kill(second.pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (!(zombie(first.pid) && zombie(second.pid)) && Date.now() < deadline);
  assert.ok(zombie(first.pid) && zombie(second.pid));
  const send = process.kill.bind(process);
  const signalledAfterReap = [];
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    if (Math.abs(pid) === second.pid && startedAt(second.pid) !== secondStart) signalledAfterReap.push(pid);
    return send(pid, signal);
  });
  await stopChild(first);
  await stopChild(second);
  kill.mock.restore();
  assert.deepEqual(signalledAfterReap, []);
});

test("each attempt is judged on its own output, so a later unrelated failure is reported and not retried", async () => {
  const output = [];
  let attempts = 0;
  await assert.rejects(startChildOnPorts({
    host,
    requested: [0],
    output: () => output.join(""),
    spawnChild: ([candidate], launch) => {
      attempts += 1;
      const failure = attempts === 1 ? `console.error("listen EADDRINUSE: address already in use 127.0.0.1:${candidate}"); process.exit(1);` : `console.error("migration failed"); process.exit(42);`;
      const child = launch.spawn(process.execPath, ["-e", failure], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk) => output.push(String(chunk)));
      return child;
    },
  }), /exited before it was ready \(exit 42\)/);
  assert.equal(attempts, 2);
});

test("a retry judges a log file only by what the failed attempt appended", async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "start-on-port-")), "child.log");
  let attempts = 0;
  try {
    await assert.rejects(startChildOnPorts({
      host,
      requested: [0],
      output: () => fs.readFileSync(log, "utf8"),
      spawnChild: ([candidate], launch) => {
        attempts += 1;
        const failure = attempts === 1 ? `console.error("listen EADDRINUSE: address already in use 127.0.0.1:${candidate}"); process.exit(1);` : `console.error("migration failed"); process.exit(42);`;
        const fd = fs.openSync(log, "a");
        try {
          return launch.spawn(process.execPath, ["-e", failure], { stdio: ["ignore", fd, fd] });
        } finally {
          fs.closeSync(fd);
        }
      },
    }), /exited before it was ready \(exit 42\)/);
    assert.equal(attempts, 2);
  } finally {
    fs.rmSync(path.dirname(log), { recursive: true, force: true });
  }
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
