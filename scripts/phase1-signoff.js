/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const auditDir = path.join(process.cwd(), "audit");
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[phase1-signoff] BASE_URL is required");
  process.exit(1);
}

const run = (args) => {
  try {
    const output = execFileSync(process.execPath, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", BASE_URL },
    });
    return { code: 0, output };
  } catch (err) {
    return { code: typeof err.status === "number" ? err.status : 1,
      output: String(err.stdout || err.stderr || err.message || "") };
  }
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

const checks = [
  { name: "routes", args: ["node_modules/@playwright/test/cli.js", "test", "tests/routes-smoke.spec.js", "--reporter=line"] },
  { name: "nonjs", args: ["node_modules/@playwright/test/cli.js", "test", "tests/nonjs-seo.spec.js", "--reporter=line"] },
  { name: "seo", args: ["scripts/check-seo.js"] },
  { name: "budgets", args: ["scripts/check-budgets.js"] },
];
async function main() {
  const safety = await import("./lib/test-target-safety.mjs");
  safety.refuseEnvFiles();
  safety.localOrigin(BASE_URL);
  safety.installNetworkGuard([BASE_URL]);
  const response = await fetch(BASE_URL);
  if (!response.ok) throw new Error("An existing isolated server is required for signoff.");
  const results = checks.map(item => ({ ...item, ...run(item.args) }));

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
