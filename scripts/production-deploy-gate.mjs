import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryLock, withRecoveryLock } from "./lib/production-recovery-lock.mjs";
import { isProductionMonitor } from "./lib/production-monitor.mjs";
import { annotate, log, logError, deploymentOrigin, isLoopback } from "./lib/production-diagnostics.mjs";
import { recordPassedGate } from "./lib/production-recovery-history.mjs";
import { confirmationWait, differentialFailures, validateReport, verifyEvidence } from "./lib/production-smoke-report.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const DOMAIN = "www.rooindustries.com";
const LIVE_ATTEMPTS = Number(process.env.GATE_LIVE_ATTEMPTS || 30);
const LIVE_WAIT_MS = Number(process.env.GATE_LIVE_WAIT_MS || 10000);

const runNode = (script, args, { env = process.env, capture = false } = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(scripts, script), ...args], { env,
    stdio: ["ignore", "pipe", "pipe", ...(recoveryLock === undefined || script !== "deploy-rollback.mjs" ? [] : [recoveryLock])] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("error", error => { stderr += error.message; });
  child.on("close", code => {
    if (!capture && stdout) log(stdout.trimEnd());
    if (stderr) logError(stderr.trimEnd());
    resolve({ code, stdout });
  });
});

const liveState = async () => {
  const result = await runNode("deploy-rollback.mjs", ["--status"], { capture: true });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
};

