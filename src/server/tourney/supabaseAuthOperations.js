import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { runSupabaseTourneyTransaction } from "./sqlClient.js";

const LEASE_MS = 2 * 60 * 1000;
const nowIso = () => new Date().toISOString();

const conflict = (message, code) => {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
};

const operationProjection = (row = {}) => ({
  id: row.id,
  key: row.operation_key,
  playerId: row.player_id,
  tokenId: row.token_id || "",
  kind: row.operation_kind,
  desiredStatus: row.desired_status || "",
  desiredCredentialVersion: row.desired_credential_version || "",
  passwordHash: row.password_hash || "",
  payload: row.operation_payload || {},
  status: row.operation_status,
  leaseId: row.lease_id || "",
  leaseExpiresAt: row.lease_expires_at || "",
});

const playerColumns = `
  id, username, email, password_hash, status, discord, display_name,
  discord_key, battlenet, rank_name, role_play, secondary_role_play,
  approved_role_play, registration_pool, time_zone, twitch_username,
  team_name, available_aug_1_2, accepted_rules, accepted_roo_visibility,
  notes, version, created_at, updated_at, approved_at, approved_by,
  denied_at, denied_by, removed_at, removed_by, withdrawn_at, withdrawn_by,
  discord_invite_sent_at, discord_invite_email_id,
  discord_invite_last_error, discord_user_id, discord_oauth_username,
  discord_oauth_global_name, discord_linked_at, discord_role_assigned_at,
  discord_role_last_error
`;

const selectOperation = async ({ sql, operationKey }) => {
  const rows = await sql`
    select id, operation_key, player_id, token_id, operation_kind,
      desired_status, desired_credential_version, password_hash,
      operation_payload, operation_status, lease_id, lease_expires_at
    from tourney.tourney_player_auth_operations
    where operation_key = ${operationKey}
    limit 1
    for update
  `;
  return rows?.[0] || null;
};

const selectPlayer = async ({ sql, playerId, forUpdate = false }) => {
  const rows = forUpdate
    ? await sql.unsafe(
        `select ${playerColumns} from tourney.tourney_players where id = $1 limit 1 for update`,
        [playerId]
      )
    : await sql.unsafe(
        `select ${playerColumns} from tourney.tourney_players where id = $1 limit 1`,
        [playerId]
      );
  return rows?.[0] || null;
};

const assertLeaseAvailable = (operation) => {
  const expiresAt = new Date(operation?.lease_expires_at || "").getTime();
  if (
    operation?.operation_status === "processing" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now()
  ) {
    throw conflict(
      "This Tourney account change is already in progress.",
      "TOURNEY_AUTH_OPERATION_IN_PROGRESS"
    );
  }
};

export const claimSupabaseRegistrationDecision = async ({
  playerId,
  tokenHash = "",
  purpose,
  actorUsername,
  resolveDecision,
  env = process.env,
} = {}) =>
  runSupabaseTourneyTransaction({
    env,
    lockKey: "roo-tourney-registration-decisions",
    callback: async (sql) => {
      const operationKey = `decision:${playerId}`;
      let operation = await selectOperation({ sql, operationKey });
      if (operation?.operation_status === "completed") {
        return {
          operation: operationProjection(operation),
          player: await selectPlayer({ sql, playerId }),
          completed: true,
        };
      }
      if (operation?.operation_status === "auth_applied") {
        return {
          operation: operationProjection(operation),
          player: await selectPlayer({ sql, playerId }),
          authApplied: true,
        };
      }
      if (operation) assertLeaseAvailable(operation);

      const player = await selectPlayer({ sql, playerId, forUpdate: true });
      if (!player || player.status !== "pending") {
        throw conflict(
          "Registration is no longer pending.",
          "TOURNEY_DECISION_NOT_PENDING"
        );
      }

      let token = null;
      if (tokenHash) {
        const tokens = await sql`
          select id, player_id, purpose, used_at
          from tourney.tourney_player_tokens
          where token_hash = ${tokenHash}
            and player_id = ${playerId}
            and purpose = ${purpose}
          limit 1
          for update
        `;
        token = tokens?.[0] || null;
        if (!token || token.used_at) {
          throw conflict(
            "Registration decision token is no longer valid.",
            "TOURNEY_DECISION_TOKEN_USED"
          );
        }
      }

      const reservations = await sql`
        select operation_payload
        from tourney.tourney_player_auth_operations
        where operation_kind = 'decision'
          and desired_status = 'approved'
          and operation_status in ('pending', 'processing', 'auth_applied', 'retry')
          and player_id <> ${playerId}
      `;
      const decision = await resolveDecision({ player, reservations });
      const leaseId = crypto.randomUUID();
      const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      const payload = {
        actorUsername,
        approvedRolePlay: decision.approvedRolePlay || "",
        registrationPool: decision.registrationPool || player.registration_pool,
      };

      if (operation) {
        if (
          operation.desired_status !== decision.status ||
          operation.operation_payload?.approvedRolePlay !== payload.approvedRolePlay
        ) {
          throw conflict(
            "The registration decision changed after it was claimed.",
            "TOURNEY_DECISION_CHANGED"
          );
        }
        const rows = await sql`
          update tourney.tourney_player_auth_operations
          set operation_status = 'processing', lease_id = ${leaseId},
              lease_expires_at = ${leaseExpiresAt}, attempt_count = attempt_count + 1,
              next_attempt_at = now(), last_error = null, updated_at = now()
          where id = ${operation.id}
          returning id, operation_key, player_id, token_id, operation_kind,
            desired_status, desired_credential_version, password_hash,
            operation_payload, operation_status, lease_id, lease_expires_at
        `;
        operation = rows[0];
      } else {
        const rows = await sql`
          insert into tourney.tourney_player_auth_operations (
            operation_key, player_id, token_id, operation_kind, desired_status,
            desired_role, desired_credential_version, operation_payload,
            operation_status, lease_id, lease_expires_at, attempt_count
          ) values (
            ${operationKey}, ${playerId}, ${token?.id || null}, 'decision',
            ${decision.status}, 'player', ${String(Number(player.version || 1) + 1)},
            ${JSON.stringify(payload)}::jsonb, 'processing', ${leaseId},
            ${leaseExpiresAt}, 1
          )
          returning id, operation_key, player_id, token_id, operation_kind,
            desired_status, desired_credential_version, password_hash,
            operation_payload, operation_status, lease_id, lease_expires_at
        `;
        operation = rows[0];
      }
      return { operation: operationProjection(operation), player };
    },
  });

