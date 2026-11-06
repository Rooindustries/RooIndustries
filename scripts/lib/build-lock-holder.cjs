const fs = require("node:fs");
const { flock, recordOf, withGate } = require("./build-lock-gate.cjs");

const join = (dir) => withGate(dir, () => {
  let recorded = null;
  try {
    recorded = fs.readFileSync(recordOf(dir), "utf8");
  } catch {}
  const token = process.env.ROO_BUILD_LOCK_TOKEN;
  if (!token || recorded !== token) return `${dir} now belongs to another run.`;
  const result = flock(fs.openSync(dir, "r"), ["--shared", "--nonblock"]);
  return result.status === 0 ? null : `Could not join the build lock on ${dir}: ${result.stderr}`;
});

const dir = process.env.ROO_BUILD_LOCK;
if (dir) {
  let refusal;
  try {
    refusal = join(dir);
  } catch (error) {
    refusal = `${dir} belongs to no run now: ${error.message}`;
  }
  if (refusal) {
    fs.writeSync(2, `${refusal}\n`);
    process.exit(1);
  }
}