const main = async () => {
  const deploymentUrl = deploymentOrigin(process.env.DEPLOYMENT_URL || "");
  const monitoring = isProductionMonitor();
  const fixture = isLoopback(process.env.VERCEL_API_URL) && isLoopback(process.env.GITHUB_API_URL);
  if (!fixture && (process.env.SMOKE_BASE_URL || process.env.SMOKE_PREVIOUS_BASE_URL)) {
    throw new Error("Recovery smoke overrides require loopback provider and history fixtures.");
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    const base = process.env.SMOKE_BASE_URL || (monitoring ? "https://www.rooindustries.com" : "");
    if ((!isLoopback(base) && !(monitoring && base === "https://www.rooindustries.com")) ||
        (process.env.SMOKE_PREVIOUS_BASE_URL && !isLoopback(process.env.SMOKE_PREVIOUS_BASE_URL)) ||
        (!monitoring && process.env.VERCEL_TOKEN && !isLoopback(process.env.VERCEL_API_URL))) {
      annotate("error", "CI requires an explicit loopback SMOKE_BASE_URL and credential-free fixture services; live monitoring is disabled.");
      return 1;
    }
  }
  const hasToken = Boolean(String(process.env.VERCEL_TOKEN || "").trim());
  let state = null;
  if (hasToken) {
    for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt += 1) {
      state = await liveState();
      if (state?.live?.url && deploymentOrigin(`https://${state.live.url}`) === deploymentUrl) break;
      if (attempt < LIVE_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, LIVE_WAIT_MS));
    }
  }
  const confirmedLive = Boolean(state?.live?.url && deploymentOrigin(`https://${state.live.url}`) === deploymentUrl);
  if (!hasToken) annotate("warning", "VERCEL_TOKEN is not set: the smoke can alert, but production cannot be rolled back.");
  else if (!confirmedLive) annotate("notice", `${deploymentUrl} is not serving production; the smoke still checks production but won't roll anything back.`);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo-production-comparison-"));
  try {
    let reportNumber = 0;
    const smoke = async base => {
      const filename = path.join(scratch, `smoke-${reportNumber++}.json`);
      const env = { ...process.env, SMOKE_DEPLOYMENT_URL: base.startsWith("https:") ? base : "" };
      for (const key of ["VERCEL_TOKEN", "GITHUB_TOKEN", "ROO_RECOVERY_LOCK"]) delete env[key];
      const result = await runNode("production-smoke.mjs", ["--base", base, "--report", filename], { env });
      let report = null;
      try { report = JSON.parse(fs.readFileSync(filename, "utf8")); } catch {}
      return { code: result.code, report };
    };
    const sourceBase = process.env.SMOKE_BASE_URL || (confirmedLive ? deploymentUrl : "https://www.rooindustries.com");
    const first = await smoke(sourceBase);
    if (first.code === 0) {
      validateReport(first.report);
      if (first.report.results.some(row => !row.ok)) throw new Error("The passing smoke contradicts its report; no history was written.");
      if (hasToken && confirmedLive && process.env.GITHUB_TOKEN && process.env.PRODUCTION_RECOVERY_EPOCH) {
        const fresh = await liveState();
        if (fresh?.live?.id !== state.live.id || fresh.live.sha !== state.live.sha) {
          throw new Error("Production moved before its passing gate could be recorded; no passed-gate history was written.");
        }
        await recordPassedGate(fresh.live, fresh.projectId, DOMAIN);
        annotate("notice", "The live deployment passed and its gate history was recorded.");
      } else annotate("warning", "Smoke passed, but complete recovery credentials and epoch are unavailable; no passed-gate history was written.");
      return 0;
    }
    if (first.code !== 2) throw new Error("The money-path smoke could not run, so nothing was rolled back.");
    if (!hasToken) throw new Error("The money-path smoke failed. VERCEL_TOKEN is not set, so production was not rolled back: run npm run deploy:rollback by hand.");
    if (!confirmedLive) throw new Error("Production fails the money-path smoke, but this deployment isn't live, so nothing was rolled back.");

    const planned = await runNode("deploy-rollback.mjs", ["--plan", "--if-live", deploymentUrl], { capture: true });
    if (planned.code !== 0) throw new Error("Passed-gate history or target compatibility could not be verified; nothing was rolled back.");
    const plan = JSON.parse(planned.stdout);
    const targetBase = process.env.SMOKE_PREVIOUS_BASE_URL || plan.targetUrl;
    const previous = await smoke(targetBase);
    if (previous.code !== 0) throw new Error("The previous deployment also failed or could not run; dependency incident or cold start: nothing was rolled back.");
    const failures = differentialFailures(first.report, previous.report);
    const evidence = { version: 1, sourceId: plan.sourceId, targetId: plan.targetId, historyId: plan.historyId,
      epoch: plan.epoch, rounds: [{ current: first.report, previous: previous.report }] };
    const wait = confirmationWait();
    annotate("notice", `New deployment fails ${failures.join(", ")}; the previous deployment passes. Waiting ${Math.round(wait / 1000)} seconds to confirm before recovery.`);
    await new Promise(resolve => setTimeout(resolve, wait));
    const current = await smoke(sourceBase);
    const comparison = await smoke(targetBase);
    if (current.code !== 2 || comparison.code !== 0) throw new Error("The deployment-specific regression was not confirmed twice; nothing was rolled back.");
    evidence.rounds.push({ current: current.report, previous: comparison.report });
    verifyEvidence(evidence, { ...plan, sourceBase, targetBase });
    const filename = path.join(scratch, "comparison.json");
    fs.writeFileSync(filename, JSON.stringify(evidence), { mode: 0o600 });
    const rollback = await runNode("deploy-rollback.mjs", ["--if-live", deploymentUrl, "--evidence", filename,
      "--reason", "Repeated money-path regression: new deployment fails and previous passed gate passes"]);
    if (rollback.code === 2) throw new Error("The rollback was sent, but production was not confirmed on the previous deployment; any detected newer deployment was restored when possible. Check the recovery evidence above.");
    if (rollback.code !== 0) throw new Error("Automatic recovery was refused after revalidation; nothing was rolled back.");
    annotate("error", "The repeated deployment-specific smoke failed, so production was rolled back. Fix forward, then run npm run deploy:rollback -- --undo.");
    return 1;
  } finally {
    fs.rmSync(scratch, { recursive: true });
  }
};

withRecoveryLock(DOMAIN, main).then(code => { process.exitCode = code; }, error => {
  annotate("error", `Deploy gate failed: ${error.message}`);
  process.exitCode = 1;
});
