import crypto from "node:crypto";
import {
  getTourneySql,
  getTourneySqlForBackend,
  runTourneyTransaction,
} from "./sqlClient.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";
import {
  enqueueTourneyExternalOperation,
  enqueueTourneyIdentityUnlinkOperation,
  rearmTourneyDiscordOperationWithAccessToken,
  saveTourneyDiscordOperationAccessToken,
  supersedeQueuedDiscordOperationsForCommand,
} from "./externalOperations.js";
import { executeTourneyCommand, resolveTourneyStorePolicy } from "./store.js";

const normalize = (value) => String(value || "").trim();
export const desiredTourneyDiscordRoleForAccount = (account = {}) => {
  const lifecycle = normalize(account.lifecycle_status || "approved");
  if (account.active === false || lifecycle !== "approved") return "none";
  const role = normalize(account.role).replace(/^tourney_/, "");
  if (role === "player") return "participant";
  if (["owner", "caster"].includes(role)) return "host";
  return "none";
};
const assignmentRelation = (backend) => backend === "supabase"
  ? "accounts.discord_role_assignments"
  : "tourney_discord_role_assignments";
const operationRelation = (backend) => backend === "supabase"
  ? "tourney.external_operations"
  : "tourney_external_operations";
const receiptRelation = (backend) => backend === "supabase"
  ? "tourney.command_receipts"
  : "tourney_command_receipts";
const emailRelation = (backend) => backend === "supabase"
  ? "tourney.email_dispatches"
  : "tourney_email_dispatches";

const normalizeAssignment = (assignment = {}) => ({
  principalId: normalize(assignment.principal_id || assignment.principalId),
  discordUserId: normalize(assignment.discord_user_id || assignment.discordUserId),
  previousDiscordUserId: normalize(
    assignment.previous_discord_user_id || assignment.previousDiscordUserId
  ),
  staleDiscordUserIds: [...new Set(
    (assignment.stale_discord_user_ids || assignment.staleDiscordUserIds || [])
      .map(normalize)
      .filter(Boolean)
  )],
  desiredRole: normalize(assignment.desired_role || assignment.desiredRole),
  generation: Number(assignment.generation || 0),
  leaseId: normalize(assignment.lease_id || assignment.leaseId),
});

const setCommandContext = async ({ sql, policy, commandId }) => {
  await sql`
    select
      set_config('roo.tourney_backend', ${policy.primaryBackend}, true),
      set_config('roo.tourney_mirror_enabled', ${policy.mirrorEnabled ? "1" : "0"}, true),
      set_config('roo.tourney_generation', ${String(policy.generation)}, true),
      set_config('roo.tourney_command_id', ${commandId}, true)
  `;
};

