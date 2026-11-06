import fs from "node:fs";
import { spawn } from "node:child_process";

const directory = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
const handles = new WeakMap();
const tracked = new WeakSet();

export const isRunning = (proc) => {
  try {
    const stat = fs.readFileSync(`${proc}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
};

export const leaderProc = (child) => (handles.has(child) ? `/proc/self/fd/${handles.get(child)}` : null);

export const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const leaderUnreaped = (child) => !exited(child) && fs.existsSync(`${leaderProc(child)}/stat`);

export const isTrackedLeader = (child) => tracked.has(child);

export const trackGroupLeader = (child, onExit = () => {}) => {
  if (!child.pid || handles.has(child)) return child;
  const fd = fs.openSync(`/proc/${child.pid}`, directory);
  handles.set(child, fd);
  tracked.add(child);
  child.once("exit", () => {
    handles.delete(child);
    fs.closeSync(fd);
    onExit();
  });
  return child;
};

export const spawnGroup = (command, args, options = {}) =>
  trackGroupLeader(spawn(command, args, { ...options, detached: true }));

export const signalGroup = (child, signal) => {
  if (exited(child)) return;
  if (!handles.has(child)) {
    child.kill(signal);
    return;
  }
  if (!leaderUnreaped(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const groupOf = (proc) => {
  const stat = fs.readFileSync(`${proc}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
};

export const holdGroupMembers = (child) => {
  if (!handles.has(child) || !leaderUnreaped(child)) return [];
  return fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((pid) => {
    let fd;
    try {
      fd = fs.openSync(`/proc/${pid}`, directory);
      if (groupOf(`/proc/self/fd/${fd}`) === child.pid) return [fd];
    } catch {}
    if (fd !== undefined) fs.closeSync(fd);
    return [];
  });
};

export const releaseGroupMembers = (held) => {
  const running = held.filter((fd) => isRunning(`/proc/self/fd/${fd}`)).length;
  for (const fd of held) fs.closeSync(fd);
  return running;
};
