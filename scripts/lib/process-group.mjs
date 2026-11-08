import fs from "node:fs";
import { spawn } from "node:child_process";
import { fixtureScope, rememberFixtureScope } from "./fixture-run.mjs";
import { processTable, sameProcess } from "./macos-process.mjs";

const directory = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
const handles = new WeakMap();
const tracked = new WeakSet();
const macLeaders = new WeakMap();

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
  if (process.platform === "darwin") {
    if (!child.pid || tracked.has(child)) return child;
    macLeaders.set(child, processTable().find(({ pid }) => pid === child.pid));
    tracked.add(child);
    child.once("exit", onExit);
    return child;
  }
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

export const spawnGroup = (command, args, options = {}) => {
  const scope = fixtureScope(options.env);
  const child = spawn(command, args, { ...options, env: scope.env, detached: true });
  rememberFixtureScope(child, scope);
  return trackGroupLeader(child);
};

export const signalGroup = (child, signal) => {
  if (exited(child)) return;
  if (process.platform === "darwin" && tracked.has(child)) {
    if (!sameProcess(macLeaders.get(child), processTable().find(({ pid }) => pid === child.pid))) return;
    try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    return;
  }
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
  if (process.platform === "darwin") {
    return processTable().filter((entry) => entry.group === child.pid);
  }
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
  if (process.platform === "darwin") {
    const table = processTable();
    return held.filter((entry) => table.some((candidate) => sameProcess(entry, candidate))).length;
  }
  const running = held.filter((fd) => isRunning(`/proc/self/fd/${fd}`)).length;
  for (const fd of held) fs.closeSync(fd);
  return running;
};
