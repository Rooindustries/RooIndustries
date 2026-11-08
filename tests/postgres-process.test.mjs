import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { freeTcpPort } from "../scripts/lib/free-tcp-port.mjs";

test("PostgreSQL stays in the fixture tree and stops when its launcher is killed", { timeout: 30000 }, async () => {
  const host = "127.0.0.1";
  const port = await freeTcpPort(host);
  const pgBin = process.env.PG_BIN || spawnSync("pg_config", ["--bindir"], { encoding: "utf8" }).stdout.trim();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "postgres-process-"));
  const dataDir = path.join(scratch, "data");
  const helper = new URL("../scripts/lib/start-postgres.mjs", import.meta.url).href;
  let parent;
  try {
    const initialized = spawnSync(path.join(pgBin, "initdb"),
      ["-D", dataDir, "--auth=trust", "--no-locale"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
    assert.equal(initialized.status, 0, initialized.stderr);
    parent = spawn(process.execPath, ["--input-type=module", "-e", `
const { startPostgres } = await import(${JSON.stringify(helper)});
await startPostgres(${JSON.stringify(pgBin)}, ${JSON.stringify(dataDir)}, ${JSON.stringify(host)}, ${port});
console.log("ready");
setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
    await Promise.race([once(parent.stdout, "data"), once(parent, "exit").then(() => {
      throw new Error("PostgreSQL launcher exited before readiness");
    })]);
    assert.equal(spawnSync(path.join(pgBin, "pg_isready"), ["-h", host, "-p", String(port)]).status, 0);
    parent.kill("SIGKILL");
    await once(parent, "exit");
    const deadline = Date.now() + 10000;
    for (;;) {
      const listener = net.createServer();
      const available = await new Promise((resolve) => {
        listener.once("error", () => resolve(false));
        listener.listen(port, host, () => listener.close(() => resolve(true)));
      });
      const table = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout;
      if (available && !table.includes(`${path.join(pgBin, "postgres")} -D ${dataDir}`)) break;
      assert.ok(Date.now() < deadline, "PostgreSQL survived its killed launcher");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
