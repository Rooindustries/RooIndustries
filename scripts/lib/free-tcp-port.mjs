import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { endOwnChannel } from "./own-channel.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";

const { flock, inUse } = createRequire(import.meta.url)("./build-lock-gate.cjs");
const registry = "/tmp/roo-fixture-ports";
const reservations = new Map();
const reservationEnv = "ROO_TCP_PORT_RESERVATIONS";

for (const { host, port, fd } of JSON.parse(process.env[reservationEnv] || "[]")) {
  reservations.set(`${host}|${port}`, fd);
}
delete process.env[reservationEnv];

const validPort = (requested) =>
  Number.isInteger(requested) && (requested === 0 || (requested >= 1024 && requested <= 65535));

const held = new Map();
const heldKey = (host, port) => `${host}|${port}`;
const holderEnv = "ROO_HELD_TCP_PORTS";
const holder = () => net.createServer((socket) => socket.destroy());

const bindReserved = async (host, requested, server) => {
  const mask = process.umask(0);
  try {
    try {
      fs.mkdirSync(registry, { mode: 0o1777 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const directory = fs.lstatSync(registry);
    if (!directory.isDirectory()) throw new Error(`Fixture port registry is not a directory: ${registry}`);
    if ((directory.mode & 0o7777) !== 0o1777) fs.chmodSync(registry, 0o1777);
  } finally {
    process.umask(mask);
  }
  for (;;) {
    server.listen(requested, host);
    await once(server, "listening");
    const port = server.address().port;
    const existing = reservations.get(heldKey(host, port));
    if (existing !== undefined) {
      if (requested) return { server, port, fd: existing, existing: true };
      await new Promise((resolve) => server.close(resolve));
      continue;
    }
    let fd;
    try {
      const mask = process.umask(0);
      try {
        try {
          fd = fs.openSync(`${registry}/${port}`, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDONLY, 0o666);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          fd = fs.openSync(`${registry}/${port}`, fs.constants.O_RDONLY);
        }
      } finally {
        process.umask(mask);
      }
      const result = flock(fd, { nonblock: true, conflictExitCode: inUse });
      if (result.status === 0) return { server, port, fd };
      if (result.status !== inUse) throw new Error(`Cannot reserve fixture port ${port}: ${result.stderr}`);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      await new Promise((resolve) => server.close(resolve));
      throw error;
    }
    fs.closeSync(fd);
    await new Promise((resolve) => server.close(resolve));
    if (requested) throw Object.assign(new Error(`Fixture port ${port} belongs to another run.`), { code: "EADDRINUSE" });
  }
};

export const takeTcpPortReservations = (host, ports) => ports.map((port) => {
  const key = heldKey(host, port);
  const fd = reservations.get(key);
  assert.ok(fd !== undefined, `Port ${port} has no reservation`);
  reservations.delete(key);
  return fd;
});

export const passTcpPortReservations = (host, ports, options = {}) => {
  const selected = ports.flatMap((port) => {
    const fd = reservations.get(heldKey(host, port));
    return fd === undefined ? [] : [{ host, port, fd }];
  });
  if (!selected.length) return options;
  const stdio = typeof options.stdio === "string"
    ? Array(3).fill(options.stdio)
    : [...(options.stdio || ["pipe", "pipe", "pipe"])];
  const entries = selected.map(({ host: address, port }, index) => ({
    host: address, port, fd: stdio.length + index,
  }));
  return {
    ...options,
    stdio: [...stdio, ...selected.map(({ fd }) => fd)],
    env: { ...(options.env || process.env), [reservationEnv]: JSON.stringify(entries) },
  };
};

export const shiftTcpPortReservations = (env, offset) => {
  if (!env[reservationEnv]) return env;
  const entries = JSON.parse(env[reservationEnv]).map((entry) => ({ ...entry, fd: entry.fd + offset }));
  return { ...env, [reservationEnv]: JSON.stringify(entries) };
};

export const freeTcpPorts = async (host, requested) => {
  assert.ok(requested.every(validPort), "Invalid fixture port");
  const servers = requested.map(() => net.createServer());
  const explicitFirst = (a, b) => Number(requested[a] === 0) - Number(requested[b] === 0);
  const bindOrder = requested.map((port, index) => index).sort(explicitFirst);
  const locks = [];
  let complete = false;
  try {
    for (const index of bindOrder) {
      locks.push(await bindReserved(host, requested[index], servers[index]));
    }
    for (const { port, fd } of locks) reservations.set(heldKey(host, port), fd);
    complete = true;
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
    if (!complete) for (const { fd, existing } of locks) if (!existing) fs.closeSync(fd);
  }
};

export const freeTcpPort = async (host, requested = 0) => (await freeTcpPorts(host, [requested]))[0];

export const releaseTcpSockets = async (host, ports) => {
  await Promise.all(ports.map(async (port) => {
    const server = held.get(heldKey(host, port));
    held.delete(heldKey(host, port));
    if (server) await new Promise((resolve) => server.close(resolve));
  }));
};

export const releaseTcpPorts = async (host, ports) => {
  await releaseTcpSockets(host, ports);
  for (const port of ports) {
    const fd = reservations.get(heldKey(host, port));
    if (fd !== undefined) fs.closeSync(fd);
    reservations.delete(heldKey(host, port));
  }
};

export const reserveTcpPorts = async (host, requested) => {
  assert.ok(requested.every(validPort), "Invalid fixture port");
  const ports = [...requested];
  const bound = [];
  const explicitFirst = (a, b) => Number(requested[a] === 0) - Number(requested[b] === 0);
  try {
    for (const index of requested.map((port, index) => index).sort(explicitFirst)) {
      if (requested[index] !== 0 && held.has(heldKey(host, requested[index]))) continue;
      const entry = await bindReserved(host, requested[index], holder());
      const { server, port } = entry;
      bound.push(entry);
      server.unref();
      ports[index] = port;
    }
    assert.equal(new Set(ports).size, ports.length, "Fixture ports must differ");
    for (const { port, server, fd } of bound) {
      held.set(heldKey(host, port), server);
      reservations.set(heldKey(host, port), fd);
    }
    return ports;
  } catch (error) {
    await Promise.all(bound.filter(({ server }) => server.listening).map(({ server }) => new Promise((resolve) => server.close(resolve))));
    for (const { fd, existing } of bound) if (!existing) fs.closeSync(fd);
    throw error;
  }
};

export const portFromEnv = (name, env = process.env) => {
  const value = env[name];
  if (value === undefined || value === "") return 0;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1024 || port > 65535) throw new Error(`${name} must be a TCP port from 1024 to 65535, got "${value}".`);
  return port;
};

export const listenOnPort = async (server, host, port) => {
  const holder = held.get(heldKey(host, port));
  held.delete(heldKey(host, port));
  const fd = reservations.get(heldKey(host, port));
  reservations.delete(heldKey(host, port));
  if (fd !== undefined) server.once("close", () => fs.closeSync(fd));
  server.listen(...(holder ? [holder] : [port, host]));
  await once(server, "listening");
  server.ref();
};

export const passHeldTcpPorts = (host, ports) => {
  const servers = ports.map((port) => {
    const server = held.get(heldKey(host, port));
    assert.ok(server, `Port ${port} is not reserved`);
    return server;
  });
  const handOver = (child) => new Promise((resolve, reject) => {
    const finish = (error) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", finish);
      child.channel?.unref();
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish(new Error("Child exited before it took its held ports."));
    const onMessage = (message) => {
      if (message?.[holderEnv] === "wanted") servers.forEach((server, index) => child.send({ [holderEnv]: ports[index] }, server, { keepOpen: true }));
      if (message?.[holderEnv] === "adopted") releaseTcpPorts(host, ports).then(() => child.send({ [holderEnv]: "released" }, finish), finish);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", finish);
  });
  const transfer = passTcpPortReservations(host, ports, {
    stdio: ["ignore", "ignore", "ignore", "ipc"], env: { [holderEnv]: JSON.stringify(ports) },
  });
  return { stdio: transfer.stdio.slice(3), env: transfer.env, handOver };
};

export const adoptHeldTcpPorts = async () => {
  const ports = JSON.parse(process.env[holderEnv] || "[]");
  delete process.env[holderEnv];
  if (!ports.length) return;
  assert.ok(process.send, "Held ports need an IPC channel to arrive on");
  const pending = new Set(ports);
  await new Promise((resolve) => {
    const onMessage = (message, server) => {
      const port = message?.[holderEnv];
      if (!pending.has(port)) return;
      assert.equal(server.address().port, port, "Passed fixture port does not match its socket");
      server.on("connection", (socket) => socket.destroy());
      server.unref();
      held.set(heldKey(server.address().address, port), server);
      pending.delete(port);
      if (pending.size) return;
      process.off("message", onMessage);
      resolve();
    };
    process.on("message", onMessage);
    process.send({ [holderEnv]: "wanted" });
  });
  await new Promise((resolve) => {
    const onReleased = (message) => {
      if (message?.[holderEnv] !== "released") return;
      process.off("message", onReleased);
      resolve();
    };
    process.on("message", onReleased);
    process.send({ [holderEnv]: "adopted" });
  });
  endOwnChannel();
};