export const recordTourneyDiscordDesiredState = async ({
  accountUserId = "",
  player,
  discordUser,
  guildId,
  freshCredentials = false,
  forceRepair = false,
  env = process.env,
} = {}) => {
  const playerId = normalize(player?.id);
  const normalizedAccountUserId = normalize(accountUserId);
  const discordUserId = normalize(discordUser?.id);
  const normalizedGuildId = normalize(guildId);
  const shouldRearm = freshCredentials === true || forceRepair === true;
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    if ((!playerId && !normalizedAccountUserId) || !discordUserId) {
      throw new Error("Discord desired state is invalid.");
    }
    return {
      principalId: playerId || normalizedAccountUserId,
      userId: normalizedAccountUserId || playerId,
      playerId,
      discordUserId,
      previousDiscordUserId: "",
      desiredRole: playerId ? "participant" : "host",
      generation: 1,
      status: "pending",
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
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-record:${playerId || normalizedAccountUserId}`,
    waitForLock: true,
    callback: async (sql) => {
      const accounts = await sql`
        with input as (
          select ${playerId || null}::text player_id,
            ${normalizedAccountUserId || null}::uuid account_user_id
        )
        select user_id, principal_id, role, active, lifecycle_status
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
      const desiredRole = desiredTourneyDiscordRoleForAccount(account);
      const rows = await sql`
        insert into accounts.discord_role_assignments (
          user_id, principal_id, player_id, discord_user_id, guild_id,
          tourney_role, desired_role, status
        ) values (
          ${account.user_id}, ${account.principal_id}, ${playerId || null}, ${discordUserId},
          ${normalizedGuildId}, ${account.role}, ${desiredRole}, 'pending'
        ) on conflict (principal_id) do update set
          stale_discord_user_ids = case
            when accounts.discord_role_assignments.discord_user_id <> excluded.discord_user_id
            then array(
              select distinct stale_id from unnest(
                coalesce(accounts.discord_role_assignments.stale_discord_user_ids, '{}'::text[])
                || array[accounts.discord_role_assignments.discord_user_id]
              ) stale_id
              where stale_id is not null and stale_id <> excluded.discord_user_id
            )
            else accounts.discord_role_assignments.stale_discord_user_ids end,
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
          status = case
            when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
              and accounts.discord_role_assignments.guild_id = excluded.guild_id
              and accounts.discord_role_assignments.desired_role = excluded.desired_role
              and accounts.discord_role_assignments.status in ('blocked', 'blocked_reauth')
              and ${shouldRearm} = false
              then 'blocked_reauth'
            when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
              and accounts.discord_role_assignments.guild_id = excluded.guild_id
              and accounts.discord_role_assignments.desired_role = excluded.desired_role
              and accounts.discord_role_assignments.status = 'applied'
              and accounts.discord_role_assignments.applied_role = excluded.desired_role
              and accounts.discord_role_assignments.applied_generation = accounts.discord_role_assignments.generation
              and ${shouldRearm} = false
              then 'applied'
            else 'pending' end,
          attempt_count = case when ${shouldRearm} then 0
            else accounts.discord_role_assignments.attempt_count end,
          lease_id = null, lease_expires_at = null,
          last_error = null,
          blocked_at = case
            when accounts.discord_role_assignments.discord_user_id = excluded.discord_user_id
              and accounts.discord_role_assignments.guild_id = excluded.guild_id
              and accounts.discord_role_assignments.desired_role = excluded.desired_role
              and accounts.discord_role_assignments.status in ('blocked', 'blocked_reauth')
              and ${shouldRearm} = false
              then coalesce(
                accounts.discord_role_assignments.blocked_at,
                accounts.discord_role_assignments.updated_at
              )
            else null end,
          updated_at = now()
        returning principal_id, user_id, player_id, discord_user_id,
          previous_discord_user_id, stale_discord_user_ids, guild_id,
          desired_role, applied_role,
          generation, status
      `;
      return rows[0];
    },
  });
};

export const listTourneyDiscordDesiredState = async ({ env = process.env } = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  const relation = assignmentRelation(policy.primaryBackend);
  return sql`select * from ${sql(relation)} order by created_at, principal_id`;
};

export const listAuthoritativeTourneyDiscordMappings = async ({
  playerIds = [],
  principalIds = [],
  env = process.env,
} = {}) => {
  const normalizedPlayerIds = [...new Set(playerIds.map(normalize).filter(Boolean))];
  const normalizedPrincipalIds = [...new Set(
    principalIds.map((value) => normalize(value).toLowerCase()).filter(Boolean)
  )];
  if (normalizedPlayerIds.length > 0 && normalizedPrincipalIds.length > 0) {
    throw new Error("Discord authority lookup accepts one target type.");
  }
  const sql = await getTourneySqlForBackend({ backend: "supabase", env });
  const playerFilter = normalizedPlayerIds.length > 0 ? normalizedPlayerIds : [""];
  const principalFilter = normalizedPrincipalIds.length > 0 ? normalizedPrincipalIds : [""];
  return sql`
    select account.legacy_sanity_id as player_id,
      account.principal_id,
      account.active as account_active,
      identity.provider_subject as discord_user_id
    from accounts.tourney_accounts account
    left join accounts.identity_links identity
      on identity.principal_id = account.principal_id
     and identity.provider = 'discord'
    where account.role = 'tourney_player'
      and account.legacy_sanity_id is not null
      and (${normalizedPlayerIds.length === 0}
        or account.legacy_sanity_id in ${sql(playerFilter)})
      and (${normalizedPrincipalIds.length === 0}
        or account.principal_id::text in ${sql(principalFilter)})
    order by account.legacy_sanity_id, account.principal_id, identity.provider_subject
  `;
};

