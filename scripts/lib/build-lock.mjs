import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";

const lockName = (dir) => `\0roo-build-lock-${createHash("sha256").update(path.resolve(dir)).digest("hex")}`;
const leasePath = (dir) => `${path.resolve(dir)}.lock`;
const trackedGroups = new Set();
const ownedLeases = new Set();

const signalGroup = (group, signal) => {
  try {
    process.kill(-group, signal);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

process.on("exit", () => {
  for (const group of trackedGroups) signalGroup(group, "SIGKILL");
  for (const lease of ownedLeases) fs.rmSync(lease, { force: true });
});

const bindLock = (dir) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(null) : reject(error)));
  server.listen(lockName(dir), () => {
    server.unref();
    resolve(server);
  });
});

const usersStillRunning = (dir) => {
  if (!fs.existsSync(leasePath(dir))) return false;
  return JSON.parse(fs.readFileSync(leasePath(dir), "utf8")).groups.some((group) => signalGroup(group, 0));
};

const writeLease = (dir, groups) => {
  const next = `${leasePath(dir)}.${process.pid}`;
  fs.writeFileSync(next, JSON.stringify({ owner: process.pid, groups }));
  fs.renameSync(next, leasePath(dir));
};

export const lockBuildDirectory = async (dir, { slots = 1 } = {}) => {
  for (let slot = 1; slot <= slots; slot += 1) {
    const candidate = slot === 1 ? dir : `${dir}-${slot}`;
    const server = await bindLock(candidate);
    if (!server) continue;
    if (usersStillRunning(candidate)) {
      await new Promise((resolve) => server.close(resolve));
      continue;
    }
    const groups = [];
    writeLease(candidate, groups);
    ownedLeases.add(leasePath(candidate));
    return {
      dir: candidate,
      track(child) {
        groups.push(child.pid);
        trackedGroups.add(child.pid);
        writeLease(candidate, groups);
      },
      release: () => new Promise((resolve) => server.close(resolve)),
    };
  }
  throw Object.assign(new Error(`${dir} is in use by another run.`), { code: "ELOCKED" });
};

export const signalTracked = (child, signal) => signalGroup(child.pid, signal);
