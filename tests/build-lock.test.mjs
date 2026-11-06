import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockBuildDirectory } from "../scripts/lib/build-lock.mjs";
import { freeTcpPort } from "../scripts/lib/free-tcp-port.mjs";

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
const processes = () => {
  const result = spawnSync("ps", ["-A", "-o", "pid=,stat=,ppid=,pgid="], { encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").map((line) => {
    const [pid, state, parent, group] = line.trim().split(/\s+/);
    return [Number(pid), { state, parent: Number(parent), group: Number(group) }];
  });
};
const stat = (pid) => processes().find(([current]) => current === pid)?.[1] ?? null;
const alive = (pid) => {
  const current = stat(pid);
  return current !== null && !current.state.startsWith("Z");
};
const descendants = (root) => {
  const snapshot = new Map(processes());
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { parent }] of snapshot) {
      if (!tree.has(pid) && tree.has(parent)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return [...tree].filter((pid) => snapshot.has(pid) && !snapshot.get(pid).state.startsWith("Z"));
};
const commandOf = (pid) => spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
const hasCommand = (command) => spawnSync(command, ["--version"], { stdio: "ignore" }).error?.code !== "ENOENT";
const networkNamespaces = hasCommand("unshare");
const containedServers = networkNamespaces && hasCommand("setpriv");
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
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
};
const stopTree = async (roots, group) => {
  const known = new Set(roots);
  const deadline = Date.now() + 10000;
  for (;;) {
    for (const pid of [...known]) {
      for (const member of descendants(pid)) known.add(member);
    }
    for (const [pid, current] of processes()) {
      if (current.group === group) known.add(pid);
    }
    const living = [...known].filter(alive);
    if (!living.length) return;
    killAll(living);
    assert.ok(Date.now() < deadline, `could not stop ${living.map(commandOf).join(", ")}`);
    await pause(25);
  }
};
const runWrapper = (dir, body, { command = [process.execPath], from = library } = {}) => {
  const child = spawn(
    command[0],
    [
      ...command.slice(1),
      "--input-type=module",
      "-e",
      `import { spawn } from "node:child_process";
const { lockBuildDirectory } = await import(${JSON.stringify(from)});
const lock = lockBuildDirectory(${JSON.stringify(dir)});
${body}`,
    ],
    { stdio: ["ignore", "pipe", "inherit"], detached: true },
  );
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(...String(chunk).trim().split("\n")));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const pidOf = (label) => Number(lines.find((line) => line.startsWith(`${label} `))?.split(" ")[1]);
  return {
    child,
    lines,
    exited,
    pidOf,
    ended: () => child.exitCode !== null || child.signalCode !== null,
    stop: () => stopTree([child.pid], child.pid),
  };
};
const startBuilder = `const builder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "ignore", lock.fd],
});
console.log(builder.pid);`;
const refused = (dir) => {
  assert.throws(() => lockBuildDirectory(dir), { code: "ELOCKED" });
};
const reclaim = (dir) => lockBuildDirectory(dir).release();
const joinBuild = (env) => spawnSync(process.execPath, ["-e", ""], { env, encoding: "utf8", timeout: 30000 });
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

test("a run in another network namespace cannot take the same directory", {
  skip: !networkNamespaces && "unshare is not on PATH",
}, async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, 'console.log("locked");\nsetInterval(() => {}, 1000);', {
    command: ["unshare", "--user", "--map-root-user", "--net", process.execPath],
  });
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
    for (const entry of fs.readdirSync(path.dirname(dir)))
      if (entry !== path.basename(dir))
        fs.rmSync(path.join(path.dirname(dir), entry), { recursive: true, force: true });
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

test("a process cannot join a released run whose token record was left behind", () => {
  const dir = scratchDir();
  const lock = lockBuildDirectory(dir);
  const env = lock.childEnv({ PATH: process.env.PATH });
  lock.release();
  fs.writeFileSync(`${dir}.build-lock`, env.ROO_BUILD_LOCK_TOKEN);
  const late = joinBuild(env);
  assert.equal(late.status, 1, `late process exited ${late.status}: ${late.stderr}`);
  assert.match(late.stderr, /belongs to no run now\./);
  reclaim(dir);
});

