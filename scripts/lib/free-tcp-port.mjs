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

export const fixturePorts = (host, first, count) =>
  reserveTcpPorts(host, Array.from({ length: count }, (_, index) => (first ? Number(first) + index : 0)));

export const passHeldTcpPorts = (host, ports, firstFd = 3) => {
  const fds = ports.map((port) => {
    const server = held.get(heldKey(host, port));
    assert.ok(server, `Port ${port} is not reserved`);
    return server._handle.fd;
  });
  return {
    stdio: fds,
    env: { [holderEnv]: JSON.stringify(Object.fromEntries(ports.map((port, index) => [firstFd + index, port]))) },
  };
};

export const adoptHeldTcpPorts = async () => {
  const passed = JSON.parse(process.env[holderEnv] || "{}");
  delete process.env[holderEnv];
  for (const [fd, port] of Object.entries(passed)) {
    const server = holder();
    server.listen({ fd: Number(fd) });
    await once(server, "listening");
    server.unref();
    assert.equal(server.address().port, port, "Passed fixture port does not match its socket");
    held.set(heldKey(server.address().address, port), server);
  }
};
