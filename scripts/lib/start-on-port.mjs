import fs from "node:fs";
import { freeTcpPorts, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "./free-tcp-port.mjs";

export const addressInUse = (output) => /EADDRINUSE|Address already in use|\(Address in use\)/.test(output);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const processTree = (root) => {
  const parents = new Map();
  for (const name of fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
};

const listeningSockets = (port) => {
  const sockets = new Set();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    for (const line of fs.readFileSync(table, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && parseInt(fields[1].split(":")[1], 16) === port) sockets.add(`socket:[${fields[9]}]`);
    }
  }
  return sockets;
};

export const ownsPorts = (pid, ports) => {
  const open = new Set();
  for (const member of processTree(pid)) {
    try {
      for (const fd of fs.readdirSync(`/proc/${member}/fd`)) {
        try { open.add(fs.readlinkSync(`/proc/${member}/fd/${fd}`)); } catch {}
      }
    } catch {}
  }
  return ports.every((port) => [...listeningSockets(port)].some((socket) => open.has(socket)));
};

export const stopChild = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const signal = (name) => {
    try { process.kill(-child.pid, name); } catch { child.kill(name); }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
};

const waitUntilReady = async (child, ports, isReady, output, timeout) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child exited before it was ready:\n${output()}`);
    if (ownsPorts(child.pid, ports) && await isReady(ports)) return;
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
    const child = spawnChild(ports, passHeld ? passHeldTcpPorts(host, ports) : null);
    if (passHeld) await releaseTcpPorts(host, ports);
    try {
      await waitUntilReady(child, ports, isReady, output, timeout);
      return { ports, child };
    } catch (error) {
      await stopChild(child);
      if (!automatic || attempt === attempts || !addressInUse(output())) throw error;
    }
  }
};
