import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const prefix = "ROO_FIXTURE_SCOPE_";
const scopes = new WeakMap();
const ticks = process.platform === "linux"
  ? Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout) : 0;
const watching = process.env.ROO_FIXTURE_WATCHER === "1";
const ownsRun = !process.env.ROO_FIXTURE_RUN && !watching;
if (!watching) process.env.ROO_FIXTURE_RUN ||= randomUUID();
const startedAt = () => process.platform === "darwin" ? Date.now() : Math.floor(os.uptime() * ticks) * 1000 / ticks;
const runScope = { run: process.env.ROO_FIXTURE_RUN, startedAt: startedAt() };

export const fixtureScope = (env = process.env) => {
  const name = `${prefix}${randomUUID().replaceAll("-", "")}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith(prefix)));
  return {
    name,
    run: process.env.ROO_FIXTURE_RUN,
    startedAt: startedAt(),
    env: { ...env, ...inherited, ROO_FIXTURE_RUN: process.env.ROO_FIXTURE_RUN, [name]: "1" },
  };
};

export const rememberFixtureScope = (child, scope) => scopes.set(child, scope);
export const scopeOf = (child) => scopes.get(child);

export const markedPids = (scope, pids) => {
  if (!scope) return new Set();
  const marker = scope.name && `${scope.name}=1`;
  const run = `ROO_FIXTURE_RUN=${scope.run}`;
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-E", "-ww", "-axo", "pid=,command="], {
      encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) throw new Error(`Cannot inspect fixture environments: ${result.stderr}`);
    return new Set(result.stdout.split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s/);
      const values = line.split(/\s+/);
      return match && (!marker || values.includes(marker)) && values.includes(run) ? [Number(match[1])] : [];
    }));
  }
  return new Set(pids.filter((pid) => {
    try {
      const values = fs.readFileSync(`/proc/${pid}/environ`).toString().split("\0");
      return (!marker || values.includes(marker)) && values.includes(run);
    } catch (error) {
      if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false;
      throw error;
    }
  }));
};

const linuxIdentity = (pid, scope) => {
  try {
    const dir = `/proc/${pid}`;
    if (fs.statSync(dir).uid !== process.getuid()) return null;
    const stat = fs.readFileSync(`${dir}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || Number(fields[19]) * 1000 / ticks < scope.startedAt ? null : fields[19];
  } catch (error) {
    if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return null;
    throw error;
  }
};

const linuxMembers = (scope) => {
  const entries = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    const start = linuxIdentity(name, scope);
    return start && Number(name) !== process.pid ? [{ pid: Number(name), start }] : [];
  });
  const marked = markedPids(scope, entries.map(({ pid }) => pid));
  return entries.filter(({ pid }) => marked.has(pid));
};

const macIdentities = (scope, pid) => {
  const args = pid ? ["-p", String(pid)] : ["-ax"];
  const result = spawnSync("ps", [...args, "-o", "pid=,uid=,lstart=,stat="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  });
  if (![0, 1].includes(result.status)) throw new Error(`Cannot inspect fixture processes: ${result.stderr}`);
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(\S+)/);
    const start = match && Date.parse(match[3]);
    if (!match || !Number.isFinite(start) || Number(match[1]) === process.pid || Number(match[2]) !== process.getuid() ||
        match[4].startsWith("Z") || start < Math.floor(scope.startedAt / 1000) * 1000) return [];
    return [{ pid: Number(match[1]), start: match[3] }];
  });
};

const macMembers = (scope) => {
  const entries = macIdentities(scope);
  const marked = markedPids(scope, entries.map(({ pid }) => pid));
  return entries.filter(({ pid }) => marked.has(pid));
};

export const drainFixtureScope = async (scope, grace = 1000) => {
  if (!scope) return;
  const signalled = new Map();
  for (;;) {
    const members = process.platform === "darwin" ? macMembers(scope) : linuxMembers(scope);
    if (!members.length) return;
    for (const { pid, start } of members) {
      const key = `${pid}:${start}`;
      const sentAt = signalled.get(key);
      if (sentAt !== undefined && Date.now() - sentAt < grace) continue;
      const identity = process.platform === "darwin" ? macIdentities(scope, pid)[0]?.start : linuxIdentity(pid, scope);
      if (identity !== start || !markedPids(scope, [pid]).has(pid)) continue;
      try { process.kill(pid, sentAt === undefined ? "SIGTERM" : "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
      if (sentAt === undefined) signalled.set(key, Date.now());
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

if (ownsRun) {
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => name !== "ROO_FIXTURE_RUN" && !name.startsWith(prefix)));
  const watcher = spawn(process.execPath, [fileURLToPath(new URL("./fixture-run-watcher.mjs", import.meta.url)),
    JSON.stringify(runScope)], { env: { ...env, ROO_FIXTURE_WATCHER: "1" },
    detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let finishing = false;
  watcher.once("error", (error) => { console.error(error); process.exitCode = 1; });
  watcher.once("exit", (code, signal) => {
    if (!finishing || code !== 0) {
      console.error(`Fixture run watcher exited unexpectedly: ${code ?? signal}.`);
      process.exitCode = 1;
    }
  });
  watcher.stdio[3].unref();
  watcher.unref();
  process.once("beforeExit", () => {
    if (watcher.exitCode !== null || watcher.signalCode !== null) return;
    finishing = true;
    watcher.ref();
    watcher.stdio[3].ref();
    watcher.stdio[3].end();
  });
}
