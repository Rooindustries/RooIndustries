/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-run-context] BASE_URL is required");
  process.exit(1);
}

const run = (cmd) => {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    return `ERROR: ${String(err.message || err)}`;
  }
};

const lockfilePath = path.join(process.cwd(), "package-lock.json");
const lockHash = fs.existsSync(lockfilePath)
  ? run(`shasum -a 256 \"${lockfilePath}\" | awk '{print $1}'`)
  : "missing";

const listening = run(`lsof -nP -iTCP:${new URL(BASE_URL).port || "80"} -sTCP:LISTEN`);

const payload = {
  generatedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  branch: run("git branch --show-current"),
  commit: run("git rev-parse HEAD"),
  node: run("node -v"),
  npm: run("npm -v"),
  timezone: run("date +%Z"),
  localTime: run("date '+%Y-%m-%d %H:%M:%S %z'"),
  lockfileSha256: lockHash,
  playwrightTimezone: process.env.PW_TIMEZONE || "UTC",
  listeningProcess: listening,
};

const auditDir = path.join(process.cwd(), "audit");
fs.mkdirSync(auditDir, { recursive: true });
const out = path.join(auditDir, "phase1-run-context.json");
fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[phase1-run-context] wrote ${out}`);
