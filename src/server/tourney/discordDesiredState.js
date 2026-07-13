import { getTourneySql, runTourneyTransaction } from "./sqlClient.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";
import { enqueueTourneyExternalOperation } from "./externalOperations.js";
import { executeTourneyCommand, resolveTourneyStorePolicy } from "./store.js";

const normalize = (value) => String(value || "").trim();
const desiredRoleFor = (role) => ["owner", "caster"].includes(normalize(role))
  ? "host"
  : "participant";

export const recordTourneyDiscordDesiredState = async ({
  accountUserId = "",
  player,
  discordUser,
  guildId,
  env = process.env,
} = {}) => {
  const playerId = normalize(player?.id);
  const normalizedAccountUserId = normalize(accountUserId);
  const discordUserId = normalize(discordUser?.id);
  const normalizedGuildId = normalize(guildId);
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    if ((!playerId && !normalizedAccountUserId) || !discordUserId) {
      throw new Error("Discord desired state is invalid.");
    }
    return {
      principalId: playerId || normalizedAccountUserId,
      userId: normalizedAccountUserId || playerId,
      desiredRole: playerId ? "participant" : "host",
    };
  }
  if ((!playerId && !normalizedAccountUserId) || !discordUserId || !/^\d{5,30}$/.test(normalizedGuildId)) {
    throw Object.assign(new Error("Discord desired state is invalid."), {
      code: "TOURNEY_DISCORD_DESIRED_STATE_INVALID",
    });
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    const error = new Error("New Discord authentication is temporarily unavailable during fallback.");
    error.status = 503;
    error.code = "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE";
    throw error;
  }
  const sql = await getTourneySql(env);
  const accounts = await sql`
    with input as (
      select ${playerId || null}::text player_id,
        ${normalizedAccountUserId || null}::uuid account_user_id
    )
    select user_id, principal_id, role
    from accounts.tourney_accounts, input
    where (
      input.player_id is not null
      and input.account_user_id is not null
      and legacy_sanity_id = input.player_id
      and user_id = input.account_user_id
    ) or (
      input.player_id is not null
      and input.account_user_id is null
      and legacy_sanity_id = input.player_id
    ) or (
      input.player_id is null
      and input.account_user_id is not null
      and user_id = input.account_user_id
    )
    limit 1 for update
  `;
  const account = accounts[0];
  if (!account?.principal_id || !account?.user_id) {
    const error = new Error("The Tourney identity projection is still completing.");
    error.status = 409;
    error.code = "TOURNEY_IDENTITY_SYNC_PENDING";
    throw error;
  }
  const desiredRole = desiredRoleFor(String(account.role || "").replace(/^tourney_/, ""));
  const rows = await sql`
    insert into accounts.discord_role_assignments (
      user_id, principal_id, player_id, discord_user_id, guild_id,
      tourney_role, desired_role, status
    ) values (
      ${account.user_id}, ${account.principal_id}, ${playerId || null}, ${discordUserId},
      ${normalizedGuildId}, ${account.role}, ${desiredRole}, 'pending'
    ) on conflict (principal_id) do update set
      previous_discord_user_id = case
        when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
          then accounts.discord_role_assignments.discord_user_id
        else accounts.discord_role_assignments.previous_discord_user_id end,
      user_id = excluded.user_id,
      player_id = excluded.player_id,
      discord_user_id = excluded.discord_user_id,
      guild_id = excluded.guild_id,
      tourney_role = excluded.tourney_role,
      desired_role = excluded.desired_role,
      generation = case when
        accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
        or accounts.discord_role_assignments.guild_id <> excluded.guild_id
        or accounts.discord_role_assignments.desired_role <> excluded.desired_role
        then accounts.discord_role_assignments.generation + 1
        else accounts.discord_role_assignments.generation end,
      status = case when
        accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
        and accounts.discord_role_assignments.guild_id = excluded.guild_id
        and accounts.discord_role_assignments.desired_role = excluded.desired_role
        and accounts.discord_role_assignments.applied_role = excluded.desired_role
        and accounts.discord_role_assignments.applied_generation = accounts.discord_role_assignments.generation
        then 'applied' else 'pending' end,
      last_error = null, blocked_at = null, updated_at = now()
    returning principal_id, user_id, player_id, discord_user_id, guild_id,
      desired_role, applied_role, generation, status
  `;
  return rows[0];
};

export const listTourneyDiscordDesiredState = async ({ env = process.env } = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  const relation = policy.primaryBackend === "supabase"
    ? "accounts.discord_role_assignments"
    : "tourney_discord_role_assignments";
  return sql`select * from ${sql(relation)} order by created_at, principal_id`;
};

