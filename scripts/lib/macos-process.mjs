import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { markedPids } from "./fixture-run.mjs";

const { spawnSync } = createRequire(import.meta.url)("./fixture-tool-policy.cjs");

const helpers = new Map();
const nativeHelper = (name) => {
  if (!helpers.has(name)) {
    const source = fileURLToPath(new URL(`./${name}.c`, import.meta.url));
    const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    const inspector = fileURLToPath(new URL(`../../node_modules/.cache/process-info-${digest}`, import.meta.url));
    fs.mkdirSync(path.dirname(inspector), { recursive: true });
    if (!fs.existsSync(inspector)) {
      const temporary = `${inspector}.${process.pid}`;
      const built = spawnSync("cc", ["-O2", source, "-o", temporary], { encoding: "utf8" });
      if (built.status !== 0) {
        throw new Error(`Cannot build process inspector: ${built.stderr}`, { cause: built.error });
      }
      fs.renameSync(temporary, inspector);
    }
    helpers.set(name, inspector);
  }
  return helpers.get(name);
};
export const macInspector = () => nativeHelper("macos-process-info");
export const linuxSubreaper = () => nativeHelper("linux-subreaper");

const macIdentities = () => {
  const result = spawnSync(macInspector(), [], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Cannot inspect process identities: ${result.stderr}`, { cause: result.error });
  }
  return new Map(result.stdout.trim().split("\n").map((line) => line.split(" "))
    .map(([pid, start, uid, parent, group, status]) => [Number(pid), {
      start, startedAt: Number(start) * 1000, uid: Number(uid), parent: Number(parent), group: Number(group),
      status: Number(status),
    }]));
};

const macAncestry = () => [...macIdentities()].flatMap(([pid, identity]) =>
  identity.status === 5 ? [] : [{ pid, ...identity }]);

export const allocationTime = () => process.platform === "darwin" ? Date.now() : os.uptime() * 1000;
const ticks = process.platform === "linux" ? Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout) : 0;

export const processTable = () => {
  const before = process.platform === "darwin" ? macIdentities() : null;
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,uid=,command="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot inspect fixture processes: ${result.stderr}`);
  const rows = result.stdout.trim().split("\n").map((line) =>
    line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match && Number(match[1]) !== result.pid && !match[4].startsWith("Z"));
  const identities = before && macIdentities();
  return rows.flatMap((match) => {
    const pid = Number(match[1]);
    try {
      const stat = identities ? null : fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      const identity = identities ? identities.get(pid) : { start, startedAt: Number(start) * 1000 / ticks };
      if (before && (identity?.start !== before.get(pid)?.start || identity?.uid !== before.get(pid)?.uid)) return [];
      return identity ? [{ pid, parent: Number(match[2]), group: Number(match[3]), uid: Number(match[5]),
        command: match[6], ...identity }] : [];
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return [];
      throw error;
    }
  });
};

export const sameProcess = (left, right) => Boolean(left && right && left.pid === right.pid &&
  left.start === right.start);

const watchRecords = (state) => {
  const file = state.directory && path.join(state.directory, "ancestry.log");
  if (!file || !fs.existsSync(file)) return { members: [] };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const watcher = lines.find((line) => line.startsWith("watcher "))?.split(" ").slice(1).join(":");
  return { watcher, done: lines.includes("done"), members: lines.filter((line) => line.startsWith("member "))
    .map((line) => line.split(" ").slice(1).join(":")) };
};

