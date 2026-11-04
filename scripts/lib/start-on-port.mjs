import fs from "node:fs";
import net from "node:net";
import { freeTcpPorts, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "./free-tcp-port.mjs";

export const addressInUse = (output) => /EADDRINUSE|Address already in use|\(Address in use\)/.test(output);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const processTable = () => {
  const table = new Map();
  for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const [state, parent, group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { state, parent: Number(parent), group: Number(group) });
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

const tableAddresses = (host) => {
  if (net.isIPv4(host)) {
    const bytes = host.split(".").map(Number);
    return {
      "/proc/net/tcp": new Set([littleEndianWords(bytes), "00000000"]),
      "/proc/net/tcp6": new Set([littleEndianWords([...Array(10).fill(0), 255, 255, ...bytes]), "0".repeat(32)]),
    };
  }
  return { "/proc/net/tcp": new Set(), "/proc/net/tcp6": new Set([littleEndianWords(ipv6Bytes(host)), "0".repeat(32)]) };
};

const listeningSockets = (host, port) => {
  const sockets = new Set();
  for (const [table, addresses] of Object.entries(tableAddresses(host))) {
    for (const line of fs.readFileSync(table, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, localPort] = fields[1].split(":");
      if (fields[3] === "0A" && parseInt(localPort, 16) === port && addresses.has(address)) sockets.add(`socket:[${fields[9]}]`);
    }
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

const running = new Set();

const signalAll = (pids, group, signal) => {
  try { process.kill(-group, signal); } catch {}
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch {}
  }
};

const anyAlive = (pids, group) => [...processTable()].some(([pid, entry]) => entry.state !== "Z" && (pids.has(pid) || entry.group === group));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const members = (child) => (exited(child) ? new Set() : processTree(child.pid));

const stopAllNow = () => {
  const targets = [...running].map((child) => ({ child, pids: members(child) }));
  for (const { child, pids } of targets) signalAll(pids, child.pid, "SIGTERM");
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && targets.some(({ child, pids }) => anyAlive(pids, child.pid))) pauseSync(25);
  for (const { child, pids } of targets) signalAll(pids, child.pid, "SIGKILL");
  running.clear();
};

process.on("exit", stopAllNow);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const onSignal = () => {
    stopAllNow();
    if (process.listenerCount(signal) === 1) {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    }
  };
  process.on(signal, onSignal);
}

export const stopChild = async (child) => {
  if (!child.pid) return;
  const pids = members(child);
  signalAll(pids, child.pid, "SIGTERM");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && anyAlive(pids, child.pid)) await pause(50);
  signalAll(pids, child.pid, "SIGKILL");
  if (!exited(child)) await new Promise((resolve) => child.once("exit", resolve));
  running.delete(child);
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
    let ports;
    if (passHeld) {
      ports = await reserveTcpPorts(host, requested);
    } else {
      const picks = await freeTcpPorts(host, requested.filter((port) => !port));
      ports = requested.map((port) => port || picks.shift());
      await releaseTcpPorts(host, ports);
    }
    let child;
    let spawnError;
    try {
      child = spawnChild(ports, passHeld ? passHeldTcpPorts(host, ports) : null);
      child.once("error", (error) => { spawnError = error; });
      if (child.pid) {
        running.add(child);
        child.once("exit", () => { if (!anyAlive(new Set(), child.pid)) running.delete(child); });
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
