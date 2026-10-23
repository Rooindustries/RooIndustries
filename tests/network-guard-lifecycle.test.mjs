import assert from "node:assert/strict";
import fs from "node:fs";
import http, { request as namedRequest } from "node:http";
import https from "node:https";
import { after, test } from "node:test";
import { getGlobalDispatcher, request as undiciRequest } from "undici";
import { installNetworkGuard } from "../scripts/lib/test-target-safety.mjs";

const evidence = [];
after(() => {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/network-guard-lifecycle.json", JSON.stringify({ node: process.version, evidence }, null, 2));
});

for (const order of [[0, 1], [1, 0], [1, 0, 2], [0, 2, 1]]) {
  test(`network guards restore in order ${order.join(", ")}`, async () => {
    const originals = [http.request, http.get, https.request, https.get, globalThis.fetch, getGlobalDispatcher()];
    let hits = 0;
    const server = http.createServer((_request, response) => { hits++; response.end("fixture"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = url => new Promise((resolve, reject) => {
      http.get(url, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
    });
    const restores = order.map(() => installNetworkGuard([origin]));
    try {
      assert.equal(await request(origin), 200);
      for (const index of order.slice(0, -1)) {
        restores[index]();
        restores[index]();
        const before = hits;
        await assert.rejects(request("http://127.0.0.1:9/"), /outside the local fixture/);
        await assert.rejects(fetch("http://127.0.0.1:9/"), /outside the local fixture/);
        await assert.rejects(undiciRequest("http://127.0.0.1:9/"), /outside the local fixture/);
        assert.equal(hits, before);
        assert.equal(namedRequest, http.request);
        assert.equal(await request(origin), 200);
      }
      restores[order.at(-1)]();
      assert.deepEqual([http.request, http.get, https.request, https.get, globalThis.fetch, getGlobalDispatcher()], originals);
      assert.equal(namedRequest, http.request);
      assert.equal(await request(origin), 200);
      evidence.push({ order, restored: true, hits });
    } finally {
      for (const restore of restores.toReversed()) restore();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test("removing a restrictive inner guard leaves only the outer policy", async () => {
  const server = http.createServer((_request, response) => response.end("outer fixture"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const inner = installNetworkGuard(["http://127.0.0.1:9"]);
  const outer = installNetworkGuard(["http://127.0.0.1:9", origin]);
  try {
    await assert.rejects(fetch(origin), /outside the local fixture/);
    inner();
    assert.equal(await (await fetch(origin)).text(), "outer fixture");
    assert.ok(JSON.parse(process.env.ROO_TEST_NETWORK_ORIGINS).includes(origin));
    evidence.push({ remainingPolicy: "outer", allowed: true });
  } finally {
    outer();
    inner();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
