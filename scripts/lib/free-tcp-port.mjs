import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

export const freeTcpPort = async (host, requested = 0) => {
  assert.ok(
    Number.isInteger(requested) && (requested === 0 || (requested >= 1024 && requested <= 65535)),
    "Invalid fixture port"
  );
  const server = net.createServer();
  server.listen(requested, host);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};
