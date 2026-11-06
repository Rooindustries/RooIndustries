const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const inUse = 75;

const lockScript = String.raw`
use strict;
use warnings;
use Fcntl ':flock';
use Errno qw(EAGAIN EWOULDBLOCK);
use Time::HiRes qw(time);
my ($shared, $nonblock, $wait, $conflict) = @ARGV;
open(my $lock, '<&=', 3) or die "Cannot open build lock fd 3: $!\n";
my $mode = $shared ? LOCK_SH : LOCK_EX;
my $waiting = length($wait);
my $deadline = time() + ($waiting ? $wait : 0);
while (!flock($lock, $mode | ($nonblock || $waiting ? LOCK_NB : 0))) {
  die "Cannot take build lock: $!\n" unless $! == EAGAIN || $! == EWOULDBLOCK;
  exit($conflict) if $nonblock;
  if ($waiting && time() >= $deadline) {
    print STDERR "Timed out waiting for the build lock after $wait seconds.\n";
    exit(1);
  }
  select(undef, undef, undef, 0.05);
}
exit(0);
`;

const flock = (fd, { shared = false, nonblock = false, wait = null, conflictExitCode = 1 }) => {
  const args = [
    "perl", "-e", lockScript,
    shared ? "1" : "0", nonblock ? "1" : "0", String(wait ?? ""), String(conflictExitCode),
  ];
  const result = spawnSync("/usr/bin/env", args, { stdio: ["ignore", "ignore", "pipe", fd], encoding: "utf8" });
  if (result.error?.code === "ENOENT" || result.status === 127) {
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
