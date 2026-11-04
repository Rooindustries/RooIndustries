import fs from "node:fs";
import net from "node:net";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { freeTcpPorts, passHeldTcpPorts, releaseTcpPorts, reserveTcpPorts } from "./free-tcp-port.mjs";

export const addressInUse = (output) => /EADDRINUSE|Address already in use|\(Address in use\)/.test(output);

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const groupMembers = (group) => fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]) === group;
  } catch {
    return false;
  }
});

export const ownsPorts = (group, host, ports) => {
  const open = new Set();
  for (const member of groupMembers(group)) {
    try {
      for (const fd of fs.readdirSync(`/proc/${member}/fd`)) {
        try { open.add(fs.readlinkSync(`/proc/${member}/fd/${fd}`)); } catch {}
      }
    } catch {}
  }
  return ports.every((port) => [...listeningSockets(host, port)].some((socket) => open.has(socket)));
};

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

const signalGroup = (child, signal) => {
  if (!child.pid || exited(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

export const stopChild = async (child, grace = 5000) => {
  if (!child.pid || exited(child)) return;
  const ended = once(child, "exit");
  signalGroup(child, "SIGTERM");
  let timer;
  await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, grace); })]);
  clearTimeout(timer);
  if (exited(child)) return;
  signalGroup(child, "SIGKILL");
  await ended;
};

const launched = new WeakSet();

const launcher = (held) => (command, args, options = {}) => {
  const stdio = typeof options.stdio === "string" ? Array(3).fill(options.stdio) : [...(options.stdio || ["ignore", "ignore", "ignore"])];
  const child = spawn(command, args, {
    ...options,
    detached: true,
    env: { ...(options.env || process.env), ...held.env },
    stdio: [...stdio.slice(0, 3), ...held.stdio],
  });
  launched.add(child);
  return child;
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

const choosePorts = async (host, wanted, passHeld, probe = false) => {
  if (passHeld) return reserveTcpPorts(host, wanted);
  const picks = await freeTcpPorts(host, probe ? wanted : wanted.filter((port) => !port));
  const ports = probe ? picks : wanted.map((port) => port || picks.shift());
  await releaseTcpPorts(host, ports);
  return ports;
};

export const startChildOnPorts = async ({ host, requested, preferred, spawnChild, output, isReady = () => true, passHeld = false, attempts = 5, timeout = 30000 }) => {
  const automatic = requested.every((port) => !port);
  for (let attempt = 1; ; attempt += 1) {
    const ports = automatic && preferred && attempt === 1
      ? await choosePorts(host, preferred, passHeld, true).catch((error) => {
        if (error.code !== "EADDRINUSE") throw error;
        return choosePorts(host, requested, passHeld);
      })
      : await choosePorts(host, requested, passHeld);
    let child;
    let spawnError;
    try {
      const held = passHeld ? passHeldTcpPorts(host, ports) : { stdio: [], env: {} };
      child = spawnChild(ports, { spawn: launcher(held) });
      if (!launched.has(child)) throw new Error("spawnChild must start its child with launch.spawn.");
      child.once("error", (error) => { spawnError = error; });
      if (passHeld) await releaseTcpPorts(host, ports);
      await waitUntilReady({ child, host, ports, isReady, output, timeout, failure: () => spawnError || (!child.pid && new Error("Child did not start.")) });
      return { ports, child };
    } catch (error) {
      if (passHeld) await releaseTcpPorts(host, ports);
      if (child && launched.has(child)) await stopChild(child);
      if (!automatic || attempt === attempts || !addressInUse(output())) throw error;
    }
  }
};
