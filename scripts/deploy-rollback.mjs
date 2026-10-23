const USAGE = `Usage: npm run deploy:rollback -- [options]

  (no options)            Roll production back to the previous ready production deployment.
  --dry-run               Show the live and target deployments and change nothing.
  --undo                  Promote the newest ready production deployment and turn
                          automatic production domains back on.
  --status                Print the live deployment and rollback state as JSON.
  --if-live <url-or-id>   Inspect an automatic rollback. Mutations are disabled until
                          the provider can enforce the expected live deployment.
  --reason <text>         Reason recorded with the rollback in Vercel.
  --domain <host>         Production domain to check (default www.rooindustries.com).

The Vercel token is read from VERCEL_TOKEN only.`;

const VERCEL_API = "https://api.vercel.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PENDING_JOBS = new Set(["pending", "in-progress"]);
const FAILED_JOBS = new Set(["failed", "error", "canceled", "cancelled"]);
const VERIFY_INTERVAL_MS = Number(process.env.ROLLBACK_VERIFY_INTERVAL_MS || 3000);
const VERIFY_TIMEOUT_MS = Number(process.env.ROLLBACK_VERIFY_TIMEOUT_MS || 120000);
const CANDIDATE_PAGES = 10;
let mutationAccepted = false;

class Refusal extends Error {}

