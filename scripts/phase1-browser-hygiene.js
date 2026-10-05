/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APPLY = process.env.APPLY_CLEANUP === "1";
const ownershipPath = process.env.BROWSER_CLEANUP_OWNERSHIP;
const runId = process.env.BROWSER_RUN_ID || "";
let ownership = null;
try {
  const candidate = JSON.parse(fs.readFileSync(ownershipPath, "utf8"));
  const expectedProfile = `/tmp/roo-tooling-${runId}`;
  if (candidate.version === 1 && candidate.runId === runId &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(runId) && candidate.profile === expectedProfile &&
      fs.realpathSync(candidate.profile) === expectedProfile && Array.isArray(candidate.processes)) {
    ownership = candidate;
  }
} catch {}

const readProcess = (pid) => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const profileArg = args.find(arg => arg.startsWith("--user-data-dir="));
    return { startTime, profile: profileArg?.slice("--user-data-dir=".length) || "" };
  } catch { return null; }
};

const isOwned = (pid, profile) => {
  if (!ownership || profile !== ownership.profile || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const saved = ownership.processes.find(item => item.pid === pid);
  const live = readProcess(pid);
  return Boolean(saved && /^\d+$/.test(saved.startTime) && live &&
    live.startTime === saved.startTime && live.profile === ownership.profile);
};

const run = (cmd) => {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
};

const parseUserDataDir = (cmd) => {
  const match = cmd.match(/--user-data-dir=([^\s]+)/);
  return match ? match[1] : "";
};

const collectRows = () => {
  const out = run("ps -Ao pid,ppid,command | rg -i 'Google Chrome|Chrome Helper|chromium' | rg -v 'rg -i'");
  const lines = out ? out.split("\n") : [];
  return lines.map((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    const userDataDir = parseUserDataDir(command);
    const isMainProfile = !ownership || userDataDir !== ownership.profile;
    const automationOwned = isOwned(pid, userDataDir);
    const eligibleCleanup = automationOwned;
    return {
      pid,
      ppid,
      user_data_dir: userDataDir,
      automation_owned: automationOwned,
      main_profile: isMainProfile,
      eligible_cleanup: eligibleCleanup,
      command,
    };
  }).filter(Boolean);
};

const toCsv = (rows) => {
  const headers = [
    "pid",
    "ppid",
    "user_data_dir",
    "automation_owned",
    "main_profile",
    "eligible_cleanup",
    "command",
  ];
  const esc = (v) => {
    const raw = String(v ?? "");
    if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
      return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
  };
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((h) => esc(row[h])).join(","))
    .join("\n")}\n`;
};

const auditDir = path.join(process.cwd(), "audit");
fs.mkdirSync(auditDir, { recursive: true });

const preRows = collectRows();
fs.writeFileSync(path.join(auditDir, "phase1-browser-process-pre.csv"), toCsv(preRows));

const killed = [];
if (APPLY) {
  preRows
    .filter((row) => row.eligible_cleanup)
    .forEach((row) => {
      try {
        if (!isOwned(row.pid, row.user_data_dir)) return;
        process.kill(row.pid, "SIGTERM");
        killed.push(row.pid);
      } catch {}
    });
}

const postRows = collectRows();
fs.writeFileSync(path.join(auditDir, "phase1-browser-process-post.csv"), toCsv(postRows));

console.log(
  `[phase1-browser-hygiene] pre=${preRows.length} post=${postRows.length} killed=${killed.length} apply=${APPLY}`
);
