import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { lockBuildDirectory } from "../scripts/lib/build-lock.mjs";

const library = JSON.stringify(new URL("../scripts/lib/build-lock.mjs", import.meta.url).href);
const scratchDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roo-build-lock-")), ".next-e2e-lock");
const alive = (pid) => {
  try {
    return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z");
  } catch {
    return false;
  }
};
const waitFor = async (check, timeout = 10000) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const runWrapper = (dir, body, command = [process.execPath]) => {
  const child = spawn(command[0], [...command.slice(1), "--input-type=module", "-e", `import { spawn } from "node:child_process";
const { lockBuildDirectory } = await import(${library});
const lock = await lockBuildDirectory(${JSON.stringify(dir)});
${body}`], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")));
  return { child, lines };
};
const startBuilder = `const builder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", lock.fd] });
console.log(builder.pid);`;
const refused = async (dir) => {
  await assert.rejects(async () => await lockBuildDirectory(dir), { code: "ELOCKED" });
};
const reclaim = async (dir) => (await lockBuildDirectory(dir)).release();

test("a locked build directory is refused to other runs and offered as the next slot", async () => {
  const dir = scratchDir();
  const { child, lines } = runWrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);');
  try {
    await waitFor(() => lines.includes("locked"));
    await refused(dir);
    const next = await lockBuildDirectory(dir, { slots: 3 });
    assert.equal(next.dir, `${dir}-2`);
    await next.release();
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  await reclaim(dir);
});

test("a run in another network namespace cannot take the same directory", async () => {
  const dir = scratchDir();
  const { child, lines } = runWrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);', ["unshare", "--user", "--map-root-user", "--net", process.execPath]);
  try {
    await waitFor(() => lines.includes("locked"));
    await refused(dir);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  await reclaim(dir);
});

test("a builder holds the lock from the moment it is spawned, even if its wrapper is killed at once", async () => {
  const dir = scratchDir();
  const { child, lines } = runWrapper(dir, `${startBuilder}\nprocess.kill(process.pid, "SIGKILL");`);
  await once(child, "exit");
  const builder = Number(lines[0]);
  try {
    assert.ok(alive(builder));
    await refused(dir);
  } finally {
    process.kill(builder, "SIGKILL");
  }
  await waitFor(() => !alive(builder));
  await reclaim(dir);
});

test("deleting files beside the directory never frees a lock that a builder holds", async () => {
  const dir = scratchDir();
  const { child, lines } = runWrapper(dir, `${startBuilder}\nsetInterval(() => {}, 1000);`);
  await waitFor(() => lines.length > 0);
  const builder = Number(lines[0]);
  child.kill("SIGKILL");
  await once(child, "exit");
  try {
    for (const entry of fs.readdirSync(path.dirname(dir))) if (entry !== path.basename(dir)) fs.rmSync(path.join(path.dirname(dir), entry), { recursive: true, force: true });
    await refused(dir);
  } finally {
    process.kill(builder, "SIGKILL");
  }
  await waitFor(() => !alive(builder));
  await reclaim(dir);
});

test("a wrapper that exits never signals its builder, which keeps the lock until it ends", async () => {
  const dir = scratchDir();
  const { child, lines } = runWrapper(dir, `${startBuilder}\nsetTimeout(() => process.exit(0), 100);`);
  await once(child, "exit");
  const builder = Number(lines[0]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(alive(builder));
    await refused(dir);
  } finally {
    process.kill(builder, "SIGKILL");
  }
  await waitFor(() => !alive(builder));
  await reclaim(dir);
});

test("files and process ids left by an earlier run never block the lock", async () => {
  const dir = scratchDir();
  fs.writeFileSync(`${dir}.lock`, JSON.stringify({ owner: process.pid, groups: [Number(fs.readFileSync("/proc/self/stat", "utf8").split(") ")[1].split(" ")[2])] }));
  await reclaim(dir);
  fs.writeFileSync(`${dir}.lock`, "{not json");
  await reclaim(dir);
});

test("a former owner exiting never frees the lock of the run after it", async () => {
  const dir = scratchDir();
  const former = runWrapper(dir, 'await lock.release();\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log("released");\nsetInterval(() => {}, 1000);');
  await waitFor(() => former.lines.includes("released"));
  const current = runWrapper(dir, `${startBuilder}\nsetInterval(() => {}, 1000);`);
  await waitFor(() => current.lines.length > 0);
  const builder = Number(current.lines[0]);
  former.child.kill("SIGTERM");
  await once(former.child, "exit");
  current.child.kill("SIGKILL");
  await once(current.child, "exit");
  try {
    await refused(dir);
  } finally {
    process.kill(builder, "SIGKILL");
  }
  await waitFor(() => !alive(builder));
  await reclaim(dir);
});

test("the lock refuses to run without Linux and util-linux flock", () => {
  const dir = scratchDir();
  const attempt = (prelude, env) => spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}
const { lockBuildDirectory } = await import(${library});
lockBuildDirectory(${JSON.stringify(dir)});`], { encoding: "utf8", env: { ...process.env, ...env } });
  const otherPlatform = attempt('Object.defineProperty(process, "platform", { value: "darwin" });', {});
  assert.notEqual(otherPlatform.status, 0);
  assert.match(otherPlatform.stderr, /need Linux flock/);
  const noFlock = attempt("", { PATH: path.dirname(process.execPath) });
  assert.notEqual(noFlock.status, 0);
  assert.match(noFlock.stderr, /need util-linux flock/);
});

test("killing the UI sweep wrapper keeps its build directory locked until next dev stops", async () => {
  const free = () => new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const dist = `.next-e2e-lock-ui-${process.pid}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo-ui-lock-"));
  const ui = spawn(process.execPath, ["scripts/test-ui-sweep-server.mjs"], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { PATH: process.env.PATH, HOME: scratch, ROO_TEST_HOST: "127.0.0.1", UI_PORT: String(await free()), UI_NEXT_PORT: String(await free()), NEXT_DIST_DIR: dist, UI_ARTIFACT: path.join(scratch, "ui.json") },
  });
  let output = "";
  ui.stdout.on("data", (chunk) => { output += chunk; });
  let next;
  try {
    await waitFor(() => /"nextPid":(\d+)/.test(output), 30000);
    next = Number(output.match(/"nextPid":(\d+)/)[1]);
    ui.kill("SIGKILL");
    await once(ui, "exit");
    assert.ok(alive(next));
    await refused(dist);
  } finally {
    if (next) {
      process.kill(next, "SIGTERM");
      await waitFor(() => !alive(next), 15000);
    }
  }
  await reclaim(dist);
  for (const entry of [dist, scratch]) fs.rmSync(entry, { recursive: true, force: true });
});