export const queueTourneyDiscordStateForPlayerMutation = async ({
  commandId,
  player,
  env = process.env,
} = {}) => {
  const playerId = normalize(player?.id);
  if (!playerId || env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return null;
  }
  const policy = resolveTourneyStorePolicy(env);
  const relation = assignmentRelation(policy.primaryBackend);
  const desiredRole = normalize(player?.status) === "approved"
    ? "participant"
    : "none";
  const sql = await getTourneySql(env);
  const rows = await sql`
    update ${sql(relation)} set
      desired_role = ${desiredRole},
      tourney_role = 'tourney_player',
      generation = generation + 1,
      status = 'pending',
      lease_id = null,
      lease_expires_at = null,
      last_error = null,
      blocked_at = null,
      updated_at = now()
    where player_id = ${playerId}
      and desired_role is distinct from ${desiredRole}
    returning principal_id,discord_user_id,previous_discord_user_id,
      stale_discord_user_ids,desired_role,generation
  `;
  const assignment = rows[0];
  if (!assignment) return null;
  await enqueueTourneyExternalOperation({
    commandId,
    operationKind: "discord_role_reconcile",
    entityType: "player",
    entityId: playerId,
    desiredState: {
      assignment: normalizeAssignment(assignment),
    },
    env,
  });
  return assignment;
};

export const normalizeTourneyDiscordState = (status, linked = false) => {
  if (!linked) return "unlinked";
  const normalized = normalize(status).toLowerCase();
  if (normalized === "applied") return "applied";
  if (normalized === "retry") return "retry";
  if (["blocked", "blocked_reauth"].includes(normalized)) return "blocked_reauth";
  if (normalized === "dead_letter") return "dead_letter";
  return "pending";
};

