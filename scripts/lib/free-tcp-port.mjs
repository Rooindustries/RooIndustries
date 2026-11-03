import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

const validPort = (requested) =>
  Number.isInteger(requested) && (requested === 0 || (requested >= 1024 && requested <= 65535));

export const freeTcpPorts = async (host, requested) => {
  assert.ok(requested.every(validPort), "Invalid fixture port");
  const servers = requested.map(() => net.createServer());
  try {
    for (const [index, server] of servers.entries()) {
      server.listen(requested[index], host);
      await once(server, "listening");
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
};

export const freeTcpPort = async (host, requested = 0) => (await freeTcpPorts(host, [requested]))[0];
