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
