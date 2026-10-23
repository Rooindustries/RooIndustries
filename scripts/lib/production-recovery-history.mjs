import { execFileSync } from "node:child_process";
import { deploymentOrigin, isLoopback } from "./production-diagnostics.mjs";
import { CHECK_NAMES } from "./production-smoke-report.mjs";

const ENVIRONMENT = "production-smoke-history";
const TASK = "roo:production-smoke";
const REPOSITORY = "/repos/Rooindustries/RooIndustries";
const SHA = /^[a-f0-9]{40}$/;
const PROTECTED_PATHS = ["supabase", "src/server", "app/api", "src/lib/cms/contentSchema.js", "src/lib/cms/contentPreservation.js", "vercel.json"];

export const recoveryEpoch = () => {
  const epoch = process.env.PRODUCTION_RECOVERY_EPOCH;
  if (!/^[a-z\d_.:-]{1,80}$/i.test(epoch || "")) throw new Error("PRODUCTION_RECOVERY_EPOCH is missing or invalid; automatic recovery is disabled.");
  return epoch;
};

const historyApi = async (method, pathname, body) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Passed-gate history requires GITHUB_TOKEN; automatic recovery is disabled.");
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  if (base !== "https://api.github.com" && !isLoopback(base)) throw new Error("History API must be GitHub or a credential-free loopback fixture.");
  const response = await fetch(new URL(`${REPOSITORY}${pathname}`, base), { method, redirect: "error",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Passed-gate history ${method} answered ${response.status}; no older record is substituted.`);
  return response.json();
};

export const latestPassedGate = async () => {
  const records = await historyApi("GET", `/deployments?environment=${ENVIRONMENT}&task=${encodeURIComponent(TASK)}&per_page=1`);
  const record = Array.isArray(records) ? records[0] : null;
  let proof = record?.payload;
  if (typeof proof === "string") { try { proof = JSON.parse(proof); } catch { proof = null; } }
  if (!Number.isSafeInteger(record?.id) || record.id <= 0 || record.environment !== ENVIRONMENT || record.task !== TASK ||
      record.creator?.login !== "github-actions[bot]" || proof?.version !== 1 || !SHA.test(proof.sha) || record.sha !== proof.sha ||
      !/^dpl_[a-z\d_-]+$/i.test(proof.deploymentId || "") || !proof.projectId || !proof.domain ||
      !Number.isFinite(proof.createdAt) || proof.createdAt <= 0 || !Number.isFinite(proof.checkedAt) || proof.createdAt > proof.checkedAt ||
      proof.checkedAt > Date.now() + 1000 || proof.checks !== CHECK_NAMES.length || !proof.epoch) {
    throw new Error("The latest passed-gate history is missing or invalid; no older record is substituted.");
  }
  deploymentOrigin(proof.url);
  const statuses = await historyApi("GET", `/deployments/${record.id}/statuses?per_page=1`);
  if (!Array.isArray(statuses) || statuses[0]?.state !== "success" || statuses[0]?.environment !== ENVIRONMENT) {
    throw new Error("The latest gate history has no confirmed success; no older record is substituted.");
  }
  return { ...proof, id: record.id };
};

export const verifyHistoryTarget = (record, state, target, domain) => {
  const targetId = target.uid || target.id;
  const sourceId = state.live.uid || state.live.id;
  const job = state.project.lastAliasRequest;
  if (record.projectId !== state.project.id || record.domain !== domain || record.deploymentId !== targetId ||
      record.sha !== target.meta?.githubCommitSha || record.url !== deploymentOrigin(`https://${target.url}`) ||
      record.createdAt !== Number(target.created ?? target.createdAt) || record.epoch !== recoveryEpoch()) {
    throw new Error("The previous deployment does not match the latest passed-gate history and compatibility epoch.");
  }
  if (!job || job.jobStatus !== "succeeded" || job.type === "rollback" || job.toDeploymentId !== sourceId || job.fromDeploymentId !== targetId) {
    throw new Error("Production alias history does not identify the passed gate as the immediately previous deployment.");
  }
  const sourceSha = state.live.meta?.githubCommitSha;
  if (!SHA.test(sourceSha || "")) throw new Error("The current deployment has no verified commit for compatibility.");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", record.sha, sourceSha], { stdio: "pipe" });
    const changes = execFileSync("git", ["log", "--full-history", "--format=%H", `${record.sha}..${sourceSha}`, "--", ...PROTECTED_PATHS], { encoding: "utf8", stdio: "pipe" });
    if (changes.trim()) throw new Error("Schema or webhook/server contract changed; automatic rollback cannot cross this deployment.");
  } catch (error) {
    if (error.message.startsWith("Schema or webhook")) throw error;
    throw new Error("Deployment ancestry or schema/webhook compatibility could not be verified from repository history.");
  }
};

export const recordPassedGate = async (live, projectId, domain) => {
  const sha = live.sha;
  if (!SHA.test(sha || "")) throw new Error("Cannot record passed-gate history without the deployment commit.");
  const payload = { version: 1, projectId, domain, deploymentId: live.id, url: deploymentOrigin(`https://${live.url}`),
    sha, createdAt: live.createdAt, checkedAt: Date.now(), checks: CHECK_NAMES.length, epoch: recoveryEpoch() };
  const record = await historyApi("POST", "/deployments", { ref: sha, auto_merge: false, required_contexts: [],
    environment: ENVIRONMENT, task: TASK, production_environment: false, transient_environment: false, payload });
  let stored = record?.payload;
  if (typeof stored === "string") { try { stored = JSON.parse(stored); } catch { stored = null; } }
  if (!Number.isSafeInteger(record?.id) || record.sha !== sha || record.environment !== ENVIRONMENT || record.task !== TASK ||
      Object.entries(payload).some(([key, value]) => stored?.[key] !== value)) {
    throw new Error("Passed-gate history write could not be confirmed.");
  }
  const status = await historyApi("POST", `/deployments/${record.id}/statuses`, { state: "success", environment: ENVIRONMENT,
    auto_inactive: false, description: "All production money-path smoke checks passed." });
  if (status?.state !== "success" || status.environment !== ENVIRONMENT) throw new Error("Passed-gate success status could not be confirmed.");
  const confirmed = await latestPassedGate();
  if (confirmed.id !== record.id) throw new Error("Passed-gate history changed before confirmation.");
};
