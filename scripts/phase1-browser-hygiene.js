/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const APPLY = process.env.APPLY_CLEANUP === "1";
const AUTOMATION_MARKERS = [
  "/tmp/roo-e2e-chrome",
  "/tmp/codex-automation-chrome",
  "/tmp/playwright_chromium",
  "/tmp/playwright-firefox",
  "/tmp/playwright-webkit",
];
const MAIN_PROFILE_MARKER = "/Users/serviroo/Library/Application Support/Google/Chrome";

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
    const firstSpace = trimmed.indexOf(" ");
    const secondSpace = trimmed.indexOf(" ", firstSpace + 1);
    const pid = Number(trimmed.slice(0, firstSpace));
    const ppid = Number(trimmed.slice(firstSpace + 1, secondSpace).trim());
    const command = trimmed.slice(secondSpace + 1);
    const userDataDir = parseUserDataDir(command);
    const isMainProfile = userDataDir.includes(MAIN_PROFILE_MARKER);
    const automationOwned =
      userDataDir &&
      AUTOMATION_MARKERS.some((marker) => userDataDir.includes(marker));
    const eligibleCleanup = automationOwned && !isMainProfile;
    return {
      pid,
      ppid,
      user_data_dir: userDataDir,
      automation_owned: automationOwned,
      main_profile: isMainProfile,
      eligible_cleanup: eligibleCleanup,
      command,
    };
  });
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
