import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startSite } from "./fake-site.mjs";
import { startVercel, TOKEN, HISTORY_TOKEN, DOMAIN } from "./fake-vercel.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIVE_URL = "https://rooindustries-live-roo-industries.vercel.app";
export const PREVIOUS_URL = "https://rooindustries-previous-roo-industries.vercel.app";
export const changes = vercel => vercel.requests.filter(request => request.method === "POST" && !request.path.startsWith("/repos/"));

export const execute = (script, args, env) => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root, env: Object.fromEntries(Object.entries({
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      SMOKE_RETRY_MS: "10", SMOKE_MARKER_TIMEOUT_MS: "250", GATE_CONFIRM_WAIT_MS: "40",
      GATE_LIVE_ATTEMPTS: "1", GATE_LIVE_WAIT_MS: "10", ROLLBACK_VERIFY_INTERVAL_MS: "10",
      ROLLBACK_VERIFY_TIMEOUT_MS: "200", ...env,
    }).filter(([,value]) => value !== undefined)),
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});

export const seedHistory = (vercel, sha, epoch = "fixture-v1") => {
  const previous = vercel.state.deployments.find(item => item.uid === "dpl_previous");
  vercel.state.history = [{ id: 41, sha, task: "roo:production-smoke", environment: "production-smoke-history",
    creator: { login: "github-actions[bot]" }, payload: { version: 1, projectId: vercel.state.project.id,
      domain: DOMAIN, deploymentId: previous.uid, url: `https://${previous.url}`, sha, epoch,
      createdAt: previous.created, checkedAt: Date.now() - 60000, checks: 10 } }];
  vercel.state.historyStatuses[41] = [{ id: 1, state: "success", environment: "production-smoke-history" }];
};

export const withRecovery = async (options, body) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "roo702-recovery-"));
  const git = args => execFileSync("git", args, { cwd: scratch, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q"]);
  fs.writeFileSync(path.join(scratch, "page.txt"), "previous\n");
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Previous deployment"]);
  const previousSha = git(["rev-parse", "HEAD"]);
  const changed = options.changedPath || "page.txt";
  fs.mkdirSync(path.dirname(path.join(scratch, changed)), { recursive: true });
  fs.writeFileSync(path.join(scratch, changed), "new deployment\n");
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "New deployment"]);
  const liveSha = git(["rev-parse", "HEAD"]);
  const site = await startSite(options.site);
  const previous = await startSite(options.previous);
  const vercel = await startVercel(options.vercel);
  vercel.state.deployments.find(item => item.uid === "dpl_live").meta.githubCommitSha = liveSha;
  vercel.state.deployments.find(item => item.uid === "dpl_previous").meta.githubCommitSha = previousSha;
  seedHistory(vercel, previousSha);
  options.history?.(vercel.state);
  const env = { VERCEL_TOKEN: TOKEN, VERCEL_API_URL: vercel.origin, GITHUB_TOKEN: HISTORY_TOKEN,
    GITHUB_API_URL: vercel.origin, PRODUCTION_RECOVERY_EPOCH: "fixture-v1", SMOKE_BASE_URL: site.base,
    SMOKE_PREVIOUS_BASE_URL: previous.base, DEPLOYMENT_URL: LIVE_URL,
    GIT_DIR: path.join(scratch, ".git"), GIT_WORK_TREE: scratch };
  const executions = [];
  try {
    await body({ site, previous, vercel, env, scratch, liveSha, previousSha,
      exec: async extra => {
        const result = await execute("production-deploy-gate.mjs", [], { ...env, ...extra });
        executions.push(result);
        return result;
      } });
  } finally {
    const artifacts = path.join(root, "test-results", "production-recovery");
    fs.mkdirSync(artifacts, { recursive: true });
    fs.writeFileSync(path.join(artifacts, `${path.basename(scratch)}.json`), JSON.stringify({ executions,
      site: site.requests, previous: previous.requests,
      provider: vercel.requests.map(({ auth, ...request }) => request), finalState: vercel.state }, null, 2));
    await site.close();
    await previous.close();
    await vercel.close();
    fs.rmSync(scratch, { recursive: true });
  }
};
