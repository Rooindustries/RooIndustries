const path = require("node:path");
const childProcess = require("node:child_process");

const nodePrograms = new Map([
  ["node_modules/next/dist/bin/next", ["build", "dev", "start"]],
  ["dist/start/server.js", [undefined]],
  ["scripts/test-tooling-sweep-server.mjs", [undefined]],
  ["scripts/test-admin-server.mjs", [undefined]],
  ["scripts/test-ui-sweep-server.mjs", [undefined]],
  ["scripts/generate-sitemap.js", [undefined]],
  ["scripts/generate-robots.js", [undefined]],
  ["scripts/validate-runtime-env.js", [undefined]],
  ["scripts/phase1-api-contract.js", [undefined]],
  ["scripts/sourcemaps-e2e.mjs", ["--build"]],
  ["scripts/lib/network-control.mjs", ["https://monitoring-fixture.invalid/", "https://sourcemaps-guard.invalid"]],
  ["tests/fixtures/port-reservation.mjs", ["reserve", "bind-later"]],
]);

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

const sameArgs = (args, expected) => JSON.stringify(args) === JSON.stringify(expected);

const synchronousTools = new Map([
  ["initdb", (args) => args[0] === "-D"],
  ["pg_config", (args) => sameArgs(args, ["--bindir"])],
  ["pg_isready", (args) => args.includes("-h") && args.includes("-p")],
  ["createdb", (args) => args.includes("-h") && args.includes("-p")],
  ["psql", (args) => args.includes("-h") && args.includes("-p")],
  ["git", (args) => ["ls-files", "rev-parse"].includes(args[0]) ||
    (args[0] === "-C" && args[2] === "rev-parse")],
  ["cc", (args) => args.length === 4 && args[0] === "-O2" &&
    ["macos-process-info.c", "linux-subreaper.c"].some((file) => args[1].endsWith(`/scripts/lib/${file}`)) &&
    args[2] === "-o"],
  ["ps", (args) => sameArgs(args, ["-axo", "pid=,ppid=,pgid=,stat=,uid=,command="])],
  ["lsof", (args) => (args.length === 4 && args[0] === "-nP" &&
    /^-iTCP:\d+$/.test(args[1]) && args[2] === "-sTCP:LISTEN" && args[3] === "-Fptn") ||
    (args.length === 6 && args[0] === "-a" && args[1] === "-p" && args[3] === "-d" && args[5] === "-Fn")],
  ["perl", (args) => args[0] === "-e" && args[1] === lockScript],
  ["getconf", (args) => sameArgs(args, ["CLK_TCK"])],
]);

const assertFixtureTool = (command, args, options = {}, synchronous = false) => {
  const name = path.basename(command);
  if (command === process.execPath) {
    const program = path.resolve(options.cwd || process.cwd(), args[0] || "");
    const entry = [...nodePrograms].find(([suffix]) => program.endsWith(`/${suffix}`));
    if (entry && entry[1].includes(args[1])) return;
  } else if (name === "postgres" && (args[0] === "-D" ||
    (synchronous && args.length === 1 && args[0] === "--version"))) {
    return;
  } else if (name === "postgrest" && (!args.length ||
    (synchronous && args.length === 1 && args[0] === "--version"))) {
    return;
  } else if (synchronous && (synchronousTools.get(name)?.(args) ||
    (/^process-info-[a-f0-9]{64}$/.test(name) && !args.length))) {
    return;
  }
  throw new Error(`Fixture command must use a listed foreground mode: ${command} ${args.join(" ")}`);
};

const spawnSync = (command, args, options) => {
  assertFixtureTool(command, args, options, true);
  return childProcess.spawnSync(command, args, options);
};

const execFileSync = (command, args, options) => {
  assertFixtureTool(command, args, options, true);
  return childProcess.execFileSync(command, args, options);
};

module.exports = { assertFixtureTool, spawnSync, execFileSync, lockScript };
