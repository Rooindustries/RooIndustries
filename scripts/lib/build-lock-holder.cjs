const fs = require("node:fs");
const { flock, inUse, recordOf, withGate } = require("./build-lock-gate.cjs");

const join = (dir) => withGate(dir, () => {
  let recorded = null;
  try {
    recorded = fs.readFileSync(recordOf(dir), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = process.env.ROO_BUILD_LOCK_TOKEN;
  if (!token || recorded === null) return `${dir} belongs to no run now.`;
  if (recorded !== token) return `${dir} now belongs to another run.`;
  const fd = fs.openSync(dir, "r");
  let joined = false;
  try {
    const probe = flock(fd, ["--exclusive", "--nonblock", "--conflict-exit-code", String(inUse)]);
    if (probe.status === 0) return `${dir} belongs to no run now.`;
    if (probe.status !== inUse) return `Could not join the build lock on ${dir}: ${probe.stderr}`;
    const result = flock(fd, ["--shared", "--nonblock"]);
    joined = result.status === 0;
    return joined ? null : `Could not join the build lock on ${dir}: ${result.stderr}`;
  } finally {
    if (!joined) fs.closeSync(fd);
  }
});

const dir = process.env.ROO_BUILD_LOCK;
if (dir) {
  let refusal;
  try {
    refusal = join(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    refusal = `${dir} is gone, so this process belongs to no run: ${error.message}`;
  }
  if (refusal) {
    fs.writeSync(2, `${refusal}\n`);
    process.exit(1);
  }
}
