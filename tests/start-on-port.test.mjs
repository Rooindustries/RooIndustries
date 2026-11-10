import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort, reserveTcpPorts } from "../scripts/lib/free-tcp-port.mjs";
import { spawnContained, startChildOnPorts, stopChild } from "../scripts/lib/start-on-port.mjs";
import { spawnGroup } from "../scripts/lib/process-group.mjs";

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

test("a child that took held ports still reports close once it stops", async () => {
  const started = await startChildOnPorts({
    host,
    requested: [0],
    passHeld: true,
    output: () => "",
    isReady: answers,
    spawnChild: ([candidate], launch) => {
      const args = ["--input-type=module", "-e", handoffChild, String(candidate)];
      const child = launch.spawn(process.execPath, args, { stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.once("data", () => child.stdin.end("go\n"));
      return child;
    },
  });
  const closed = once(started.child, "close").then(() => "closed");
  await stopChild(started.child);
  let timer;
  const stuck = new Promise((resolve) => { timer = setTimeout(() => resolve("stuck"), 5000); });
  const result = await Promise.race([closed, stuck]);
  clearTimeout(timer);
  assert.equal(result, "closed", "close never fired after the port hand-over");
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

test("a leader that exits on its own takes its descendants down and its group is never signalled again", async (t) => {
  let closed;
  const { child } = await startChildOnPorts({
    host,
    requested: [0],
    isReady: answers,
    output: () => "",
    spawnChild: ([candidate], launch) => {
      const child = launch.spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "ignore"] });
const server = require("http").createServer((q, s) => s.end("child")).listen(${candidate}, "127.0.0.1");
process.stdin.once("data", () => { server.close(); process.exit(0); });`], { stdio: ["pipe", "pipe", "ignore"] });
      child.stdout.resume();
      closed = once(child.stdout, "close");
      return child;
    },
  });
  child.stdin.end("exit\n");
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
  const kill = t.mock.method(process, "kill");
  await stopChild(child, 500);
  assert.deepEqual(kill.mock.calls.filter(({ arguments: [pid] }) => pid === -child.pid || pid === child.pid), []);
  kill.mock.restore();
  await within(closed, 3000);
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

test("stopChild refuses a child it did not start instead of waiting on it forever", async () => {
  const stray = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    await assert.rejects(stopChild(stray), /only stops children started with launch\.spawn, spawnContained or spawnGroup/);
  } finally {
    stray.kill("SIGKILL");
    if (stray.exitCode === null && stray.signalCode === null) await once(stray, "exit");
  }
  const tracked = spawnContained(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await stopChild(tracked, 500);
  assert.ok(tracked.exitCode !== null || tracked.signalCode !== null, "the contained child is still running");
  const grouped = spawnGroup(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await stopChild(grouped, 500);
  assert.equal(grouped.signalCode, "SIGTERM");
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

const takePid = [
  "use POSIX ();",
  "my ($nr, $pid) = @ARGV;",
  "my $want = pack('i', $pid);",
  "my $args = pack('Q11', 0, 0, 0, 0, 17, 0, 0, 0, unpack('Q', pack('p', $want)), 1, 0);",
  "my $got = syscall($nr + 0, $args, length $args);",
  "die \"clone3: $!\\n\" if $got < 0;",
  "if ($got == 0) {",
  "  POSIX::setsid();",
  "  open STDIN, '<', '/dev/null'; open STDOUT, '>', '/dev/null'; open STDERR, '>', '/dev/null';",
  "  exec 'sleep', '300'; POSIX::_exit(127);",
  "}",
  "print \"$got\\n\";",
].join("\n");

test("a fixture whose exit callback stops another that exited with it never signals the reused PID", async () => {
  const clone3 = { x64: 435, arm64: 435 }[process.arch];
  assert.ok(clone3, `no clone3 syscall number for ${process.arch}`);
  const program = `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const { startChildOnPorts, stopChild } = await import(${library("start-on-port.mjs")});
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const zombie = (pid) => { try { return fs.readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1][0] === "Z"; } catch { return false; } };
const start = () => startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: ([port], launch) => launch.spawn(process.execPath, ["-e", 'require("http").createServer().listen(' + port + ', "127.0.0.1")']) });
const fixtures = [await start(), await start()];
let victim, target;
const stopOther = (other) => () => {
  if (!victim && other.child.exitCode === null && other.child.signalCode === null && !fs.existsSync("/proc/" + other.child.pid)) {
    target = other.child.pid;
    const grouped = () => fs.readdirSync("/proc").some((entry) => { try { return /^\\d+$/.test(entry) && Number(fs.readFileSync("/proc/" + entry + "/stat", "utf8").split(") ")[1].split(" ")[2]) === target; } catch { return false; } });
    for (let tries = 0; tries < 500 && grouped(); tries += 1) wait(10);
    const taken = spawnSync("perl", ["-e", ${JSON.stringify(takePid)}, "${clone3}", String(target)], { encoding: "utf8" });
    victim = Number(taken.stdout.trim()) || null;
    if (!victim) console.error(taken.stderr);
  }
  stopChild(other.child);
};
fixtures[0].child.once("exit", stopOther(fixtures[1]));
fixtures[1].child.once("exit", stopOther(fixtures[0]));
for (const { child } of fixtures) process.kill(-child.pid, "SIGKILL");
for (let tries = 0; tries < 500 && !fixtures.every(({ child }) => zombie(child.pid)); tries += 1) wait(10);
await new Promise((resolve) => setTimeout(resolve, 500));
console.log(JSON.stringify({ reused: Boolean(victim) && victim === target, victimAlive: victim ? fs.existsSync("/proc/" + victim) && !zombie(victim) : null }));
if (victim && fs.existsSync("/proc/" + victim)) process.kill(victim, "SIGKILL");
process.exit(0);`;
  const run = spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "--", "/bin/sh", "-c", "\"$@\"; exit $?", "sh", process.execPath, "--input-type=module", "-e", program], { encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.reused, true, "the second fixture's PID was not reused, so the race never happened");
  assert.equal(result.victimAlive, true, "stopping the second fixture signalled the unrelated process that took its PID");
});

test("stopChild waits for a namespace that outlives its reaped wrapper before the port is reused", async () => {
  const syscalls = { x64: 101, arm64: 117 };
  assert.ok(syscalls[process.arch], `no ptrace syscall number for ${process.arch}`);
  const marker = `held-at-exit-${process.pid}`;
  const { ports: [port], child } = await startChildOnPorts({
    host,
    requested: [0],
    isReady: answers,
    output: () => "",
    spawnChild: ([candidate], launch) => launch.spawn(process.execPath, ["-e", server(candidate, false), marker]),
  });
  const owner = fs.readdirSync("/proc").find((entry) => {
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      return args[0] === process.execPath && args.includes(marker);
    } catch {
      return false;
    }
  });
  assert.ok(owner, "the port owner was not found");
  const tracer = spawn("perl", ["-e", "syscall($ARGV[0] + 0, 0x4206, $ARGV[1] + 0, 0, 0x40) == 0 or die \"seize: $!\\n\"; $| = 1; print \"seized\\n\"; sleep 60", String(syscalls[process.arch]), owner], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(tracer.stdout, "data");
    await dismiss(port);
    const state = () => { try { return fs.readFileSync(`/proc/${owner}/stat`, "utf8").split(") ")[1][0]; } catch { return null; } };
    const deadline = Date.now() + 5000;
    while (state() !== "t") {
      assert.ok(Date.now() < deadline, "the port owner never stopped at exit");
      await pause(20);
    }
    process.kill(child.pid, "SIGKILL");
    await once(child, "exit");
    let stopped = false;
    const stopping = stopChild(child, 200).then(() => { stopped = true; });
    await pause(1500);
    assert.equal(stopped, false, "stopChild returned while the namespace still held the port");
    await assert.rejects(competitor(port), { code: "EADDRINUSE" });
    tracer.kill("SIGKILL");
    await within(stopping, 5000);
    await close(await competitor(port));
  } finally {
    tracer.kill("SIGKILL");
    await stopChild(child);
  }
});

test("a fixture started while its parent dies never runs", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "roo-paused-setpriv-"));
  const real = spawnSync("sh", ["-c", "command -v setpriv"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(path.join(bin, "setpriv"), `#!/bin/sh\nfor last; do :; done\nif [ "$last" != true ]; then echo $$ > "${bin}/pid"; kill -STOP $$; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  const parent = spawn(process.execPath, ["--input-type=module", "-e", `const { startChildOnPorts } = await import(${library("start-on-port.mjs")});
const server = ${server.toString()};
await startChildOnPorts({ host: "127.0.0.1", requested: [0], output: () => "", spawnChild: ([port], launch) => { console.log(port); return launch.spawn(process.execPath, ["-e", server(port, false)]); } });`], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const [line] = await once(parent.stdout, "data");
  const port = Number(line);
  let wrapper;
  try {
    const deadline = Date.now() + 5000;
    const stopped = () => { try { return fs.readFileSync(`/proc/${wrapper}/stat`, "utf8").split(") ")[1][0] === "T"; } catch { return false; } };
    while (!(wrapper = Number(fs.existsSync(path.join(bin, "pid")) && fs.readFileSync(path.join(bin, "pid"), "utf8"))) || !stopped()) {
      assert.ok(Date.now() < deadline, "the wrapper never paused");
      await pause(20);
    }
    parent.kill("SIGKILL");
    await once(parent, "exit");
    process.kill(wrapper, "SIGCONT");
    const quiet = Date.now() + 3000;
    while (Date.now() < quiet) {
      assert.equal(await answering(port), false, "the fixture started after its parent was gone");
      await pause(100);
    }
  } finally {
    await dismiss(port);
    fs.rmSync(bin, { recursive: true, force: true });
  }
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
