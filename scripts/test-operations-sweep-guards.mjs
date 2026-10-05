const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetch as importedFetch, getGlobalDispatcher } from "undici";
import { installNetworkGuard } from "./lib/test-target-safety.mjs";

const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), "..");
const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const stage = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "final";
const names = ["shared-undici-refuses-second-origin", "shared-undici-allows-owned-origin-and-restores", "shared-global-manual-307", "shared-global-manual-308", "cms-undici-refuses-all"];
if (!scenario) {
  const results = [];
  for (const name of names) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [self, `--scenario=${name}`], { env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test", ROO_TEST_HOST: testHost } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (bytes) => { stdout += bytes; });
      child.stderr.on("data", (bytes) => { stderr += bytes; });
      child.on("error", reject);
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10000); timeout.unref();
      child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    });
    let row;
    try { row = JSON.parse(result.stdout); } catch { row = { name, ok: false, error: result.stderr || result.stdout }; }
    results.push({ ...row, exitCode: result.code });
  }
  await fs.mkdir(path.join(root, "test-results"), { recursive: true });
  const artifact = path.join(root, "test-results", `operations-guards-${stage}.json`);
  await fs.writeFile(artifact, JSON.stringify({ stage, results }, null, 2));
  process.stdout.write(`${JSON.stringify({ artifact, passed: results.filter((row) => row.ok).length, total: results.length })}\n`);
  if (results.some((row) => !row.ok)) process.exitCode = 1;
} else {
  assert(names.includes(scenario));
  const originalDispatcher = getGlobalDispatcher();
  const observations = { firstOriginRequests: 0, secondOriginRequests: 0, secondOriginConnections: 0 };
  const second = http.createServer((_req, res) => { observations.secondOriginRequests += 1; res.end("owned second origin"); });
  second.on("connection", () => { observations.secondOriginConnections += 1; });
  await new Promise((resolve) => second.listen(0, testHost, resolve));
  const secondOrigin = `http://${testHost}:${second.address().port}`;
  const first = http.createServer((_req, res) => {
    observations.firstOriginRequests += 1;
    if (scenario.includes("manual")) res.writeHead(Number(scenario.split("-").at(-1)), { Location: `${secondOrigin}/redirect` });
    res.end("owned first origin");
  });
  await new Promise((resolve) => first.listen(0, testHost, resolve));
  const firstOrigin = `http://${testHost}:${first.address().port}`;
  let cleanup, error = "", ok = false;
  try {
    if (scenario.startsWith("cms-")) await import("./test-cms-download-sweep-network-guard.mjs");
    else cleanup = installNetworkGuard([firstOrigin]);
    if (scenario.includes("refuses")) {
      let caught;
      try { await importedFetch(`${secondOrigin}/disallowed`, { signal: AbortSignal.timeout(1500) }); }
      catch (cause) { caught = cause; }
      observations.rejected = Boolean(caught);
      assert(caught);
      assert.equal(observations.secondOriginRequests, 0);
      assert.equal(observations.secondOriginConnections, 0);
      if (scenario.startsWith("cms-")) {
        await assert.rejects(importedFetch(`${firstOrigin}/also-disallowed`, { signal: AbortSignal.timeout(1500) }));
        assert.equal(observations.firstOriginRequests, 0);
      }
    } else if (scenario.includes("manual")) {
      const response = await globalThis.fetch(`${firstOrigin}/manual`, { redirect: "manual" });
      observations.status = response.status;
      assert.equal(response.status, Number(scenario.split("-").at(-1)));
      await response.body.cancel();
      assert.equal(observations.firstOriginRequests, 1);
      assert.equal(observations.secondOriginRequests, 0);
    } else {
      assert.equal(await (await importedFetch(`${firstOrigin}/allowed`)).text(), "owned first origin");
      assert.equal(observations.firstOriginRequests, 1);
    }
    if (cleanup) {
      cleanup(); cleanup = null;
      observations.dispatcherRestored = getGlobalDispatcher() === originalDispatcher;
      assert.equal(observations.dispatcherRestored, true);
      if (scenario.includes("restores")) {
        assert.equal(await (await importedFetch(`${secondOrigin}/after-cleanup`)).text(), "owned second origin");
        assert.equal(observations.secondOriginRequests, 1);
      }
    }
    ok = true;
  } catch (cause) { error = `${cause.name}: ${cause.message}`; }
  finally {
    cleanup?.();
    for (const server of [first, second]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
  process.stdout.write(`${JSON.stringify({ name: scenario, ok, observations, ...(error ? { error } : {}) })}\n`);
  if (!ok) process.exitCode = 1;
}
