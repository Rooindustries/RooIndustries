import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { lockBuildDirectory } from "../scripts/lib/build-lock.mjs";

const library = JSON.stringify(new URL("../scripts/lib/build-lock.mjs", import.meta.url).href);
const scratchDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "roo-build-lock-")), ".next-e2e-lock");
const groupAlive = (group) => {
  try {
    process.kill(-group, 0);
    return true;
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
const wrapper = (dir, body) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { spawn } from "node:child_process";
const { lockBuildDirectory } = await import(${library});
const lock = await lockBuildDirectory(${JSON.stringify(dir)});
${body}`], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")));
  return { child, lines };
};
const startBuilder = `const builder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
lock.track(builder);
console.log(builder.pid);`;

test("a locked build directory is refused to other runs and offered as the next slot", async () => {
  const dir = scratchDir();
  const { child, lines } = wrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);');
  try {
    await waitFor(() => lines.includes("locked"));
    await assert.rejects(lockBuildDirectory(dir), { code: "ELOCKED" });
    const next = await lockBuildDirectory(dir, { slots: 3 });
    assert.equal(next.dir, `${dir}-2`);
    await next.release();
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
  const reclaimed = await lockBuildDirectory(dir);
  await reclaimed.release();
});

test("the lock stays held while a killed wrapper's builders still run", async () => {
  const dir = scratchDir();
  const { child, lines } = wrapper(dir, `${startBuilder}\nsetInterval(() => {}, 1000);`);
  await waitFor(() => lines.length > 0);
  const builder = Number(lines[0]);
  child.kill("SIGKILL");
  await once(child, "exit");
  try {
    assert.ok(groupAlive(builder));
    await assert.rejects(lockBuildDirectory(dir), { code: "ELOCKED" });
  } finally {
    process.kill(-builder, "SIGKILL");
  }
  await waitFor(() => !groupAlive(builder));
  const reclaimed = await lockBuildDirectory(dir);
  await reclaimed.release();
});

test("a wrapper that exits takes its builders with it", async () => {
  const dir = scratchDir();
  const { child, lines } = wrapper(dir, `${startBuilder}\nsetTimeout(() => process.exit(0), 200);`);
  await waitFor(() => lines.length > 0);
  await once(child, "exit");
  await waitFor(() => !groupAlive(Number(lines[0])));
  const reclaimed = await lockBuildDirectory(dir);
  await reclaimed.release();
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
    assert.ok(groupAlive(next));
    await assert.rejects(lockBuildDirectory(dist), { code: "ELOCKED" });
  } finally {
    if (next) {
      try { process.kill(-next, "SIGKILL"); } catch {}
      await waitFor(() => !groupAlive(next));
    }
  }
  const reclaimed = await lockBuildDirectory(dist);
  await reclaimed.release();
  for (const entry of [dist, `${dist}.lock`, scratch]) fs.rmSync(entry, { recursive: true, force: true });
});
