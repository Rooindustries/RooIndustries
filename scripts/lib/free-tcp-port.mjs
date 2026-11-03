import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

const validPort = (requested) =>
  Number.isInteger(requested) && (requested === 0 || (requested >= 1024 && requested <= 65535));

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

export const fixturePorts = (host, first, count) =>
  freeTcpPorts(host, Array.from({ length: count }, (_, index) => (first ? Number(first) + index : 0)));