export const finalizeSupabaseRegistrationDecision = async ({
  operation,
  env = process.env,
} = {}) =>
  runSupabaseTourneyTransaction({
    env,
    lockKey: "roo-tourney-registration-decisions",
    callback: async (sql) => {
      const current = await selectOperation({ sql, operationKey: operation.key });
      if (!current) throw conflict("Decision operation was lost.", "TOURNEY_AUTH_OPERATION_MISSING");
      if (["auth_applied", "completed"].includes(current.operation_status)) {
        return selectPlayer({ sql, playerId: current.player_id });
      }
      if (
        current.operation_status !== "processing" ||
        String(current.lease_id || "") !== String(operation.leaseId || "")
      ) {
        throw conflict("Decision operation lease changed.", "TOURNEY_AUTH_LEASE_CHANGED");
      }
      const payload = current.operation_payload || {};
      const now = nowIso();
      const rows = current.desired_status === "approved"
        ? await sql`
            update tourney.tourney_players
            set status = 'approved',
                approved_role_play = ${payload.approvedRolePlay || ""},
                registration_pool = ${payload.registrationPool || "main"},
                approved_at = ${now}, approved_by = ${payload.actorUsername || ""},
                updated_at = ${now}, version = version + 1
            where id = ${current.player_id} and status = 'pending'
            returning ${sql(playerColumns.split(",").map((value) => value.trim()))}
          `
        : await sql`
            update tourney.tourney_players
            set status = 'denied', denied_at = ${now},
                denied_by = ${payload.actorUsername || ""}, updated_at = ${now},
                version = version + 1
            where id = ${current.player_id} and status = 'pending'
            returning ${sql(playerColumns.split(",").map((value) => value.trim()))}
          `;
      if (!rows?.[0]) {
        throw conflict("Registration is no longer pending.", "TOURNEY_DECISION_NOT_PENDING");
      }
      await sql`
        update tourney.tourney_player_tokens
        set used_at = ${now}, used_by = ${payload.actorUsername || ""}
        where player_id = ${current.player_id}
          and purpose in ('approve', 'deny') and used_at is null
      `;
      await sql`
        update tourney.tourney_player_auth_operations
        set operation_status = 'auth_applied', lease_id = null,
            lease_expires_at = null, next_attempt_at = now(), updated_at = now()
        where id = ${current.id}
      `;
      return rows[0];
    },
  });

