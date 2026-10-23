import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const artifactBase = process.env.ROO_ACCOUNT_DOMAIN_STARTUP_ARTIFACT_DIR
  || path.join(root, "test-results/account-domain-startup");
fs.mkdirSync(artifactBase, { recursive: true });
const artifacts = fs.mkdtempSync(path.join(artifactBase, "run-"));

test("account identity retains failed PostgreSQL startup logs after owned cleanup", { timeout: 120_000 }, async (t) => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-account-startup-"));
  const temporaryBase = path.join(jobDir, "tmp");
  fs.mkdirSync(temporaryBase);
  const owner = net.createServer((socket) => socket.end("occupied-port-fixture\n"));
  owner.listen(0, "127.0.0.1");
  await once(owner, "listening");
  const port = owner.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/sentry.*dsn/i.test(key)));
  Object.assign(env, { ROO_JOB_DIR: jobDir, ROO_TEST_POSTGRES_HOST: "127.0.0.1", ROO_TEST_POSTGRES_PORT: String(port) });
  const run = async (label) => {
    const output = path.join(artifacts, label);
    fs.mkdirSync(output);
    const child = spawn(process.execPath, ["scripts/test-account-domain-identity-postgres.mjs"], {
      cwd: root,
      env: { ...env, ROO_ACCOUNT_DOMAIN_ARTIFACT_DIR: output },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 50_000,
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, "close");
    fs.writeFileSync(path.join(output, "stdout.log"), stdout);
    fs.writeFileSync(path.join(output, "stderr.log"), stderr);
    const runs = fs.readdirSync(output).filter((name) => name.startsWith("run-"));
    return {
      code, signal, stdout, stderr, runs,
      scratchRemoved: fs.readdirSync(temporaryBase).length === 0,
      postgresLogs: runs.map((name) => path.join(output, name, "postgres.log")),
    };
  };
  try {
    const failure = await run("occupied");
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(5_000, () => socket.destroy(new Error("Port owner did not answer")));
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await once(socket, "close");
    failure.portOwnerResponse = Buffer.concat(chunks).toString();
    await new Promise((resolve) => owner.close(resolve));
    const normal = await run("normal");
    fs.writeFileSync(path.join(artifacts, "result.json"), `${JSON.stringify({ port, failure, normal }, null, 2)}\n`);
    t.diagnostic(`Artifacts: ${artifacts}`);

    assert.equal(failure.code, 1, failure.stderr);
    assert.equal(failure.signal, null);
    assert.equal(failure.scratchRemoved, true, "Failed fixture retained its temporary cluster");
    assert.equal(failure.portOwnerResponse, "occupied-port-fixture\n", "Cleanup disturbed the existing port owner");
    assert.equal(failure.postgresLogs.length, 1, "Native startup log was not retained");
    const failedLog = fs.readFileSync(failure.postgresLogs[0], "utf8");
    assert.match(failedLog, /Address already in use/);
    assert.match(failedLog, /FATAL:.*could not create any TCP\/IP sockets/);
    assert.match(failure.stderr, /pg_ctl.*failed/);
    assert.match(failure.stderr, /Address already in use/);
    const failedRun = path.dirname(failure.postgresLogs[0]);
    assert.match(fs.readFileSync(path.join(failedRun, "pg_ctl-start.log"), "utf8"), /could not start server/);
    assert.match(fs.readFileSync(path.join(failedRun, "initdb.log"), "utf8"), /Success/);
    const failedPid = Number(failedLog.match(/\[(\d+)\] LOG:\s+starting PostgreSQL/)[1]);
    assert.throws(() => process.kill(failedPid, 0), { code: "ESRCH" }, "Failed PostgreSQL process is still running");

    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(normal.signal, null);
    assert.equal(normal.scratchRemoved, true, "Normal fixture retained its temporary cluster");
    const identity = JSON.parse(normal.stdout);
    assert.equal(identity.ok, true);
    assert.match(identity.postgres, /^17\./);
    assert.equal(identity.verified.length, 9, "The original account identity checks did not complete");
    assert.equal(normal.postgresLogs.length, 1);
    const normalLog = fs.readFileSync(normal.postgresLogs[0], "utf8");
    assert.match(normalLog, /database system is ready to accept connections/);
    assert.match(normalLog, /database system is shut down/);
    assert.match(fs.readFileSync(path.join(path.dirname(normal.postgresLogs[0]), "pg_ctl-stop.log"), "utf8"), /server stopped/);
    const pid = Number(normalLog.match(/\[(\d+)\] LOG:\s+starting PostgreSQL/)[1]);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Owned PostgreSQL process is still running");
  } finally {
    if (owner.listening) await new Promise((resolve) => owner.close(resolve));
    const pgBin = process.env.PG_BIN || spawnSync(process.env.PG_CONFIG || "pg_config", ["--bindir"], { encoding: "utf8" }).stdout?.trim();
    for (const name of fs.readdirSync(temporaryBase)) {
      const dataDir = path.join(temporaryBase, name, "pgdata");
      if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
        const stopped = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { env, encoding: "utf8" });
        assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
      }
    }
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test("account identity cleanup retains client close errors", { timeout: 180_000 }, async t => {
  const pgBin = process.env.PG_BIN || spawnSync(process.env.PG_CONFIG || "pg_config", ["--bindir"], { encoding: "utf8" }).stdout?.trim();
  for (const mode of ["client", "stop", "remove"]) await t.test(mode, async () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "roo-account-close-"));
    const scratch = path.join(jobDir, "tmp");
    const output = fs.mkdtempSync(path.join(artifacts, `${mode}-`));
    fs.mkdirSync(scratch);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/sentry.*dsn/i.test(key)));
    Object.assign(env, { PG_BIN: pgBin, ROO_JOB_DIR: jobDir, ROO_CLOSE_FIXTURE_MODE: mode, ROO_ACCOUNT_DOMAIN_ARTIFACT_DIR: output });
    if (mode === "stop") {
      const bin = path.join(jobDir, "bin"); fs.mkdirSync(bin);
      for (const command of ["initdb", "psql"]) fs.symlinkSync(path.join(pgBin, command), path.join(bin, command));
      fs.writeFileSync(path.join(bin, "pg_ctl"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nif(args.includes('stop')) {process.stderr.write('fixture-stop-failure\\n');process.exit(1);}\nconst result=spawnSync(${JSON.stringify(path.join(pgBin, "pg_ctl"))},args,{stdio:'inherit'});\nprocess.exit(result.status??1);\n`, { mode: 0o700 });
      env.PG_BIN = bin;
    }
    let pid;
    try {
      const child = spawn(process.execPath, ["--import", "./tests/fixtures/account-domain-close-failure.mjs", "scripts/test-account-domain-identity-postgres.mjs"], {
        cwd: root, env, stdio: ["ignore", "pipe", "pipe"], timeout: 50_000,
      });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
      const [code, signal] = await once(child, "close");
      const run = fs.readdirSync(output).find(name => name.startsWith("run-"));
      const nativeLog = fs.readFileSync(path.join(output, run, "postgres.log"), "utf8");
      pid = Number(nativeLog.match(/\[(\d+)\] LOG:\s+starting PostgreSQL/)[1]);
      const clusters = fs.readdirSync(scratch);
      const observation = { mode, code, signal, stdout, stderr, pid, nativeLog, clusters };
      fs.writeFileSync(path.join(output, "result.json"), `${JSON.stringify(observation, null, 2)}\n`);
      t.diagnostic(`Artifacts: ${output}`);
      assert.equal(code, 1, stderr);
      assert.equal(signal, null);
      const identity = JSON.parse(stdout);
      assert.equal(identity.ok, true);
      assert.match(identity.postgres, /^17\./);
      assert.equal(identity.verified.length, 9);
      assert.match(stderr, /fixture-client-close-failure/);
      if (mode === "stop") {
        assert.match(stderr, /fixture-stop-failure/);
        assert.equal(clusters.length, 1, "Failed native stop must retain its cluster");
        assert.doesNotThrow(() => process.kill(pid, 0), "Fixture did not exercise a failed stop with the server alive");
      } else {
        assert.match(nativeLog, /database system is shut down/);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        if (mode === "remove") { assert.match(stderr, /EACCES|EPERM/); assert.equal(clusters.length, 1); }
        else assert.deepEqual(clusters, [], "Client-close failure skipped cluster removal");
      }
    } finally {
      for (const name of fs.readdirSync(scratch)) {
        const cluster = path.join(scratch, name); fs.chmodSync(cluster, 0o700);
        const dataDir = path.join(cluster, "pgdata");
        if (fs.existsSync(path.join(dataDir, "postmaster.pid"))) {
          const stopped = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { encoding: "utf8", env });
          assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
          fs.writeFileSync(path.join(output, "owned-stop.log"), `${stopped.stdout}\n${stopped.stderr}`);
        }
      }
      fs.rmSync(jobDir, { recursive: true, force: true });
      if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Owned database process survived E2E cleanup");
    }
  });
});
