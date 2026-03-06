/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-env-determinism] BASE_URL is required");
  process.exit(1);
}

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim();
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
};

const lockPath = path.join(process.cwd(), "package-lock.json");
const lockHash = fs.existsSync(lockPath)
  ? run(`shasum -a 256 "${lockPath}" | awk '{print $1}'`)
  : "missing";

const content = [
  "# Phase 1 Environment Determinism",
  "",
  `- Generated: ${new Date().toISOString()}`,
  `- Branch: ${run("git branch --show-current")}`,
  `- Commit: ${run("git rev-parse HEAD")}`,
  `- Node: ${run("node -v")}`,
  `- npm: ${run("npm -v")}`,
  `- OS: ${run("uname -a")}`,
  `- Timezone: ${run("date +%Z")} (${run("date '+%Y-%m-%d %H:%M:%S %z'")})`,
  `- package-lock sha256: ${lockHash}`,
  `- BASE_URL: ${BASE_URL}`,
  "",
  "## Deterministic Test Policy",
  "",
  "- Build uses clean `.next` each run.",
  "- Runtime host drift is blocked; artifacts must remain on BASE_URL.",
  "- Playwright configured for `workers=1`, `fullyParallel=false`, and fixed `timezoneId=UTC`.",
  "- Webserver startup uses fixed local loopback URL and fixed port.",
  "- Failure artifacts (trace/screenshot/video) retained on failure.",
  "",
  "## Browser Process Safety",
  "",
  "- Only automation-owned/headless browser processes are terminated in cleanup scripts.",
  "- No broad Chrome kill commands are allowed.",
];

const auditDir = path.join(process.cwd(), "audit");
fs.mkdirSync(auditDir, { recursive: true });
const out = path.join(auditDir, "phase1-env-determinism.md");
fs.writeFileSync(out, `${content.join("\n")}\n`);
console.log(`[phase1-env-determinism] wrote ${out}`);