class ApiError extends Error {
  constructor(method, pathname, status, detail) {
    super(`Vercel API ${method} ${pathname} answered ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
  }
}

const parseArgs = (argv) => {
  const options = { dryRun: false, undo: false, status: false, ifLive: null, reason: null, domain: "www.rooindustries.com" };
  const valueFlags = { "--if-live": "ifLive", "--reason": "reason", "--domain": "domain" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--undo") options.undo = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (valueFlags[arg]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Refusal(`${arg} needs a value.`);
      options[valueFlags[arg]] = value;
      index += 1;
    } else {
      throw new Refusal(`Unknown option "${arg}".`);
    }
  }
  if (options.status && (options.undo || options.ifLive || options.dryRun)) throw new Refusal("--status can't be combined with other actions.");
  if (options.undo && options.ifLive) throw new Refusal("--if-live only applies to a rollback, not to --undo.");
  return options;
};

const resolveApiBase = () => {
  const raw = process.env.VERCEL_API_URL || VERCEL_API;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal("VERCEL_API_URL is not a valid URL.");
  }
  if (url.origin === VERCEL_API) return VERCEL_API;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  throw new Refusal("VERCEL_API_URL must be https://api.vercel.com (or a loopback address in tests).");
};

const createClient = (token, base) => async (method, pathname, query = {}, payload) => {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiError(method, url.pathname, response.status, body?.error?.message || body?.error?.code || text.slice(0, 200));
  }
  return { status: response.status, body };
};

const createdAt = (deployment) => Number(deployment?.created ?? deployment?.createdAt ?? 0);
const deploymentId = (deployment) => deployment?.uid || deployment?.id;
const readyState = (deployment) => deployment?.readyState || deployment?.state;

const summarize = (deployment) => {
  const sha = String(deployment?.meta?.githubCommitSha || "").slice(0, 8) || "no-sha";
  const message = String(deployment?.meta?.githubCommitMessage || "").split("\n")[0];
  const when = createdAt(deployment) ? new Date(createdAt(deployment)).toISOString() : "unknown time";
  return `${deploymentId(deployment)} ${deployment?.url || ""} ${when} ${sha}${message ? ` "${message}"` : ""}`;
};

const findScope = async (api, domain) => {
  const { body } = await api("GET", "/v2/teams", { limit: 100 });
  const teams = Array.isArray(body?.teams) ? body.teams : [];
  for (const teamId of [...teams.map((team) => team.id), null]) {
    try {
      const { body: alias } = await api("GET", `/v4/aliases/${encodeURIComponent(domain)}`, { teamId });
      return { teamId, alias };
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) continue;
      throw error;
    }
  }
  throw new Refusal(`No Vercel team this token can use serves ${domain}.`);
};

const loadState = async (api, domain) => {
  const { teamId, alias } = await findScope(api, domain);
  if (!alias?.deploymentId || alias.redirect) throw new Refusal(`${domain} is not pointed at a deployment.`);
  const { body: live } = await api("GET", `/v13/deployments/${encodeURIComponent(alias.deploymentId)}`, { teamId });
  if (deploymentId(live) !== alias.deploymentId) throw new Refusal(`Vercel returned ${deploymentId(live)} for ${alias.deploymentId}.`);
  if (alias.projectId && live.projectId !== alias.projectId) throw new Refusal(`${domain} belongs to ${alias.projectId}, but its deployment belongs to ${live.projectId}.`);
  if (readyState(live) !== "READY" || live.target !== "production") {
    throw new Refusal(`The live deployment ${deploymentId(live)} is ${readyState(live)} with target ${live.target}; fix production by hand.`);
  }
  const { body: project } = await api("GET", `/v9/projects/${encodeURIComponent(live.projectId)}`, { teamId });
  if (project?.id !== live.projectId) throw new Refusal(`Vercel returned project ${project?.id} for ${live.projectId}.`);
  const { body: listing } = await api("GET", "/v7/deployments", {
    projectId: project.id,
    target: "production",
    state: "READY",
    limit: 20,
    teamId,
  });
  const production = (Array.isArray(listing?.deployments) ? listing.deployments : [])
    .filter((deployment) => isLiveable(deployment, project.id))
    .sort((a, b) => createdAt(b) - createdAt(a));
  return { teamId, live, project, newest: production[0] || null };
};

const isLiveable = (deployment, projectId) =>
  deployment?.projectId === projectId &&
  deployment?.target === "production" &&
  readyState(deployment) === "READY" &&
  deployment?.softDeletedByRetention !== true &&
  !deployment?.deletedAt;

const checkTarget = (deployment, state, { rollback }) => {
  const problems = [];
  if (deployment.projectId !== state.project.id) problems.push(`it belongs to project ${deployment.projectId}`);
  if (deployment.target !== "production") problems.push(`its target is ${deployment.target}`);
  if (readyState(deployment) !== "READY") problems.push(`it is ${readyState(deployment)}`);
  if (deployment.softDeletedByRetention === true || deployment.deletedAt) problems.push("it was deleted");
  if (rollback) {
    const eligible = deployment.isRollbackCandidate === true ||
      (deployment.isRollbackCandidate == null && deployment.readySubstate === "PROMOTED");
    if (!eligible) problems.push("Vercel doesn't list it as a rollback candidate");
    if (createdAt(deployment) >= createdAt(state.live)) problems.push("it isn't older than the live deployment");
  }
  if (deploymentId(deployment) === deploymentId(state.live)) problems.push("it is already live");
  if (problems.length) throw new Refusal(`Refusing ${deploymentId(deployment)}: ${problems.join(", ")}.`);
};

const refuseBusyProject = (state) => {
  const job = state.project.lastAliasRequest;
  if (job && PENDING_JOBS.has(job.jobStatus)) {
    throw new Refusal(`A ${job.type} to ${job.toDeploymentId} is still ${job.jobStatus}; wait for it to finish.`);
  }
  if (state.live.readySubstate === "ROLLING") throw new Refusal("A rolling release is moving traffic; finish or abort it in Vercel first.");
};

// Vercel's last promote or rollback says which deployment served production before the live one,
// and which one a rollback already moved away from. Creation order alone can pick a known-bad deployment.
const findRollbackTarget = async (api, state) => {
  const job = state.project.lastAliasRequest;
  const settled = job?.jobStatus === "succeeded" && job?.fromDeploymentId;
  const previous = settled && job.type !== "rollback" && job.toDeploymentId === deploymentId(state.live) ? job.fromDeploymentId : null;
  const rolledAwayFrom = settled && job.type === "rollback" ? job.fromDeploymentId : null;
  const wanted = (deployment) => previous
    ? deploymentId(deployment) === previous
    : deploymentId(deployment) !== deploymentId(state.live) && deploymentId(deployment) !== rolledAwayFrom;
  // Vercel lists 20 deployments per page, newest first; follow pagination.next until the target turns up.
  let until = createdAt(state.live);
  for (let page = 0; page < CANDIDATE_PAGES && until; page += 1) {
    const { body: listing } = await api("GET", "/v7/deployments", {
      projectId: state.project.id,
      target: "production",
      state: "READY",
      rollbackCandidate: true,
      until,
      limit: 20,
      teamId: state.teamId,
    });
    const target = (Array.isArray(listing?.deployments) ? listing.deployments : [])
      .filter(wanted)
      .sort((a, b) => createdAt(b) - createdAt(a))[0];
    if (target) return target;
    until = Number(listing?.pagination?.next) || null;
  }
  if (previous) throw new Refusal(`No earlier production deployment to roll back to: ${previous}, which served production before ${deploymentId(state.live)}, is no longer a rollback candidate.`);
  throw new Refusal("No earlier production deployment to roll back to.");
};

const resolveDeployment = async (api, state, value) => {
  const key = value.startsWith("dpl_") ? value : new URL(value.includes("://") ? value : `https://${value}`).hostname;
  try {
    const { body } = await api("GET", `/v13/deployments/${encodeURIComponent(key)}`, { teamId: state.teamId });
    return body;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) throw new Refusal(`Vercel doesn't know the deployment ${value}.`);
    throw error;
  }
};

const checkAutomaticRollback = async (api, state, ifLive) => {
  const failing = await resolveDeployment(api, state, ifLive);
  if (deploymentId(failing) !== deploymentId(state.live)) {
    throw new Refusal(`${deploymentId(failing)} is not live (${deploymentId(state.live)} is); leaving production alone.`);
  }
  if (deploymentId(state.newest) !== deploymentId(state.live)) {
    throw new Refusal(`${deploymentId(state.live)} is not the newest production deployment (${deploymentId(state.newest)} is); leaving production alone.`);
  }
  if (state.project.autoAssignCustomDomains === false) {
    throw new Refusal("Production is already rolled back; an automatic rollback never goes further back.");
  }
};

const waitForDomain = async (api, state, domain, targetId, { autoAssign, expectedFrom } = {}) => {
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let alias = null;
  let job = null;
  for (;;) {
    ({ body: alias } = await api("GET", `/v4/aliases/${encodeURIComponent(domain)}`, { teamId: state.teamId }));
    const { body: project } = await api("GET", `/v9/projects/${encodeURIComponent(state.project.id)}`, { teamId: state.teamId });
    job = project?.lastAliasRequest || null;
    const domainMoved = alias?.deploymentId === targetId;
    const jobTargetsThis = job?.toDeploymentId === targetId;
    const assignmentReady = autoAssign === undefined ||
      (autoAssign ? project?.autoAssignCustomDomains !== false : project?.autoAssignCustomDomains === false);
    if (domainMoved && job?.jobStatus === "succeeded" && jobTargetsThis && assignmentReady) {
      if (expectedFrom && !job.fromDeploymentId) {
        throw new Error(`${domain} now serves ${targetId}, but Vercel didn't record which deployment it replaced, so it isn't confirmed that ${expectedFrom} was the one. Check that no newer deployment went live just before the request, and run \`npm run deploy:rollback -- --undo\` if one did.`);
      }
      if (expectedFrom && job.fromDeploymentId !== expectedFrom) {
        throw new Error(`${domain} now serves ${targetId}, but Vercel moved it away from ${job.fromDeploymentId}, not ${expectedFrom}: a newer deployment went live just before the request. Check it, and run \`npm run deploy:rollback -- --undo\` if it was healthy.`);
      }
      return;
    }
    if (job && FAILED_JOBS.has(job.jobStatus) && (jobTargetsThis || domainMoved)) {
      throw new Error(`Vercel accepted the request, but the ${job.type || "alias"} job ${job.jobStatus} for ${targetId}. ${domain} serves ${alias?.deploymentId}. Check the Vercel dashboard.`);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  throw new Error(`Vercel accepted the request, but ${domain} still serves ${alias?.deploymentId}; not confirmed (last ${job?.type || "alias"} job: ${job?.jobStatus || "unknown"}). Check the Vercel dashboard.`);
};

const ambiguousDelivery = (error) =>
  !(error instanceof Refusal) && !(error instanceof ApiError && error.status < 500);

const postMutation = async (api, state, domain, pathname, query, { automatic = false } = {}) => {
  const { body: alias } = await api("GET", `/v4/aliases/${encodeURIComponent(domain)}`, { teamId: state.teamId });
  if (alias?.deploymentId !== deploymentId(state.live)) {
    throw new Refusal(`${deploymentId(state.live)} is no longer live (${alias?.deploymentId} is); leaving production alone.`);
  }
  if (automatic) {
    throw new Refusal("Automatic rollback is disabled: Vercel cannot enforce the expected live deployment. Production was not changed; inspect it before a manual rollback.");
  }
  try {
    await api("POST", pathname, query, {});
    mutationAccepted = true;
  } catch (error) {
    if (ambiguousDelivery(error)) mutationAccepted = true;
    if (mutationAccepted) {
      throw new Error(`${error.message}. Vercel may have applied the request anyway, so production's state is unknown. Run \`npm run deploy:rollback -- --status\` and check the Vercel dashboard before trying again.`);
    }
    throw error;
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const token = String(process.env.VERCEL_TOKEN || "").trim();
  if (!token) throw new Refusal("VERCEL_TOKEN is not set. Create a Vercel token for the team and export it first.");
  const api = createClient(token, resolveApiBase());
  const state = await loadState(api, options.domain);

  if (options.status) {
    console.log(JSON.stringify({
      domain: options.domain,
      live: { id: deploymentId(state.live), url: state.live.url, createdAt: createdAt(state.live), sha: state.live.meta?.githubCommitSha || null },
      newest: state.newest ? { id: deploymentId(state.newest), url: state.newest.url, createdAt: createdAt(state.newest) } : null,
      autoAssignCustomDomains: state.project.autoAssignCustomDomains ?? null,
      lastAliasRequest: state.project.lastAliasRequest ?? null,
    }, null, 2));
    return;
  }

  console.log(`Live:   ${summarize(state.live)}`);
  if (state.project.autoAssignCustomDomains === false) {
    console.log("Production is rolled back: new deployments don't go live until `npm run deploy:rollback -- --undo`.");
  }

  if (options.undo) {
    const target = state.newest;
    if (!target) throw new Refusal("No ready production deployment to promote.");
    if (deploymentId(target) === deploymentId(state.live) && state.project.autoAssignCustomDomains !== false) {
      console.log("Nothing to undo: the newest production deployment is live and new deployments go live automatically.");
      return;
    }
    refuseBusyProject(state);
    if (deploymentId(target) !== deploymentId(state.live)) checkTarget(target, state, { rollback: false });
    console.log(`Target: ${summarize(target)}`);
    if (options.dryRun) {
      console.log("Dry run: nothing changed.");
      return;
    }
    const fresh = await loadState(api, options.domain);
    const freshTarget = fresh.newest;
    if (!freshTarget) throw new Refusal("No ready production deployment to promote.");
    refuseBusyProject(fresh);
    if (deploymentId(fresh.live) !== deploymentId(state.live)) {
      throw new Refusal(`${deploymentId(state.live)} is no longer live (${deploymentId(fresh.live)} is); leaving production alone.`);
    }
    if (deploymentId(freshTarget) === deploymentId(fresh.live) && fresh.project.autoAssignCustomDomains !== false) {
      console.log("Nothing to undo: the newest production deployment is live and new deployments go live automatically.");
      return;
    }
    if (deploymentId(freshTarget) !== deploymentId(target)) {
      throw new Refusal(`The undo target changed from ${deploymentId(target)} to ${deploymentId(freshTarget)}; leaving production alone.`);
    }
    if (deploymentId(freshTarget) !== deploymentId(fresh.live)) checkTarget(freshTarget, fresh, { rollback: false });
    await postMutation(api, fresh, options.domain, `/v10/projects/${encodeURIComponent(fresh.project.id)}/promote/${encodeURIComponent(deploymentId(freshTarget))}`, { teamId: fresh.teamId });
    await waitForDomain(api, fresh, options.domain, deploymentId(freshTarget), { autoAssign: true, expectedFrom: deploymentId(fresh.live) });
    console.log(`${options.domain} now serves ${deploymentId(target)}, and new production deployments go live automatically again.`);
    return;
  }

  refuseBusyProject(state);
  if (options.ifLive) await checkAutomaticRollback(api, state, options.ifLive);
  const target = await findRollbackTarget(api, state);
  checkTarget(target, state, { rollback: true });
  console.log(`Target: ${summarize(target)}`);
  if (options.dryRun) {
    console.log("Dry run: nothing changed.");
    return;
  }
  const fresh = await loadState(api, options.domain);
  refuseBusyProject(fresh);
  if (deploymentId(fresh.live) !== deploymentId(state.live)) {
    throw new Refusal(`${deploymentId(state.live)} is no longer live (${deploymentId(fresh.live)} is); leaving production alone.`);
  }
  if (options.ifLive) await checkAutomaticRollback(api, fresh, options.ifLive);
  const freshTarget = await findRollbackTarget(api, fresh);
  checkTarget(freshTarget, fresh, { rollback: true });
  if (deploymentId(freshTarget) !== deploymentId(target)) {
    throw new Refusal(`The rollback target changed from ${deploymentId(target)} to ${deploymentId(freshTarget)}; leaving production alone.`);
  }
  await postMutation(api, fresh, options.domain, `/v1/projects/${encodeURIComponent(fresh.project.id)}/rollback/${encodeURIComponent(deploymentId(freshTarget))}`, {
    teamId: fresh.teamId,
    description: options.reason || "npm run deploy:rollback",
  }, { automatic: Boolean(options.ifLive) });
  await waitForDomain(api, fresh, options.domain, deploymentId(freshTarget), { expectedFrom: deploymentId(fresh.live) });
  console.log(`${options.domain} now serves ${deploymentId(target)}.`);
  console.log("New production deployments stay off the domain until you run `npm run deploy:rollback -- --undo`.");
};

main().catch((error) => {
  console.error(error instanceof Refusal ? `Refusing: ${error.message.replace(/^Refusing /, "")}` : error.message);
  process.exitCode = mutationAccepted ? 2 : 1;
});
