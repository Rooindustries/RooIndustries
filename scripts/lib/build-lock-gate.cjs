const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const flock = (fd, options) => {
  const result = spawnSync("flock", [...options, "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("Build directory locks need util-linux flock on PATH.");
  if (result.error) throw result.error;
  return result;
};

const recordOf = (dir) => `${path.resolve(dir)}.build-lock`;

const withGate = (dir, use) => {
  const gate = fs.openSync(path.dirname(path.resolve(dir)), "r");
  try {
    const taken = flock(gate, ["--exclusive", "--wait", "30"]);
    if (taken.status !== 0) {
      const why = taken.stderr.trim() || "another process held it for 30 seconds";
      throw new Error(`Could not take the lock gate for ${dir}: ${why}.`);
    }
    return use();
  } finally {
    fs.closeSync(gate);
  }
};

module.exports = { flock, recordOf, withGate };
