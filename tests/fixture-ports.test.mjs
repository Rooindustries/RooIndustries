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

const run = (args, env, { detached = false, command = process.execPath } = {}) => {
  let output = "";
  const child = spawn(command, args, { detached, stdio: ["ignore", "pipe", "pipe"], env: { ...cleanEnv(), ROO_TEST_HOST: host, ...env } });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  return { child, output: () => output };
};

const startTooling = async (dist, port, env = {}) => {
  const server = run(["scripts/test-tooling-sweep-server.mjs"], {
    BASE_URL: `http://${host}:${port}`, PW_PORT: String(port), NEXT_DIST_DIR: dist,
    ROO_ADMIN_FIXTURE: "0", TOOLING_DEV_SERVER: "0", TOOLING_API_ROUTES: "0", ...env,
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

const reportFile = port => path.resolve(`.next-fixture-ports/${host}_${port}.json`);
const reportedContentPort = port => JSON.parse(fs.readFileSync(reportFile(port), "utf8")).ports.TOOLING_CONTENT_PORT;
const playwright = (args, env) => run(["-a", ...args], env, { command: "xvfb-run" });

test("a reused build rebuilds for a new content port when its old one is taken", { timeout: 900000 }, async () => {
  const dist = `.next-e2e-reuse-${process.pid}`;
  const port = await freeTcpPort(host);
  let holder;
  try {
    const first = await startTooling(dist, port);
    const builtPort = reportedContentPort(port);
    await stopChild(first.child);
    holder = net.createServer().listen(builtPort, host);
    await once(holder, "listening");
    const second = await startTooling(dist, port);
    try {
      const contentPort = reportedContentPort(port);
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

test("an external server's ports reach the specs when its build directory is not named", { timeout: 900000 }, async () => {
  const dist = `.next-e2e-server-${process.pid}`;
  const port = await freeTcpPort(host);
  try {
    const server = await startTooling(dist, port, { TOOLING_API_ROUTES: "1", NODE_OPTIONS: "--import=./tests/fixtures/creator-portal-loader.mjs" });
    try {
      const suite = playwright(["npm", "run", "test:creator:portal", "--", "--grep", "creator session follows login and logout", "--output", `test-results/fixture-ports-${process.pid}`], {
        BASE_URL: `http://${host}:${port}`, PW_PORT: String(port),
      });
      const [code] = await once(suite.child, "exit");
      assert.equal(code, 0, suite.output());
      assert.match(suite.output(), /1 passed/);
    } finally {
      await stopChild(server.child);
    }
    assert.equal(fs.existsSync(reportFile(port)), false);
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(`test-results/fixture-ports-${process.pid}`, { recursive: true, force: true });
  }
});

test("a run against a server without a live port report stops before any spec", { timeout: 120000 }, async () => {
  const port = await freeTcpPort(host);
  const origin = `http://${host}:${port}`;
  const ended = run(["-e", ""], {});
  await once(ended.child, "exit");
  fs.mkdirSync(path.dirname(reportFile(port)), { recursive: true });
  try {
    for (const report of [null, { baseURL: origin, pid: ended.child.pid, ports: { TOOLING_CONTENT_PORT: port } }]) {
      if (report) fs.writeFileSync(reportFile(port), JSON.stringify(report));
      const suite = run(["node_modules/@playwright/test/cli.js", "test", "tests/creator-portal.spec.js", "--project=chromium", "--output", `test-results/fixture-ports-${process.pid}`], {
        BASE_URL: origin, PW_PORT: String(port),
      });
      const [code] = await once(suite.child, "exit");
      assert.notEqual(code, 0);
      assert.match(suite.output(), new RegExp(`No running fixture server reported its ports for ${origin.replaceAll(".", "\\.")}`));
    }
  } finally {
    fs.rmSync(reportFile(port), { force: true });
    fs.rmSync(`test-results/fixture-ports-${process.pid}`, { recursive: true, force: true });
  }
});
