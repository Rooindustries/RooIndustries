import crypto from "node:crypto";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import { getTourneySql, runTourneyTransaction } from "./sqlClient.js";
import { resolveTourneyStorePolicy } from "./store.js";
import { stableTourneyJson } from "./canonical.js";

const normalize = (value) => String(value || "").trim();
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const relation = (backend) => backend === "supabase"
  ? "tourney.external_operations"
  : "tourney_external_operations";

const MEMORY_OPERATIONS = globalThis.__rooTourneyExternalOperations ||
  (globalThis.__rooTourneyExternalOperations = new Map());

export const enqueueTourneyExternalOperation = async ({
  commandId,
  operationKind,
  entityType,
  entityId,
  desiredState = {},
  maxAttempts = 12,
  env = process.env,
} = {}) => {
  const normalizedCommandId = normalize(commandId);
  const normalizedKind = normalize(operationKind);
  const normalizedEntityType = normalize(entityType);
  const normalizedEntityId = normalize(entityId);
  if (!normalizedCommandId || !normalizedKind || !normalizedEntityType || !normalizedEntityId) {
    throw new Error("A complete Tourney external operation is required.");
  }
  const desiredStateHash = sha256(stableTourneyJson(desiredState));
  const operationKey = [
    normalizedCommandId,
    normalizedKind,
    normalizedEntityType,
    normalizedEntityId,
    desiredStateHash.slice(0, 24),
  ].join(":");
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const existing = MEMORY_OPERATIONS.get(operationKey);
    if (existing) return existing;
    const created = {
      operation_key: operationKey,
      status: "pending",
      desired_state_hash: desiredStateHash,
    };
    MEMORY_OPERATIONS.set(operationKey, created);
    return created;
  }
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const sql = await getTourneySql(env);
  const rows = await sql`
    insert into ${sql(table)} (
      operation_key, command_id, operation_kind, entity_type, entity_id,
      desired_state, desired_state_hash, max_attempts
    ) values (
      ${operationKey}, ${normalizedCommandId}, ${normalizedKind},
      ${normalizedEntityType}, ${normalizedEntityId}, ${sql.json(desiredState)},
      ${desiredStateHash}, ${Math.max(1, Math.min(100, Number(maxAttempts) || 12))}
    )
    on conflict (operation_key) do update set updated_at = now()
    returning *
  `;
  return rows[0];
};

const claimOperations = async ({ env, limit, commandId = "" }) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const leaseId = crypto.randomUUID();
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-external-claim:${commandId || "queue"}`,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${`external-claim:${leaseId}`},true)
      `;
      const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
      const rows = commandId
        ? await sql`
            select * from ${sql(table)}
            where command_id = ${commandId} and (
              (status in ('pending','retry') and next_attempt_at <= now())
              or (status = 'processing' and lease_expires_at <= now())
            )
            order by created_at, operation_key
            for update skip locked limit ${safeLimit}
          `
        : await sql`
            select * from ${sql(table)}
            where (status in ('pending','retry') and next_attempt_at <= now())
               or (status = 'processing' and lease_expires_at <= now())
            order by next_attempt_at, created_at, operation_key
            for update skip locked limit ${safeLimit}
          `;
      if (rows.length === 0) return [];
      const keys = rows.map((row) => row.operation_key);
      await sql`
        update ${sql(table)} set
          status = 'processing', lease_id = ${leaseId},
          lease_expires_at = now() + interval '5 minutes',
          attempt_count = attempt_count + 1, updated_at = now()
        where operation_key in ${sql(keys)}
      `;
      return rows.map((row) => ({
        ...row,
        lease_id: leaseId,
        attempt_count: Number(row.attempt_count || 0) + 1,
      }));
    },
  });
};

