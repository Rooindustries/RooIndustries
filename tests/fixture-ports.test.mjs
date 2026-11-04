import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort } from "../scripts/lib/free-tcp-port.mjs";
import { stopChild } from "../scripts/lib/start-on-port.mjs";

const host = "127.0.0.1";
const inherited = /SENTRY_DSN$|^BASE_URL$|^NEXT_DIST_DIR$|^PW_PORT$|^PW_SERVER_ID$|^TOOLING_|^BOOKING_ROUTE_PORT$|^NODE_OPTIONS$|^NODE_TEST_CONTEXT$/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited.test(name)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const run = (args, env, { detached = false } = {}) => {
  let output = "";
  const child = spawn(process.execPath, args, { detached, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanEnv(), ROO_TEST_HOST: host, ...env } });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  return { child, output: () => output };
};

const startTooling = async (dist, port) => {
  const server = run(["scripts/test-tooling-sweep-server.mjs"], {
    BASE_URL: `http://${host}:${port}`, PW_PORT: String(port), NEXT_DIST_DIR: dist,
    ROO_ADMIN_FIXTURE: "0", TOOLING_DEV_SERVER: "0", TOOLING_API_ROUTES: "0",
  }, { detached: true });
  const deadline = Date.now() + 420000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`The tooling server exited:\n${server.output()}`);
    if (await fetch(`http://${host}:${port}/`).then(response => response.ok, () => false)) return server;
    await pause(1000);
  }
  await stopChild(server.child);
  throw new Error(`The tooling server never answered:\n${server.output()}`);
};

const reportedContentPort = dist => JSON.parse(fs.readFileSync(`${path.resolve(dist)}-ports.json`, "utf8")).ports.TOOLING_CONTENT_PORT;

test("a reused build rebuilds for a new content port when its old one is taken", { timeout: 900000 }, async () => {
  const dist = `.next-e2e-reuse-${process.pid}`;
  const port = await freeTcpPort(host);
  let holder;
  try {
    const first = await startTooling(dist, port);
    const builtPort = reportedContentPort(dist);
    await stopChild(first.child);
    holder = net.createServer().listen(builtPort, host);
    await once(holder, "listening");
    const second = await startTooling(dist, port);
    try {
      const contentPort = reportedContentPort(dist);
      assert.notEqual(contentPort, builtPort);
      assert.match(second.output(), /content port is taken; rebuilding/);
      const manifest = JSON.parse(fs.readFileSync(path.join(dist, "tooling-build.json"), "utf8"));
      assert.equal(manifest.contentURL, `http://${host}:${contentPort}`);
      assert.match(await (await fetch(`http://${host}:${port}/`)).text(), /Fixture Hero Heading One/);
    } finally {
      await stopChild(second.child);
    }
  } finally {
    if (holder?.listening) await new Promise(resolve => holder.close(resolve));
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test("booking holds claims its route port before it starts the content fixture", { timeout: 120000 }, async () => {
  const holder = net.createServer().listen(0, host);
  await once(holder, "listening");
  const port = holder.address().port;
  try {
    const suite = run(["--test", "--test-reporter=tap", "tests/booking-holds.test.mjs"], { BOOKING_ROUTE_PORT: String(port) });
    const [code] = await once(suite.child, "exit");
    assert.notEqual(code, 0);
    assert.match(suite.output(), new RegExp(`address already in use ${host}:${port}`));
    assert.match(suite.output(), /^# tests 1$/m, suite.output());
  } finally {
    await new Promise(resolve => holder.close(resolve));
  }
});
