import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { lockBuildDirectory } from "../scripts/lib/build-lock.mjs";

const library = new URL("../scripts/lib/build-lock.mjs", import.meta.url).href;
const cleanup = [];
after(() => {
  for (const entry of cleanup) fs.rmSync(entry, { recursive: true, force: true });
});
const scratchRoot = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(root);
  return root;
};
const scratchDir = () => path.join(scratchRoot("roo-build-lock-"), ".next-e2e-lock");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stat = (pid) => {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) };
  } catch {
    return null;
  }
};
const alive = (pid) => {
  const current = stat(pid);
  return current !== null && current.state !== "Z";
};
const processes = () => fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map((name) => [Number(name), stat(name)]).filter(([, current]) => current);
const descendants = (root) => {
  const parents = new Map(processes().map(([pid, current]) => [pid, current.parent]));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return [...tree].filter(alive);
};
const commandOf = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
};
const waitFor = async (check, timeout = 10000, exitedEarly = () => false) => {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(!exitedEarly(), "the process under test exited early");
    assert.ok(Date.now() < deadline, "timed out");
    await pause(25);
  }
};
const killAll = (pids) => {
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
};
const stopTree = async (roots, group) => {
  const known = new Set(roots);
  const deadline = Date.now() + 10000;
  for (;;) {
    for (const pid of [...known]) for (const member of descendants(pid)) known.add(member);
    for (const [pid, current] of processes()) if (current.group === group) known.add(pid);
    const living = [...known].filter(alive);
    if (!living.length) return;
    killAll(living);
    assert.ok(Date.now() < deadline, `could not stop ${living.map(commandOf).join(", ")}`);
    await pause(25);
  }
};
const runWrapper = (dir, body, { command = [process.execPath], from = library } = {}) => {
  const child = spawn(command[0], [...command.slice(1), "--input-type=module", "-e", `import { spawn } from "node:child_process";
const { lockBuildDirectory } = await import(${JSON.stringify(from)});
const lock = lockBuildDirectory(${JSON.stringify(dir)});
${body}`], { stdio: ["ignore", "pipe", "inherit"], detached: true });
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const pidOf = (label) => Number(lines.find((line) => line.startsWith(`${label} `))?.split(" ")[1]);
  return { child, lines, exited, pidOf, ended: () => child.exitCode !== null || child.signalCode !== null, stop: () => stopTree([child.pid], child.pid) };
};
const startBuilder = `const builder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore", lock.fd] });
console.log(builder.pid);`;
const refused = (dir) => {
  assert.throws(() => lockBuildDirectory(dir), { code: "ELOCKED" });
};
const reclaim = (dir) => lockBuildDirectory(dir).release();
const neverAcquirableWhileAlive = async (dir, pids) => {
  for (let check = 0; check < 10; check += 1) {
    let lock;
    try {
      lock = lockBuildDirectory(dir);
    } catch (error) {
      assert.equal(error.code, "ELOCKED");
      await pause(50);
      continue;
    }
    const living = pids.filter(alive);
    lock.release();
    assert.deepEqual(living, [], `the directory was acquired while ${living.map(commandOf).join(", ")} still ran`);
    return;
  }
};
const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