const executeOperation = async ({ operation, env, context = {} }) => {
  const state = operation.desired_state || {};
  switch (operation.operation_kind) {
    case "supabase_player_auth": {
      const { syncSupabaseTourneyPlayerAccount } = await import("../supabase/accounts.js");
      const synced = await syncSupabaseTourneyPlayerAccount({
        player: state.player,
        passwordHash: state.player?.password_hash,
        authUserId: state.authUserId || "",
        installPassword: state.installPassword !== false,
        env,
      });
      if (synced.principalId) {
        const policy = resolveTourneyStorePolicy(env);
        const playerTable = policy.primaryBackend === "supabase"
          ? "tourney.tourney_players"
          : "tourney_players";
        await runTourneyTransaction({
          env,
          lockKey: `roo-tourney-player-principal:${operation.entity_id}`,
          callback: async (sql) => {
            await sql`
              select
                set_config('roo.tourney_backend',${policy.primaryBackend},true),
                set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
                set_config('roo.tourney_generation',${String(policy.generation)},true),
                set_config('roo.tourney_command_id',${operation.command_id},true)
            `;
            await sql`
              update ${sql(playerTable)} set principal_id = ${synced.principalId}
              where id = ${operation.entity_id}
                and principal_id is distinct from ${synced.principalId}
            `;
          },
        });
      }
      return synced;
    }
    case "supabase_admin_auth": {
      const { syncSupabaseTourneyAdminAccount } = await import("../supabase/accounts.js");
      const synced = await syncSupabaseTourneyAdminAccount({ account: state.account, env });
      const principalId = synced.account?.principal_id || "";
      if (principalId) {
        const [{ executeTourneyCommand }, { appendTourneyAccountPrincipalSnapshot }] =
          await Promise.all([import("./store.js"), import("./accountStore.js")]);
        const username = String(state.account?.username || "").trim().toLowerCase();
        const principalCommand = await executeTourneyCommand({
          commandId: `account-principal:${username}:${principalId}`,
          purpose: "identity:account-principal",
          requestPayload: { username, principalId },
          maintenanceWhilePaused: true,
          env,
          callback: async () => ({
            body: await appendTourneyAccountPrincipalSnapshot({
              username,
              principalId,
              env,
            }),
          }),
        });
        if (principalCommand.syncPending) {
          throw Object.assign(new Error("Tourney account principal synchronization is pending."), {
            code: "TOURNEY_ACCOUNT_PRINCIPAL_SYNC_PENDING",
          });
        }
      }
      return synced;
    }
    case "sanity_account_projection": {
      const { projectTourneyAccountSnapshotToSanity } = await import("./accountStore.js");
      return projectTourneyAccountSnapshotToSanity({
        accountsJson: state.accountsJson,
        actorUsername: state.actorUsername,
        env,
      });
    }
    case "discord_membership":
    case "discord_role_reconcile": {
      const { applyTourneyDiscordDesiredState } = await import("./discordRoleSync.js");
      const { completeTourneyDiscordDesiredState } = await import("./discordDesiredState.js");
      const result = await applyTourneyDiscordDesiredState({
        accessToken: context.discordAccessTokens?.[operation.entity_id] || "",
        assignment: state.assignment,
        env,
      });
      const blocked = result.reason === "blocked_reauth";
      if (!result.applied && !blocked) {
        throw Object.assign(new Error("Discord desired state is not ready."), {
          code: result.reason || "discord_desired_state_not_applied",
        });
      }
      await completeTourneyDiscordDesiredState({
        assignment: state.assignment,
        status: blocked ? "blocked_reauth" : "applied",
        errorCode: blocked ? "discord_membership_reauth_required" : "",
        commandId: operation.command_id,
        env,
      });
      return result;
    }
    default:
      throw Object.assign(new Error("Unsupported Tourney external operation."), {
        code: "TOURNEY_EXTERNAL_OPERATION_UNSUPPORTED",
      });
  }
};

const finishOperation = async ({ operation, status, errorCode = "", env }) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-external-finish:${operation.operation_key}`,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${operation.command_id || `external:${operation.operation_key}`},true)
      `;
      const rows = await sql`
        update ${sql(table)} set
          status = ${status},
          completed_at = case when ${status} = 'applied' then now() else completed_at end,
          next_attempt_at = case when ${status} = 'retry'
            then now() + make_interval(secs => least(3600, 2 ^ least(attempt_count, 11)))
            else next_attempt_at end,
          lease_id = null, lease_expires_at = null,
          last_error_code = ${errorCode || null}, updated_at = now()
        where operation_key = ${operation.operation_key}
          and status = 'processing' and lease_id = ${operation.lease_id}
        returning operation_key
      `;
      if (rows.length !== 1) {
        const error = new Error("Tourney external operation lease changed.");
        error.code = "TOURNEY_EXTERNAL_LEASE_MISMATCH";
        throw error;
      }
    },
  });
};

export const reconcileTourneyExternalOperations = async ({
  env = process.env,
  limit = 10,
  commandId = "",
  context = {},
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return { claimed: 0, applied: 0, retried: 0, deadLettered: 0 };
  }
  const operations = await claimOperations({ env, limit, commandId });
  let applied = 0;
  let retried = 0;
  let deadLettered = 0;
  for (const operation of operations) {
    try {
      await executeOperation({ operation, env, context });
      await finishOperation({ operation, status: "applied", env });
      applied += 1;
    } catch (error) {
      logSafeError("Tourney external operation failed", error);
      const terminal = Number(operation.attempt_count) >= Number(operation.max_attempts || 12);
      await finishOperation({
        operation,
        status: terminal ? "dead_letter" : "retry",
        errorCode: getSafeErrorCode(error, "tourney_external_operation_failed").slice(0, 128),
        env,
      });
      if (terminal) deadLettered += 1;
      else retried += 1;
    }
  }
  return { claimed: operations.length, applied, retried, deadLettered };
};

export const hasPendingTourneyExternalOperations = async ({
  commandId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return false;
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const sql = await getTourneySql(env);
  const [row] = await sql`
    select exists(
      select 1 from ${sql(table)}
      where command_id = ${commandId}
        and status in ('pending','processing','retry','dead_letter')
    ) as pending
  `;
  return row?.pending === true;
};
