import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

export async function postgresFixturePort(host) {
  assert.equal(host, "127.0.0.1");
  const listener = net.createServer();
  listener.listen(0, host);
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}
