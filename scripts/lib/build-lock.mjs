import fs from "node:fs";
import { spawnSync } from "node:child_process";

const inUse = 75;

export const lockBuildDirectory = (dir, { slots = 1 } = {}) => {
  if (process.platform !== "linux") throw new Error("Build directory locks need Linux flock(2).");
  for (let slot = 1; slot <= slots; slot += 1) {
    const candidate = slot === 1 ? dir : `${dir}-${slot}`;
    fs.mkdirSync(candidate, { recursive: true });
    const fd = fs.openSync(candidate, "r");
    const result = spawnSync("flock", ["--nonblock", "--conflict-exit-code", String(inUse), "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
    if (result.status === 0) return { dir: candidate, fd, release: () => fs.closeSync(fd) };
    fs.closeSync(fd);
    if (result.error?.code === "ENOENT") throw new Error("Build directory locks need util-linux flock on PATH.");
    if (result.status !== inUse) throw new Error(`flock could not lock ${candidate}: ${result.error?.message || result.stderr}`);
  }
  throw Object.assign(new Error(`${dir} is in use by another run.`), { code: "ELOCKED" });
};