export const getTourneyDiscordStatusForPlayer = async ({
  playerId,
  env = process.env,
} = {}) => {
  const normalizedPlayerId = normalize(playerId);
  if (!normalizedPlayerId || env.TOURNEY_DATABASE_MODE === "memory") return null;
  const policy = resolveTourneyStorePolicy(env);
  const sql = await getTourneySql(env);
  const assignments = await sql`
    select * from ${sql(assignmentRelation(policy.primaryBackend))}
    where player_id = ${normalizedPlayerId}
    order by updated_at desc limit 1
  `;
  const assignment = assignments[0];
  if (assignment) {
    let linked = Boolean(assignment.discord_user_id);
    let assignmentMatchesIdentity = linked;
    if (policy.primaryBackend === "supabase") {
      const [identity] = await sql`
        select linked_identity.provider_subject as discord_user_id
        from accounts.tourney_accounts account
        join accounts.identity_links linked_identity
          on linked_identity.principal_id = account.principal_id
         and linked_identity.provider = 'discord'
        where account.legacy_sanity_id = ${normalizedPlayerId}
        limit 1
      `;
      linked = Boolean(identity?.discord_user_id);
      assignmentMatchesIdentity =
        normalize(identity?.discord_user_id) === normalize(assignment.discord_user_id);
    }
    const desiredStateApplied = assignment.status === "applied" &&
      assignment.applied_role === assignment.desired_role &&
      Number(assignment.applied_generation) === Number(assignment.generation);
    const roleAssigned = linked && assignmentMatchesIdentity &&
      assignment.desired_role !== "none" && desiredStateApplied;
    const state = !linked
      ? "unlinked"
      : roleAssigned
        ? "applied"
        : normalizeTourneyDiscordState(
            assignment.status === "applied" ? "pending" : assignment.status,
            true
          );
    return {
      linked,
      state,
      roleAssigned,
      roleAssignedAt: roleAssigned ? assignment.applied_at || "" : "",
      lastError: assignment.last_error || "",
    };
  }
  if (policy.primaryBackend !== "supabase") return null;
  const rows = await sql`
    select
      exists(
        select 1 from accounts.identity_links identity
        where identity.principal_id = account.principal_id
          and identity.provider = 'discord'
      ) as linked,
      operation.status,
      operation.last_error_code
    from accounts.tourney_accounts account
    left join lateral (
      select queued.status, queued.last_error_code
      from ${sql(operationRelation(policy.primaryBackend))} queued
      where queued.operation_kind = 'discord_membership'
        and queued.desired_state->'oauthProjection'->>'userId' = account.user_id::text
      order by queued.created_at desc limit 1
    ) operation on true
    where account.legacy_sanity_id = ${normalizedPlayerId}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const linked = row.linked === true;
  const state = row.status === "applied"
    ? (linked ? "dead_letter" : "unlinked")
    : normalizeTourneyDiscordState(row.status, linked);
  return {
    linked,
    state,
    roleAssigned: false,
    roleAssignedAt: "",
    lastError: row.last_error_code || "",
  };
};

export const claimTourneyDiscordDesiredState = async ({
  assignment,
  commandId,
  env = process.env,
} = {}) => {
  const expected = normalizeAssignment(assignment);
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return { ...expected, leaseId: crypto.randomUUID() };
  }
  const policy = resolveTourneyStorePolicy(env);
  const relation = assignmentRelation(policy.primaryBackend);
  const leaseId = crypto.randomUUID();
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-claim:${expected.principalId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId });
      const rows = await sql`
        update ${sql(relation)} set
          status = 'processing', lease_id = ${leaseId},
          lease_expires_at = now() + interval '5 minutes',
          attempt_count = attempt_count + 1, last_error = null,
          blocked_at = null, updated_at = now()
        where principal_id = ${expected.principalId}
          and generation = ${expected.generation}
          and discord_user_id = ${expected.discordUserId}
          and desired_role = ${expected.desiredRole}
          and (
            status in ('pending', 'retry')
            or (status = 'processing' and lease_expires_at <= now())
          )
        returning principal_id, discord_user_id, previous_discord_user_id,
          stale_discord_user_ids, desired_role, generation, lease_id
      `;
      if (rows[0]) return normalizeAssignment(rows[0]);
      const currentRows = await sql`
        select principal_id, discord_user_id, desired_role, generation,
          status, lease_expires_at,
          greatest(
            1,
            ceil(extract(epoch from (lease_expires_at - now())) * 1000)
          )::bigint as retry_after_ms
        from ${sql(relation)}
        where principal_id = ${expected.principalId}
        for update
      `;
      const current = currentRows[0];
      const sameDesiredState = current &&
        Number(current.generation) === expected.generation &&
        normalize(current.discord_user_id) === expected.discordUserId &&
        normalize(current.desired_role) === expected.desiredRole;
      if (
        sameDesiredState && current.status === "processing" &&
        Date.parse(current.lease_expires_at) > Date.now()
      ) {
        return {
          busy: true,
          retryAfterMs: Number(current.retry_after_ms || 1),
        };
      }
      return { superseded: true };
    },
  });
};

export const withTourneyDiscordMutationFence = async ({
  assignment,
  env = process.env,
  callback,
} = {}) => {
  if (typeof callback !== "function") throw new Error("Discord mutation callback is required.");
  const expected = normalizeAssignment(assignment);
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return callback();
  }
  const policy = resolveTourneyStorePolicy(env);
  const relation = assignmentRelation(policy.primaryBackend);
  await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-mutation:${expected.principalId}`,
    waitForLock: true,
    callback: async (sql) => {
      const rows = await sql`
        select principal_id from ${sql(relation)}
        where principal_id = ${expected.principalId}
          and generation = ${expected.generation}
          and discord_user_id = ${expected.discordUserId}
          and desired_role = ${expected.desiredRole}
          and status = 'processing'
          and lease_id = ${expected.leaseId}
          and lease_expires_at > now()
        for update
      `;
      if (rows.length !== 1) {
        const error = new Error("Discord desired state generation changed.");
        error.code = "TOURNEY_DISCORD_GENERATION_CHANGED";
        throw error;
      }
      return true;
    },
  });
  const result = await callback();
  await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-mutation:${expected.principalId}`,
    waitForLock: true,
    callback: async (sql) => {
      const rows = await sql`
        select principal_id from ${sql(relation)}
        where principal_id = ${expected.principalId}
          and generation = ${expected.generation}
          and discord_user_id = ${expected.discordUserId}
          and desired_role = ${expected.desiredRole}
          and status = 'processing'
          and lease_id = ${expected.leaseId}
          and lease_expires_at > now()
        for update
      `;
      if (rows.length !== 1) {
        const error = new Error("Discord desired state generation changed.");
        error.code = "TOURNEY_DISCORD_GENERATION_CHANGED";
        throw error;
      }
    },
  });
  return result;
};

export const completeTourneyDiscordDesiredState = async ({
  assignment,
  status,
  errorCode = "",
  commandId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return true;
  const expected = normalizeAssignment(assignment);
  const policy = resolveTourneyStorePolicy(env);
  const relation = assignmentRelation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-complete:${expected.principalId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId });
      const rows = await sql`
        update ${sql(relation)} set
          applied_role = case when ${status} = 'applied'
            then ${expected.desiredRole} else applied_role end,
          applied_generation = case when ${status} = 'applied'
            then ${expected.generation} else applied_generation end,
          status = ${status},
          last_error = ${errorCode || null},
          blocked_at = case when ${status} = 'blocked_reauth' then now() else null end,
          applied_at = case when ${status} = 'applied' then now() else applied_at end,
          previous_discord_user_id = case when ${status} = 'applied'
            then null else previous_discord_user_id end,
          stale_discord_user_ids = case when ${status} = 'applied'
            then '{}'::text[] else stale_discord_user_ids end,
          lease_id = null, lease_expires_at = null, updated_at = now()
        where principal_id = ${expected.principalId}
          and generation = ${expected.generation}
          and lease_id = ${expected.leaseId}
        returning principal_id
      `;
      if (rows.length !== 1) {
        const error = new Error("Discord desired state generation changed.");
        error.code = "TOURNEY_DISCORD_GENERATION_CHANGED";
        throw error;
      }
      return true;
    },
  });
};

export const failTourneyDiscordDesiredState = async ({
  assignment,
  status,
  errorCode = "",
  commandId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return true;
  const expected = normalizeAssignment(assignment);
  const policy = resolveTourneyStorePolicy(env);
  const relation = assignmentRelation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-fail:${expected.principalId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId });
      const rows = await sql`
        update ${sql(relation)} set
          status = ${status}, last_error = ${errorCode || null},
          lease_id = null, lease_expires_at = null, updated_at = now()
        where principal_id = ${expected.principalId}
          and generation = ${expected.generation}
          and lease_id = ${expected.leaseId}
        returning principal_id
      `;
      return rows.length === 1;
    },
  });
};

export const projectTourneyDiscordOAuthDesiredState = async ({
  claimedUserId,
  commandId,
  intentId,
  operationKey,
  userId,
  env = process.env,
} = {}) => {
  const normalizedIntentId = normalize(intentId);
  const normalizedUserId = normalize(userId);
  const normalizedClaimedUserId = normalize(claimedUserId || userId);
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    const error = new Error("Discord OAuth projection requires Supabase primary.");
    error.code = "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE";
    throw error;
  }
  const normalizedOperationKey = normalize(operationKey);
  const canonicalSerializationKey = normalizedOperationKey
    ? await runTourneyTransaction({
        env,
        lockKey: `roo-tourney-discord-oauth-serialization:${normalizedIntentId}`,
        waitForLock: true,
        callback: async (sql) => {
          await setCommandContext({ sql, policy, commandId });
          const intents = await sql`
            select status, provider, target_user_id, claimed_user_id, principal_id
            from accounts.oauth_intents
            where id = ${normalizedIntentId}::uuid
            for update
          `;
          const intent = intents[0];
          const targetUserId = normalize(intent?.target_user_id);
          if (
            intent?.status !== "completed" || intent?.provider !== "discord" ||
            !intent.principal_id ||
            (targetUserId && targetUserId !== normalizedUserId) ||
            normalize(intent.claimed_user_id) !== normalizedClaimedUserId
          ) {
            return "";
          }
          const serializationKey = `discord:${intent.principal_id}`;
          const rows = await sql`
            update tourney.external_operations set
              serialization_key = ${serializationKey}, updated_at = now()
            where operation_key = ${normalizedOperationKey}
              and command_id = ${commandId}
              and operation_kind in ('discord_membership','discord_role_reconcile')
            returning operation_key
          `;
          return rows.length === 1 ? serializationKey : "";
        },
      })
    : "";
  const projected = await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-oauth:${normalizedIntentId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId });
      const intents = await sql`
        select status, expires_at, provider, flow, action, target_user_id,
          claimed_user_id, principal_id
        from accounts.oauth_intents where id = ${normalizedIntentId}::uuid
        for update
      `;
      const intent = intents[0];
      if (!intent || intent.provider !== "discord") return { superseded: true };
      if (intent.status !== "completed") {
        if (intent.status !== "pending" || Date.parse(intent.expires_at) <= Date.now()) {
          return { superseded: true };
        }
        const error = new Error("Discord OAuth finalization is still pending.");
        error.code = "TOURNEY_DISCORD_OAUTH_FINALIZATION_PENDING";
        throw error;
      }
      const targetUserId = normalize(intent.target_user_id);
      if (
        (targetUserId && targetUserId !== normalizedUserId) ||
        normalize(intent.claimed_user_id) !== normalizedClaimedUserId ||
        !intent.principal_id
      ) {
        const error = new Error("Discord OAuth projection user changed.");
        error.code = "TOURNEY_DISCORD_OAUTH_USER_CHANGED";
        throw error;
      }
      const accountRows = await sql`
        select user_id as account_user_id,
          case when role = 'tourney_player'
            then legacy_sanity_id else null end as player_id
        from accounts.tourney_accounts account
        where account.principal_id = ${intent.principal_id}::uuid
          and exists(
            select 1 from accounts.principal_auth_users mapping
            where mapping.user_id = ${normalizedClaimedUserId}::uuid
              and mapping.principal_id = account.principal_id
          )
        limit 1
      `;
      const account = accountRows[0];
      if (!account) {
        if (intent.flow === "tourney" && intent.action === "signup") {
          const secrets = await sql`
            select expires_at
            from tourney.external_operation_secrets
          where operation_key = ${normalizedOperationKey}
              and expires_at > now()
            limit 1
          `;
          const expiresAt = Date.parse(secrets[0]?.expires_at || "");
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            throw Object.assign(
              new Error("The Discord signup credential expired before registration completed."),
              {
                code: "TOURNEY_DISCORD_SIGNUP_CREDENTIAL_EXPIRED",
                nonRetryable: true,
              }
            );
          }
          const error = new Error("The Tourney account projection is still pending.");
          error.code = "TOURNEY_DISCORD_ACCOUNT_PROJECTION_PENDING";
          error.retryAfterMs = Math.min(
            5 * 60 * 1000,
            Math.max(1, expiresAt - Date.now())
          );
          throw error;
        }
        return { superseded: true, reason: "tourney_not_linked" };
      }
      const rows = await sql`
        select account.user_id as account_user_id,
          case when account.role = 'tourney_player'
            then account.legacy_sanity_id else null end as player_id,
          identity.provider_subject as discord_user_id,
          identity.metadata as identity_metadata
        from accounts.tourney_accounts account
        join accounts.identity_links identity
          on identity.principal_id = account.principal_id
         and identity.provider = 'discord'
        where account.principal_id = ${intent.principal_id}::uuid
        order by identity.last_seen_at desc nulls last
        limit 1
      `;
      const identity = rows[0];
      if (!identity?.discord_user_id) {
        const error = new Error("Discord identity projection is still pending.");
        error.code = "TOURNEY_DISCORD_IDENTITY_SYNC_PENDING";
        throw error;
      }
      const discordUser = {
        id: identity.discord_user_id,
        username: identity.identity_metadata?.username || "",
        global_name: identity.identity_metadata?.global_name || "",
      };
      if (identity.player_id) {
        const { recordTourneyPlayerDiscordLink } = await import("./playerStore.js");
        await recordTourneyPlayerDiscordLink({
          playerId: identity.player_id,
          discordUser,
          env,
        });
      }
      return recordTourneyDiscordDesiredState({
        accountUserId: identity.account_user_id,
        player: identity.player_id ? { id: identity.player_id } : undefined,
        discordUser,
        guildId: getTourneyDiscordRoleConfig(env).guildId,
        freshCredentials: true,
        env,
      });
    },
  });
  if (!canonicalSerializationKey || projected?.superseded) return projected;
  return { ...projected, canonicalSerializationKey };
};

export const resolveQueuedTourneyDiscordAuthProjectionAfterFinalizeFailure = async ({
  claimedUserId,
  commandId,
  intentId,
  userId,
  env = process.env,
} = {}) => {
  const normalizedCommandId = normalize(commandId);
  const normalizedIntentId = normalize(intentId);
  const normalizedUserId = normalize(userId);
  const normalizedClaimedUserId = normalize(claimedUserId || userId);
  const policy = resolveTourneyStorePolicy(env);
  if (
    policy.primaryBackend !== "supabase" || !normalizedCommandId ||
    !normalizedIntentId || !normalizedUserId
  ) {
    return { finalized: false, resolved: false };
  }
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-oauth-resolve:${normalizedIntentId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId: normalizedCommandId });
      const intents = await sql`
        select status, target_user_id, claimed_user_id, principal_id
        from accounts.oauth_intents
        where id = ${normalizedIntentId}::uuid
        for update
      `;
      const intent = intents[0];
      const completed = intent?.status === "completed" &&
        (!normalize(intent.target_user_id) ||
          normalize(intent.target_user_id) === normalizedUserId) &&
        normalize(intent.claimed_user_id) === normalizedClaimedUserId &&
        Boolean(intent.principal_id);
      if (completed) return { finalized: true, resolved: true };

      const operationTable = operationRelation(policy.primaryBackend);
      const resolved = await sql`
        update ${sql(operationTable)} set
          status = 'applied', completed_at = coalesce(completed_at, now()),
          lease_id = null, lease_expires_at = null,
          last_error_code = 'oauth_intent_not_finalized', updated_at = now()
        where command_id = ${normalizedCommandId}
          and operation_kind = 'discord_membership'
          and (
            status in ('pending','retry','dead_letter')
            or (status = 'processing' and lease_expires_at <= now())
          )
        returning operation_key
      `;
      if (resolved.length > 0) {
        await sql`
          delete from tourney.external_operation_secrets
          where operation_key in ${sql(resolved.map((row) => row.operation_key))}
        `;
      }
      const receiptTable = receiptRelation(policy.primaryBackend);
      const emailTable = emailRelation(policy.primaryBackend);
      await sql`
        update ${sql(receiptTable)} receipt set
          status = 'completed', completed_at = coalesce(completed_at, now()),
          updated_at = now()
        where receipt.command_id = ${normalizedCommandId}
          and receipt.status = 'committed'
          and not exists (
            select 1 from ${sql(operationTable)} operation
            where operation.command_id = receipt.command_id
              and operation.status <> 'applied'
          )
          and not exists (
            select 1 from ${sql(emailTable)} dispatch
            where dispatch.command_id = receipt.command_id
              and dispatch.status not in ('sent','historical_unknown','expired')
          )
      `;
      return { finalized: false, resolved: resolved.length > 0 };
    },
  });
};

export const queueTourneyDiscordIdentityUnlinkProjection = async ({
  accessToken,
  commandId,
  expiresAt,
  identityId,
  provider,
  reauthTokenHash,
  userId,
  env = process.env,
} = {}) => {
  const normalizedUserId = normalize(userId);
  const normalizedProvider = normalize(provider).toLowerCase();
  const normalizedReauthTokenHash = normalize(reauthTokenHash).toLowerCase();
  const normalizedIdentityId = normalize(identityId);
  if (
    !normalizedUserId || !normalizedIdentityId ||
    (normalizedIdentityId !== "already-unlinked" && !normalizedReauthTokenHash) ||
    !["discord", "google"].includes(normalizedProvider)
  ) {
    throw new Error("Identity unlink projection is invalid.");
  }
  return executeTourneyCommand({
    commandId,
    purpose: "identity:unlink",
    requestPayload: {
      provider: normalizedProvider,
      reauthTokenHash: normalizedReauthTokenHash,
      userId: normalizedUserId,
    },
    env,
    callback: async () => {
      if (
        normalizedIdentityId !== "already-unlinked" &&
        env.NODE_ENV !== "test" && env.TOURNEY_DATABASE_MODE !== "memory"
      ) {
        const sql = await getTourneySql(env);
        const grants = await sql`
          update accounts.reauth_grants grant_row set used_at = now()
          where grant_row.token_hash = ${normalizedReauthTokenHash}
            and grant_row.user_id = ${normalizedUserId}::uuid
            and grant_row.purpose = 'unlink_identity'
            and grant_row.provider is not distinct from ${normalizedProvider}
            and grant_row.used_at is null and grant_row.expires_at > now()
          returning grant_row.id
        `;
        if (grants.length !== 1) {
          throw Object.assign(new Error("Recent authentication is required."), {
            code: "42501",
            status: 409,
          });
        }
      }
      await enqueueTourneyIdentityUnlinkOperation({
        accessToken,
        commandId,
        expiresAt,
        identityId: normalizedIdentityId,
        provider: normalizedProvider,
        userId: normalizedUserId,
        env,
      });
      return { body: { ok: true, provider: normalizedProvider } };
    },
  });
};

export const completeTourneyIdentityUnlinkProjection = async ({
  commandId,
  provider,
  userId,
  env = process.env,
} = {}) => {
  const normalizedProvider = normalize(provider).toLowerCase();
  const normalizedUserId = normalize(userId);
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase" || !normalizedUserId) {
    throw new Error("Identity unlink projection requires Supabase primary.");
  }
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-identity-unlink-project:${normalizedUserId}`,
    waitForLock: true,
    callback: async (sql) => {
      await setCommandContext({ sql, policy, commandId });
      await sql`
        select public.roo_reconcile_auth_identity_links(
          ${normalizedUserId}::uuid
        )
      `;
      const config = getTourneyDiscordRoleConfig(env);
      if (normalizedProvider !== "discord" || !config.enabled) {
        return { queued: false, provider: normalizedProvider };
      }
      const rows = await sql`
        select public.roo_refresh_discord_role_assignment(
          ${normalizedUserId}::uuid,
          ${config.guildId}
        ) as assignment
      `;
      const assignment = rows[0]?.assignment;
      if (assignment?.queued !== true) {
        return { queued: false, provider: normalizedProvider };
      }
      await enqueueTourneyExternalOperation({
        commandId,
        operationKind: "discord_role_reconcile",
        entityType: "account",
        entityId: normalizedUserId,
        desiredState: { assignment: normalizeAssignment(assignment) },
        env,
      });
      return { queued: true, provider: normalizedProvider };
    },
  });
};

