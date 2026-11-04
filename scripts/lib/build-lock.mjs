import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const inUse = 75;
const holder = fileURLToPath(new URL("./build-lock-holder.cjs", import.meta.url));

const flock = (fd, options) => {
  const result = spawnSync("flock", [...options, "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("Build directory locks need util-linux flock on PATH.");
  if (result.error) throw result.error;
  return result;
};

const lockSlot = (candidate) => {
  fs.mkdirSync(candidate, { recursive: true });
  const gate = fs.openSync(path.dirname(path.resolve(candidate)), "r");
  try {
    if (flock(gate, ["--exclusive", "--wait", "30"]).status !== 0) throw new Error(`Could not take the lock gate for ${candidate}.`);
    const fd = fs.openSync(candidate, "r");
    const probe = flock(fd, ["--exclusive", "--nonblock", "--conflict-exit-code", String(inUse)]);
    if (probe.status === 0 && flock(fd, ["--shared", "--nonblock"]).status === 0) return fd;
    fs.closeSync(fd);
    if (probe.status !== inUse) throw new Error(`flock could not lock ${candidate}: ${probe.stderr}`);
    return null;
  } finally {
    fs.closeSync(gate);
  }
};

export const lockBuildDirectory = (dir, { slots = 1 } = {}) => {
  if (process.platform !== "linux") throw new Error("Build directory locks need Linux flock(2).");
  for (let slot = 1; slot <= slots; slot += 1) {
    const candidate = slot === 1 ? dir : `${dir}-${slot}`;
    const fd = lockSlot(candidate);
    if (fd === null) continue;
    const resolved = path.resolve(candidate);
    return {
      dir: candidate,
      fd,
      childEnv: (env) => ({ ...env, ROO_BUILD_LOCK: resolved, NODE_OPTIONS: `${env.NODE_OPTIONS || ""} --require=${holder}`.trim() }),
      release: () => fs.closeSync(fd),
    };
  }
  throw Object.assign(new Error(`${dir} is in use by another run.`), { code: "ELOCKED" });
};
