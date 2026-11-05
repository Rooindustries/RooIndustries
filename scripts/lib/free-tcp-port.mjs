import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

const validPort = (requested) =>
  Number.isInteger(requested) && (requested === 0 || (requested >= 1024 && requested <= 65535));

const held = new Map();
const heldKey = (host, port) => `${host}|${port}`;
const holderEnv = "ROO_HELD_TCP_PORTS";
const holder = () => net.createServer((socket) => socket.destroy());

export const freeTcpPorts = async (host, requested) => {
  assert.ok(requested.every(validPort), "Invalid fixture port");
  const servers = requested.map(() => net.createServer());
  const explicitFirst = (a, b) => Number(requested[a] === 0) - Number(requested[b] === 0);
  const bindOrder = requested.map((port, index) => index).sort(explicitFirst);
  try {
    for (const index of bindOrder) {
      servers[index].listen(requested[index], host);
      await once(servers[index], "listening");
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers
        .filter((server) => server.listening)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
};

export const freeTcpPort = async (host, requested = 0) => (await freeTcpPorts(host, [requested]))[0];

export const releaseTcpPorts = async (host, ports) => {
  await Promise.all(ports.map(async (port) => {
    const server = held.get(heldKey(host, port));
    if (!server) return;
    held.delete(heldKey(host, port));
    await new Promise((resolve) => server.close(resolve));
  }));
};

export const reserveTcpPorts = async (host, requested) => {
  assert.ok(requested.every(validPort), "Invalid fixture port");
  const ports = [...requested];
  const bound = [];
  const explicitFirst = (a, b) => Number(requested[a] === 0) - Number(requested[b] === 0);
  try {
    for (const index of requested.map((port, index) => index).sort(explicitFirst)) {
      if (requested[index] !== 0 && held.has(heldKey(host, requested[index]))) continue;
      const server = holder();
      server.listen(requested[index], host);
      bound.push({ server });
      await once(server, "listening");
      server.unref();
      ports[index] = server.address().port;
      bound.at(-1).port = ports[index];
    }
    assert.equal(new Set(ports).size, ports.length, "Fixture ports must differ");
    for (const { port, server } of bound) held.set(heldKey(host, port), server);
    return ports;
  } catch (error) {
    await Promise.all(bound.filter(({ server }) => server.listening).map(({ server }) => new Promise((resolve) => server.close(resolve))));
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
  return { stdio: ["ipc"], env: { [holderEnv]: JSON.stringify(ports) }, handOver };
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
  if (process.connected) process.disconnect();
};