export const queueTourneyDiscordAuthProjection = async ({
  accountUserId = "",
  accessToken = "",
  attemptExternalWork = true,
  claimedUserId = "",
  commandId = "",
  deferUntil = "",
  env = process.env,
  intentId,
  userId,
} = {}) => {
  const normalizedUserId = normalize(accountUserId || userId);
  const normalizedClaimedUserId = normalize(claimedUserId || userId);
  const normalizedIntentId = normalize(intentId);
  if (!normalizedUserId || !normalizedClaimedUserId || !normalizedIntentId) {
    return { applied: false, reason: "not_linked" };
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    return { applied: false, reason: "oauth_temporarily_unavailable" };
  }
  const config = getTourneyDiscordRoleConfig(env);
  if (!config.enabled) return { applied: false, reason: "not_configured" };
  const semanticCommandId = normalize(commandId) ||
    `discord-oauth:${normalizedIntentId}:${normalizedUserId}`;
  if (attemptExternalWork) {
    await rearmTourneyDiscordOperationWithAccessToken({
      accessToken,
      commandId: semanticCommandId,
      entityType: "account",
      entityId: normalizedUserId,
      env,
    });
    await supersedeQueuedDiscordOperationsForCommand({
      commandId: semanticCommandId,
      env,
    });
  }
  const command = await executeTourneyCommand({
    commandId: semanticCommandId,
    purpose: "discord:link",
    requestPayload: {
      intentId: normalizedIntentId,
      claimedUserId: normalizedClaimedUserId,
      userId: normalizedUserId,
    },
    env,
    attemptExternalWork,
    postCommitContext: {
      discordAccessTokens: { [normalizedUserId]: normalize(accessToken) },
    },
    callback: async () => {
      const sql = await getTourneySql(env);
      const [principal] = await sql`
        select principal_id from accounts.principal_auth_users
        where user_id = ${normalizedUserId}
        order by is_primary desc
        limit 1
      `;
      const operation = await enqueueTourneyExternalOperation({
        commandId: semanticCommandId,
        operationKind: "discord_membership",
        entityType: "account",
        entityId: normalizedUserId,
        desiredState: {
          oauthProjection: {
            intentId: normalizedIntentId,
            userId: normalizedUserId,
            accountUserId: normalizedUserId,
            claimedUserId: normalizedClaimedUserId,
            principalId: normalize(principal?.principal_id),
          },
        },
        nextAttemptAt: deferUntil,
        env,
      });
      if (normalize(accessToken)) {
        await saveTourneyDiscordOperationAccessToken({
          accessToken,
          operationKey: operation.operation_key,
          env,
        });
      }
      return { body: { ok: true } };
    },
  });
  return {
    applied: !command.syncPending,
    reason: command.syncPending ? "pending" : "applied",
  };
};