export const recordMacMembers = (state, table = process.platform === "darwin" ? macAncestry() : processTable()) => {
  const watch = watchRecords(state);
  const live = new Set(table.map(({ pid, start }) => `${pid}:${start}`));
  const observed = new Set(watch.members);
  for (const key of state.members.keys()) if (!live.has(key)) state.members.delete(key);
  const allowed = (entry) => entry.uid === process.getuid() && `${entry.pid}:${entry.start}` !== watch.watcher &&
    entry.pid !== process.pid && !sameProcess(entry, state.leader) &&
    entry.startedAt >= (state.scope?.startedAt ?? state.leader?.startedAt ?? 0);
  if (state.directory && fs.existsSync(state.directory)) {
    for (const file of fs.readdirSync(state.directory).filter((name) => name.endsWith(".json"))) {
      for (const entry of JSON.parse(fs.readFileSync(path.join(state.directory, file), "utf8"))) {
        if (live.has(`${entry.pid}:${entry.start}`) && allowed(entry)) state.members.set(`${entry.pid}:${entry.start}`, entry);
      }
    }
  }
  for (const entry of table) {
    if (allowed(entry) && observed.has(`${entry.pid}:${entry.start}`)) {
      state.members.set(`${entry.pid}:${entry.start}`, { ...entry, ports: state.ports });
    }
  }
  const marked = markedPids(state.scope, table.map(({ pid }) => pid));
  for (const entry of table) {
    if (!marked.has(entry.pid) || !allowed(entry)) continue;
    state.members.set(`${entry.pid}:${entry.start}`, { ...entry, ports: state.ports });
  }
  const parents = table.filter((entry) => sameProcess(entry, state.leader) ||
    state.members.has(`${entry.pid}:${entry.start}`));
  const leader = table.find((entry) => entry.pid === state.leader?.pid);
  for (const entry of table.filter((candidate) => (!leader || sameProcess(leader, state.leader)) &&
    allowed(candidate) && candidate.group === state.leader?.pid &&
    candidate.startedAt >= state.leader.startedAt && !sameProcess(candidate, state.leader))) {
    state.members.set(`${entry.pid}:${entry.start}`, { ...entry, ports: state.ports });
    parents.push(entry);
  }
  for (const parent of parents) {
    for (const entry of table.filter((candidate) => candidate.parent === parent.pid && allowed(candidate))) {
      const key = `${entry.pid}:${entry.start}`;
      if (sameProcess(entry, state.leader) || state.members.has(key)) continue;
      state.members.set(key, { ...entry, ports: state.ports });
      parents.push(entry);
    }
  }
  if (state.directory && fs.existsSync(state.directory)) {
    const file = path.join(state.directory, String(process.pid));
    fs.writeFileSync(`${file}.tmp`, JSON.stringify([...state.members.values()]));
    fs.renameSync(`${file}.tmp`, `${file}.json`);
  }
  return table.filter((entry) => [...state.members.values()].some((member) => sameProcess(member, entry)));
};

export const portListeners = (port) => {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fptn"], { encoding: "utf8" });
  if (result.error || ![0, 1].includes(result.status)) throw result.error || new Error(result.stderr);
  let pid, type;
  return result.stdout.split("\n").flatMap((line) => {
    if (line[0] === "p") pid = Number(line.slice(1));
    if (line[0] === "t") type = line.slice(1);
    return line[0] === "n" ? [{ pid, type, address: line.slice(1, line.lastIndexOf(":")) }] : [];
  });
};

export const ownsMacPorts = async (child, host, ports, state) => {
  if (state.leader?.pid !== child.pid) return false;
  const members = recordMacMembers(state);
  for (const port of ports) {
    const listeners = portListeners(port);
    const exact = listeners.filter(({ address }) => address === host || address === `[${host}]`);
    const wildcards = listeners.filter(({ address }) => address === "*");
    const ipv4 = wildcards.filter(({ type }) => type === "IPv4");
    const candidates = exact.length ? exact : net.isIPv4(host) && ipv4.length ? ipv4 : wildcards;
    const owned = candidates.some(({ pid }) => members.some((entry) => entry.pid === pid &&
      state.members.get(`${entry.pid}:${entry.start}`).ports.includes(port)));
    if (!owned) return false;
    const reachable = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (ready) => { socket.destroy(); resolve(ready); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1000, () => finish(false));
    });
    if (!reachable) return false;
  }
  return true;
};

export const drainMacGroup = async (state, grace = 1000) => {
  const signalled = new Map();
  const interval = process.platform === "darwin" ? 250 : 25;
  for (;;) {
    const members = recordMacMembers(state);
    if (!members.length) {
      const watch = watchRecords(state);
      const table = processTable();
      if (watch.watcher && !watch.done && !table.some((entry) => sameProcess(entry, state.leader)) &&
        table.some((entry) => `${entry.pid}:${entry.start}` === watch.watcher)) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        continue;
      }
      return;
    }
    for (const entry of members) {
      const key = `${entry.pid}:${entry.start}`;
      const sentAt = signalled.get(key);
      if (sentAt !== undefined && Date.now() - sentAt < grace) continue;
      const signal = sentAt === undefined ? "SIGTERM" : "SIGKILL";
      if (!sameProcess(entry, processTable().find(({ pid }) => pid === entry.pid))) continue;
      try { process.kill(entry.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      if (sentAt === undefined) signalled.set(key, Date.now());
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
};

export const descriptorPath = (fd) => {
  const result = spawnSync("lsof", ["-a", "-p", String(process.pid), "-d", String(fd), "-Fn"], { encoding: "utf8" });
  return result.stdout?.split("\n").find((line) => line.startsWith("n/"))?.slice(1);
};
