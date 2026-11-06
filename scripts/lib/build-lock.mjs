import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { withNodeOption } from "./node-options.mjs";

const { flock, inUse, recordOf, withGate } = createRequire(import.meta.url)("./build-lock-gate.cjs");
const holder = fileURLToPath(new URL("./build-lock-holder.cjs", import.meta.url));

const readRecord = (candidate) => {
  try {
    return fs.readFileSync(recordOf(candidate), "utf8");
  } catch {
    return null;
  }
};

const record = (candidate, token) => {
  const target = recordOf(candidate);
  const pending = `${target}.${process.pid}.${token}`;
  try {
    fs.writeFileSync(pending, token);
    fs.renameSync(pending, target);
  } finally {
    fs.rmSync(pending, { force: true });
  }
};

const lockSlot = (candidate) => {
  fs.mkdirSync(candidate, { recursive: true });
  return withGate(candidate, () => {
    const fd = fs.openSync(candidate, "r");
    try {
      const probe = flock(fd, { nonblock: true, conflictExitCode: inUse });
      const failed = probe.status !== 0 && probe.status !== inUse;
      if (failed) throw new Error(`flock could not lock ${candidate}: ${probe.stderr}`);
      if (probe.status === 0) {
        const shared = flock(fd, { shared: true, nonblock: true });
        if (shared.status !== 0) throw new Error(`flock could not share the lock on ${candidate}: ${shared.stderr}`);
        const token = randomUUID();
        record(candidate, token);
        return { fd, token };
      }
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
    fs.closeSync(fd);
    return null;
  });
};

export const lockBuildDirectory = (dir, { slots = 1 } = {}) => {
  for (let slot = 1; slot <= slots; slot += 1) {
    const candidate = slot === 1 ? dir : `${dir}-${slot}`;
    const slotLock = lockSlot(candidate);
    if (slotLock === null) continue;
    const { fd, token } = slotLock;
    let released = false;
    return {
      dir: candidate,
      fd,
      childEnv: (env) => {
        const locked = { ...env, ROO_BUILD_LOCK: path.resolve(candidate), ROO_BUILD_LOCK_TOKEN: token };
        return withNodeOption(locked, "--require", holder);
      },
      release: () => {
        if (released) return;
        released = true;
        let closed = false;
        try {
          withGate(candidate, () => {
            try {
              if (readRecord(candidate) === token) fs.rmSync(recordOf(candidate), { force: true });
            } finally {
              closed = true;
              fs.closeSync(fd);
            }
          });
        } catch (error) {
          process.stderr.write(`Releasing the build lock on ${candidate} left its record: ${error.message}\n`);
        } finally {
          if (!closed) fs.closeSync(fd);
        }
      },
    };
  }
  throw Object.assign(new Error(`${dir} is in use by another run.`), { code: "ELOCKED" });
};
