const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const dir = process.env.ROO_BUILD_LOCK;
if (dir) {
  const fd = fs.openSync(dir, "r");
  const result = spawnSync("flock", ["--shared", "--wait", "30", "3"], { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not join the build lock on ${dir}: ${result.error?.message || result.stderr}`);
}
