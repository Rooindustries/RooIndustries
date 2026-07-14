import { getTourneyDiscordRoleConfig } from "./discordConfig.js";

const DISCORD_REQUEST_TIMEOUT_MS = 5_000;

const acceptedStatus = (response) => response.ok || response.status === 204;

const parseRetrySeconds = (value) => {
  const normalized = String(value ?? "").trim();
  return normalized ? Number(normalized) : Number.NaN;
};

const parseRetryAfterMs = ({ body = {}, response } = {}) => {
  const header = response?.headers?.get?.("retry-after") ||
    response?.headers?.get?.("x-ratelimit-reset-after") || "";
  const bodySeconds = parseRetrySeconds(body?.retry_after);
  const headerSeconds = parseRetrySeconds(header);
  if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
    return Math.max(1, Math.ceil(bodySeconds * 1000));
  }
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return Math.max(1, Math.ceil(headerSeconds * 1000));
  }
  const headerDate = Date.parse(String(header || ""));
  return Number.isFinite(headerDate)
    ? Math.max(1, headerDate - Date.now())
    : 1000;
};

const discordRateLimitError = async (response) => {
  const body = await response.json().catch(() => ({}));
  const global = body?.global === true ||
    String(response?.headers?.get?.("x-ratelimit-global") || "").toLowerCase() === "true";
  const failure = new Error("Discord rate limit requires a retry.");
  failure.code = global ? "discord_global_rate_limited" : "discord_rate_limited";
  failure.retryAfterMs = parseRetryAfterMs({ body, response });
  failure.discordGlobalRateLimit = global;
  return failure;
};

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
  beforeRequest,
  withMutationFence,
}) => {
  const suffix = roleId ? `/roles/${roleId}` : "";
  const timeout = requestSignal(deadlineAt);
  const performRequest = async () => {
    await beforeRequest?.();
    return fetchImpl(
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
  };
  let response;
  try {
    response = method === "GET" || typeof withMutationFence !== "function"
      ? await performRequest()
      : await withMutationFence(performRequest);
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
  if (response.status === 429) throw await discordRateLimitError(response);
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
  beforeRequest,
  withMutationFence,
}) => {
  if (!accessToken) return false;
  await discordRequest({
    config,
    discordUserId: assignment.discord_user_id,
    fetchImpl,
    method: "PUT",
    body: { access_token: accessToken },
    deadlineAt,
    beforeRequest,
    withMutationFence,
  });
  return true;
};

const readMemberRoles = async ({
  config,
  discordUserId,
  fetchImpl,
  deadlineAt,
  beforeRequest,
}) => {
  const response = await discordRequest({
    config,
    discordUserId,
    fetchImpl,
    method: "GET",
    deadlineAt,
    beforeRequest,
  });
  const member = await response.json().catch(() => ({}));
  return new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
};

const removeStaleManagedRoles = async ({
  assignment,
  config,
  fetchImpl,
  roleIds,
  deadlineAt,
  beforeRequest,
  withMutationFence,
}) => {
  const staleUserIds = [...new Set([
    assignment.previous_discord_user_id,
    ...(assignment.stale_discord_user_ids || []),
  ].filter((userId) => userId && userId !== assignment.discord_user_id))];
  for (const discordUserId of staleUserIds) {
    let staleRoles;
    try {
      staleRoles = await readMemberRoles({
        config,
        discordUserId,
        fetchImpl,
        deadlineAt,
        beforeRequest,
      });
    } catch (error) {
      if (error?.code === "discord_http_404") continue;
      throw error;
    }
    for (const roleId of Object.values(roleIds)) {
      if (!staleRoles.has(roleId)) continue;
      await discordRequest({
        config,
        discordUserId,
        fetchImpl,
        method: "DELETE",
        roleId,
        deadlineAt,
        beforeRequest,
        withMutationFence,
      });
    }
  }
};

const applyManagedRoles = async ({
  assignment,
  config,
  currentRoles,
  fetchImpl,
  deadlineAt,
  beforeRequest,
  withMutationFence,
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
      beforeRequest,
      withMutationFence,
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
      beforeRequest,
      withMutationFence,
    });
  }
  await removeStaleManagedRoles({
    assignment,
    config,
    fetchImpl,
    roleIds,
    deadlineAt,
    beforeRequest,
    withMutationFence,
  });
};

export const applyTourneyDiscordDesiredState = async ({
  accessToken = "",
  assignment,
  env = process.env,
  fetchImpl = fetch,
  deadlineAt = 0,
  beforeRequest,
  withMutationFence,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { applied: false, reason: "not_configured" };
  const normalized = {
    discord_user_id: assignment.discordUserId,
    previous_discord_user_id: assignment.previousDiscordUserId || "",
    stale_discord_user_ids: assignment.staleDiscordUserIds || [],
    desired_role: assignment.desiredRole,
  };
  if (!normalized.discord_user_id || !["none", "participant", "host"].includes(normalized.desired_role)) {
    const failure = new Error("Discord desired state is invalid.");
    failure.code = "discord_desired_state_invalid";
    throw failure;
  }
  let currentRoles;
  try {
    currentRoles = await readMemberRoles({
      config,
      discordUserId: normalized.discord_user_id,
      fetchImpl,
      deadlineAt,
      beforeRequest,
    });
  } catch (error) {
    if (error?.code === "discord_http_404") {
      if (normalized.desired_role !== "none") {
        if (!accessToken) return { applied: false, reason: "blocked_reauth" };
        try {
          await ensureMember({
            accessToken,
            assignment: normalized,
            config,
            fetchImpl,
            deadlineAt,
            beforeRequest,
            withMutationFence,
          });
          currentRoles = await readMemberRoles({
            config,
            discordUserId: normalized.discord_user_id,
            fetchImpl,
            deadlineAt,
            beforeRequest,
          });
        } catch (joinError) {
          if (["discord_http_401", "discord_http_403", "discord_http_404"]
            .includes(joinError?.code)) {
            return { applied: false, reason: "blocked_reauth" };
          }
          throw joinError;
        }
      } else {
        currentRoles = new Set();
      }
    } else {
      throw error;
    }
  }
  await applyManagedRoles({
    assignment: normalized,
    config,
    currentRoles,
    fetchImpl,
    deadlineAt,
    beforeRequest,
    withMutationFence,
  });
  return { applied: true, desiredRole: normalized.desired_role };
};