test("a locked build directory is refused to other runs and offered as the next slot", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);');
  try {
    await waitFor(() => wrapper.lines.includes("locked"), 10000, wrapper.ended);
    refused(dir);
    const next = lockBuildDirectory(dir, { slots: 3 });
    assert.equal(next.dir, `${dir}-2`);
    next.release();
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("a run in another network namespace cannot take the same directory", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);', { command: ["unshare", "--user", "--map-root-user", "--net", process.execPath] });
  try {
    await waitFor(() => wrapper.lines.includes("locked"), 10000, wrapper.ended);
    refused(dir);
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("a builder holds the lock from the moment it is spawned, even if its wrapper is killed at once", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, `${startBuilder}\nprocess.kill(process.pid, "SIGKILL");`);
  try {
    await wrapper.exited;
    assert.ok(alive(Number(wrapper.lines[0])));
    refused(dir);
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("deleting files beside the directory never frees a lock that a builder holds", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, `${startBuilder}\nsetInterval(() => {}, 1000);`);
  try {
    await waitFor(() => wrapper.lines.length > 0, 10000, wrapper.ended);
    wrapper.child.kill("SIGKILL");
    await wrapper.exited;
    for (const entry of fs.readdirSync(path.dirname(dir))) if (entry !== path.basename(dir)) fs.rmSync(path.join(path.dirname(dir), entry), { recursive: true, force: true });
    refused(dir);
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("a wrapper that exits never signals its builder, which keeps the lock until it ends", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, `${startBuilder}\nsetTimeout(() => process.exit(0), 100);`);
  try {
    await wrapper.exited;
    await pause(200);
    assert.ok(alive(Number(wrapper.lines[0])));
    refused(dir);
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("the next owner replaces the token record, so processes carrying the earlier token are refused", () => {
  const dir = scratchDir();
  const joinBuild = (env) => spawnSync(process.execPath, ["-e", ""], { env, encoding: "utf8", timeout: 30000 });
  const first = lockBuildDirectory(dir);
  const earlier = first.childEnv({ PATH: process.env.PATH });
  first.release();
  fs.writeFileSync(`${dir}.build-lock`, "left by an earlier run");
  const second = lockBuildDirectory(dir);
  try {
    const current = second.childEnv({ PATH: process.env.PATH });
    assert.equal(fs.readFileSync(`${dir}.build-lock`, "utf8"), current.ROO_BUILD_LOCK_TOKEN);
    assert.notEqual(current.ROO_BUILD_LOCK_TOKEN, earlier.ROO_BUILD_LOCK_TOKEN);
    const stale = joinBuild(earlier);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /belongs to another run/);
    const joined = joinBuild(current);
    assert.equal(joined.status, 0, joined.stderr);
  } finally {
    second.release();
  }
});

test("a former owner exiting never frees the lock of the run after it", async () => {
  const dir = scratchDir();
  const former = runWrapper(dir, 'lock.release();\nprocess.on("SIGTERM", () => process.exit(0));\nconsole.log("released");\nsetInterval(() => {}, 1000);');
  let current;
  try {
    await waitFor(() => former.lines.includes("released"), 10000, former.ended);
    current = runWrapper(dir, `${startBuilder}\nsetInterval(() => {}, 1000);`);
    await waitFor(() => current.lines.length > 0, 10000, current.ended);
    former.child.kill("SIGTERM");
    await former.exited;
    current.child.kill("SIGKILL");
    await current.exited;
    refused(dir);
  } finally {
    await former.stop();
    await current?.stop();
  }
  reclaim(dir);
});

test("the lock refuses to run without Linux and util-linux flock", () => {
  const dir = scratchDir();
  const attempt = (prelude, env) => spawnSync(process.execPath, ["--input-type=module", "-e", `${prelude}
const { lockBuildDirectory } = await import(${JSON.stringify(library)});
lockBuildDirectory(${JSON.stringify(dir)});`], { encoding: "utf8", env: { ...process.env, ...env } });
  const otherPlatform = attempt('Object.defineProperty(process, "platform", { value: "darwin" });', {});
  assert.notEqual(otherPlatform.status, 0);
  assert.match(otherPlatform.stderr, /need Linux flock/);
  const noFlock = attempt("", { PATH: scratchRoot("roo-no-flock-") });
  assert.notEqual(noFlock.status, 0);
  assert.match(noFlock.stderr, /need util-linux flock/);
});

const startCli = (cli) => `const cli = spawn(process.execPath, ["-e", ${JSON.stringify(cli)}], { env: lock.childEnv(process.env), stdio: ["ignore", "inherit", "inherit", lock.fd] });
cli.once("exit", (code, signal) => console.log("cli-exit " + (signal || code)));
console.log("cli " + cli.pid);
setInterval(() => {}, 1000);`;
const workerCli = (workerCode, workerEnv = "process.env") => `const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerCode)}], { env: ${workerEnv}, stdio: ["ignore", "ignore", "inherit", "ipc"] });
console.log("worker " + worker.pid);
setInterval(() => {}, 1000);`;
const cliStopped = (wrapper) => () => wrapper.ended() || wrapper.lines.some((line) => line.startsWith("cli-exit "));

const outlivingWorker = async (from) => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, startCli(workerCli("process.on('disconnect', () => {}); setInterval(() => {}, 1000)")), { from });
  try {
    await waitFor(() => wrapper.lines.some((line) => line.startsWith("worker ")), 10000, cliStopped(wrapper));
    const tree = [wrapper.child.pid, wrapper.pidOf("cli"), wrapper.pidOf("worker")];
    for (const pid of tree) {
      killAll([pid]);
      await waitFor(() => !alive(pid));
      await neverAcquirableWhileAlive(dir, tree);
    }
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
};

test("a forked worker that outlives its wrapper and its parent keeps the directory locked", async () => {
  await outlivingWorker(library);
});

test("a checkout path with spaces still locks every Node process of the build", async () => {
  const checkout = path.join(scratchRoot("roo build lock "), "checkout with \"quotes\" and spaces");
  fs.cpSync(new URL("../scripts/lib", import.meta.url), path.join(checkout, "scripts", "lib"), { recursive: true });
  await outlivingWorker(pathToFileURL(path.join(checkout, "scripts", "lib", "build-lock.mjs")).href);
});

test("a worker paused before its preload never joins a run that started after its own run ended", async () => {
  const dir = scratchDir();
  const scratch = scratchRoot("roo-build-lock-pause-");
  const [paused, go, ran, pauser] = ["paused", "go", "ran", "pause.cjs"].map((name) => path.join(scratch, name));
  fs.writeFileSync(pauser, `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(paused)}, "");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);`);
  const workerEnv = `{ ...process.env, NODE_OPTIONS: ${JSON.stringify(`--require ${JSON.stringify(pauser)} `)} + process.env.NODE_OPTIONS }`;
  const wrapper = runWrapper(dir, startCli(workerCli(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, ""); setInterval(() => {}, 1000)`, workerEnv)));
  let next;
  try {
    await waitFor(() => fs.existsSync(paused) && wrapper.lines.some((line) => line.startsWith("worker ")), 10000, cliStopped(wrapper));
    const ancestors = [wrapper.child.pid, wrapper.pidOf("cli")];
    const worker = wrapper.pidOf("worker");
    killAll(ancestors);
    await waitFor(() => !ancestors.some(alive));
    next = lockBuildDirectory(dir);
    fs.writeFileSync(go, "");
    await waitFor(() => fs.existsSync(ran) || !alive(worker));
    assert.equal(fs.existsSync(ran), false, "the orphaned worker ran inside the build of the next run");
  } finally {
    next?.release();
    await wrapper.stop();
  }
  reclaim(dir);
});

test("the UI sweep build directory stays locked while the wrapper, next dev or its server still runs", { timeout: 120000 }, async () => {
  const dist = `.next-e2e-lock-ui-${process.pid}`;
  cleanup.push(path.resolve(dist), `${path.resolve(dist)}.build-lock`);
  const scratch = scratchRoot("roo-ui-lock-");
  const nextPort = await freePort();
  const ui = spawn(process.execPath, ["scripts/test-ui-sweep-server.mjs"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { PATH: process.env.PATH, HOME: scratch, ROO_TEST_HOST: "127.0.0.1", UI_PORT: String(await freePort()), UI_NEXT_PORT: String(nextPort), NEXT_DIST_DIR: dist, UI_ARTIFACT: path.join(scratch, "ui.json") },
  });
  const ended = () => ui.exitCode !== null || ui.signalCode !== null;
  let tree = [ui.pid];
  try {
    const answers = () => fetch(`http://127.0.0.1:${nextPort}/`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    const deadline = Date.now() + 90000;
    while (!(await answers())) {
      assert.ok(!ended() && Date.now() < deadline, "next dev never answered");
      await pause(250);
    }
    tree = descendants(ui.pid);
    const cli = tree.find((pid) => commandOf(pid).includes("next/dist/bin/next dev"));
    const servers = tree.filter((pid) => pid !== ui.pid && pid !== cli);
    assert.ok(cli && servers.length, `unexpected tree: ${tree.map(commandOf).join(" | ")}`);
    for (const step of [[ui.pid], [cli], servers]) {
      killAll(step);
      await waitFor(() => !step.some(alive));
      await neverAcquirableWhileAlive(dist, tree);
    }
  } finally {
    await stopTree([ui.pid, ...tree], ui.pid);
  }
  reclaim(dist);
});

test("a production build stays locked while the wrapper, next build or any build worker still runs", { timeout: 300000 }, async () => {
  const dist = `.next-e2e-lock-build-${process.pid}`;
  cleanup.push(path.resolve(dist), `${path.resolve(dist)}.build-lock`);
  const scratch = scratchRoot("roo-build-tree-lock-");
  const port = await freePort();
  const wrapper = spawn(process.execPath, ["scripts/test-tooling-sweep-server.mjs"], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { PATH: process.env.PATH, HOME: scratch, ROO_TEST_HOST: "127.0.0.1", BASE_URL: `http://127.0.0.1:${port}`, PW_PORT: String(port), TOOLING_CONTENT_PORT: String(await freePort()), NEXT_DIST_DIR: dist, ROO_ADMIN_FIXTURE: "0" },
  });
  const ended = () => wrapper.exitCode !== null || wrapper.signalCode !== null;
  let tree = [wrapper.pid];
  try {
    let cli;
    await waitFor(() => {
      cli = descendants(wrapper.pid).find((pid) => commandOf(pid).includes("next/dist/bin/next build"));
      return Boolean(cli) && descendants(cli).length > 1;
    }, 240000, ended);
    tree = descendants(wrapper.pid);
    const workers = descendants(cli).filter((pid) => pid !== cli);
    for (const step of [[wrapper.pid], [cli], workers]) {
      killAll(step);
      await waitFor(() => !step.some(alive));
      await neverAcquirableWhileAlive(dist, tree);
    }
  } finally {
    await stopTree([wrapper.pid, ...tree], wrapper.pid);
  }
  reclaim(dist);
});
