import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { holdGroupMembers, releaseGroupMembers, signalGroup, spawnGroup } from "../scripts/lib/process-group.mjs";

const zombie = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
  } catch {
    return false;
  }
};

const sleeper = () => spawnGroup(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

test("signalGroup sends nothing to a group whose leader was reaped before its exit callback ran", async (t) => {
  const first = sleeper();
  const second = sleeper();
  process.kill(first.pid, "SIGKILL");
  process.kill(second.pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (!(zombie(first.pid) && zombie(second.pid)) && Date.now() < deadline);
  assert.ok(zombie(first.pid) && zombie(second.pid));
  const signalled = [];
  const send = process.kill.bind(process);
  const kill = t.mock.method(process, "kill", (pid, signal) => {
    signalled.push(pid);
    return send(pid, signal);
  });
  first.once("exit", () => signalGroup(second, "SIGTERM"));
  await Promise.all([once(first, "exit"), once(second, "exit")]);
  kill.mock.restore();
  assert.deepEqual(signalled, []);
});

test("signalGroup stops the whole group while its leader is running", async () => {
  const leader = spawnGroup(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stdout.write(String(child.pid));
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "ignore"] });
  const [chunk] = await once(leader.stdout, "data");
  const grandchild = Number(String(chunk));
  const members = holdGroupMembers(leader);
  assert.equal(members.length, 2);
  signalGroup(leader, "SIGKILL");
  await once(leader, "exit");
  const deadline = Date.now() + 5000;
  const gone = () => !fs.existsSync(`/proc/${grandchild}`) || zombie(grandchild);
  while (!gone() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releaseGroupMembers(members), 0);
});
