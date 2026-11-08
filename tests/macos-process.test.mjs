import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  freeTcpPorts, releaseTcpPorts, reserveTcpPorts, takeTcpPortReservations,
} from "../scripts/lib/free-tcp-port.mjs";
import { allocationTime, drainMacGroup, ownsMacPorts, processTable, recordMacMembers } from "../scripts/lib/macos-process.mjs";
import { scopeOf } from "../scripts/lib/fixture-run.mjs";
import { spawnContained, stopChild } from "../scripts/lib/start-on-port.mjs";

const host = "127.0.0.1";
const supervisor = fileURLToPath(new URL("../scripts/lib/macos-fixture-child.mjs", import.meta.url));
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
const until = async (condition) => {
  const deadline = Date.now() + 10000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "fixture cleanup did not complete");
    await pause();
  }
};
const alive = (pid) => processTable().some((entry) => entry.pid === pid);
const terminate = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGKILL");
  await ended;
};
const fixture = async (program, ports, daemons = [], command = process.execPath, args = ["-e", program]) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "macos-members-"));
  const allocatedAt = allocationTime();
  const allocations = daemons.map((daemon) => ({ ...daemon, allocatedAt }));
  const child = spawn(process.execPath, [supervisor, JSON.stringify({
    command, args, extra: [], ipc: false, ports, allocations, directory,
  })], { detached: true, stdio: ["ignore", "pipe", "inherit", "pipe"] });
  const state = {
    directory, ports, allocations, members: new Map(), leader: processTable().find(({ pid }) => pid === child.pid),
  };
  await once(child.stdio[3], "data");
  child.stdio[3].write("\n");
  const dispose = async () => {
    await terminate(child);
    child.stdio[3].destroy();
    await drainMacGroup(state, 0);
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { child, state, dispose };
};

test("cleanup stops a fast reparented background child in the original process group", async () => {
  const started = await fixture(undefined, [], [], "/bin/sh", ["-c", "sleep 60 &"]);
  try {
    if (started.child.exitCode === null) await once(started.child, "exit");
    assert.deepEqual(processTable().filter(({ group }) => group === started.child.pid), []);
  } finally {
    for (const entry of processTable().filter(({ group }) => group === started.child.pid)) {
      process.kill(entry.pid, "SIGKILL");
    }
    await started.dispose();
  }
});

