import { getTourneyDiscordRoleConfig } from "./discordConfig.js";

const DISCORD_REQUEST_TIMEOUT_MS = 5_000;

const acceptedStatus = (response) => response.ok || response.status === 204;

const requestSignal = (deadlineAt = 0) => {
  const remaining = deadlineAt ? deadlineAt - Date.now() : DISCORD_REQUEST_TIMEOUT_MS;
  if (remaining <= 0) {
    const failure = new Error("Discord reconciliation budget was exhausted.");
    failure.code = "discord_retry_budget_exhausted";
    throw failure;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Math.min(DISCORD_REQUEST_TIMEOUT_MS, remaining)
  );
  return { signal: controller.signal, stop: () => clearTimeout(timeoutId) };
};

const discordRequest = async ({
  config,
  discordUserId,
  fetchImpl,
  method,
  roleId = "",
  body,
  deadlineAt = 0,
}) => {
  const suffix = roleId ? `/roles/${roleId}` : "";
  const timeout = requestSignal(deadlineAt);
  let response;
  try {
    response = await fetchImpl(
      `${config.apiBaseUrl}/guilds/${config.guildId}/members/${discordUserId}${suffix}`,
      {
        method,
        signal: timeout.signal,
        headers: {
          Authorization: `Bot ${config.botToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    );
  } catch (error) {
    if (timeout.signal.aborted) {
      const failure = new Error("Discord request timed out.");
      failure.code = "discord_request_timeout";
      throw failure;
    }
    throw error;
  } finally {
    timeout.stop();
  }
  if (!acceptedStatus(response) && !(method === "DELETE" && response.status === 404)) {
    const failure = new Error(`Discord operation failed with ${response.status}.`);
    failure.code = `discord_http_${response.status}`;
    throw failure;
  }
  return response;
};

const ensureMember = async ({
  accessToken,
  assignment,
  config,
  fetchImpl,
  deadlineAt,
}) => {
  if (!accessToken) return false;
  await discordRequest({
    config,
    discordUserId: assignment.discord_user_id,
    fetchImpl,
    method: "PUT",
    body: { access_token: accessToken },
    deadlineAt,
  });
  return true;
};

const readMemberRoles = async ({
  config,
  discordUserId,
  fetchImpl,
  deadlineAt,
}) => {
  const response = await discordRequest({
    config,
    discordUserId,
    fetchImpl,
    method: "GET",
    deadlineAt,
  });
  const member = await response.json().catch(() => ({}));
  return new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
};

const removePreviousManagedRoles = async ({
  assignment,
  config,
  fetchImpl,
  roleIds,
  deadlineAt,
}) => {
  if (!assignment.previous_discord_user_id ||
      assignment.previous_discord_user_id === assignment.discord_user_id) return;
  let previousRoles;
  try {
    previousRoles = await readMemberRoles({
      config,
      discordUserId: assignment.previous_discord_user_id,
      fetchImpl,
      deadlineAt,
    });
  } catch (error) {
    if (error?.code === "discord_http_404") return;
    throw error;
  }
  for (const roleId of Object.values(roleIds)) {
    if (!previousRoles.has(roleId)) continue;
    await discordRequest({
      config,
      discordUserId: assignment.previous_discord_user_id,
      fetchImpl,
      method: "DELETE",
      roleId,
      deadlineAt,
    });
  }
};

const applyManagedRoles = async ({
  assignment,
  config,
  currentRoles,
  fetchImpl,
  deadlineAt,
}) => {
  const roleIds = {
    host: config.hostRoleId,
    participant: config.participantRoleId,
  };
  const desired = assignment.desired_role;
  if (desired !== "none" && !currentRoles.has(roleIds[desired])) {
    await discordRequest({
      config,
      discordUserId: assignment.discord_user_id,
      fetchImpl,
      method: "PUT",
      roleId: roleIds[desired],
      deadlineAt,
    });
  }
  for (const role of ["participant", "host"]) {
    if (role === desired || !currentRoles.has(roleIds[role])) continue;
    await discordRequest({
      config,
      discordUserId: assignment.discord_user_id,
      fetchImpl,
      method: "DELETE",
      roleId: roleIds[role],
      deadlineAt,
    });
  }
  await removePreviousManagedRoles({
    assignment,
    config,
    fetchImpl,
    roleIds,
    deadlineAt,
  });
};

export const applyTourneyDiscordDesiredState = async ({
  accessToken = "",
  assignment,
  env = process.env,
  fetchImpl = fetch,
  deadlineAt = 0,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { applied: false, reason: "not_configured" };
  const normalized = {
    discord_user_id: assignment.discordUserId,
    previous_discord_user_id: assignment.previousDiscordUserId || "",
    desired_role: assignment.desiredRole,
  };
  if (accessToken) {
    await ensureMember({
      accessToken,
      assignment: normalized,
      config,
      fetchImpl,
      deadlineAt,
    });
  }
  let currentRoles;
  try {
    currentRoles = await readMemberRoles({
      config,
      discordUserId: normalized.discord_user_id,
      fetchImpl,
      deadlineAt,
    });
  } catch (error) {
    if (error?.code === "discord_http_404") {
      return { applied: false, reason: "blocked_reauth" };
    }
    throw error;
  }
  await applyManagedRoles({
    assignment: normalized,
    config,
    currentRoles,
    fetchImpl,
    deadlineAt,
  });
  return { applied: true, desiredRole: normalized.desired_role };
};