test("a process can join while only a joined child of its run still holds the directory", async () => {
  const dir = scratchDir();
  const wrapper = runWrapper(dir, `const env = lock.childEnv({ PATH: process.env.PATH });
spawn(process.execPath, ["-e", 'console.log("joined"); setInterval(() => {}, 1000)'], {
  env,
  stdio: ["ignore", "inherit", "inherit"],
});
console.log("env " + JSON.stringify(env));
setInterval(() => {}, 1000);`);
  try {
    await waitFor(() => wrapper.lines.includes("joined"), 10000, wrapper.ended);
    const env = JSON.parse(wrapper.lines.find((line) => line.startsWith("env ")).slice(4));
    wrapper.child.kill("SIGKILL");
    await wrapper.exited;
    refused(dir);
    const joined = joinBuild(env);
    assert.equal(joined.status, 0, joined.stderr);
  } finally {
    await wrapper.stop();
  }
  reclaim(dir);
});

test("a release takes its token record with it, and a process whose run's directory is gone is refused plainly", () => {
  const dir = scratchDir();
  const lock = lockBuildDirectory(dir);
  const env = lock.childEnv({ PATH: process.env.PATH });
  lock.release();
  assert.equal(fs.existsSync(`${dir}.build-lock`), false);
  fs.writeFileSync(`${dir}.build-lock`, env.ROO_BUILD_LOCK_TOKEN);
  fs.rmSync(dir, { recursive: true, force: true });
  const late = spawnSync(process.execPath, ["-e", ""], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /is gone, so this process belongs to no run/);
  assert.doesNotMatch(late.stderr, /\n\s+at /);
});

test("after a release its own later processes belong to no run, and releasing twice is harmless", () => {
  const dir = scratchDir();
  const lock = lockBuildDirectory(dir);
  const env = lock.childEnv({ PATH: process.env.PATH });
  lock.release();
  assert.throws(() => fs.fstatSync(lock.fd), { code: "EBADF" });
  assert.doesNotThrow(() => lock.release());
  const late = spawnSync(process.execPath, ["-e", ""], { env, encoding: "utf8", timeout: 30000 });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /belongs to no run now\./);
});

test("a release never removes the record another run wrote", () => {
  const dir = scratchDir();
  const lock = lockBuildDirectory(dir);
  fs.writeFileSync(`${dir}.build-lock`, "another run's token");
  lock.release();
  assert.equal(fs.readFileSync(`${dir}.build-lock`, "utf8"), "another run's token");
});

test("a former owner exiting never frees the lock of the run after it", async () => {
  const dir = scratchDir();
  const former = runWrapper(
    dir,
    'lock.release();\nprocess.on("SIGTERM", () => process.exit(0));\n' +
      'console.log("released");\nsetInterval(() => {}, 1000);',
  );
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

test("the lock reports a missing perl on PATH", () => {
  const dir = scratchDir();
  const noPerl = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { lockBuildDirectory } = await import(${JSON.stringify(library)});
lockBuildDirectory(${JSON.stringify(dir)}).release();`,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: scratchRoot("roo-no-perl-") } },
  );
  assert.notEqual(noPerl.status, 0);
  assert.match(noPerl.stderr, /need perl on PATH/);
});

test("the lock works without optional Perl modules", () => {
  const dir = scratchDir();
  const bin = scratchRoot("roo-base-perl-");
  const modules = path.join(bin, "modules");
  fs.mkdirSync(path.join(modules, "Time"), { recursive: true });
  fs.writeFileSync(path.join(modules, "Time", "HiRes.pm"), 'die "Time::HiRes is unavailable\\n";');
  const perl = spawnSync("sh", ["-c", "command -v perl"], { encoding: "utf8" });
  assert.equal(perl.status, 0, perl.stderr);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = path.join(bin, "perl");
  const script = `#!/bin/sh\nPERL5LIB=${quote(modules)} exec ${quote(perl.stdout.trim())} "$@"\n`;
  fs.writeFileSync(wrapper, script, { mode: 0o755 });
  const blocked = spawnSync(wrapper, ["-MTime::HiRes", "-e", ""], { encoding: "utf8" });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Time::HiRes is unavailable/);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { lockBuildDirectory } from ${JSON.stringify(library)};
    lockBuildDirectory(${JSON.stringify(dir)}).release();
  `], { encoding: "utf8", env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
});

test("the lock ignores Perl settings and broken locales in its caller", () => {
  const dir = scratchDir();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { lockBuildDirectory } from ${JSON.stringify(library)};
    const lock = lockBuildDirectory(${JSON.stringify(dir)});
    console.log(JSON.stringify(lock.childEnv(process.env)));
    lock.release();
  `], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, LC_ALL: "xx_YY.UTF-8", PERL5OPT: "-Mnonexistent", PERL5LIB: path.dirname(dir) },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, "");
  const late = joinBuild(JSON.parse(child.stdout));
  assert.equal(late.status, 1);
  assert.equal(late.stderr, `${dir} belongs to no run now.\n`);
});

