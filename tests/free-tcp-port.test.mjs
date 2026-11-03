import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort, freeTcpPorts } from "../scripts/lib/free-tcp-port.mjs";

const host = "127.0.0.1";

test("each port stays held until the whole set is reserved", async () => {
  const [port] = await freeTcpPorts(host, [0]);
  await assert.rejects(freeTcpPorts(host, [port, port]), { code: "EADDRINUSE" });
});

test("a requested port is bound before any free pick can take it", async () => {
  const [wanted] = await freeTcpPorts(host, [0]);
  const ports = await freeTcpPorts(host, [0, 0, 0, wanted]);
  assert.equal(ports[3], wanted);
  assert.equal(new Set(ports).size, ports.length, ports.join(", "));
});

test("ports reserved together are distinct", async () => {
  const ports = await freeTcpPorts(host, [0, 0, 0, 0]);
  assert.equal(new Set(ports).size, ports.length, ports.join(", "));
});

test("reserved ports are released for the fixture to bind", async () => {
  const [port] = await freeTcpPorts(host, [0]);
  const server = net.createServer().listen(port, host);
  await once(server, "listening");
  await new Promise((resolve) => server.close(resolve));
});

test("a requested port that is taken fails and releases the others", async () => {
  const holder = net.createServer().listen(0, host);
  await once(holder, "listening");
  try {
    const taken = holder.address().port;
    const [free] = await freeTcpPorts(host, [0]);
    await assert.rejects(freeTcpPorts(host, [free, taken]), { code: "EADDRINUSE" });
    assert.equal(await freeTcpPort(host, free), free);
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("an invalid port is refused", async () => {
  await assert.rejects(freeTcpPorts(host, [80]), /Invalid fixture port/);
});
