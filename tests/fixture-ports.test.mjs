import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { freeTcpPort } from "../scripts/lib/free-tcp-port.mjs";
import { stopChild } from "../scripts/lib/start-on-port.mjs";
import fixturePorts from "./fixtures/fixture-ports.cjs";
import { host, readReport, reportDir, reportFile, run, startTooling, waitFor, writeReport } from "./fixtures/fixture-ports-harness.mjs";

const listen = async server => {
  server.listen(0, host);
  await once(server, "listening");
  return server.address().port;
};
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const missingReport = origin => new RegExp(`No running fixture server reported its ports for ${origin.replaceAll(".", "\\.")}`);
const stopRun = async (suite, timeout = 60000) => {
  if (suite.child.exitCode === null && suite.child.signalCode === null) suite.child.kill("SIGTERM");
  const timer = setTimeout(() => suite.child.kill("SIGKILL"), timeout);
  try { if (suite.child.exitCode === null && suite.child.signalCode === null) await once(suite.child, "exit"); } finally { clearTimeout(timer); }
};

test("a reused build rebuilds for a new content port when its old one is taken", { timeout: 900000 }, async () => {
  const dist = `.next-e2e-reuse-${process.pid}`;
  const port = await freeTcpPort(host);
  let holder;
  try {
    const first = await startTooling(dist, port);
    const builtPort = readReport(port).ports.TOOLING_CONTENT_PORT;
    await stopChild(first.child);
    holder = net.createServer().listen(builtPort, host);
    await once(holder, "listening");
    const second = await startTooling(dist, port);
    try {
      const contentPort = readReport(port).ports.TOOLING_CONTENT_PORT;
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
    fs.rmSync(reportFile(port), { force: true });
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

test("a port report counts only while its helper answers with the report's instance", { timeout: 60000 }, async () => {
  const port = await freeTcpPort(host);
  const origin = `http://${host}:${port}`;
  const successor = http.createServer((request, response) => response.end(request.url === fixturePorts.INSTANCE_PATH ? "successor" : ""));
  const helperPort = await listen(successor);
  const deadPort = await freeTcpPort(host);
  const saved = process.env.TOOLING_CONTENT_PORT;
  try {
    for (const report of [
      { baseURL: origin, pid: process.pid, instance: "stale", ports: { TOOLING_CONTENT_PORT: helperPort } },
      { baseURL: origin, pid: process.pid, instance: "successor", ports: { TOOLING_CONTENT_PORT: deadPort } },
      { baseURL: origin, pid: process.pid, instance: "successor", ports: {} },
    ]) {
      writeReport(port, report);
      await assert.rejects(async () => fixturePorts.loadFixturePorts(origin), missingReport(origin), JSON.stringify(report));
    }
    writeReport(port, { baseURL: origin, instance: "successor", ports: { TOOLING_CONTENT_PORT: helperPort } });
    assert.deepEqual(await fixturePorts.loadFixturePorts(origin), { TOOLING_CONTENT_PORT: helperPort });
    assert.equal(process.env.TOOLING_CONTENT_PORT, String(helperPort));
  } finally {
    if (saved === undefined) delete process.env.TOOLING_CONTENT_PORT;
    else process.env.TOOLING_CONTENT_PORT = saved;
    fs.rmSync(reportFile(port), { force: true });
    await close(successor);
  }
});

test("a stopped server leaves its report for the next server on the same origin to replace", { timeout: 300000 }, async () => {
  const port = await freeTcpPort(host);
  const origin = `http://${host}:${port}`;
  const dists = [`.next-e2e-report-a-${process.pid}`, `.next-e2e-report-b-${process.pid}`];
  fs.rmSync(reportFile(port), { force: true });
  try {
    const first = await startTooling(dists[0], port, {}, { ready: "report" });
    const firstReport = readReport(port);
    await stopChild(first.child);
    assert.deepEqual(readReport(port), firstReport);
    await assert.rejects(async () => fixturePorts.loadFixturePorts(origin), missingReport(origin));
    const second = await startTooling(dists[1], port, {}, { ready: "report" });
    try {
      await waitFor(second, () => readReport(port)?.instance !== firstReport.instance, 60000, "replaced the report");
      const ports = await fixturePorts.loadFixturePorts(origin);
      assert.deepEqual(ports, readReport(port).ports);
    } finally {
      await stopChild(second.child);
    }
    assert.notEqual(readReport(port).instance, firstReport.instance);
  } finally {
    for (const dist of dists) fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(reportFile(port), { force: true });
    delete process.env.TOOLING_CONTENT_PORT;
  }
});

test("a run against a server without a live port report stops before any spec", { timeout: 120000 }, async () => {
  const port = await freeTcpPort(host);
  const origin = `http://${host}:${port}`;
  try {
    for (const report of [null, { baseURL: origin, pid: process.pid, instance: "stale", ports: { TOOLING_CONTENT_PORT: port } }]) {
      if (report) writeReport(port, report);
      else fs.rmSync(reportFile(port), { force: true });
      const suite = run(["node_modules/@playwright/test/cli.js", "test", "tests/creator-portal.spec.js", "--project=chromium", "--output", `test-results/fixture-ports-${process.pid}`], {
        BASE_URL: origin, PW_PORT: String(port),
      });
      const [code] = await once(suite.child, "exit");
      assert.notEqual(code, 0);
      assert.match(suite.output(), missingReport(origin));
    }
  } finally {
    fs.rmSync(reportFile(port), { force: true });
    fs.rmSync(`test-results/fixture-ports-${process.pid}`, { recursive: true, force: true });
  }
});

const holdPorts = async ports => {
  const results = await Promise.allSettled(ports.map(async port => {
    const holder = net.createServer().listen(port, host);
    await once(holder, "listening");
    return holder;
  }));
  const held = results.filter(result => result.status === "fulfilled").map(result => result.value);
  const failure = results.find(result => result.status === "rejected");
  if (!failure) return held;
  await Promise.all(held.map(close));
  throw failure.reason;
};
const freePortWithFreeNeighbors = async count => {
  for (;;) {
    const port = await freeTcpPort(host);
    if (port + count > 65535) continue;
    const held = await holdPorts(Array.from({ length: count }, (_, index) => port + index + 1)).catch(() => null);
    if (held) return { port, held };
  }
};

test("holding neighbour ports lets go of the ones it got when one is taken", async () => {
  const { port, held } = await freePortWithFreeNeighbors(3);
  await Promise.all(held.map(close));
  const blocker = net.createServer().listen(port + 2, host);
  await once(blocker, "listening");
  try {
    await assert.rejects(holdPorts([port + 1, port + 2, port + 3]), { code: "EADDRINUSE" });
    const again = await holdPorts([port + 1, port + 3]);
    await Promise.all(again.map(close));
  } finally {
    await close(blocker);
  }
});

const reportsSince = since => {
  try {
    return fs.readdirSync(reportDir).filter(name => name.endsWith(".json")).map(name => path.join(reportDir, name))
      .filter(file => fs.statSync(file).mtimeMs >= since).map(file => JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
};

test("the production startup check picks its content port instead of the next port up", { timeout: 300000 }, async () => {
  const { port, held } = await freePortWithFreeNeighbors(1);
  const base = `.next-e2e-startup-${process.pid}`;
  fs.rmSync(reportFile(port), { force: true });
  const check = run(["scripts/monitoring-next-startup-e2e.mjs"], { PW_PORT: String(port), NEXT_DIST_DIR: base });
  try {
    const report = await waitFor(check, () => readReport(port), 120000, "started its fixture server");
    assert.equal(report.baseURL, `http://${host}:${port}`);
    assert.notEqual(report.ports.TOOLING_CONTENT_PORT, port + 1);
  } finally {
    await stopRun(check);
    await Promise.all(held.map(close));
    const artifact = check.output().match(/^report: (.+)$/m)?.[1];
    if (artifact) fs.rmSync(path.dirname(artifact), { recursive: true, force: true });
    fs.rmSync(`${base}-${port}`, { recursive: true, force: true });
    fs.rmSync(reportFile(port), { force: true });
  }
});

test("the API audit picks its own ports instead of offsets from the target", { timeout: 300000 }, async () => {
  const { port, held } = await freePortWithFreeNeighbors(3);
  const base = `.next-e2e-audit-${process.pid}`;
  const since = Date.now();
  const audit = run(["scripts/run-api-contract-audit.mjs"], { PW_PORT: String(port), NEXT_DIST_DIR: base });
  let report;
  try {
    report = await waitFor(audit, () => reportsSince(since)[0], 120000, "started its fixture server");
    const auditPort = Number(new URL(report.baseURL).port);
    assert.ok(![port, port + 2, port + 3].includes(auditPort), report.baseURL);
    assert.ok(![port + 2, port + 3].includes(report.ports.TOOLING_CONTENT_PORT), JSON.stringify(report.ports));
  } finally {
    await stopRun(audit);
    await Promise.all(held.map(close));
    for (const entry of fs.readdirSync(".")) if (entry.startsWith(`${base}-`)) fs.rmSync(entry, { recursive: true, force: true });
    if (report) fs.rmSync(reportFile(new URL(report.baseURL).port), { force: true });
  }
});