test("the gate keeps its timeout message after a 30 second hold", async (t) => {
  const { flock } = await import("../scripts/lib/build-lock-gate.cjs");
  const dir = scratchDir();
  const fd = fs.openSync(path.dirname(dir), "r");
  try {
    assert.equal(flock(fd, { nonblock: true }).status, 0);
    const message = `Could not take the lock gate for ${dir}: another process held it for 30 seconds.`;
    const started = performance.now();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { withGate } from ${JSON.stringify(new URL("../scripts/lib/build-lock-gate.cjs", import.meta.url).href)};
      try {
        withGate(${JSON.stringify(dir)}, () => {});
      } catch (error) {
        process.stderr.write(error.message + "\\n");
        process.exit(1);
      }
    `], {
      encoding: "utf8",
      timeout: 45000,
      env: { ...process.env, LC_ALL: "xx_YY.UTF-8", PERL5OPT: "-Mnonexistent", PERL5LIB: path.dirname(dir) },
    });
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, `${message}\n`);
    assert.ok(performance.now() - started >= 30000, "the gate returned before its wait expired");
    t.diagnostic(message);
  } finally {
    fs.closeSync(fd);
  }
});

test("a waiting lock times out on conflict and takes the directory after its holder exits", async () => {
  const { flock, inUse } = await import("../scripts/lib/build-lock-gate.cjs");
  const dir = scratchDir();
  const wrapper = runWrapper(dir, 'console.log("locked"); setInterval(() => {}, 1000);');
  let fd, waiter;
  try {
    await waitFor(() => wrapper.lines.includes("locked"), 10000, wrapper.ended);
    fd = fs.openSync(dir, "r");
    assert.equal(flock(fd, { nonblock: true, conflictExitCode: inUse }).status, inUse);
    const immediate = flock(fd, { wait: 0 });
    assert.equal(immediate.status, 1);
    assert.equal(immediate.stderr, "");
    const started = performance.now();
    const timedOut = flock(fd, { wait: 1 });
    assert.equal(timedOut.status, 1);
    assert.equal(timedOut.stderr, "");
    assert.ok(performance.now() - started >= 1000, "the lock returned before its wait expired");
    for (const wait of [0, 1, 1.5]) {
      const started = performance.now();
      const conflict = flock(fd, { wait, conflictExitCode: inUse });
      assert.equal(conflict.status, inUse);
      assert.equal(conflict.stderr, "");
      assert.ok(performance.now() - started >= Math.ceil(wait) * 1000, "the lock returned before its wait expired");
    }
    waiter = spawn(process.execPath, ["--input-type=module", "-e", `
      import { flock } from ${JSON.stringify(new URL("../scripts/lib/build-lock-gate.cjs", import.meta.url).href)};
      console.log("waiting");
      const result = flock(3, { wait: 5 });
      process.stderr.write(result.stderr);
      process.exit(result.status);
    `], { stdio: ["ignore", "pipe", "pipe", fd] });
    let output = "", error = "";
    waiter.stdout.on("data", (chunk) => { output += chunk; });
    waiter.stderr.on("data", (chunk) => { error += chunk; });
    const exited = new Promise((resolve) => waiter.once("exit", resolve));
    await waitFor(() => output.includes("waiting"), 10000, () => waiter.exitCode !== null);
    await wrapper.stop();
    assert.equal(await exited, 0, error);
  } finally {
    if (waiter && alive(waiter.pid)) waiter.kill("SIGKILL");
    if (fd !== undefined) fs.closeSync(fd);
    await wrapper.stop();
  }
});

const startCli = (
  cli,
) => `const cli = spawn(process.execPath, ["-e", ${JSON.stringify(cli)}], {
  env: lock.childEnv(process.env),
  stdio: ["ignore", "inherit", "inherit", lock.fd],
});
cli.once("exit", (code, signal) => console.log("cli-exit " + (signal || code)));
console.log("cli " + cli.pid);
setInterval(() => {}, 1000);`;
const workerCli = (workerCode, workerEnv = "process.env") => `const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerCode)}], {
  env: ${workerEnv},
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
console.log("worker " + worker.pid);
setInterval(() => {}, 1000);`;
const cliStopped = (wrapper) => () => wrapper.ended() || wrapper.lines.some((line) => line.startsWith("cli-exit "));

const outlivingWorker = async (from) => {
  const dir = scratchDir();
  const wrapper = runWrapper(
    dir,
    startCli(workerCli("process.on('disconnect', () => {}); setInterval(() => {}, 1000)")),
    { from },
  );
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
  const checkout = path.join(scratchRoot("roo build lock "), 'checkout with "quotes" and spaces');
  fs.cpSync(new URL("../scripts/lib", import.meta.url), path.join(checkout, "scripts", "lib"), { recursive: true });
  await outlivingWorker(pathToFileURL(path.join(checkout, "scripts", "lib", "build-lock.mjs")).href);
});

test("a server in a checkout path with spaces and quotes loads its guard and build lock in every child", async () => {
  const repo = new URL("../", import.meta.url);
  const checkout = path.join(scratchRoot("roo node options "), 'checkout with "quotes" and spaces');
  fs.cpSync(new URL("scripts/lib", repo), path.join(checkout, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(new URL("next.config.mjs", repo), path.join(checkout, "next.config.mjs"));
  for (const name of ["src", "node_modules"])
    fs.symlinkSync(fileURLToPath(new URL(name, repo)), path.join(checkout, name));
  const lib = (name) => import(pathToFileURL(path.join(checkout, "scripts", "lib", name)).href);
  const [{ withNodeOption }, checkoutLock] = await Promise.all([lib("node-options.mjs"), lib("build-lock.mjs")]);
  const guard = path.join(checkout, "scripts", "lib", "test-target-safety.mjs");
  const dir = scratchDir();
  const lock = checkoutLock.lockBuildDirectory(dir);
  try {
    const serverEnv = withNodeOption(
      {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TOOLING_NETWORK_GUARD: "1",
        BASE_URL: "http://127.0.0.1:9",
        NODE_OPTIONS: "--no-warnings",
      },
      "--import",
      guard,
    );
    assert.equal(withNodeOption(serverEnv, "--import", guard).NODE_OPTIONS, serverEnv.NODE_OPTIONS);
    const outside =
      'fetch("http://outside.fixture.invalid/")' +
      '.then(() => "reached", (error) => String(error.cause?.message ?? error.message))';
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { execFileSync } from "node:child_process";
const grandchild = execFileSync(process.execPath, ["-e", ${JSON.stringify(`${outside}.then(console.log)`)}], {
  encoding: "utf8",
}).trim();
console.log(JSON.stringify({ lock: process.env.ROO_BUILD_LOCK, child: await ${outside}, grandchild }));`,
      ],
      { cwd: checkout, env: lock.childEnv(serverEnv), encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const proof = JSON.parse(child.stdout);
    assert.equal(proof.lock, path.resolve(dir));
    assert.match(proof.child, /\[test-target\]/);
    assert.match(proof.grandchild, /\[test-target\]/);
  } finally {
    lock.release();
  }
});

