/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const auditDir = path.join(process.cwd(), "audit");
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-signoff] BASE_URL is required");
  process.exit(1);
}

const run = (cmd) => {
  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (err) {
    return {
      code: typeof err.status === "number" ? err.status : 1,
      output: String(err.stdout || err.stderr || err.message || ""),
    };
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForServer = async (url, timeoutMs = 90000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probe = run(`curl -fsS ${url} > /dev/null`);
    if (probe.code === 0) {
      return true;
    }
    await sleep(1000);
  }
  return false;
};

const runWithServer = async (commands) => {
  let port = 3001;
  try {
    port = Number(new URL(BASE_URL).port || "3001");
  } catch {
    port = 3001;
  }

  const server = spawn("npm", ["run", "start", "--", "--port", String(port)], {
    stdio: "ignore",
  });

  const ready = await waitForServer(BASE_URL);
  if (!ready) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {}
    return commands.map((item) => ({
      ...item,
      code: 1,
      output: "Server did not become ready in time",
    }));
  }

  const results = commands.map((item) => ({
    ...item,
    ...run(item.cmd),
  }));

  try {
    process.kill(server.pid, "SIGTERM");
  } catch {}
  return results;
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(auditDir, file), "utf8"));
  } catch {
    return null;
  }
};

const nav = readJson("phase1-nav-reliability.json");
const crashes = readJson("phase1-client-crash-log.json");
const hydration = readJson("phase1-hydration-log.json");

const preChecks = [
  { name: "build", cmd: `BASE_URL=${BASE_URL} npm run build` },
  { name: "unit", cmd: `BASE_URL=${BASE_URL} CI=true npm test -- --watchAll=false --runInBand` },
];

const routeChecks = [
  { name: "routes", cmd: `BASE_URL=${BASE_URL} npm run test:smoke:routes -- --reporter=line` },
  { name: "nonjs", cmd: `BASE_URL=${BASE_URL} npm run test:seo:nonjs -- --reporter=line` },
];

const postChecks = [
  { name: "seo", cmd: `BASE_URL=${BASE_URL} npm run check:seo` },
  { name: "budgets", cmd: `BASE_URL=${BASE_URL} npm run check:budgets` },
];
async function main() {
  const preResults = preChecks.map((item) => ({
    ...item,
    ...run(item.cmd),
  }));
  const routeResults = await runWithServer(routeChecks);
  const postResults = postChecks.map((item) => ({
    ...item,
    ...run(item.cmd),
  }));
  const results = [...preResults, ...routeResults, ...postResults];

  const navPass = Boolean(nav?.summary?.pass);
  const crashPass = Array.isArray(crashes?.errors) ? crashes.errors.length === 0 : false;
  const hydrationPass = Array.isArray(hydration?.errors) ? hydration.errors.length === 0 : false;
  const commandPass = results.every((r) => r.code === 0);
  const finalPass = navPass && crashPass && hydrationPass && commandPass;

  const lines = [
  "# PHASE1_PHASE2_SIGNOFF",
  "",
  `- Generated: ${new Date().toISOString()}`,
  `- BASE_URL: ${BASE_URL}`,
  `- Final result: ${finalPass ? "PASS" : "FAIL"}`,
  "",
  "## Gate Summary",
  "",
  `- Navigation reliability: ${navPass ? "PASS" : "FAIL"}`,
  `- Client crash sentinel: ${crashPass ? "PASS" : "FAIL"}`,
  `- Hydration sentinel: ${hydrationPass ? "PASS" : "FAIL"}`,
  ...results.map((r) => `- ${r.name}: ${r.code === 0 ? "PASS" : "FAIL"}`),
  "",
  "## Artifacts",
  "",
  "- audit/phase1-env-determinism.md",
  "- audit/phase1-run-context.json",
  "- audit/phase1-browser-process-pre.csv",
  "- audit/phase1-browser-process-post.csv",
  "- audit/phase1-static-safety.md",
  "- audit/phase1-route-contract.csv",
  "- audit/phase1-api-contract.csv",
  "- audit/phase1-nav-reliability.json",
  "- audit/phase1-nav-chaos.md",
  "- audit/phase1-client-crash-log.json",
  "- audit/phase1-hydration-log.json",
  "- audit/phase1-visual-parity-report.md",
  "- audit/phase1-css-integrity.json",
  "- audit/phase1-browser-device-matrix.csv",
  "- audit/phase1-stress-results.md",
  "- audit/phase1-seo-nonjs-report.md",
  "- audit/phase1-a11y-critical.md",
  "- audit/phase1-business-smoke.md",
  "",
  ];

  fs.mkdirSync(auditDir, { recursive: true });
  const out = path.join(auditDir, "PHASE1_PHASE2_SIGNOFF.md");
  fs.writeFileSync(out, `${lines.join("\n")}\n`);
  console.log(`[phase1-signoff] wrote ${out}`);
  if (!finalPass) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[phase1-signoff] unexpected error: ${error.message}`);
  process.exit(1);
});
