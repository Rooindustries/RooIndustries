import { createSupabaseAdminClient } from "../supabase/adminClient.js";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";

const acceptedStatus = (response) => response.ok || response.status === 204;

const discordRequest = async ({
  config,
  discordUserId,
  fetchImpl,
  method,
  roleId = "",
  body,
}) => {
  const suffix = roleId ? `/roles/${roleId}` : "";
  const response = await fetchImpl(
    `${config.apiBaseUrl}/guilds/${config.guildId}/members/${discordUserId}${suffix}`,
    {
      method,
      headers: {
        Authorization: `Bot ${config.botToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }
  );
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
}) => {
  if (!accessToken) return false;
  await discordRequest({
    config,
    discordUserId: assignment.discord_user_id,
    fetchImpl,
    method: "PUT",
    body: { access_token: accessToken },
  });
  return true;
};

const applyManagedRoles = async ({ assignment, config, fetchImpl }) => {
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
    });
    await applyManagedRoles({ assignment, config, fetchImpl });
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
  limit = 25,
} = {}) => {
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { supported: false, checked: 0, applied: 0 };
  const result = await adminClient
    .schema("accounts")
    .from("discord_role_assignments")
    .select("user_id")
    .in("status", ["pending", "retry"])
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)));
  if (result.error) throw new Error("Discord role retry queue could not be read.");
  let applied = 0;
  for (const row of result.data || []) {
    const synced = await syncTourneyDiscordRoleAssignment({
      adminClient,
      env,
      fetchImpl,
      userId: row.user_id,
    });
    if (synced.applied) applied += 1;
  }
  return {
    supported: true,
    checked: (result.data || []).length,
    applied,
  };
};
