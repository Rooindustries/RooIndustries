const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "final";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "roo-operations-assets-"));
const expectedBytes = Buffer.from("original source asset bytes");
const wrongBytes = Buffer.from("different asset, different length");
const hash = (bytes, algorithm) => crypto.createHash(algorithm).update(bytes).digest("hex");
const results = [];
let current;
const second = http.createServer((req, res) => {
  current.secondOriginRequests += 1;
  res.setHeader("Content-Type", "image/png"); res.setHeader("X-Sanity-SHA1", hash(expectedBytes, "sha1")); res.end(expectedBytes);
});
await new Promise((resolve) => second.listen(0, testHost, resolve));
const first = http.createServer(async (req, res) => {
  const parts = []; for await (const part of req) parts.push(part);
  const host = req.headers["x-operations-fixture-target"];
  const url = new URL(req.url, "http://fixture.invalid");
  current.requests.push({ path: url.pathname, host, credentialPresent: Boolean(req.headers.authorization) });
  res.setHeader("Content-Type", "application/json");
  if (url.pathname.includes("/data/query/")) {
    const asset = { _id: "image-fixture-1x1-png", _type: "sanity.imageAsset", _rev: "asset-r1", assetId: "fixture-1x1", extension: "png", mimeType: "image/png", size: expectedBytes.length,
      sha1hash: hash(expectedBytes, "sha1"), url: current.name === "asset-url-secret-boundary" ? "https://targetb.supabase.co/stolen" : "https://cdn.sanity.io/images/targetb/fixtureb/asset.png" };
    res.end(JSON.stringify({ result: [asset] })); return;
  }
  if (url.pathname === "/stolen") {
    current.initialForeignRequests += 1;
    res.setHeader("Content-Type", "image/png"); res.end(expectedBytes); return;
  }
  if (url.pathname.startsWith("/cdn")) {
    if (current.name === "asset-migration-redirect-boundary") {
      res.writeHead(302, { Location: `http://${testHost}:${second.address().port}/stolen` }); res.end(); return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("X-Sanity-SHA1", hash(wrongBytes, "sha1")); res.end(wrongBytes); return;
  }
  const rpc = url.pathname.split("/").at(-1);
  res.end(JSON.stringify(rpc.includes("summary") ? {} : []));
});
await new Promise((resolve) => first.listen(0, testHost, resolve));
const envPath = path.join(temp, "selected.env");
await fs.writeFile(envPath, "SANITY_PROJECT_ID=targetb\nSANITY_DATASET=fixtureb\nSANITY_READ_TOKEN=fixture-targetb\nSUPABASE_URL=https://targetb.supabase.co\nSUPABASE_SECRET_KEY=fixture-targetb\nDATA_PRIMARY_BACKEND=sanity\nCOMMERCE_PRIMARY_BACKEND=sanity\n", { mode: 0o600 });
const manifest = path.join(temp, "fixture.json");
const trace = path.join(temp, "trace.jsonl");
await fs.writeFile(manifest, JSON.stringify({ origin: `http://${testHost}:${first.address().port}`, trace,
  localOrigins: [`http://${testHost}:${second.address().port}`] }));
try {
  for (const name of ["asset-url-secret-boundary", "asset-migration-redirect-boundary", "asset-metadata-cannot-override-source-checksum"]) {
    current = { name, requests: [], secondOriginRequests: 0, initialForeignRequests: 0 };
    await fs.writeFile(trace, "");
    let ok = false, error = "";
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", path.join(root, "scripts/test-operations-sweep-network.mjs"), path.join(root, "scripts/migrate-sanity-to-supabase.mjs"), "--env", envPath, "--verify-only"], {
          cwd: temp, env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test", ROO_TEST_HOST: testHost, OPERATIONS_TEST_MANIFEST: manifest },
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (bytes) => { stdout += bytes; }); child.stderr.on("data", (bytes) => { stderr += bytes; });
        child.on("error", reject);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15000); timeout.unref();
        child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      });
      current.cli = result;
      assert.notEqual(result.code, 0);
      assert.equal(current.initialForeignRequests, 0);
      assert.equal(current.secondOriginRequests, 0);
      if (name === "asset-metadata-cannot-override-source-checksum") assert.match(result.stderr, /source (size|checksum)|byte-size|source metadata/);
      ok = true;
    } catch (cause) { error = cause.message; }
    results.push({ ...current, ok, ...(error ? { error } : {}) });
  }
} finally {
  for (const server of [first, second]) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await fs.rm(temp, { recursive: true, force: true });
}
await fs.mkdir(path.join(root, "test-results"), { recursive: true });
const artifact = path.join(root, "test-results", `operations-assets-${stage}.json`);
await fs.writeFile(artifact, JSON.stringify({ stage, results }, null, 2));
process.stdout.write(`${JSON.stringify({ artifact, passed: results.filter((row) => row.ok).length, total: results.length })}\n`);
if (results.some((row) => !row.ok)) process.exitCode = 1;