export const claimSupabasePasswordReset = async ({
  tokenHash,
  password,
  passwordHash,
  env = process.env,
} = {}) =>
  runSupabaseTourneyTransaction({
    env,
    lockKey: `roo-tourney-password-reset:${tokenHash}`,
    callback: async (sql) => {
      const tokens = await sql`
        select id, player_id, used_at, expires_at
        from tourney.tourney_player_tokens
        where token_hash = ${tokenHash} and purpose = 'reset'
        limit 1
        for update
      `;
      const token = tokens?.[0];
      if (!token) throw conflict("Invalid or expired reset link.", "TOURNEY_RESET_INVALID");
      const operationKey = `reset:${token.id}`;
      let operation = await selectOperation({ sql, operationKey });
      if (operation?.password_hash) {
        const matches = await bcrypt.compare(String(password || ""), operation.password_hash);
        if (!matches) {
          throw conflict(
            "This reset link is already processing a different password.",
            "TOURNEY_RESET_PASSWORD_CHANGED"
          );
        }
      }
      if (operation?.operation_status === "completed") {
        return {
          operation: operationProjection(operation),
          player: await selectPlayer({ sql, playerId: token.player_id }),
          completed: true,
        };
      }
      if (operation?.operation_status === "auth_applied") {
        return {
          operation: operationProjection(operation),
          player: await selectPlayer({ sql, playerId: token.player_id }),
          authApplied: true,
        };
      }
      if (operation) assertLeaseAvailable(operation);
      if (token.used_at || new Date(token.expires_at).getTime() <= Date.now()) {
        throw conflict("Invalid or expired reset link.", "TOURNEY_RESET_INVALID");
      }
      const player = await selectPlayer({ sql, playerId: token.player_id, forUpdate: true });
      if (!player || player.status !== "approved") {
        throw conflict("Invalid or expired reset link.", "TOURNEY_RESET_INVALID");
      }
      const leaseId = crypto.randomUUID();
      const leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
      if (operation) {
        const rows = await sql`
          update tourney.tourney_player_auth_operations
          set operation_status = 'processing', lease_id = ${leaseId},
              lease_expires_at = ${leaseExpiresAt}, attempt_count = attempt_count + 1,
              next_attempt_at = now(), last_error = null, updated_at = now()
          where id = ${operation.id}
          returning id, operation_key, player_id, token_id, operation_kind,
            desired_status, desired_credential_version, password_hash,
            operation_payload, operation_status, lease_id, lease_expires_at
        `;
        operation = rows[0];
      } else {
        const rows = await sql`
          insert into tourney.tourney_player_auth_operations (
            operation_key, player_id, token_id, operation_kind,
            desired_credential_version, password_hash, operation_status,
            lease_id, lease_expires_at, attempt_count
          ) values (
            ${operationKey}, ${player.id}, ${token.id}, 'password_reset',
            ${String(Number(player.version || 1) + 1)}, ${passwordHash},
            'processing', ${leaseId}, ${leaseExpiresAt}, 1
          )
          returning id, operation_key, player_id, token_id, operation_kind,
            desired_status, desired_credential_version, password_hash,
            operation_payload, operation_status, lease_id, lease_expires_at
        `;
        operation = rows[0];
      }
      return { operation: operationProjection(operation), player };
    },
  });

export const finalizeSupabasePasswordReset = async ({
  operation,
  env = process.env,
} = {}) =>
  runSupabaseTourneyTransaction({
    env,
    lockKey: `roo-tourney-password-reset:${operation.key}`,
    callback: async (sql) => {
      const current = await selectOperation({ sql, operationKey: operation.key });
      if (!current) throw conflict("Reset operation was lost.", "TOURNEY_AUTH_OPERATION_MISSING");
      if (["auth_applied", "completed"].includes(current.operation_status)) {
        return selectPlayer({ sql, playerId: current.player_id });
      }
      if (
        current.operation_status !== "processing" ||
        String(current.lease_id || "") !== String(operation.leaseId || "")
      ) {
        throw conflict("Reset operation lease changed.", "TOURNEY_AUTH_LEASE_CHANGED");
      }
      const now = nowIso();
      const rows = await sql`
        update tourney.tourney_players
        set password_hash = ${current.password_hash}, updated_at = ${now},
            version = version + 1
        where id = ${current.player_id} and status = 'approved'
        returning ${sql(playerColumns.split(",").map((value) => value.trim()))}
      `;
      if (!rows?.[0]) throw conflict("Invalid reset account.", "TOURNEY_RESET_INVALID");
      await sql`
        update tourney.tourney_player_tokens
        set used_at = ${now}, used_by = ${rows[0].username}
        where id = ${current.token_id} and used_at is null
      `;
      await sql`
        update tourney.tourney_player_auth_operations
        set operation_status = 'auth_applied', lease_id = null,
            lease_expires_at = null, next_attempt_at = now(), updated_at = now()
        where id = ${current.id}
      `;
      return rows[0];
    },
  });

export const markSupabaseAuthOperationRetry = async ({
  operationKey,
  errorCode = "AUTH_SYNC_FAILED",
  env = process.env,
} = {}) => {
  const result = await runSupabaseTourneyTransaction({
    env,
    lockKey: `roo-tourney-auth-operation:${operationKey}`,
    callback: async (sql) => sql`
      update tourney.tourney_player_auth_operations
      set operation_status = 'retry', lease_id = null, lease_expires_at = null,
          next_attempt_at = now() + interval '1 minute',
          last_error = ${String(errorCode || "AUTH_SYNC_FAILED").slice(0, 240)},
          updated_at = now()
      where operation_key = ${operationKey}
        and operation_status = 'processing'
      returning id
    `,
  });
  return Boolean(result?.[0]);
};

export const completeSupabaseAuthOperation = async ({
  operationKey,
  env = process.env,
} = {}) => {
  const result = await runSupabaseTourneyTransaction({
    env,
    lockKey: `roo-tourney-auth-operation:${operationKey}`,
    callback: async (sql) => sql`
      update tourney.tourney_player_auth_operations
      set operation_status = 'completed', completed_at = now(),
          lease_id = null, lease_expires_at = null, last_error = null,
          updated_at = now()
      where operation_key = ${operationKey}
        and operation_status in ('auth_applied', 'completed')
      returning id
    `,
  });
  return Boolean(result?.[0]);
};