test("module flags add up once per path and any other flag is refused instead of being skipped", async () => {
  const { appendNodeOption, prependNodeOption, withNodeOption } = await import("../scripts/lib/node-options.mjs");
  const dir = scratchRoot('roo node options "flags" ');
  const preload = (name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `globalThis.loaded = [...(globalThis.loaded ?? []), ${JSON.stringify(name)}];`);
    return file;
  };
  const [first, second, holder, leading] = [
    preload("first one.mjs"),
    preload('second "two".mjs'),
    preload("holder.cjs"),
    preload('leading "0".mjs'),
  ];
  assert.throws(() => appendNodeOption("--title=first --title=second", "--title", "first"), /module-loading flags/);
  assert.throws(() => withNodeOption({ NODE_OPTIONS: "" }, "--loader", first), /module-loading flags/);
  const relativeSecond = `./${path.basename(second)}`;
  const once = withNodeOption(
    { PATH: process.env.PATH, NODE_OPTIONS: '--title=--import="./second \\"two\\".mjs"' },
    "--import",
    first,
    relativeSecond,
    first,
  );
  const ordered = withNodeOption(withNodeOption(once, "--require", holder), "-r", holder);
  const env = { ...ordered, NODE_OPTIONS: prependNodeOption(ordered.NODE_OPTIONS, "--import", leading) };
  assert.match(env.NODE_OPTIONS, /^--import="/);
  const child = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(globalThis.loaded))"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ["holder.cjs", 'leading "0".mjs', "first one.mjs", 'second "two".mjs']);
});