export const completeTourneyDiscordDesiredState = async ({
  assignment,
  status,
  errorCode = "",
  commandId,
  env = process.env,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const relation = policy.primaryBackend === "supabase"
    ? "accounts.discord_role_assignments"
    : "tourney_discord_role_assignments";
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-complete:${assignment.principalId}`,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend', ${policy.primaryBackend}, true),
          set_config('roo.tourney_mirror_enabled', ${policy.mirrorEnabled ? "1" : "0"}, true),
          set_config('roo.tourney_generation', ${String(policy.generation)}, true),
          set_config('roo.tourney_command_id', ${commandId}, true)
      `;
      const rows = await sql`
        update ${sql(relation)} set
          applied_role = case when ${status} = 'applied'
            then ${assignment.desiredRole} else applied_role end,
          applied_generation = case when ${status} = 'applied'
            then ${assignment.generation} else applied_generation end,
          status = ${status},
          last_error = ${errorCode || null},
          blocked_at = case when ${status} = 'blocked_reauth' then now() else null end,
          applied_at = case when ${status} = 'applied' then now() else applied_at end,
          previous_discord_user_id = case when ${status} = 'applied'
            then null else previous_discord_user_id end,
          updated_at = now()
        where principal_id = ${assignment.principalId}
          and generation = ${assignment.generation}
        returning principal_id
      `;
      if (rows.length !== 1) {
        const error = new Error("Discord desired state generation changed.");
        error.code = "TOURNEY_DISCORD_GENERATION_CHANGED";
        throw error;
      }
    },
  });
};

export const queueTourneyDiscordAuthProjection = async ({
  accessToken = "",
  env = process.env,
  userId,
} = {}) => {
  const normalizedUserId = normalize(userId);
  if (!normalizedUserId) return { applied: false, reason: "not_linked" };
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    return { applied: false, reason: "oauth_temporarily_unavailable" };
  }
  const sql = await getTourneySql(env);
  const rows = await sql`
    select account.legacy_sanity_id as player_id, account.principal_id,
      account.role as tourney_role,
      identity.provider_subject as discord_user_id,
      identity.metadata as identity_metadata
    from accounts.tourney_accounts account
    join accounts.identity_links identity
      on identity.principal_id = account.principal_id
     and identity.provider = 'discord'
    where account.user_id = ${normalizedUserId}
      and account.active
    order by identity.last_seen_at desc nulls last
    limit 1
  `;
  const identity = rows[0];
  if (!identity?.principal_id || !identity?.discord_user_id) {
    return { applied: false, reason: "not_linked" };
  }
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { applied: false, reason: "not_configured" };
  const discordUser = {
    id: identity.discord_user_id,
    username: identity.identity_metadata?.username || "",
    global_name: identity.identity_metadata?.global_name || "",
  };
  const isPlayer = String(identity.tourney_role || "") === "tourney_player";
  const entityId = isPlayer ? identity.player_id : identity.principal_id;
  if (!entityId) return { applied: false, reason: "not_linked" };
  const commandId = `supabase-discord-oauth:${entityId}:${identity.discord_user_id}`;
  const command = await executeTourneyCommand({
    commandId,
    purpose: "discord:link",
    requestPayload: {
      entityId,
      discordUserId: identity.discord_user_id,
    },
    env,
    postCommitContext: {
      discordAccessTokens: { [entityId]: normalize(accessToken) },
    },
    callback: async () => {
      const player = isPlayer
        ? await import("./playerStore.js").then(({ recordTourneyPlayerDiscordLink }) =>
            recordTourneyPlayerDiscordLink({
              playerId: identity.player_id,
              discordUser,
              env,
            })
          )
        : null;
      const assignment = await recordTourneyDiscordDesiredState({
        accountUserId: normalizedUserId,
        player: player || undefined,
        discordUser,
        guildId: config.guildId,
        env,
      });
      await enqueueTourneyExternalOperation({
        commandId,
        operationKind: "discord_membership",
        entityType: isPlayer ? "player" : "account",
        entityId,
        desiredState: {
          assignment: {
            principalId: assignment.principal_id,
            discordUserId: assignment.discord_user_id,
            previousDiscordUserId: assignment.previous_discord_user_id || "",
            desiredRole: assignment.desired_role,
            generation: Number(assignment.generation),
          },
        },
        env,
      });
      return { body: { ok: true } };
    },
  });
  return {
    applied: !command.syncPending,
    reason: command.syncPending ? "pending" : "applied",
  };
};
