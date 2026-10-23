const fs = require("node:fs");
const path = require("node:path");

if (process.env.NAV_RUNNER_FIXTURE === "interrupted") process.exit(1);
const run = fs.existsSync("run-count") ? Number(fs.readFileSync("run-count", "utf8")) + 1 : 1;
fs.writeFileSync("run-count", String(run));
if (process.env.NAV_RUNNER_FIXTURE === "complete") {
  fs.mkdirSync("audit", { recursive: true });
  for (const artifact of ["phase1-nav-reliability", "phase1-client-crash-log", "phase1-hydration-log"]) {
    fs.writeFileSync(path.join("audit", artifact + ".json"), JSON.stringify({ run }));
  }
}
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify({
  stats: { expected: 4, skipped: 0, unexpected: 0, flaky: 0 },
}));