test("the NODE_OPTIONS command line loads a preload from a checkout path with quotes and spaces", () => {
  const checkout = path.join(scratchRoot("roo node options cli "), 'checkout with "quotes" and spaces');
  fs.mkdirSync(path.join(checkout, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(
    new URL("../scripts/lib/node-options.mjs", import.meta.url),
    path.join(checkout, "scripts", "lib", "node-options.mjs"),
  );
  fs.writeFileSync(path.join(checkout, "scripts", "lib", "guard.mjs"), "process.env.ROO_GUARD_LOADED = '1';");
  const script = `set -e
node_options="$(node scripts/lib/node-options.mjs --import "$PWD/scripts/lib/guard.mjs")"
NODE_OPTIONS="$node_options" node -e 'console.log(JSON.stringify({
  guard: process.env.ROO_GUARD_LOADED ?? null,
  options: process.env.NODE_OPTIONS,
}))'`;
  const child = spawnSync("bash", ["-c", script], {
    cwd: checkout,
    env: { PATH: process.env.PATH, NODE_OPTIONS: "--no-warnings" },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  const proof = JSON.parse(child.stdout);
  assert.equal(proof.guard, "1");
  assert.match(proof.options, /^--no-warnings --import=/);
  const refused = spawnSync(
    process.execPath,
    [path.join(checkout, "scripts", "lib", "node-options.mjs"), "--title", "x"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /module-loading flags/);
});

test("a worker paused before its preload never joins a run that started after its own run ended", async () => {
  const dir = scratchDir();
  const scratch = scratchRoot("roo-build-lock-pause-");
  const [paused, go, ran, pauser] = ["paused", "go", "ran", "pause.cjs"].map((name) => path.join(scratch, name));
  fs.writeFileSync(
    pauser,
    `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(paused)}, "");
while (!fs.existsSync(${JSON.stringify(go)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);`,
  );
  const nodeOptions = JSON.stringify(fileURLToPath(new URL("../scripts/lib/node-options.mjs", import.meta.url)));
  const pauserArg = JSON.stringify(pauser);
  const prepend = `require(${nodeOptions})
    .prependNodeOption(process.env.NODE_OPTIONS, "--require", ${pauserArg})`;
  const workerEnv = `{ ...process.env, NODE_OPTIONS: ${prepend} }`;
  const wrapper = runWrapper(
    dir,
    startCli(
      workerCli(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, ""); setInterval(() => {}, 1000)`, workerEnv),
    ),
  );
  let next;
  try {
    await waitFor(
      () => fs.existsSync(paused) && wrapper.lines.some((line) => line.startsWith("worker ")),
      10000,
      cliStopped(wrapper),
    );
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

test(
  "the UI sweep build directory stays locked while the wrapper, next dev or its server still runs",
  { timeout: 120000, skip: !containedServers && "setpriv and unshare are required by the server launcher" },
  async () => {
    const dist = `.next-e2e-lock-ui-${process.pid}`;
    cleanup.push(path.resolve(dist), `${path.resolve(dist)}.build-lock`);
    const scratch = scratchRoot("roo-ui-lock-");
    const nextPort = await freeTcpPort("127.0.0.1");
    const ui = spawn(process.execPath, ["scripts/test-ui-sweep-server.mjs"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        ROO_TEST_HOST: "127.0.0.1",
        UI_PORT: "",
        UI_NEXT_PORT: String(nextPort),
        NEXT_DIST_DIR: dist,
        UI_ARTIFACT: path.join(scratch, "ui.json"),
      },
    });
    const ended = () => ui.exitCode !== null || ui.signalCode !== null;
    let tree = [ui.pid];
    try {
      const answers = () =>
        fetch(`http://127.0.0.1:${nextPort}/`, { signal: AbortSignal.timeout(2000) }).then(
          () => true,
          () => false,
        );
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
  },
);

test(
  "a production build stays locked while the wrapper, next build or any build worker still runs",
  { timeout: 300000, skip: !containedServers && "setpriv and unshare are required by the server launcher" },
  async () => {
    const dist = `.next-e2e-lock-build-${process.pid}`;
    cleanup.push(path.resolve(dist), `${path.resolve(dist)}.build-lock`);
    const scratch = scratchRoot("roo-build-tree-lock-");
    const port = await freeTcpPort("127.0.0.1");
    const wrapper = spawn(process.execPath, ["scripts/test-tooling-sweep-server.mjs"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: {
        PATH: process.env.PATH,
        HOME: scratch,
        ROO_TEST_HOST: "127.0.0.1",
        BASE_URL: `http://127.0.0.1:${port}`,
        PW_PORT: String(port),
        TOOLING_CONTENT_PORT: "",
        NEXT_DIST_DIR: dist,
        ROO_ADMIN_FIXTURE: "0",
      },
    });
    const ended = () => wrapper.exitCode !== null || wrapper.signalCode !== null;
    let tree = [wrapper.pid];
    try {
      let cli;
      await waitFor(
        () => {
          cli = descendants(wrapper.pid).find((pid) => commandOf(pid).includes("next/dist/bin/next build"));
          return Boolean(cli) && descendants(cli).length > 1;
        },
        240000,
        ended,
      );
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
  },
);
