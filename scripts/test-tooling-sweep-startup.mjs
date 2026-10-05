import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import seo from "../src/lib/seo.js";
import { JSDOM } from "jsdom";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
assert.equal(process.env.ROO_TEST_HOST, "100.127.48.111");
const host = process.env.ROO_TEST_HOST;
const runId = crypto.randomUUID();
const dist = `.next-e2e-tooling-startup-${runId}`;
const artifact = path.resolve(process.env.TOOLING_STARTUP_ARTIFACT || "test-results/tooling-startup.json");
const evidence = { runId, dist, scenarios: [], commands: [], boundaries: ["Actual local Next production build/start and HTTP; HTML parses through jsdom without script/resource execution. Hosted data, browsers and Mac reachability are not exercised."] };
const children = new Set();
const freePort = async () => {
  const server = http.createServer();
  server.listen(0, host);
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const port = await freePort();
const baseURL = `http://${host}:${port}`;
const launch = (name, { output = dist, targetPort = port } = {}) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, CI: "true", TZ: "UTC", ROO_TEST_HOST: host,
    BASE_URL: `http://${host}:${targetPort}`, PW_PORT: String(targetPort), NEXT_DIST_DIR: output };
  const argv = [path.join(root, "scripts/test-tooling-sweep-server.mjs")];
  const child = spawn(process.execPath, argv, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const record = { name, binary: process.execPath, argv, cwd: root, env, pid: child.pid, stdout: "", stderr: "" };
  evidence.commands.push(record);
  child.stdout.on("data", bytes => { record.stdout += bytes; });
  child.stderr.on("data", bytes => { record.stderr += bytes; });
  const done = new Promise(resolve => child.once("close", (code, signal) => {
    record.exitCode = code; record.signal = signal; children.delete(child); resolve(record);
  }));
  return { child, record, done };
};
const stop = async process => {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
  await Promise.race([process.done, delay(5000)]);
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGKILL");
  await process.done;
};
const check = async (name, fn) => {
  try { evidence.scenarios.push({ name, passed: true, proof: await fn() }); }
  catch (error) { evidence.scenarios.push({ name, passed: false, error: error.message }); }
};
const ready = async process => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    assert.equal(process.child.exitCode, null, process.record.stdout + process.record.stderr);
    try {
      const response = await fetch(baseURL, { redirect: "error", signal: AbortSignal.timeout(500) });
      if (response.status === 200) { await response.body.cancel(); return; }
      await response.body.cancel();
    } catch {}
    await delay(100);
  }
  throw new Error(`Local startup deadline exceeded: ${process.record.stdout}${process.record.stderr}`);
};
const refused = async process => {
  const result = await Promise.race([process.done, delay(10000).then(() => { throw new Error("Refusal did not settle"); })]);
  assert.notEqual(result.exitCode, 0);
  return result;
};

try {
  await check("local-production-build-start", async () => {
    const process = launch("initial-build");
    try {
      await ready(process);
      const pages = [];
      for (const route of ["/", "/about", "/contact", "/privacy", "/reviews", "/tools"]) {
        const response = await fetch(`${baseURL}${route}`, { redirect: "error", signal: AbortSignal.timeout(10000) });
        const html = await response.text();
        assert.equal(response.status, 200, route);
        assert.match(response.headers.get("content-type"), /text\/html/);
        const dom = new JSDOM(html);
        try {
          assert.ok(dom.window.document.querySelector("main"), route);
          assert.equal(dom.window.document.title, seo.getMetadataForPath(route).title, route);
          if (route !== "/privacy") assert.ok(dom.window.document.querySelector("h1"), route);
        } finally { dom.window.close(); }
        pages.push({ route, status: response.status, sha256: crypto.createHash("sha256").update(html).digest("hex"),
          contentSecurityPolicy: response.headers.get("content-security-policy") });
      }
      assert.match(process.record.stdout, /Creating an optimized production build/);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, dist, "tooling-build.json"), "utf8"));
      assert.equal(manifest.version, 1);
      assert.equal(manifest.baseURL, baseURL);
      assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/);
      return { pages, manifest, buildId: fs.readFileSync(path.join(root, dist, "BUILD_ID"), "utf8").trim() };
    } finally { await stop(process); }
  });
  if (evidence.scenarios[0].passed) await check("same-source-local-build-reuse", async () => {
    const process = launch("reuse-build");
    try {
      await ready(process);
      assert.doesNotMatch(process.record.stdout, /Creating an optimized production build/);
      return { builtAgain: false, status: 200 };
    } finally { await stop(process); }
  });
  if (evidence.scenarios[0].passed) await check("different-local-origin-refuses-cache", async () => {
    const process = launch("wrong-origin", { targetPort: await freePort() });
    const result = await refused(process);
    assert.match(result.stderr, /build ownership or source fingerprint differs/);
    return { exitCode: result.exitCode, buildPreserved: fs.existsSync(path.join(root, dist, "BUILD_ID")) };
  });
  await check("incomplete-build-preserved", async () => {
    const output = `${dist}-incomplete`;
    fs.mkdirSync(path.join(root, output));
    const process = launch("incomplete-build", { output });
    const result = await refused(process);
    assert.match(result.stderr, /Incomplete isolated build exists/);
    assert.equal(fs.existsSync(path.join(root, output)), true);
    assert.equal(fs.existsSync(path.join(root, output, "BUILD_ID")), false);
    return { exitCode: result.exitCode, directoryPreserved: true };
  });
} finally {
  for (const child of children) { child.kill("SIGTERM"); }
  await Promise.all([...children].map(child => once(child, "close")));
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify(evidence, null, 2) + "\n");
}
console.log(JSON.stringify({ artifact, passed: evidence.scenarios.filter(row => row.passed).length, total: evidence.scenarios.length }));
if (evidence.scenarios.some(row => !row.passed)) process.exitCode = 1;
