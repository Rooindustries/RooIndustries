import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";

const DISCORD_REQUEST_TIMEOUT_MS = 5_000;
const DISCORD_RECONCILE_BUDGET_MS = 15_000;
const DISCORD_RECONCILE_CONCURRENCY = 3;

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

const completeAssignment = async ({
  adminClient,
  appliedRole,
  error = "",
  generation,
  joined = false,
  status,
  userId,
}) => {
  const result = await adminClient.rpc("roo_complete_discord_role_assignment", {
    p_applied_role: appliedRole,
    p_error: error || null,
    p_generation: generation,
    p_joined: joined,
    p_status: status,
    p_user_id: userId,
  });
  if (result.error) {
    const failure = new Error("Discord role state could not be recorded.");
    failure.code = result.error.code || "discord_state_write_failed";
    throw failure;
  }
  return result.data;
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

const applyManagedRoles = async ({ assignment, config, fetchImpl, deadlineAt }) => {
  const roleIds = {
    host: config.hostRoleId,
    participant: config.participantRoleId,
  };
  const desired = assignment.desired_role;
  if (desired !== "none") {
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
    if (role === desired) continue;
    await discordRequest({
      config,
      discordUserId: assignment.discord_user_id,
      fetchImpl,
      method: "DELETE",
      roleId: roleIds[role],
      deadlineAt,
    });
  }
  if (
    assignment.previous_discord_user_id &&
    assignment.previous_discord_user_id !== assignment.discord_user_id
  ) {
    for (const role of ["participant", "host"]) {
      await discordRequest({
        config,
        discordUserId: assignment.previous_discord_user_id,
        fetchImpl,
        method: "DELETE",
        roleId: roleIds[role],
        deadlineAt,
      });
    }
  }
};

export const refreshTourneyDiscordRoleAssignment = async ({
  adminClient = createSupabaseAdminClient(),
  env = process.env,
  userId,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { queued: false, reason: "not_configured" };
  const result = await adminClient.rpc("roo_refresh_discord_role_assignment", {
    p_guild_id: config.guildId,
    p_user_id: userId,
  });
  if (result.error) throw new Error("Discord role state could not be refreshed.");
  return result.data || { queued: false };
};

export const syncTourneyDiscordRoleAssignment = async ({
  accessToken = "",
  adminClient = createSupabaseAdminClient(),
  env = process.env,
  fetchImpl = fetch,
  repairAttempts = 1,
  deadlineAt = 0,
  userId,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { applied: false, reason: "not_configured" };
  const assignment = await refreshTourneyDiscordRoleAssignment({
    adminClient,
    env,
    userId,
  });
  if (!assignment?.queued) {
    return { applied: false, reason: assignment?.reason || "not_linked" };
  }

  let joined = false;
  try {
    joined = await ensureMember({
      accessToken,
      assignment,
      config,
      fetchImpl,
      deadlineAt,
    });
    await applyManagedRoles({ assignment, config, fetchImpl, deadlineAt });
    await completeAssignment({
      adminClient,
      appliedRole: assignment.desired_role,
      generation: assignment.generation,
      joined,
      status: "applied",
      userId,
    });
    return {
      applied: true,
      desiredRole: assignment.desired_role,
      generation: assignment.generation,
      joined,
    };
  } catch (error) {
    if (error?.code === "40001" && repairAttempts > 0) {
      return syncTourneyDiscordRoleAssignment({
        accessToken,
        adminClient,
        env,
        fetchImpl,
        repairAttempts: repairAttempts - 1,
        deadlineAt,
        userId,
      });
    }
    const errorCode = getSafeErrorCode(error, "discord_role_sync_failed");
    logSafeError("Tournament Discord role sync failed", error);
    await completeAssignment({
      adminClient,
      appliedRole: assignment.applied_role || "none",
      error: errorCode,
      generation: assignment.generation,
      joined,
      status: "retry",
      userId,
    }).catch(() => {});
    return {
      applied: false,
      generation: assignment.generation,
      reason: errorCode,
    };
  }
};

export const reconcileTourneyDiscordRoleAssignments = async ({
  adminClient = createSupabaseAdminClient(),
  env = process.env,
  fetchImpl = fetch,
  limit = 10,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { supported: false, checked: 0, applied: 0 };
  const result = await adminClient.rpc(
    "roo_list_pending_discord_role_assignments",
    { p_limit: Math.max(1, Math.min(Number(limit) || 10, 10)) }
  );
  if (result.error) {
    const failure = new Error("Discord role retry queue could not be read.");
    failure.code = result.error.code || "discord_retry_queue_read_failed";
    throw failure;
  }
  const rows = (Array.isArray(result.data) ? result.data : []).slice(0, 10);
  const deadlineAt = Date.now() + DISCORD_RECONCILE_BUDGET_MS;
  let applied = 0;
  let checked = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length && Date.now() < deadlineAt) {
      const row = rows[cursor];
      cursor += 1;
      checked += 1;
      const synced = await syncTourneyDiscordRoleAssignment({
        adminClient,
        deadlineAt,
        env,
        fetchImpl,
        userId: row.user_id,
      });
      if (synced.applied) applied += 1;
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(DISCORD_RECONCILE_CONCURRENCY, rows.length) },
      worker
    )
  );
  return {
    supported: true,
    checked,
    applied,
    ...(rows.length > checked ? { deferred: rows.length - checked } : {}),
  };
};
