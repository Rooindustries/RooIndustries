const testHost = process.env.ROO_TEST_HOST || '127.0.0.1';
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const self = fileURLToPath(import.meta.url);
const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.split("=")[1];
const stage = process.argv.find((arg) => arg.startsWith("--stage="))?.split("=")[1] || "final";
const selected = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const names = [
  "archive-existing-output", "archive-child-failure", "archive-roundtrip-tampering",
  "commerce-export-disk-readback", "database-transport-cross-origin-redirect", "database-transport-body-deadline", "lighthouse-cli-startup",
];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const safeEnv = () => ({ PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test", ROO_TEST_HOST: testHost });
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = childProcess.spawn(command, args, { env: safeEnv(), ...options });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  child.on("error", reject);
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
  timeout.unref();
  child.on("close", () => clearTimeout(timeout));
});

if (!scenario) {
  const results = [];
  for (const name of names.filter((name) => !selected || selected.split(",").includes(name))) {
    const result = await run(process.execPath, [self, `--scenario=${name}`, `--stage=${stage}`]);
    let parsed;
    try { parsed = JSON.parse(result.stdout); }
    catch { parsed = { name, ok: false, error: result.stderr || result.stdout }; }
    results.push({ ...parsed, exitCode: result.code });
  }
  await fsPromises.mkdir(path.join(root, "test-results"), { recursive: true });
  const artifact = path.join(root, "test-results", `operations-sweep-${stage}.json`);
  await fsPromises.writeFile(artifact, JSON.stringify({ stage, results }, null, 2));
  process.stdout.write(`${JSON.stringify({ artifact, passed: results.filter((row) => row.ok).length, total: results.length })}\n`);
  if (results.some((row) => !row.ok)) process.exitCode = 1;
} else {
  assert(names.includes(scenario));
  const temp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "roo-operations-fixture-"));
  await fsPromises.chmod(temp, 0o700);
  const observations = {};
  const servers = [];
  const children = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    const actual = scenario === "archive-child-failure" && command === "gzip"
      ? [process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"]]
      : [command, args];
    const child = originalSpawn(actual[0], actual[1], options);
    children.push(child);
    return child;
  };
  let keychainSecret = "";
  childProcess.execFile = (_command, args, _options, callback) => {
    if (_command !== "security") throw new Error("Unexpected executable in fixture");
    const cb = typeof _options === "function" ? _options : callback;
    observations.keychainCalls = (observations.keychainCalls || 0) + 1;
    if (args[0] === "add-generic-password") keychainSecret = args[args.indexOf("-w") + 1];
    queueMicrotask(() => cb(null, args[0] === "find-generic-password" ? `${keychainSecret}\n` : "", ""));
  };
  childProcess.execFile[Symbol.for("nodejs.util.promisify.custom")] = (command, args, options) => new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (cause, stdout, stderr) => cause ? reject(cause) : resolve({ stdout, stderr }));
  });
  const serve = async (handler) => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, testHost, resolve));
    return `http://${testHost}:${server.address().port}`;
  };
  const originalFetch = globalThis.fetch;
  const refuse = () => { throw new Error("Unexpected network call outside injected local fixture transport"); };
  globalThis.fetch = refuse;
  http.request = https.request = http.get = https.get = refuse;
  syncBuiltinESMExports();
  let ok = false, error = "";
  try {
    const archive = await import("./lib/encrypted-export.mjs");
    if (scenario === "archive-existing-output") {
      const directory = path.join(temp, "source");
      await fsPromises.mkdir(directory);
      await fsPromises.writeFile(path.join(directory, "document.json"), '{"synthetic":true}');
      const outputPath = path.join(temp, "prior.tar.gz.enc");
      const previous = Buffer.from("previous synthetic encrypted archive\0exact bytes");
      await fsPromises.writeFile(outputPath, previous, { mode: 0o600 });
      let caught;
      try { await archive.encryptTarDirectory({ directory, outputPath, passphrase: "fixture-only" }); }
      catch (cause) { caught = cause; }
      observations.errorCode = caught?.code;
      observations.beforeSha256 = sha256(previous);
      observations.exists = fs.existsSync(outputPath);
      observations.afterSha256 = observations.exists ? sha256(await fsPromises.readFile(outputPath)) : null;
      observations.childrenStarted = children.length;
      assert(caught);
      assert.equal(observations.afterSha256, observations.beforeSha256);
    } else if (scenario === "archive-child-failure") {
      const outputPath = path.join(temp, "failed.tar.gz.enc");
      let caught;
      try { await archive.encryptTarDirectory({ directory: path.join(temp, "missing-source"), outputPath, passphrase: "fixture-only" }); }
      catch (cause) { caught = cause; }
      observations.errorCode = caught?.code;
      observations.liveChildrenAtReturn = children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => child.pid);
      observations.outputExists = fs.existsSync(outputPath);
      assert(caught);
      assert.equal(observations.liveChildrenAtReturn.length, 0);
      assert.equal(observations.outputExists, false);
    } else if (scenario === "archive-roundtrip-tampering") {
      const directory = path.join(temp, "source");
      await fsPromises.mkdir(directory);
      await fsPromises.writeFile(path.join(directory, "documents.json"), '{"synthetic":true}');
      const outputPath = path.join(temp, "archive.enc");
      const encrypted = await archive.encryptTarDirectory({ directory, outputPath, passphrase: "fixture-only" });
      const verified = await archive.verifyEncryptedTarArchive({ inputPath: outputPath, passphrase: "fixture-only", expectedEntries: ["", "documents.json"] });
      assert.equal(verified.plaintextSha256, encrypted.plaintextSha256);
      const original = await fsPromises.readFile(outputPath);
      for (const position of [8, 64, original.length - 1]) {
        const tampered = Buffer.from(original);
        tampered[position] ^= 1;
        await fsPromises.writeFile(outputPath, tampered);
        await assert.rejects(archive.verifyEncryptedTarArchive({ inputPath: outputPath, passphrase: "fixture-only" }));
      }
      await fsPromises.writeFile(outputPath, original);
      await assert.rejects(archive.verifyEncryptedTarArchive({ inputPath: outputPath, passphrase: "wrong-fixture-key" }));
      await assert.rejects(archive.verifyEncryptedTarArchive({ inputPath: outputPath, passphrase: "fixture-only", expectedEntries: ["", "missing.json"] }));
      observations.verifiedSha256 = verified.plaintextSha256;
      observations.tamperedPositionsRejected = [8, 64, original.length - 1];
    } else if (scenario === "commerce-export-disk-readback") {
      const commerce = await import("./export-supabase-commerce-encrypted.mjs");
      const safety = (await import("../src/server/supabase/migrationTargetSafety.cjs")).default;
      const snapshot = { format: "roo-supabase-commerce-export-v1", exported_at: "2026-10-05T00:00:00.000Z", ...Object.fromEntries(commerce.SNAPSHOT_ARRAYS.map((key) => [key, []])) };
      const origin = await serve((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(snapshot)); });
      const target = "https://opsfixture.supabase.co";
      const envPath = path.join(temp, "private-fixture.env");
      await fsPromises.writeFile(envPath, `SUPABASE_URL=${target}\nSUPABASE_SECRET_KEY=fixture-only\nSUPABASE_COMMERCE_EXPORT_EXPECTED_FINGERPRINT=${safety.computeTourneyCutoverSupabaseApiTargetFingerprint(target)}\n`, { mode: 0o600 });
      const { createClient } = await import("@supabase/supabase-js");
      const writeFileSync = fs.writeFileSync;
      fs.writeFileSync = (destination, data, ...args) => {
        const result = writeFileSync(destination, data, ...args);
        if (typeof destination === "number") fs.writeSync(destination, Buffer.from("X"), 0, 1, 0);
        return result;
      };
      let caught, result;
      try {
        result = await commerce.runCommerceEncryptedExport({ argv: ["--env", envPath], env: {}, outputRoot: path.join(temp, "output"),
          clientFactory: (url, key, options) => createClient(url, key, { ...options, global: { ...options.global, fetch: (input, init) => {
            const requested = new URL(typeof input === "string" ? input : input.url);
            assert.equal(requested.origin, target);
            return originalFetch(`${origin}${requested.pathname}${requested.search}`, init);
          } } }),
        });
      } catch (cause) { caught = cause; }
      fs.writeFileSync = writeFileSync;
      observations.exportSuccess = result?.ok === true;
      observations.corruptionRejected = Boolean(caught);
      observations.outputFiles = await fsPromises.readdir(path.join(temp, "output"));
      assert(caught);
      assert.equal(observations.outputFiles.length, 0);
    } else if (scenario === "database-transport-cross-origin-redirect") {
      const transport = await import("./lib/supabase-database-target-transport.mjs");
      let secondCount = 0;
      const second = await serve(async (req, res) => { secondCount += 1; for await (const _chunk of req) {} res.end('{"ok":false}'); });
      const first = await serve(async (req, res) => { for await (const _chunk of req) {} res.writeHead(307, { Location: `${second}/redirected` }); res.end(); });
      const fetchImpl = (url, init) => {
        assert.equal(url, "https://www.rooindustries.com/api/admin/tourney-snapshot-transport");
        return originalFetch(`${first}/api/admin/tourney-snapshot-transport`, init);
      };
      await assert.rejects(transport.fetchSupabaseDatabaseTarget({ bearer: "fixture-only-bearer-over-32-characters", expectedTargets: Object.fromEntries(["legacy", "sanity", "supabaseApi", "supabaseDatabase"].map((key) => [key, "a".repeat(64)])), transportUrl: "https://www.rooindustries.com/api/admin/tourney-snapshot-transport", fetchImpl }));
      observations.secondOriginRequests = secondCount;
      assert.equal(secondCount, 0);
    } else if (scenario === "database-transport-body-deadline") {
      const transport = await import("./lib/supabase-database-target-transport.mjs");
      const first = await serve(async (req, res) => { for await (const _chunk of req) {} res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":true'); });
      const timeout = globalThis.setTimeout;
      globalThis.setTimeout = (callback, ms, ...args) => timeout(callback, ms === 30000 ? 50 : ms, ...args);
      let settled = false;
      const operation = transport.fetchSupabaseDatabaseTarget({ bearer: "fixture-only-bearer-over-32-characters", expectedTargets: Object.fromEntries(["legacy", "sanity", "supabaseApi", "supabaseDatabase"].map((key) => [key, "a".repeat(64)])), transportUrl: "https://www.rooindustries.com/api/admin/tourney-snapshot-transport", fetchImpl: (url, init) => {
        assert.equal(url, "https://www.rooindustries.com/api/admin/tourney-snapshot-transport");
        return originalFetch(`${first}/api/admin/tourney-snapshot-transport`, init);
      } });
      operation.then(() => { settled = true; }, () => { settled = true; });
      await delay(200);
      globalThis.setTimeout = timeout;
      observations.bodyDeadlineSettled = settled;
      observations.productionTimeoutMs = 30000;
      observations.fixtureTimeoutMs = 50;
      assert.equal(settled, true);
    } else if (scenario === "lighthouse-cli-startup") {
      const config = JSON.parse(await fsPromises.readFile(path.join(root, "lighthouserc.json")));
      const packageJson = JSON.parse(await fsPromises.readFile(path.join(root, "package.json")));
      await fsPromises.writeFile(path.join(temp, "package.json"), JSON.stringify({ scripts: packageJson.scripts }));
      await fsPromises.writeFile(path.join(temp, "lighthouserc.json"), JSON.stringify(config));
      const result = await run(process.execPath, [path.join(root, "node_modules/@lhci/cli/src/cli.js"), "collect", "--config", path.join(temp, "lighthouserc.json"), "--numberOfRuns=0", "--startServerCommand=", "--headful", "--additive", "--startServerReadyTimeout=1000"], { cwd: temp });
      observations.cliExitCode = result.code;
      observations.stdout = result.stdout;
      observations.stderr = result.stderr;
      observations.browserRuns = 0;
      assert.equal(result.code, 0);
      assert.equal(config.ci.collect.startServerCommand,
        "PW_PORT=3001 BASE_URL=http://${ROO_TEST_HOST:-127.0.0.1}:3001 NEXT_DIST_DIR=.next-e2e-lighthouse node scripts/test-tooling-sweep-server.mjs");
      assert.equal(config.ci.collect.startServerCommand.includes("npm run serve:lighthouse"), false);
      observations.configuredStartup = config.ci.collect.startServerCommand;
      observations.startupMode = "explicit-existing-server";
      assert.deepEqual(Object.fromEntries(Object.entries(config.ci.assert.assertions).map(([key, value]) => [key, value[1].maxNumericValue])), {
        "largest-contentful-paint": 2500, "cumulative-layout-shift": 0.1,
        "max-potential-fid": 200, interactive: 4000, "total-byte-weight": 2200000,
      });
    }
    ok = true;
  } catch (cause) { error = `${cause.name}: ${cause.message}`; }
  finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise((resolve) => child.once("close", resolve))));
    for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await fsPromises.rm(temp, { recursive: true, force: true });
    await delay(5);
  }
  process.stdout.write(`${JSON.stringify({ name: scenario, ok, observations, ...(error ? { error } : {}) })}\n`);
  if (!ok) process.exitCode = 1;
}
