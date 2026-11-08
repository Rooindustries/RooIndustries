const fs = require("node:fs");
const path = require("node:path");
const { spawnSync, lockScript } = require("./fixture-tool-policy.cjs");

const inUse = 75;

const flock = (fd, { shared = false, nonblock = false, wait = null, conflictExitCode = 1 }) => {
  const args = [
    "-e", lockScript,
    shared ? "1" : "0", nonblock ? "1" : "0", String(wait === null ? "" : Math.ceil(wait)), String(conflictExitCode),
  ];
  const env = { ...process.env, LC_ALL: "C" };
  for (const name of ["PERL5OPT", "PERL5LIB", "PERLLIB", "PERL5DB"]) delete env[name];
  const result = spawnSync("perl", args, {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf8",
    env,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Build directory locks need perl on PATH.");
  }
  if (result.error) throw result.error;
  return result;
};

const recordOf = (dir) => `${path.resolve(dir)}.build-lock`;

const withGate = (dir, use) => {
  const gate = fs.openSync(path.dirname(path.resolve(dir)), "r");
  try {
    const taken = flock(gate, { wait: 30 });
    if (taken.status !== 0) {
      const why = taken.stderr.trim() || "another process held it for 30 seconds";
      throw new Error(`Could not take the lock gate for ${dir}: ${why}.`);
    }
    return use();
  } finally {
    fs.closeSync(gate);
  }
};

module.exports = { flock, inUse, recordOf, withGate };
