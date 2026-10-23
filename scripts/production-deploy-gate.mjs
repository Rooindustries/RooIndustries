import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const LIVE_ATTEMPTS = Number(process.env.GATE_LIVE_ATTEMPTS || 30);
const LIVE_WAIT_MS = Number(process.env.GATE_LIVE_WAIT_MS || 10000);
const annotate = (level, message) => console.log(process.env.GITHUB_ACTIONS === "true" ? `::${level}::${message}` : `${level}: ${message}`);

const runNode = (script, args, { env = process.env, capture = false } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(scripts, script), ...args], { env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  let stdout = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.on("close", (code) => resolve({ code, stdout }));
});

const liveDeploymentUrl = async () => {
  const { code, stdout } = await runNode("deploy-rollback.mjs", ["--status"], { capture: true });
  if (code !== 0) return null;
  try {
    const host = JSON.parse(stdout)?.live?.url;
    return host ? `https://${host}` : null;
  } catch {
    return null;
  }
};

const main = async () => {
  if (process.env.GITHUB_ACTIONS === "true") {
    let base;
    try { base = new URL(process.env.SMOKE_BASE_URL); } catch { base = null; }
    if (base?.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base?.hostname) ||
        base?.username || base?.password) {
      annotate("error", "CI requires an explicit loopback SMOKE_BASE_URL; live monitoring is disabled.");
      return 1;
    }
  }
  const deploymentUrl = String(process.env.DEPLOYMENT_URL || "").replace(/\/$/, "");
  if (!/^https:\/\/[^/]+$/.test(deploymentUrl)) {
    annotate("error", "DEPLOYMENT_URL must be the deployment's https URL.");
    return 1;
  }
  const hasToken = Boolean(String(process.env.VERCEL_TOKEN || "").trim());

  let confirmedLive = false;
  if (hasToken) {
    let live = null;
    for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt += 1) {
      live = await liveDeploymentUrl();
      if (live === deploymentUrl) break;
      if (attempt < LIVE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, LIVE_WAIT_MS));
    }
    confirmedLive = live === deploymentUrl;
    if (!confirmedLive) {
      annotate("notice", `${deploymentUrl} is not serving production (live: ${live || "unknown"}); the smoke still checks production but won't roll anything back.`);
    }
  } else {
    annotate("warning", `VERCEL_TOKEN is not set: can't confirm ${deploymentUrl} is live, and a failed smoke can't roll back.`);
  }

  const smokeEnv = { ...process.env };
  delete smokeEnv.VERCEL_TOKEN;
  const smokeArgs = process.env.SMOKE_BASE_URL ? ["--base", process.env.SMOKE_BASE_URL] : [];
  const smoke = await runNode("production-smoke.mjs", smokeArgs, { env: smokeEnv });
  if (smoke.code === 0) return 0;
  if (smoke.code !== 2) {
    annotate("error", "The money-path smoke could not run, so nothing was rolled back.");
    return 1;
  }
  if (!hasToken) {
    annotate("error", `The money-path smoke failed on ${deploymentUrl}. VERCEL_TOKEN is not set, so production was not rolled back: run npm run deploy:rollback by hand.`);
    return 1;
  }
  if (!confirmedLive) {
    annotate("error", `Production fails the money-path smoke, but ${deploymentUrl} isn't the live deployment, so nothing was rolled back. Check production by hand.`);
    return 1;
  }
  const rollback = await runNode("deploy-rollback.mjs", ["--if-live", deploymentUrl, "--reason", `Money-path smoke failed on ${deploymentUrl}`]);
  if (rollback.code === 2) {
    annotate("error", `The money-path smoke failed on ${deploymentUrl}. The rollback was sent, but production was not confirmed on the previous deployment (see above).`);
    return 1;
  }
  if (rollback.code !== 0) {
    annotate("error", `The money-path smoke failed on ${deploymentUrl} and the automatic rollback did not run (see above).`);
    return 1;
  }
  annotate("error", `The money-path smoke failed on ${deploymentUrl}, so production was rolled back. Fix forward, then run npm run deploy:rollback -- --undo so new deployments go live again.`);
  return 1;
};

main().then((code) => { process.exitCode = code; }, (error) => {
  annotate("error", `Deploy gate failed: ${error.message}`);
  process.exitCode = 1;
});