test("an unmatched outside command on an allocated port is never adopted or stopped", async () => {
  const [port] = await reserveTcpPorts(host, [0]);
  const reservations = takeTcpPortReservations(host, [port]);
  await releaseTcpPorts(host, [port]);
  const program = 'setInterval(() => {}, 1000)';
  const started = await fixture(program, [port], [{ port, command: process.execPath, args: ["-e", program] }]);
  const other = spawn(process.execPath, ["-e", `require("http").createServer().listen(${port},
    "127.0.0.1", () => console.log("ready"));`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(other.stdout, "data");
    assert.equal(await ownsMacPorts(started.child, host, [port], started.state), false);
    await started.dispose();
    assert.ok(alive(other.pid), "cleanup stopped the outside listener");
  } finally {
    await terminate(other);
    await started.dispose();
    for (const fd of reservations) fs.closeSync(fd);
  }
});

test("the same command on another loopback address is never adopted", { timeout: 20000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "macos-address-"));
  const binary = path.join(scratch, "process-probe");
  const source = fileURLToPath(new URL("./fixtures/process-probe.c", import.meta.url));
  const built = spawnSync("cc", ["-O2", source, "-o", binary], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const [port] = await freeTcpPorts(host, [0]);
  const owner = spawnContained(binary, ["wait"], { stdio: ["ignore", "pipe", "inherit"] });
  let other;
  try {
    await once(owner.stdout, "data");
    const state = { leader: processTable().find(({ pid }) => pid === owner.pid), members: new Map(),
      ports: [port], scope: scopeOf(owner),
      allocations: [{ port, host, allocatedAt: allocationTime(), command: binary, args: ["wait"] }] };
    other = spawn(binary, ["wait"], { stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, FIXTURE_HOST: "::1", FIXTURE_PORT: String(port) } });
    await once(other.stdout, "data");
    recordMacMembers(state);
    assert.equal([...state.members.values()].some((entry) => entry.pid === other.pid), false);
    await stopChild(owner, 100);
    assert.ok(alive(other.pid), "cleanup stopped the unrelated listener");
  } finally {
    await stopChild(owner, 0);
    if (other) await terminate(other);
    await releaseTcpPorts(host, [port]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a matching command on another allocation is never adopted or stopped", { timeout: 20000 }, async () => {
  const [ownedPort, otherPort] = await freeTcpPorts(host, [0, 0]);
  const program = 'require("http").createServer((q, s) => s.end("alive"))' +
    '.listen(Number(process.env.FIXTURE_PORT), "127.0.0.1", () => console.log(process.pid));';
  const other = spawn(process.execPath, ["-e", program], {
    env: { ...process.env, FIXTURE_PORT: String(otherPort) }, stdio: ["ignore", "pipe", "inherit"],
  });
  await once(other.stdout, "data");
  const started = await fixture(`process.env.FIXTURE_PORT = "${ownedPort}";
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(program)}],
      { stdio: ["ignore", "inherit", "inherit"] }); setInterval(() => {}, 1000);`,
  [ownedPort, otherPort], [{ port: otherPort, command: process.execPath, args: ["-e", program] }]);
  try {
    await until(() => ownsMacPorts(started.child, host, [ownedPort], started.state));
    const adopted = await ownsMacPorts(started.child, host, [otherPort], started.state);
    started.child.stdio[3].write(`${JSON.stringify({ grace: 100 })}\n`);
    await once(started.child, "exit");
    await drainMacGroup(started.state, 0);
    assert.equal(adopted, false, "a matching command proved ownership of an unrelated listener");
    assert.ok(alive(other.pid), "cleanup stopped the unrelated listener");
  } finally {
    await started.dispose();
    await terminate(other);
  }
});

test("cleanup ignores a recorded PID with a different process start time", async () => {
  const child = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await once(child.stdout, "data");
  try {
    const identity = processTable().find(({ pid }) => pid === child.pid);
    const stale = { ...identity, start: "Sat Jan  1 00:00:00 2000", ports: [] };
    await drainMacGroup({ members: new Map([[`${stale.pid}:${stale.start}`, stale]]), ports: [] }, 0);
    assert.ok(alive(child.pid), "cleanup signalled a PID whose start time changed");
  } finally {
    await terminate(child);
  }
});

test("a listener needs its allocated port, allocation time and exact command before cleanup can adopt it", async () => {
  const [port] = await freeTcpPorts(host, [0]);
  const allocatedAt = allocationTime();
  const program = `require("http").createServer().listen(${port}, "127.0.0.1", () => console.log(process.pid))`;
  const started = await fixture(program, [port]);
  const [line] = await once(started.child.stdout, "data");
  const member = Number(String(line));
  try {
    const identity = processTable().find(({ pid }) => pid === member);
    assert.ok(identity.startedAt > allocatedAt);
    assert.equal(identity.uid, process.getuid());
    for (const change of [
      { allocatedAt: allocationTime() },
      { allocatedAt: undefined },
      { allocatedAt: NaN },
      { command: "another-command" },
      { ports: [] },
    ]) {
      const { ports = [port], ...overrides } = change;
      const allocation = { port, allocatedAt, command: process.execPath, args: ["-e", program], ...overrides };
      await drainMacGroup({ ports, allocations: [allocation], members: new Map() }, 0);
      assert.ok(alive(member), `cleanup adopted a listener with ${JSON.stringify(change)}`);
    }
  } finally {
    await started.dispose();
  }
});

for (const mode of ["stop", "killed supervisor", "killed parent"]) {
  test(`a detached member that closes its socket survives no ${mode}`, { timeout: 20000 }, async () => {
    const [port] = await freeTcpPorts(host, [0]);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "macos-detached-"));
    const marker = path.join(scratch, "terminated");
    const program = `const server = require("http").createServer((q, s) => s.end("alive"));
      process.on("SIGTERM", () => server.close(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "closed")));
      server.listen(${port}, "127.0.0.1", () => console.log(process.pid));
      setInterval(() => {}, 1000);`.replace(/\n\s*/g, " ");
    const orphan = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(program)}],
      { detached: true, stdio: ["ignore", "inherit", "inherit"], env: {} }).unref();`;
    const command = `require("node:child_process").spawn(process.execPath,
      ["-e", ${JSON.stringify(orphan)}], { detached: true, stdio: ["ignore", "inherit", "inherit"], env: {} }).unref();
      setInterval(() => {}, 1000);`;
    let started, parent, member;
    try {
      if (mode === "killed parent") {
        const directory = path.join(scratch, "members");
        fs.mkdirSync(directory);
        parent = spawn(process.execPath, ["--input-type=module", "-e", `
          import { spawn } from "node:child_process";
          import { once } from "node:events";
          import { allocationTime, ownsMacPorts, processTable } from ${JSON.stringify(new URL("../scripts/lib/macos-process.mjs", import.meta.url).href)};
          const allocations = [{ port: ${port}, command: process.execPath, args: ["-e", ${JSON.stringify(program)}],
            allocatedAt: allocationTime() }];
          const child = spawn(process.execPath, [${JSON.stringify(supervisor)}, JSON.stringify({
            command: process.execPath, args: ["-e", ${JSON.stringify(command)}], ports: [${port}], extra: [], ipc: false,
            directory: ${JSON.stringify(directory)}, allocations,
          })], { detached: true, stdio: ["ignore", "pipe", "inherit", "pipe"] });
          const state = { directory: ${JSON.stringify(directory)}, ports: [${port}], members: new Map(),
            leader: processTable().find(({ pid }) => pid === child.pid), allocations };
          await once(child.stdio[3], "data"); child.stdio[3].write("\\n");
          const [line] = await once(child.stdout, "data");
          const deadline = Date.now() + 10000;
          while (!await ownsMacPorts(child, "127.0.0.1", [${port}], state)) {
            if (Date.now() > deadline) { child.kill("SIGKILL"); process.exit(1); }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          console.log(JSON.stringify({ member: Number(String(line)), supervisor: child.pid }));
          setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
        const [line] = await once(parent.stdout, "data");
        const info = JSON.parse(String(line));
        member = info.member;
        await terminate(parent);
        await until(() => !alive(info.supervisor));
      } else {
        started = await fixture(command, [port], [{ port, command: process.execPath, args: ["-e", program] }]);
        const [line] = await once(started.child.stdout, "data");
        member = Number(String(line));
        await until(() => ownsMacPorts(started.child, host, [port], started.state));
        if (mode === "killed supervisor") {
          await terminate(started.child);
          started.state.members.clear();
          await drainMacGroup(started.state, 100);
        } else {
          started.child.stdio[3].write(`${JSON.stringify({ grace: 100 })}\n`);
          await once(started.child, "exit");
        }
      }
      assert.ok(fs.existsSync(marker), "the member never received SIGTERM");
      assert.equal(alive(member), false, "the member stayed alive after closing its socket");
    } finally {
      if (started) await started.dispose();
      if (parent) await terminate(parent);
      if (member && alive(member)) process.kill(member, "SIGKILL");
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}
