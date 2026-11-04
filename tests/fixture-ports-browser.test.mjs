import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort } from "../scripts/lib/free-tcp-port.mjs";
import { stopChild } from "../scripts/lib/start-on-port.mjs";
import fixturePorts from "./fixtures/fixture-ports.cjs";
import { host, playwright, reportFile, startTooling } from "./fixtures/fixture-ports-harness.mjs";

test("an external server's ports reach the specs when its build directory is not named", { timeout: 900000 }, async () => {
  const dist = `.next-e2e-server-${process.pid}`;
  const port = await freeTcpPort(host);
  const origin = `http://${host}:${port}`;
  try {
    const server = await startTooling(dist, port, { TOOLING_API_ROUTES: "1", NODE_OPTIONS: "--import=./tests/fixtures/creator-portal-loader.mjs" });
    try {
      const suite = playwright(["npm", "run", "test:creator:portal", "--", "--grep", "creator session follows login and logout", "--output", `test-results/fixture-ports-${process.pid}`], {
        BASE_URL: origin, PW_PORT: String(port),
      });
      const [code] = await once(suite.child, "exit");
      assert.equal(code, 0, suite.output());
      assert.match(suite.output(), /1 passed/);
    } finally {
      await stopChild(server.child);
    }
    await assert.rejects(fixturePorts.loadFixturePorts(origin), /No running fixture server reported its ports/);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(reportFile(port), { force: true });
    fs.rmSync(`test-results/fixture-ports-${process.pid}`, { recursive: true, force: true });
  }
});
