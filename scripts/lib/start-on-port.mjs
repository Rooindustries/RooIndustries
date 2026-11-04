import fs from "node:fs";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { freeTcpPorts, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "./free-tcp-port.mjs";

export const addressInUse = (output) => /EADDRINUSE|Address already in use|\(Address in use\)/.test(output);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const processTable = () => {
  const table = new Map();
  for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { state: fields[0], parent: Number(fields[1]), startTime: fields[19] });
    } catch {}
  }
  return table;
};

const processTree = (root) => {
  const table = processTable();
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { parent }] of table) {
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
};

const littleEndianWords = (bytes) => {
  const words = [];
  for (let index = 0; index < bytes.length; index += 4) words.push(bytes.slice(index, index + 4).reverse().map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  return words.join("").toUpperCase();
};

const ipv6Bytes = (address) => {
  const [head, tail = ""] = address.split("::");
  const groups = (part) => (part ? part.split(":") : []);
  const missing = 8 - groups(head).length - groups(tail).length;
  return [...groups(head), ...Array(address.includes("::") ? missing : 0).fill("0"), ...groups(tail)]
    .flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 255]);
};

const ipv6Wildcard = "0".repeat(32);

const dualStackSockets = (port) => {
  try {
    return new Set(execFileSync("ss", ["-Hltne", `sport = :${port}`], { encoding: "utf8" }).trim().split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[3] === `*:${port}`)
      .map((fields) => fields.find((field) => field.startsWith("ino:"))?.slice(4))
      .filter(Boolean)
      .map((inode) => `socket:[${inode}]`));
  } catch {
    return new Set();
  }
};

const listeningSockets = (host, port) => {
  const ipv4 = net.isIPv4(host);
  const bytes = ipv4 ? host.split(".").map(Number) : ipv6Bytes(host);
  const exact = ipv4
    ? { "/proc/net/tcp": new Set([littleEndianWords(bytes), "00000000"]), "/proc/net/tcp6": new Set([littleEndianWords([...Array(10).fill(0), 255, 255, ...bytes])]) }
    : { "/proc/net/tcp": new Set(), "/proc/net/tcp6": new Set([littleEndianWords(bytes), ipv6Wildcard]) };
  const sockets = new Set();
  const wildcards = [];
  for (const [table, addresses] of Object.entries(exact)) {
    for (const line of fs.readFileSync(table, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, localPort] = fields[1].split(":");
      if (fields[3] !== "0A" || parseInt(localPort, 16) !== port) continue;
      if (addresses.has(address)) sockets.add(`socket:[${fields[9]}]`);
      else if (ipv4 && address === ipv6Wildcard) wildcards.push(`socket:[${fields[9]}]`);
    }
  }
  if (wildcards.length) {
    const dualStack = dualStackSockets(port);
    for (const socket of wildcards) if (dualStack.has(socket)) sockets.add(socket);
  }
  return sockets;
};

export const ownsPorts = (pid, host, ports) => {
  const open = new Set();
  for (const member of processTree(pid)) {
    try {
      for (const fd of fs.readdirSync(`/proc/${member}/fd`)) {
        try { open.add(fs.readlinkSync(`/proc/${member}/fd/${fd}`)); } catch {}
      }
    } catch {}
  }
  return ports.every((port) => [...listeningSockets(host, port)].some((socket) => open.has(socket)));
};

const running = new Map();
const markerName = "ROO_CHILD_TREE";
let markers = 0;
let shuttingDown = false;
let installed = false;

const carriesMarker = (pid, marker) => {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`${markerName}=${marker}`);
  } catch {
    return false;
  }
};

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

export const childTreeEnv = () => (process.env[markerName] ? { [markerName]: process.env[markerName] } : {});

const startTimeOf = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return null;
  }
};

export const signalIfUnchanged = (pid, startTime, signal) => {
  if (startTimeOf(pid) !== startTime) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
};

