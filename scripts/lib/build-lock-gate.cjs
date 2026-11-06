const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const inUse = 75;

const lockScript = String.raw`
use strict;
use warnings;
use Fcntl ':flock';
use Errno qw(EAGAIN EWOULDBLOCK);
my ($shared, $nonblock, $wait, $conflict) = @ARGV;
open(my $lock, '<&=', 3) or do {
  print STDERR "Cannot open build lock fd 3: $!\n";
  exit(2);
};
my $mode = $shared ? LOCK_SH : LOCK_EX;
my $immediate = $nonblock || (length($wait) && $wait == 0);
local $SIG{ALRM} = sub { exit(flock($lock, $mode | LOCK_NB) ? 0 : $conflict); };
alarm($wait) if length($wait) && !$immediate;
if (!flock($lock, $mode | ($immediate ? LOCK_NB : 0))) {
  exit($conflict) if $immediate && ($! == EAGAIN || $! == EWOULDBLOCK);
  print STDERR "Cannot take build lock: $!\n";
  exit(2);
}
alarm(0);
exit(0);
`;

const flock = (fd, { shared = false, nonblock = false, wait = null, conflictExitCode = 1 }) => {
  const args = [
    "-e", lockScript,
    shared ? "1" : "0", nonblock ? "1" : "0", String(wait === null ? "" : Math.ceil(wait)), String(conflictExitCode),
  ];
  const result = spawnSync("perl", args, {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf8",
    env: { PATH: process.env.PATH },
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
