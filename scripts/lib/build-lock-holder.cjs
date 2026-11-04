const fs = require("node:fs");
const { flock, recordOf, withGate } = require("./build-lock-gate.cjs");

const dir = process.env.ROO_BUILD_LOCK;
if (dir) {
  const refusal = withGate(dir, () => {
    let recorded = null;
    try {
      recorded = fs.readFileSync(recordOf(dir), "utf8");
    } catch {}
    if (!process.env.ROO_BUILD_LOCK_TOKEN || recorded !== process.env.ROO_BUILD_LOCK_TOKEN) return `${dir} now belongs to another run.`;
    const result = flock(fs.openSync(dir, "r"), ["--shared", "--nonblock"]);
    return result.status === 0 ? null : `Could not join the build lock on ${dir}: ${result.stderr}`;
  });
  if (refusal) {
    fs.writeSync(2, `${refusal}\n`);
    process.exit(1);
  }
}
