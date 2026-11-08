import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnContained, stopChild } from "../scripts/lib/start-on-port.mjs";
import { freeTcpPort, releaseTcpPorts } from "../scripts/lib/free-tcp-port.mjs";

const processesEndingWith = (suffix) => spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout
  .split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2].endsWith(suffix) ? [Number(match[1])] : [];
  });

const processesStartingWith = (prefix) => spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout
  .split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2].startsWith(prefix) ? [Number(match[1])] : [];
  });

const stopRecorded = (file, suffix) => {
  if (!fs.existsSync(file)) return;
  const pid = Number(fs.readFileSync(file, "utf8"));
  const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout.trim();
  if (pid > 1 && command.endsWith(suffix)) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
};

const importFixture = (scratch) => {
  const entry = path.join(scratch, "entry.mjs");
  const helper = path.join(scratch, "helper.mjs");
  const pidFile = path.join(scratch, "helper.pid");
  fs.writeFileSync(helper, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  fs.writeFileSync(entry, `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(helper)}], { detached: true, stdio: "ignore" }).unref();\n`);
  return { entry, helper, pidFile };
};

const ready = (child) => Promise.race([
  once(child.stdout, "data"),
  once(child, "exit").then(() => { throw new Error("The fixture exited before it was ready."); }),
]);

const waitFor = async (check) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "the fixture did not start");
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test("cleanup stops a child that immediately detaches and reparents without a listener", { timeout: 20000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-detach-"));
  const binary = path.join(scratch, "process-probe");
  const pidFile = path.join(scratch, "detached.pid");
  const source = fileURLToPath(new URL("./fixtures/process-probe.c", import.meta.url));
  const built = spawnSync("cc", ["-O2", source, "-o", binary], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const entries = () => processesEndingWith(`${binary} immediate-detach`);
  const child = spawnContained(binary, ["immediate-detach"], {
    env: { ...process.env, FIXTURE_PID_FILE: pidFile }, stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await ready(child);
    await stopChild(child, 100);
    assert.deepEqual(entries(), [], "the detached child survived cleanup");
  } finally {
    await stopChild(child, 0);
    stopRecorded(pidFile, `${binary} immediate-detach`);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("cleanup stops descendants of the inline import recorder", { timeout: 20000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fixture-imports-"));
  const { entry, helper, pidFile } = importFixture(scratch);
  const imports = new URL("../scripts/lib/local-imports.mjs", import.meta.url).href;
  const program = `const { localImportsOf } = await import(${JSON.stringify(imports)});
localImportsOf(${JSON.stringify(entry)}, ${JSON.stringify(scratch)});
console.log("ready"); setInterval(() => {}, 1000);`;
  const child = spawnContained(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await ready(child);
    await waitFor(() => processesEndingWith(helper).length > 0);
    await stopChild(child, 100);
    assert.deepEqual(processesEndingWith(helper), []);
  } finally {
    await stopChild(child, 0);
    stopRecorded(pidFile, helper);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

for (const mode of ["normal exit", "explicit exit", "killed owner"]) {
  test(`run cleanup stops a directly started import recorder's descendants after ${mode}`, { timeout: 20000 }, async () => {
    const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fixture-direct-imports-"));
    const { entry, helper, pidFile } = importFixture(scratch);
    const run = new URL("../scripts/lib/fixture-run.mjs", import.meta.url).href;
    const imports = new URL("../scripts/lib/local-imports.mjs", import.meta.url).href;
    const program = `import { existsSync } from "node:fs";
await import(${JSON.stringify(run)});
const { localImportsOf } = await import(${JSON.stringify(imports)});
localImportsOf(${JSON.stringify(entry)}, ${JSON.stringify(scratch)});
while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((resolve) => setImmediate(resolve));
console.log("ready");
${mode === "explicit exit" ? "process.exit(0);" : mode === "killed owner" ? "setInterval(() => {}, 1000);" : ""}`;
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => key !== "ROO_FIXTURE_RUN" && !key.startsWith("ROO_FIXTURE_SCOPE_")));
    const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
      env, stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = once(child, "exit");
    const ready = once(child.stdout, "data");
    try {
      await ready;
      if (mode === "killed owner") child.kill("SIGKILL");
      const [code, signal] = await exited;
      if (mode === "killed owner") assert.equal(signal, "SIGKILL");
      else assert.equal(code, 0);
      assert.equal(fs.existsSync(pidFile), true);
      await waitFor(() => processesEndingWith(helper).length === 0);
      assert.deepEqual(processesEndingWith(helper), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      stopRecorded(pidFile, helper);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
}

test("run cleanup stops the rehearsal's PostgreSQL after its owner is killed", { timeout: 30000 }, async () => {
  const pgBin = process.env.PG_BIN || spawnSync("pg_config", ["--bindir"], { encoding: "utf8" }).stdout.trim();
  const pgLib = spawnSync(path.join(pgBin, "pg_config"), ["--libdir"], { encoding: "utf8" }).stdout.trim();
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "fixture-rehearsal-"));
  const input = path.join(scratch, "input");
  const output = path.join(scratch, "output");
  const release = path.join(scratch, "release");
  const sunshine = path.join(scratch, "sunshine");
  for (const directory of [input, output, release, sunshine]) fs.mkdirSync(directory);
  const files = {
    "hosted-full-catalog.sql": "", "hosted-full-catalog.raw.json": '{"rows":[{"catalog":{}}]}',
    "ledger-statements.raw.json": '{"rows":[]}', "stub.sql": "select pg_sleep(60);",
    "local-branch.json": "{}", "hosted-alignment-extra.raw.json": "{}",
    "tourney-state.raw.json": '{"rows":[{"state":{}}]}', "missing-capture-read-only.sql": "",
    "commerce-preimage.json": "{}",
  };
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(input, name), contents);
  const port = await freeTcpPort("127.0.0.1");
  const rehearsal = fileURLToPath(new URL("../scripts/test-hosted-alignment-rehearsal.py", import.meta.url));
  const root = fileURLToPath(new URL("..", import.meta.url));
  const args = [rehearsal, "--input-dir", input, "--output-dir", output, "--release-dir", release,
    "--pg-bin", pgBin, "--pg-library-dir", pgLib, "--port", String(port), "--sunshine-migrations-dir", sunshine,
    "--commerce-preimage", path.join(input, "commerce-preimage.json"), "--repo", root];
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key !== "ROO_FIXTURE_RUN" && !key.startsWith("ROO_FIXTURE_SCOPE_")));
  const owner = spawn("python3", args, {
    env, stdio: ["ignore", "pipe", "inherit"],
  });
  let data;
  try {
    await ready(owner);
    data = path.join(fs.readFileSync(path.join(output, "alignment-latest-path"), "utf8").trim(), "pgdata");
    const postgres = `${path.join(pgBin, "postgres")} -D ${data}`;
    assert.ok(processesStartingWith(postgres).length > 0);
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    await waitFor(() => processesStartingWith(postgres).length === 0);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    const latest = path.join(output, "alignment-latest-path");
    if (!data && fs.existsSync(latest)) data = path.join(fs.readFileSync(latest, "utf8").trim(), "pgdata");
    if (data && fs.existsSync(data)) {
      spawnSync(path.join(pgBin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    }
    await releaseTcpPorts("127.0.0.1", [port]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("cleanup stops PostgreSQL started through pg_ctl", { timeout: 30000 }, async () => {
  const pgBin = process.env.PG_BIN || spawnSync("pg_config", ["--bindir"], { encoding: "utf8" }).stdout.trim();
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "fixture-pgctl-"));
  const data = path.join(scratch, "data");
  const port = await freeTcpPort("127.0.0.1");
  const ctl = path.join(pgBin, "pg_ctl");
  const entries = () => processesStartingWith(`${path.join(pgBin, "postgres")} -D ${data}`);
  let child;
  try {
    const init = spawnSync(path.join(pgBin, "initdb"), ["-D", data, "--auth=trust", "--no-locale"], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    });
    assert.equal(init.status, 0, init.stderr);
    const args = ["-D", data, "-o", `-k ${scratch} -c listen_addresses='' -p ${port}`,
      "-l", path.join(scratch, "postgres.log"), "-w", "start"];
    const program = `require("node:child_process").execFileSync(${JSON.stringify(ctl)}, ${JSON.stringify(args)},
      { stdio: "ignore" }); console.log("ready"); setInterval(() => {}, 1000);`;
    child = spawnContained(process.execPath, ["-e", program], {
      env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "inherit"],
    });
    await ready(child);
    assert.ok(entries().length > 0);
    await stopChild(child, 100);
    assert.deepEqual(entries(), []);
  } finally {
    if (child) await stopChild(child, 0);
    await releaseTcpPorts("127.0.0.1", [port]);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
