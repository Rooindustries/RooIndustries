import fs from "node:fs";
import net from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

const namespaceOf = (pid, kind) => {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/${kind}`);
  } catch {
    return null;
  }
};

const live = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] !== "Z";
  } catch {
    return false;
  }
};

const handles = new WeakMap();
const procOf = (child) => `self/fd/${handles.get(child)}`;
const unreaped = (child) => handles.has(child) && fs.existsSync(`/proc/${procOf(child)}/stat`);
const running = (child) => handles.has(child) && live(procOf(child));

const track = (child) => {
  const fd = fs.openSync(`/proc/${child.pid}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  handles.set(child, fd);
  child.once("exit", () => {
    handles.delete(child);
    fs.closeSync(fd);
  });
};

const childNamespace = (child) => {
  const namespace = unreaped(child) ? namespaceOf(procOf(child), "pid_for_children") : null;
  return namespace === namespaceOf("self", "pid") ? null : namespace;
};

const namespaceMembers = (namespace) => namespace
  ? fs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry) && namespaceOf(entry, "pid") === namespace && live(entry))
  : [];

const pinNamespace = (child) => {
  if (!childNamespace(child)) return null;
  try {
    const fd = fs.openSync(`/proc/${procOf(child)}/ns/pid_for_children`, "r");
    return { fd, namespace: fs.readlinkSync(`/proc/self/fd/${fd}`) };
  } catch {
    return null;
  }
};

export const ownsPorts = (child, host, ports) => {
  const open = new Set();
  for (const member of namespaceMembers(childNamespace(child))) {
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
  if (exited(child)) return;
  if (!handles.has(child)) {
    child.kill(signal);
    return;
  }
  if (!unreaped(child)) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

const stops = new WeakMap();

export const stopChild = (child, grace = 5000) => {
  if (!child.pid) return Promise.resolve();
  if (!stops.has(child)) {
    stops.set(child, (async () => {
      const pinned = pinNamespace(child);
      try {
        if (!exited(child)) {
          const ended = new Promise((resolve) => child.once("exit", resolve));
          signalGroup(child, "SIGTERM");
          let timer;
          await Promise.race([ended, new Promise((resolve) => { timer = setTimeout(resolve, grace); })]);
          clearTimeout(timer);
          if (!exited(child)) {
            signalGroup(child, "SIGKILL");
            await ended;
          }
        }
        while (pinned && namespaceMembers(pinned.namespace).length) await pause(50);
      } finally {
        if (pinned) fs.closeSync(pinned.fd);
      }
    })());
  }
  return stops.get(child);
};

const launched = new WeakSet();
const closes = new WeakMap();
const captures = new WeakMap();
const containment = ["--pdeathsig", "KILL", "--", "unshare", "--user", "--map-current-user", "--pid", "--fork", "--kill-child", "--mount-proc", "--"];
const init = ["/bin/sh", "-c", "exec 9<&0; printf x >&3 && read -r go <&3 || exit 125; exec 3<&-; \"$@\" <&9 9<&- & wait $!", "sh"];
let contained = false;

const requireContainment = () => {
  if (contained) return;
  const probe = spawnSync("setpriv", [...containment, "true"], { encoding: "utf8" });
  if (probe.status !== 0) {
    const reason = (probe.error?.message || probe.stderr || `exit ${probe.status}`).trim();
    throw new Error(`Fixture children run in their own PID namespace, and this machine refused to create one: ${reason}. Allow unprivileged user namespaces for unshare (on Ubuntu 24.04, the AppArmor profile in .github/actions/setup/action.yml).`);
  }
  contained = true;
};

const logFiles = (stdio) => [...new Set(stdio.slice(1, 3).filter(Number.isInteger).flatMap((fd) => {
  try {
    return [fs.readlinkSync(`/proc/self/fd/${fd}`)];
  } catch {
    return [];
  }
}))].flatMap((file) => {
  try {
    return [{ file, offset: fs.statSync(file).size }];
  } catch {
    return [];
  }
});

const captureOutput = (child, stdio, logs) => {
  const chunks = [];
  for (const [stream, entry] of [[child.stdout, stdio[1]], [child.stderr, stdio[2]]]) if (entry === "pipe" && stream) stream.on("data", (chunk) => chunks.push(String(chunk)));
  return () => chunks.join("") + logs.map(({ file, offset }) => {
    try {
      return fs.readFileSync(file).subarray(offset).toString();
    } catch {
      return "";
    }
  }).join("");
};

const launcher = (held) => (command, args, options = {}) => {
  requireContainment();
  const stdio = typeof options.stdio === "string" ? Array(3).fill(options.stdio) : [...(options.stdio || ["ignore", "ignore", "ignore"])];
  const logs = logFiles(stdio);
  const child = spawn("setpriv", [...containment, ...init, command, ...args], {
    ...options,
    detached: true,
    env: { ...(options.env || process.env), ...held.env },
    stdio: [...stdio.slice(0, 3), "pipe", ...held.stdio],
  });
  if (child.pid) track(child);
  const lifeline = child.stdio[3];
  lifeline?.on("error", () => {});
  lifeline?.once("data", () => {
    if (running(child)) lifeline.end("\n", () => lifeline.destroy());
    else lifeline.destroy();
  });
  launched.add(child);
  captures.set(child, captureOutput(child, stdio, logs));
  closes.set(child, new Promise((resolve) => child.once("close", resolve)));
  return child;
};

const waitUntilReady = async ({ child, host, ports, isReady, output, timeout, failure }) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (failure()) throw failure();
    if (exited(child)) throw new Error(`Child exited before it was ready (exit ${child.exitCode ?? child.signalCode}):\n${output()}`);
    if (ownsPorts(child, host, ports) && await isReady(ports) && !exited(child) && ownsPorts(child, host, ports)) return;
    await pause(100);
  }
  throw new Error(`Child was not ready within ${timeout} ms:\n${output()}`);
};

const within = async (promise, timeout, message, output) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${message}\n${output()}`)), timeout); })]);
  } finally {
    clearTimeout(timer);
  }
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
      if (passHeld) {
        await within(held.handOver(child), timeout, `Child did not take its held ports within ${timeout} ms:`, output);
      }
      await waitUntilReady({ child, host, ports, isReady, output, timeout, failure: () => spawnError || (!child.pid && new Error("Child did not start.")) });
      return { ports, child };
    } catch (error) {
      if (passHeld) await releaseTcpPorts(host, ports);
      if (child && launched.has(child)) {
        await stopChild(child);
        await Promise.race([closes.get(child), pause(1000)]);
      }
      if (!automatic || attempt === attempts || !addressInUse(captures.get(child)?.() ?? "")) throw error;
    }
  }
};