const family = (children) => {
  const table = processTable();
  const wanted = new Set(children.map((child) => running.get(child)).filter(Boolean));
  const found = new Set(children.filter((child) => child.pid && !exited(child)).map((child) => child.pid));
  for (const pid of table.keys()) if (wanted.size && [...wanted].some((marker) => carriesMarker(pid, marker))) found.add(pid);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { parent }] of table) {
      if (!found.has(pid) && found.has(parent)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  found.delete(process.pid);
  return new Map([...found].filter((pid) => table.get(pid) && table.get(pid).state !== "Z").map((pid) => [pid, table.get(pid).startTime]));
};

const signalEach = (pids, signal) => {
  for (const [pid, startTime] of pids) signalIfUnchanged(pid, startTime, signal);
};

const terminateNow = (children) => {
  const graceful = Date.now() + 2000;
  const forced = graceful + 2000;
  for (let pids = family(children); pids.size && Date.now() < forced; pids = family(children)) {
    signalEach(pids, Date.now() < graceful ? "SIGTERM" : "SIGKILL");
    pauseSync(25);
  }
};

const onExit = () => {
  shuttingDown = true;
  terminateNow([...running.keys()]);
  running.clear();
};

const signalHandlers = new Map(["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => {
  const othersListening = process.listenerCount(signal) > 1;
  onExit();
  uninstall();
  if (!othersListening) process.kill(process.pid, signal);
}]));

let watcher;

const install = () => {
  if (installed) return;
  installed = true;
  watcher = setInterval(() => {
    for (const child of [...running.keys()]) if (exited(child) && !family([child]).size) forget(child);
  }, 250).unref();
  process.on("exit", onExit);
  for (const [signal, handler] of signalHandlers) process.prependListener(signal, handler);
};

function uninstall() {
  if (!installed) return;
  installed = false;
  clearInterval(watcher);
  process.removeListener("exit", onExit);
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
}

const forget = (child) => {
  running.delete(child);
  if (!running.size) uninstall();
};

export const stopChild = async (child) => {
  const graceful = Date.now() + 5000;
  const forced = graceful + 2000;
  for (let pids = family([child]); pids.size && Date.now() < forced; pids = family([child])) {
    signalEach(pids, Date.now() < graceful ? "SIGTERM" : "SIGKILL");
    await pause(50);
  }
  if (child.pid && !exited(child)) await new Promise((resolve) => child.once("exit", resolve));
  forget(child);
};

const waitUntilReady = async ({ child, host, ports, isReady, output, timeout, failure }) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure()) throw failure();
    if (exited(child)) throw new Error(`Child exited before it was ready:\n${output()}`);
    if (ownsPorts(child.pid, host, ports) && await isReady(ports) && !exited(child) && ownsPorts(child.pid, host, ports)) return;
    await pause(100);
  }
  throw new Error(`Child was not ready within ${timeout} ms:\n${output()}`);
};

export const startChildOnPorts = async ({ host, requested, spawnChild, output, isReady = () => true, passHeld = false, attempts = 5, timeout = 30000 }) => {
  const automatic = requested.every((port) => !port);
  for (let attempt = 1; ; attempt += 1) {
    if (shuttingDown) throw new Error("This process is shutting down; no new child starts.");
    let ports;
    if (passHeld) {
      ports = await reserveTcpPorts(host, requested);
    } else {
      const picks = await freeTcpPorts(host, requested.filter((port) => !port));
      ports = requested.map((port) => port || picks.shift());
      await releaseTcpPorts(host, ports);
    }
    const marker = `${process.pid}-${(markers += 1)}`;
    let child;
    let spawnError;
    try {
      if (shuttingDown) throw new Error("This process is shutting down; no new child starts.");
      const held = passHeld ? passHeldTcpPorts(host, ports) : { stdio: [], env: {} };
      child = spawnChild(ports, { stdio: held.stdio, env: { ...held.env, [markerName]: marker } });
      child.once("error", (error) => { spawnError = error; });
      if (child.pid) {
        running.set(child, marker);
        install();
        child.once("exit", () => { if (!family([child]).size) forget(child); });
      }
      if (passHeld) await releaseTcpPorts(host, ports);
      await waitUntilReady({ child, host, ports, isReady, output, timeout, failure: () => spawnError || (!child.pid && new Error("Child did not start.")) });
      return { ports, child };
    } catch (error) {
      if (passHeld) await releaseTcpPorts(host, ports);
      if (child) await stopChild(child);
      if (!automatic || attempt === attempts || !addressInUse(output())) throw error;
    }
  }
};
