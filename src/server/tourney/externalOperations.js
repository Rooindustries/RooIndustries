import crypto from "node:crypto";
import { getSafeErrorCode, logSafeError } from "../safeErrorLog.js";
import { getTourneySql, runTourneyTransaction } from "./sqlClient.js";
import { resolveTourneyStorePolicy } from "./store.js";
import { getTourneyDiscordRoleConfig } from "./discordConfig.js";
import { isEnabledTourneyFlag, stableTourneyJson } from "./canonical.js";

const normalize = (value) => String(value || "").trim();
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const resolveOperationSecretKey = (env = process.env) => {
  const material = normalize(
    env.TOURNEY_SESSION_SECRET || env.SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (!material) throw new Error("Tourney external-operation encryption is not configured.");
  return crypto.createHash("sha256").update(material).digest();
};
const encryptOperationSecret = ({ payload, env }) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", resolveOperationSecretKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((value) => value.toString("base64url"))
    .join(".");
};
const decryptOperationSecret = ({ encryptedPayload, env }) => {
  const [iv, tag, ciphertext] = normalize(encryptedPayload).split(".");
  if (!iv || !tag || !ciphertext) throw new Error("Tourney external-operation secret is invalid.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    resolveOperationSecretKey(env),
    Buffer.from(iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8"));
};
const normalizeTimestamp = (value) => {
  const timestamp = Date.parse(normalize(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
};
const relation = (backend) => backend === "supabase"
  ? "tourney.external_operations"
  : "tourney_external_operations";
const DISCORD_OPERATION_KINDS = Object.freeze([
  "discord_membership",
  "discord_role_reconcile",
]);
const REPLACEABLE_PROJECTION_KINDS = Object.freeze([
  "supabase_player_auth",
  "supabase_admin_auth",
  "sanity_account_projection",
  ...DISCORD_OPERATION_KINDS,
]);
const REPAIR_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const repairError = (message, { code, status = 409 } = {}) => Object.assign(
  new Error(message),
  { code, status }
);

const normalizeRepairToken = (value, { field, maxLength }) => {
  const token = normalize(value);
  if (
    token.length < 3 || token.length > maxLength ||
    !REPAIR_TOKEN_PATTERN.test(token)
  ) {
    throw repairError(`Tourney repair ${field} is invalid.`, {
      code: `TOURNEY_REPAIR_${field.toUpperCase()}_INVALID`,
      status: 400,
    });
  }
  return token;
};

const controlRelation = (backend) => backend === "supabase"
  ? "tourney.cutover_metadata"
  : "tourney_cutover_metadata";
const auditRelation = (backend) => backend === "supabase"
  ? "tourney.cutover_gate_events"
  : "tourney_cutover_gate_events";

export const runAuditedTourneyQueueRepair = async ({
  actor,
  callback,
  env = process.env,
  reason,
  targetId,
  targetType,
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Tourney queue repair callback is required.");
  }
  const normalizedActor = normalizeRepairToken(actor, {
    field: "actor",
    maxLength: 64,
  });
  const normalizedReason = normalizeRepairToken(reason, {
    field: "reason",
    maxLength: 128,
  });
  const normalizedTargetId = normalize(targetId);
  const normalizedTargetType = normalizeRepairToken(targetType, {
    field: "target_type",
    maxLength: 64,
  });
  if (!normalizedTargetId || normalizedTargetId.length > 512) {
    throw repairError("Tourney repair target is invalid.", {
      code: "TOURNEY_REPAIR_TARGET_INVALID",
      status: 400,
    });
  }
  if (!isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED)) {
    throw repairError("Tourney hardening is not active.", {
      code: "TOURNEY_HARDENING_INACTIVE",
      status: 503,
    });
  }
  const policy = resolveTourneyStorePolicy(env);
  if (!policy.writesPaused) {
    throw repairError("Tourney writes must be paused before queue repair.", {
      code: "TOURNEY_REPAIR_WRITES_NOT_PAUSED",
      status: 409,
    });
  }
  const controlTable = controlRelation(policy.primaryBackend);
  const auditTable = auditRelation(policy.primaryBackend);
  const targetHash = sha256(`${normalizedTargetType}:${normalizedTargetId}`);
  const repairCommandId = `repair:${normalizedTargetType}:${targetHash.slice(0, 32)}`;
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-queue-repair:${normalizedTargetType}:${targetHash}`,
    waitForLock: true,
    callback: async (sql) => {
      const controls = await sql`
        select primary_backend, generation, writes_paused, hardened_active
        from ${sql(controlTable)}
        where id = 'tourney'
        for update
      `;
      const control = controls[0];
      if (!control) {
        throw repairError("Tourney cutover controls are unavailable.", {
          code: "TOURNEY_CONTROL_UNAVAILABLE",
          status: 503,
        });
      }
      if (
        normalize(control.primary_backend).toLowerCase() !== policy.primaryBackend ||
        Number(control.generation) !== policy.generation
      ) {
        throw repairError("Tourney runtime authority does not match database controls.", {
          code: "TOURNEY_CONTROL_MISMATCH",
          status: 503,
        });
      }
      if (control.writes_paused !== true || control.hardened_active !== true) {
        throw repairError("Tourney database controls are not paused and active.", {
          code: "TOURNEY_REPAIR_CONTROL_NOT_PAUSED",
          status: 409,
        });
      }
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${repairCommandId},true)
      `;
      const result = await callback({
        actor: normalizedActor,
        policy,
        reason: normalizedReason,
        sql,
        targetHash,
      });
      await sql`
        update ${sql(controlTable)} set
          clean_since = null,
          first_zero_drift_at = null,
          second_zero_drift_at = null,
          clock_last_reset_reason = ${`manual_${normalizedTargetType}_repair:${normalizedReason}`},
          updated_at = now()
        where id = 'tourney'
      `;
      await sql`
        insert into ${sql(auditTable)} (
          event_kind, generation, actor, evidence
        ) values (
          'clock_reset', ${policy.generation}, ${normalizedActor},
          ${sql.json({
            repairType: normalizedTargetType,
            reason: normalizedReason,
            targetHash,
            ...result.auditEvidence,
          })}
        )
      `;
      return {
        ...result,
        actor: normalizedActor,
        reason: normalizedReason,
        targetHash,
      };
    },
  });
};

export const getTourneyExternalSerializationKey = ({
  operationKind,
  entityType,
  entityId,
  desiredState = {},
} = {}) => {
  const kind = normalize(operationKind);
  if (DISCORD_OPERATION_KINDS.includes(kind)) {
    const authority = normalize(
      desiredState?.assignment?.principalId ||
      desiredState?.oauthProjection?.principalId ||
      desiredState?.oauthProjection?.userId ||
      entityId
    );
    return `discord:${authority}`;
  }
  if (kind === "sanity_account_projection") return "sanity:account-snapshot";
  return `${kind}:${normalize(entityType)}:${normalize(entityId)}`;
};

const reconciliationDeadlineError = () => Object.assign(
  new Error("Tournament reconciliation exceeded its runtime budget."),
  { code: "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED", status: 503 }
);

const assertBeforeDeadline = (deadlineAt) => {
  const deadline = Number(deadlineAt);
  if (Number.isFinite(deadline) && Date.now() >= deadline) {
    throw reconciliationDeadlineError();
  }
};

const runBeforeDeadline = async ({ deadlineAt, task }) => {
  assertBeforeDeadline(deadlineAt);
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline)) return task();
  const remainingMs = Math.max(1, deadline - Date.now());
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(reconciliationDeadlineError());
          reject(reconciliationDeadlineError());
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const MEMORY_OPERATIONS = globalThis.__rooTourneyExternalOperations ||
  (globalThis.__rooTourneyExternalOperations = new Map());
const MEMORY_OPERATION_SECRETS = globalThis.__rooTourneyExternalOperationSecrets ||
  (globalThis.__rooTourneyExternalOperationSecrets = new Map());

export const isTourneyPlayerAuthStateCurrent = ({ current, desired } = {}) =>
  Boolean(
    current && desired &&
    normalize(current.id) === normalize(desired.id) &&
    normalize(current.status) === normalize(desired.status) &&
    Number(current.version) === Number(desired.version)
  );

const resolveCurrentAdminSnapshotState = async ({ state, env }) => {
  const {
    getTourneyAdminAuthCanonicalHash,
    readLatestTourneyAccountSnapshot,
  } = await import("./accountStore.js");
  const latest = await readLatestTourneyAccountSnapshot({ env });
  const accounts = Array.isArray(latest?.accounts_json)
    ? latest.accounts_json
    : latest?.accounts_json?.accounts;
  if (!latest || !Array.isArray(accounts)) return { current: false };
  const username = normalize(state.account?.username).toLowerCase();
  const account = accounts.find((candidate) =>
    normalize(candidate?.username).toLowerCase() === username
  );
  const effectiveAccount = account || { ...state.account, active: false };
  return {
    account: effectiveAccount,
    accountHash: getTourneyAdminAuthCanonicalHash(effectiveAccount),
    current: Boolean(
      normalize(state.accountHash) &&
      normalize(state.snapshotId) &&
      Number(state.snapshotVersion) > 0 &&
      normalize(state.snapshotHash) &&
      getTourneyAdminAuthCanonicalHash(effectiveAccount) === normalize(state.accountHash)
    ),
    latest,
    present: Boolean(account),
  };
};

const resolveCurrentSanitySnapshotState = async ({ state, env }) => {
  const { readLatestTourneyAccountSnapshot } = await import("./accountStore.js");
  const latest = await readLatestTourneyAccountSnapshot({ env });
  return {
    current: Boolean(
      latest && normalize(state.snapshotId) === normalize(latest.snapshot_id) &&
      Number(state.snapshotVersion) === Number(latest.version) &&
      normalize(state.snapshotHash) === normalize(latest.canonical_hash)
    ),
    latest,
  };
};

export const enqueueTourneyExternalOperation = async ({
  commandId,
  operationKind,
  entityType,
  entityId,
  desiredState = {},
  maxAttempts = 12,
  nextAttemptAt = "",
  env = process.env,
} = {}) => {
  const normalizedCommandId = normalize(commandId);
  const normalizedKind = normalize(operationKind);
  const normalizedEntityType = normalize(entityType);
  const normalizedEntityId = normalize(entityId);
  const normalizedNextAttemptAt = normalizeTimestamp(nextAttemptAt);
  if (!normalizedCommandId || !normalizedKind || !normalizedEntityType || !normalizedEntityId) {
    throw new Error("A complete Tourney external operation is required.");
  }
  if (normalize(nextAttemptAt) && !normalizedNextAttemptAt) {
    throw new Error("Tourney external operation retry timing is invalid.");
  }
  const desiredStateHash = sha256(stableTourneyJson(desiredState));
  const serializationKey = getTourneyExternalSerializationKey({
    operationKind: normalizedKind,
    entityType: normalizedEntityType,
    entityId: normalizedEntityId,
    desiredState,
  });
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
      command_id: normalizedCommandId,
      operation_kind: normalizedKind,
      entity_type: normalizedEntityType,
      entity_id: normalizedEntityId,
      status: "pending",
      desired_state: desiredState,
      desired_state_hash: desiredStateHash,
      serialization_key: serializationKey,
      next_attempt_at: normalizedNextAttemptAt || new Date().toISOString(),
    };
    MEMORY_OPERATIONS.set(operationKey, created);
    return created;
  }
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const sql = await getTourneySql(env);
  const rows = await sql`
    insert into ${sql(table)} as existing (
      operation_key, command_id, operation_kind, entity_type, entity_id,
      serialization_key,
      desired_state, desired_state_hash, max_attempts, next_attempt_at
    ) values (
      ${operationKey}, ${normalizedCommandId}, ${normalizedKind},
      ${normalizedEntityType}, ${normalizedEntityId}, ${serializationKey},
      ${sql.json(desiredState)},
      ${desiredStateHash}, ${Math.max(1, Math.min(100, Number(maxAttempts) || 12))},
      coalesce(${normalizedNextAttemptAt || null}::timestamptz, now())
    )
    on conflict (operation_key) do update set
      next_attempt_at = case when existing.status = 'pending'
        then greatest(existing.next_attempt_at, excluded.next_attempt_at)
        else existing.next_attempt_at end,
      updated_at = now()
    returning *
  `;
  return rows[0];
};

const resolveOperationSecretExpiry = ({ expiresAt = "", ttlSeconds = 86_400 } = {}) => {
  const supplied = normalizeTimestamp(expiresAt);
  const timestamp = supplied
    ? Date.parse(supplied)
    : Date.now() + Math.max(300, Math.min(604_800, Number(ttlSeconds) || 86_400)) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("Tourney external-operation credential expiry is invalid.");
  }
  return new Date(timestamp).toISOString();
};

const insertTourneyExternalOperationSecret = async ({
  accessToken,
  expiresAt,
  operationKey,
  sql,
  env,
}) => {
  const normalizedAccessToken = normalize(accessToken);
  const normalizedOperationKey = normalize(operationKey);
  if (!normalizedAccessToken || !normalizedOperationKey) {
    throw new Error("A complete Tourney external-operation credential is required.");
  }
  await sql`
    insert into tourney.external_operation_secrets(
      operation_key, encrypted_payload, expires_at
    ) values(
      ${normalizedOperationKey},
      ${encryptOperationSecret({ payload: { accessToken: normalizedAccessToken }, env })},
      ${expiresAt}::timestamptz
    )
    on conflict (operation_key) do update set
      encrypted_payload = excluded.encrypted_payload,
      expires_at = excluded.expires_at,
      created_at = now()
  `;
};

export const saveTourneyDiscordOperationAccessToken = async ({
  accessToken,
  expiresAt = "",
  operationKey,
  ttlSeconds = 86_400,
  env = process.env,
} = {}) => {
  const normalizedOperationKey = normalize(operationKey);
  const normalizedAccessToken = normalize(accessToken);
  const resolvedExpiresAt = resolveOperationSecretExpiry({ expiresAt, ttlSeconds });
  if (!normalizedOperationKey || !normalizedAccessToken) {
    throw new Error("A complete Discord operation credential is required.");
  }
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    MEMORY_OPERATION_SECRETS.set(normalizedOperationKey, {
      accessToken: normalizedAccessToken,
      expiresAt: resolvedExpiresAt,
    });
    return true;
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    throw Object.assign(
      new Error("New Discord authentication is temporarily unavailable during fallback."),
      { code: "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE", status: 503 }
    );
  }
  const sql = await getTourneySql(env);
  await insertTourneyExternalOperationSecret({
    accessToken: normalizedAccessToken,
    expiresAt: resolvedExpiresAt,
    operationKey: normalizedOperationKey,
    sql,
    env,
  });
  return true;
};

export const rearmTourneyDiscordOperationWithAccessToken = async ({
  accessToken,
  commandId,
  entityId,
  entityType,
  expiresAt = "",
  ttlSeconds = 86_400,
  env = process.env,
} = {}) => {
  const normalizedAccessToken = normalize(accessToken);
  const normalizedCommandId = normalize(commandId);
  const normalizedEntityId = normalize(entityId);
  const normalizedEntityType = normalize(entityType);
  const resolvedExpiresAt = resolveOperationSecretExpiry({ expiresAt, ttlSeconds });
  if (
    !normalizedAccessToken || !normalizedCommandId ||
    !normalizedEntityId || !normalizedEntityType
  ) {
    throw new Error("A complete Discord operation reauthorization is required.");
  }
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const operations = [...MEMORY_OPERATIONS.values()].filter((operation) =>
      operation.command_id === normalizedCommandId &&
      operation.operation_kind === "discord_membership" &&
      operation.entity_type === normalizedEntityType &&
      operation.entity_id === normalizedEntityId
    );
    if (operations.length !== 1) {
      throw new Error("The durable Discord operation could not be reauthorized.");
    }
    if (operations[0].status === "applied") return operations[0].operation_key;
    const activeLease = operations[0].status === "processing" &&
      Date.parse(operations[0].lease_expires_at || "") > Date.now();
    if (!activeLease) {
      operations[0].status = "pending";
    }
    MEMORY_OPERATION_SECRETS.set(operations[0].operation_key, {
      accessToken: normalizedAccessToken,
      expiresAt: resolvedExpiresAt,
    });
    return operations[0].operation_key;
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    throw Object.assign(
      new Error("New Discord authentication is temporarily unavailable during fallback."),
      { code: "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE", status: 503 }
    );
  }
  const table = relation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-reauthorize:${normalizedCommandId}`,
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${normalizedCommandId},true)
      `;
      const rows = await sql`
        select operation_key,status,lease_expires_at
        from ${sql(table)}
        where command_id = ${normalizedCommandId}
          and operation_kind = 'discord_membership'
          and entity_type = ${normalizedEntityType}
          and entity_id = ${normalizedEntityId}
        for update
      `;
      if (rows.length !== 1) {
        throw new Error("The durable Discord operation could not be reauthorized.");
      }
      if (rows[0].status === "applied") return rows[0].operation_key;
      const activeLease = rows[0].status === "processing" &&
        Date.parse(rows[0].lease_expires_at) > Date.now();
      if (!activeLease) {
        await sql`
          update ${sql(table)} set
            status = 'pending', attempt_count = 0, next_attempt_at = now(),
            lease_id = null, lease_expires_at = null, last_error_code = null,
            completed_at = null, updated_at = now()
          where operation_key = ${rows[0].operation_key}
        `;
      }
      await insertTourneyExternalOperationSecret({
        accessToken: normalizedAccessToken,
        expiresAt: resolvedExpiresAt,
        operationKey: rows[0].operation_key,
        sql,
        env,
      });
      return rows[0].operation_key;
    },
  });
};

export const enqueueTourneyIdentityUnlinkOperation = async ({
  accessToken,
  commandId,
  expiresAt,
  identityId,
  provider,
  userId,
  env = process.env,
} = {}) => {
  const normalizedIdentityId = normalize(identityId);
  const normalizedProvider = normalize(provider).toLowerCase();
  const normalizedUserId = normalize(userId);
  const normalizedAccessToken = normalize(accessToken);
  const normalizedExpiresAt = normalizeTimestamp(expiresAt);
  if (
    !normalizedIdentityId || !["discord", "google"].includes(normalizedProvider) ||
    !normalizedUserId || !normalizedAccessToken || !normalizedExpiresAt
  ) {
    throw new Error("A complete identity-unlink operation is required.");
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    const error = new Error("Identity changes are temporarily unavailable during fallback.");
    error.code = "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  const operation = await enqueueTourneyExternalOperation({
    commandId,
    operationKind: "supabase_identity_unlink",
    entityType: "account",
    entityId: normalizedUserId,
    desiredState: {
      identityId: normalizedIdentityId,
      provider: normalizedProvider,
      userId: normalizedUserId,
    },
    env,
  });
  const sql = await getTourneySql(env);
  const table = relation(policy.primaryBackend);
  const superseded = await sql`
    update ${sql(table)} queued set
      status = 'applied', completed_at = coalesce(completed_at, now()),
      lease_id = null, lease_expires_at = null,
      last_error_code = 'superseded_by_fresh_identity_unlink', updated_at = now()
    where queued.operation_kind = 'supabase_identity_unlink'
      and queued.entity_type = 'account'
      and queued.entity_id = ${normalizedUserId}
      and queued.operation_key <> ${operation.operation_key}
      and queued.desired_state->>'provider' = ${normalizedProvider}
      and (
        ${normalizedIdentityId} = 'already-unlinked'
        or queued.desired_state->>'identityId' = ${normalizedIdentityId}
      )
      and queued.status in ('pending','retry','dead_letter')
    returning queued.operation_key
  `;
  if (superseded.length > 0) {
    await sql`
      delete from tourney.external_operation_secrets
      where operation_key in ${sql(superseded.map((row) => row.operation_key))}
    `;
  }
  await sql`
    insert into tourney.external_operation_secrets(
      operation_key, encrypted_payload, expires_at
    ) values(
      ${operation.operation_key},
      ${encryptOperationSecret({ payload: { accessToken: normalizedAccessToken }, env })},
      ${normalizedExpiresAt}::timestamptz
    )
    on conflict (operation_key) do update set
      encrypted_payload = excluded.encrypted_payload,
      expires_at = excluded.expires_at,
      created_at = now()
  `;
  return operation;
};

const readTourneyIdentityUnlinkSecret = async ({ operation, env }) => {
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    throw Object.assign(new Error("Identity unlink requires Supabase primary."), {
      code: "TOURNEY_OAUTH_TEMPORARILY_UNAVAILABLE",
      nonRetryable: true,
    });
  }
  const sql = await getTourneySql(env);
  const rows = await sql`
    select encrypted_payload, expires_at
    from tourney.external_operation_secrets
    where operation_key = ${operation.operation_key}
  `;
  const secret = rows[0];
  if (!secret) {
    throw Object.assign(new Error("Identity unlink credential is unavailable."), {
      code: "supabase_identity_unlink_credential_missing",
      nonRetryable: true,
    });
  }
  if (Date.parse(secret.expires_at) <= Date.now()) {
    throw Object.assign(new Error("Identity unlink credential expired."), {
      code: "supabase_identity_unlink_credential_expired",
      nonRetryable: true,
    });
  }
  return decryptOperationSecret({ encryptedPayload: secret.encrypted_payload, env });
};

const readTourneyDiscordOperationAccessToken = async ({ operation, env }) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const secret = MEMORY_OPERATION_SECRETS.get(operation.operation_key);
    if (!secret || Date.parse(secret.expiresAt) <= Date.now()) return "";
    return normalize(secret.accessToken);
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") return "";
  const sql = await getTourneySql(env);
  const rows = await sql`
    select encrypted_payload, expires_at
    from tourney.external_operation_secrets
    where operation_key = ${operation.operation_key}
  `;
  const secret = rows[0];
  if (!secret || Date.parse(secret.expires_at) <= Date.now()) return "";
  try {
    const decrypted = decryptOperationSecret({
      encryptedPayload: secret.encrypted_payload,
      env,
    });
    return normalize(decrypted.accessToken);
  } catch (error) {
    error.code = "discord_oauth_credential_invalid";
    logSafeError("Tourney Discord operation credential unavailable", error);
    return "";
  }
};

export const resolveTourneyDiscordOperationAccessToken = async ({
  context = {},
  operation,
  env = process.env,
  readSecret = readTourneyDiscordOperationAccessToken,
} = {}) => {
  const transient = normalize(context.discordAccessTokens?.[operation?.entity_id]);
  if (transient) return transient;
  return normalize(await readSecret({ operation, env }));
};

export const rearmTourneyExternalOperation = async ({
  commandId,
  operationKind,
  entityType,
  entityId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return false;
  const normalizedCommandId = normalize(commandId);
  const normalizedOperationKind = normalize(operationKind);
  if (!REPLACEABLE_PROJECTION_KINDS.includes(normalizedOperationKind)) {
    throw repairError("This Tourney external operation requires a dedicated repair flow.", {
      code: "TOURNEY_EXTERNAL_OPERATION_REPAIR_FORBIDDEN",
    });
  }
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-external-rearm:${normalizedCommandId}`,
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${normalizedCommandId},true)
      `;
      const rows = await sql`
        update ${sql(table)} set
          status = 'pending', attempt_count = 0, next_attempt_at = now(),
          lease_id = null, lease_expires_at = null, last_error_code = null,
          completed_at = null, updated_at = now()
        where command_id = ${normalizedCommandId}
          and operation_kind = ${normalizedOperationKind}
          and entity_type = ${normalize(entityType)}
          and entity_id = ${normalize(entityId)}
          and (
            status in ('pending','retry','dead_letter')
            or (status = 'processing' and lease_expires_at <= now())
          )
        returning operation_key
      `;
      return rows.length > 0;
    },
  });
};

export const repairTourneyExternalOperation = async ({
  actor,
  env = process.env,
  operationKey,
  reason,
} = {}) => {
  const normalizedOperationKey = normalize(operationKey);
  if (!normalizedOperationKey || normalizedOperationKey.length > 512) {
    throw repairError("Tourney external-operation repair target is invalid.", {
      code: "TOURNEY_REPAIR_TARGET_INVALID",
      status: 400,
    });
  }
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  return runAuditedTourneyQueueRepair({
    actor,
    env,
    reason,
    targetId: normalizedOperationKey,
    targetType: "external_operation",
    callback: async ({ sql }) => {
      const operations = await sql`
        select operation_key, operation_kind, status,
          (status = 'processing' and lease_expires_at <= now()) as lease_expired
        from ${sql(table)}
        where operation_key = ${normalizedOperationKey}
        for update
      `;
      const operation = operations[0];
      if (!operation) {
        throw repairError("Tourney external operation was not found.", {
          code: "TOURNEY_EXTERNAL_OPERATION_NOT_FOUND",
          status: 404,
        });
      }
      if (!REPLACEABLE_PROJECTION_KINDS.includes(operation.operation_kind)) {
        throw repairError("This Tourney external operation requires a dedicated repair flow.", {
          code: "TOURNEY_EXTERNAL_OPERATION_REPAIR_FORBIDDEN",
        });
      }
      const repairable = ["dead_letter", "retry"].includes(operation.status) ||
        (operation.status === "processing" && operation.lease_expired === true);
      if (!repairable) {
        throw repairError("Tourney external operation is not in a repairable state.", {
          code: "TOURNEY_EXTERNAL_OPERATION_NOT_REPAIRABLE",
        });
      }
      const rows = await sql`
        update ${sql(table)} set
          status = 'pending', attempt_count = 0, next_attempt_at = now(),
          lease_id = null, lease_expires_at = null, last_error_code = null,
          completed_at = null, updated_at = now()
        where operation_key = ${normalizedOperationKey}
          and (
            status in ('dead_letter','retry')
            or (status = 'processing' and lease_expires_at <= now())
          )
        returning operation_key
      `;
      if (rows.length !== 1) {
        throw repairError("Tourney external operation changed during repair.", {
          code: "TOURNEY_EXTERNAL_OPERATION_REPAIR_CONFLICT",
        });
      }
      return {
        auditEvidence: {
          operationKind: operation.operation_kind,
          previousStatus: operation.status,
          status: "pending",
        },
        operationKind: operation.operation_kind,
        previousStatus: operation.status,
        status: "pending",
      };
    },
  });
};

export const supersedeQueuedDiscordOperationsForCommand = async ({
  commandId,
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") return 0;
  const normalizedCommandId = normalize(commandId);
  if (!normalizedCommandId) return 0;
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-coalesce:${normalizedCommandId}`,
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${normalizedCommandId},true)
      `;
      const rows = await sql`
        with current_serializations as (
          select distinct serialization_key
          from ${sql(table)}
          where command_id = ${normalizedCommandId}
            and operation_kind in ${sql(DISCORD_OPERATION_KINDS)}
        )
        update ${sql(table)} operation set
          status = 'applied', completed_at = coalesce(completed_at, now()),
          lease_id = null, lease_expires_at = null,
          last_error_code = 'superseded_by_fresh_oauth', updated_at = now()
        where operation.command_id <> ${normalizedCommandId}
          and operation.operation_kind in ${sql(DISCORD_OPERATION_KINDS)}
          and operation.serialization_key in (
            select serialization_key from current_serializations
          )
          and operation.status in ('pending','retry','dead_letter')
        returning operation.operation_key
      `;
      if (rows.length > 0 && policy.primaryBackend === "supabase") {
        await sql`
          delete from tourney.external_operation_secrets
          where operation_key in ${sql(rows.map((row) => row.operation_key))}
        `;
      }
      return rows.length;
    },
  });
};

export const purgeExpiredTourneyExternalOperationSecrets = async ({
  env = process.env,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    let deleted = 0;
    for (const [operationKey, secret] of MEMORY_OPERATION_SECRETS) {
      if (Date.parse(secret.expiresAt) > Date.now()) continue;
      MEMORY_OPERATION_SECRETS.delete(operationKey);
      deleted += 1;
    }
    return deleted;
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") return 0;
  const sql = await getTourneySql(env);
  const rows = await sql`
    delete from tourney.external_operation_secrets
    where expires_at <= now()
    returning operation_key
  `;
  return rows.length;
};

export const claimTourneyExternalOperations = async ({
  env,
  limit,
  commandId = "",
}) => {
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
            with requested_serializations as (
              select distinct serialization_key
              from ${sql(table)}
              where command_id = ${commandId}
            ), ranked as (
              select candidate.operation_key,
                row_number() over (
                  partition by candidate.serialization_key
                  order by
                    case when candidate.status = 'processing'
                      and candidate.lease_expires_at > now() then 0 else 1 end,
                    candidate.created_at,
                    candidate.operation_key
                ) serialization_rank
              from ${sql(table)} candidate
              where (
                candidate.status = 'processing'
                or (candidate.status in ('pending','retry')
                  and candidate.next_attempt_at <= now())
              )
                and candidate.serialization_key in (
                  select serialization_key from requested_serializations
                )
            )
            select candidate.* from ${sql(table)} candidate
            join ranked on ranked.operation_key = candidate.operation_key
              and ranked.serialization_rank = 1
            where (
              (candidate.status in ('pending','retry')
                and candidate.next_attempt_at <= now())
              or (candidate.status = 'processing'
                and candidate.lease_expires_at <= now())
            )
            order by candidate.created_at, candidate.operation_key
            for update skip locked limit ${safeLimit}
          `
        : await sql`
            with ranked as (
              select candidate.operation_key,
                row_number() over (
                  partition by candidate.serialization_key
                  order by
                    case when candidate.status = 'processing'
                      and candidate.lease_expires_at > now() then 0 else 1 end,
                    candidate.created_at,
                    candidate.operation_key
                ) serialization_rank
              from ${sql(table)} candidate
              where candidate.status = 'processing'
                 or (candidate.status in ('pending','retry')
                   and candidate.next_attempt_at <= now())
            )
            select candidate.* from ${sql(table)} candidate
            join ranked on ranked.operation_key = candidate.operation_key
              and ranked.serialization_rank = 1
            where (candidate.status in ('pending','retry')
                and candidate.next_attempt_at <= now())
               or (candidate.status = 'processing'
                and candidate.lease_expires_at <= now())
            order by candidate.next_attempt_at, candidate.created_at,
              candidate.operation_key
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

const normalizeDiscordAssignment = (assignment = {}) => {
  if (assignment?.queued !== true) return null;
  return {
    principalId: assignment.principal_id,
    discordUserId: assignment.discord_user_id,
    previousDiscordUserId: assignment.previous_discord_user_id || "",
    staleDiscordUserIds:
      assignment.stale_discord_user_ids || assignment.staleDiscordUserIds || [],
    desiredRole: assignment.desired_role,
    generation: Number(assignment.generation),
  };
};

const queueSyncedDiscordDesiredState = async ({
  operation,
  synced,
  env,
}) => {
  const userId = normalize(synced?.userId || synced?.account?.user_id);
  const config = getTourneyDiscordRoleConfig(env);
  if (!userId || !config.enabled) return;
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") return;
  await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-discord-after-auth:${userId}`,
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${operation.command_id},true)
      `;
      const [refreshed] = await sql`
        select public.roo_refresh_discord_role_assignment(
          ${userId}::uuid,
          ${config.guildId}
        ) as assignment
      `;
      const assignment = normalizeDiscordAssignment(refreshed?.assignment);
      if (!assignment?.principalId || !assignment.discordUserId || !assignment.desiredRole) {
        return null;
      }
      const deferred = await sql`
        select operation.operation_key,operation.command_id,
          secret.encrypted_payload,secret.expires_at
        from tourney.external_operations operation
        join tourney.external_operation_secrets secret
          on secret.operation_key=operation.operation_key
        where operation.operation_kind='discord_membership'
          and coalesce(
            operation.desired_state->'oauthProjection'->>'accountUserId',
            operation.desired_state->'oauthProjection'->>'userId'
          )=${userId}
          and operation.status in ('pending','retry','dead_letter')
          and secret.expires_at>now()
        order by secret.expires_at desc,operation.created_at desc
        limit 1 for update of operation,secret
      `;
      const oauthOperation = deferred[0];
      const queued = await enqueueTourneyExternalOperation({
        commandId: operation.command_id,
        operationKind: oauthOperation ? "discord_membership" : "discord_role_reconcile",
        entityType: operation.entity_type,
        entityId: operation.entity_id,
        desiredState: { assignment },
        env,
      });
      if (oauthOperation) {
        await sql`
          insert into tourney.external_operation_secrets(
            operation_key,encrypted_payload,expires_at
          ) values(
            ${queued.operation_key},${oauthOperation.encrypted_payload},
            ${oauthOperation.expires_at}::timestamptz
          ) on conflict(operation_key) do update set
            encrypted_payload=excluded.encrypted_payload,
            expires_at=excluded.expires_at,created_at=now()
        `;
        await sql`
          update tourney.external_operations set
            status='applied',completed_at=coalesce(completed_at,now()),
            lease_id=null,lease_expires_at=null,
            last_error_code='adopted_by_authoritative_auth_projection',updated_at=now()
          where operation_key=${oauthOperation.operation_key}
        `;
        await sql`
          delete from tourney.external_operation_secrets
          where operation_key=${oauthOperation.operation_key}
        `;
      }
      return queued;
    },
  });
};

const executeSupabasePlayerAuthOperation = async ({
  operation,
  state,
  env,
  deadlineAt,
}) => {
  const policy = resolveTourneyStorePolicy(env);
  const playerTable = policy.primaryBackend === "supabase"
    ? "tourney.tourney_players"
    : "tourney_players";
  const root = await getTourneySql(env);
  const [before] = await root`
    select * from ${root(playerTable)}
    where id = ${operation.entity_id}
    limit 1
  `;
  if (!isTourneyPlayerAuthStateCurrent({ current: before, desired: state.player })) {
    return { applied: true, superseded: true };
  }

  const { syncSupabaseTourneyPlayerAccount } = await import("../supabase/accounts.js");
  const { createSupabaseAdminClient } = await import("../supabase/adminClient.js");
  let desiredPlayer = state.player;
  let authUserId = state.authUserId || "";
  let synced;
  let stable = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    synced = await runBeforeDeadline({
      deadlineAt,
      task: (signal) => syncSupabaseTourneyPlayerAccount({
        player: desiredPlayer,
        passwordHash: desiredPlayer?.password_hash,
        authUserId,
        installPassword: state.installPassword !== false,
        adminClient: createSupabaseAdminClient({ env, signal }),
        env,
      }),
    });
    const result = await runTourneyTransaction({
      env,
      lockKey: `roo-tourney-player-auth-finalize:${operation.entity_id}`,
      waitForLock: true,
      callback: async (sql) => {
        await sql`
          select
            set_config('roo.tourney_backend',${policy.primaryBackend},true),
            set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
            set_config('roo.tourney_generation',${String(policy.generation)},true),
            set_config('roo.tourney_command_id',${operation.command_id},true)
        `;
        const [current] = await sql`
          select * from ${sql(playerTable)}
          where id = ${operation.entity_id}
          limit 1 for update
        `;
        if (!isTourneyPlayerAuthStateCurrent({ current, desired: desiredPlayer })) {
          return { current, stable: false };
        }
        if (synced.principalId) {
          await sql`
            update ${sql(playerTable)} set principal_id = ${synced.principalId}
            where id = ${operation.entity_id}
              and version = ${Number(desiredPlayer?.version || 0)}
              and status = ${desiredPlayer?.status}
              and principal_id is distinct from ${synced.principalId}
          `;
        }
        return { current, stable: true };
      },
    });
    if (result.stable) {
      stable = true;
      break;
    }
    if (!result.current) return { applied: true, superseded: true };
    desiredPlayer = result.current;
    authUserId = synced.userId || authUserId;
  }
  if (!stable) {
    throw Object.assign(new Error("Tourney player Auth state changed repeatedly."), {
      code: "tourney_player_auth_state_changed",
    });
  }
  await queueSyncedDiscordDesiredState({ operation, synced, env });
  return synced;
};

const getDiscordGlobalRetryAfterMs = async ({ env }) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  return runTourneyTransaction({
    env,
    lockKey: "roo-tourney-discord-global-rate-limit",
    waitForLock: true,
    callback: async (sql) => {
      const [row] = await sql`
        select command_id,
          extract(epoch from (next_attempt_at - now())) * 1000 as retry_after_ms
        from ${sql(table)}
        where operation_kind in ${sql(DISCORD_OPERATION_KINDS)}
          and last_error_code = 'discord_global_rate_limited'
        order by next_attempt_at, operation_key
        limit 1
      `;
      if (!row) return 0;
      const retryAfterMs = Math.ceil(Number(row.retry_after_ms || 0));
      if (retryAfterMs > 0) return retryAfterMs;
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${row.command_id},true)
      `;
      await sql`
        update ${sql(table)} set last_error_code = null, updated_at = now()
        where operation_kind in ${sql(DISCORD_OPERATION_KINDS)}
          and last_error_code = 'discord_global_rate_limited'
      `;
      return 0;
    },
  });
};

const assertDiscordProviderReady = async ({ env }) => {
  const retryAfterMs = await getDiscordGlobalRetryAfterMs({ env });
  if (retryAfterMs <= 0) return;
  const error = new Error("Discord global rate limit is still active.");
  error.code = "discord_global_rate_limited";
  error.retryAfterMs = retryAfterMs;
  error.discordGlobalRateLimit = true;
  throw error;
};

const deferDiscordOperationsForGlobalRateLimit = async ({
  operation,
  retryAfterMs,
  env,
}) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const delayMs = Math.max(1, Math.ceil(Number(retryAfterMs) || 0));
  return runTourneyTransaction({
    env,
    lockKey: "roo-tourney-discord-global-rate-limit",
    waitForLock: true,
    callback: async (sql) => {
      await sql`
        select
          set_config('roo.tourney_backend',${policy.primaryBackend},true),
          set_config('roo.tourney_mirror_enabled',${policy.mirrorEnabled ? "1" : "0"},true),
          set_config('roo.tourney_generation',${String(policy.generation)},true),
          set_config('roo.tourney_command_id',${operation.command_id},true)
      `;
      await sql`
        update ${sql(table)} set
          next_attempt_at = greatest(
            next_attempt_at,
            now() + ${delayMs} * interval '1 millisecond'
          ),
          last_error_code = 'discord_global_rate_limited',
          updated_at = now()
        where operation_kind in ${sql(DISCORD_OPERATION_KINDS)}
          and status in ('pending','processing','retry')
      `;
    },
  });
};

const executeDiscordOperation = async ({
  operation,
  state,
  env,
  context,
  deadlineAt,
}) => {
  assertBeforeDeadline(deadlineAt);
  const {
    claimTourneyDiscordDesiredState,
    completeTourneyDiscordDesiredState,
    projectTourneyDiscordOAuthDesiredState,
    withTourneyDiscordMutationFence,
  } = await import("./discordDesiredState.js");
  await assertDiscordProviderReady({ env });
  let requestedAssignment = state.assignment;
  if (state.oauthProjection) {
    requestedAssignment = await projectTourneyDiscordOAuthDesiredState({
      claimedUserId: state.oauthProjection.claimedUserId,
      commandId: operation.command_id,
      intentId: state.oauthProjection.intentId,
      operationKey: operation.operation_key,
      userId: state.oauthProjection.userId,
      env,
    });
    if (requestedAssignment?.canonicalSerializationKey) {
      operation.serialization_key = requestedAssignment.canonicalSerializationKey;
    }
    if (requestedAssignment?.superseded) return requestedAssignment;
  }
  const assignment = await claimTourneyDiscordDesiredState({
    assignment: requestedAssignment,
    commandId: operation.command_id,
    env,
  });
  if (assignment?.busy) {
    throw Object.assign(new Error("Discord desired state is already being reconciled."), {
      code: "discord_assignment_lease_active",
      retryAfterMs: assignment.retryAfterMs,
    });
  }
  if (!assignment || assignment.superseded) {
    return { applied: true, superseded: true };
  }
  try {
    const { applyTourneyDiscordDesiredState } = await import("./discordRoleSync.js");
    const accessToken = await resolveTourneyDiscordOperationAccessToken({
      context,
      operation,
      env,
    });
    const result = await applyTourneyDiscordDesiredState({
      accessToken,
      assignment,
      env,
      deadlineAt,
      beforeRequest: () => assertDiscordProviderReady({ env }),
      withMutationFence: (callback) => withTourneyDiscordMutationFence({
        assignment,
        env,
        callback,
      }),
    });
    const blocked = result.reason === "blocked_reauth";
    if (!result.applied && !blocked) {
      throw Object.assign(new Error("Discord desired state is not ready."), {
        code: result.reason || "discord_desired_state_not_applied",
      });
    }
    await completeTourneyDiscordDesiredState({
      assignment,
      status: blocked ? "blocked_reauth" : "applied",
      errorCode: blocked ? "discord_membership_reauth_required" : "",
      commandId: operation.command_id,
      env,
    });
    return result;
  } catch (error) {
    if (error?.code === "TOURNEY_DISCORD_GENERATION_CHANGED") {
      return { applied: true, superseded: true };
    }
    error.tourneyDiscordAssignment = assignment;
    throw error;
  }
};

export const executeSupabaseIdentityUnlinkOperation = async ({
  operation,
  state,
  env,
  deadlineAt,
  fetchImpl = fetch,
  readSecret = readTourneyIdentityUnlinkSecret,
}) => {
  const identityId = normalize(state.identityId);
  const provider = normalize(state.provider).toLowerCase();
  const userId = normalize(state.userId);
  if (!identityId || !["discord", "google"].includes(provider) || !userId) {
    throw Object.assign(new Error("Identity unlink desired state is invalid."), {
      code: "supabase_identity_unlink_state_invalid",
      nonRetryable: true,
    });
  }
  const identityExists = async (signal) => {
    const { createSupabaseAdminClient } = await import("../supabase/adminClient.js");
    const current = await createSupabaseAdminClient({ env, signal })
      .auth.admin.getUserById(userId);
    if (current.error || !current.data?.user) {
      throw Object.assign(new Error("Supabase identity inventory is unavailable."), {
        code: `supabase_identity_inventory_${current.error?.status || 503}`,
        status: current.error?.status || 503,
      });
    }
    return (current.data.user.identities || []).some(
      (identity) =>
        normalize(identity.identity_id || identity.id) === identityId &&
        normalize(identity.provider).toLowerCase() === provider
    );
  };
  const stillExists = await runBeforeDeadline({
    deadlineAt,
    task: identityExists,
  });
  if (stillExists) {
    const secret = await readSecret({ operation, env });
    await runBeforeDeadline({
      deadlineAt,
      task: async (signal) => {
        const { resolveSupabaseAdminEnv } = await import("../supabase/adminClient.js");
        const { url, secretKey } = resolveSupabaseAdminEnv(env);
        let response;
        let requestError;
        try {
          response = await fetchImpl(
            `${url}/auth/v1/user/identities/${encodeURIComponent(identityId)}`,
            {
              method: "DELETE",
              headers: {
                apikey: secretKey,
                Authorization: `Bearer ${secret.accessToken}`,
              },
              signal,
            }
          );
        } catch (error) {
          requestError = error;
        }
        if (response?.ok) return;
        if (!(await identityExists(signal))) return;
        if (requestError) throw requestError;
        throw Object.assign(new Error("Supabase identity unlink was rejected."), {
          code: `supabase_identity_unlink_${response?.status || 503}`,
          status: response?.status || 503,
        });
      },
    });
  }
  const { completeTourneyIdentityUnlinkProjection } =
    await import("./discordDesiredState.js");
  await completeTourneyIdentityUnlinkProjection({
    commandId: operation.command_id,
    provider,
    userId,
    env,
  });
  return { applied: true, provider };
};

const executeOperation = async ({
  operation,
  env,
  context = {},
  deadlineAt,
}) => {
  assertBeforeDeadline(deadlineAt);
  const state = operation.desired_state || {};
  switch (operation.operation_kind) {
    case "supabase_player_auth":
      return executeSupabasePlayerAuthOperation({
        operation,
        state,
        env,
        deadlineAt,
      });
    case "supabase_admin_auth": {
      const { syncSupabaseTourneyAdminAccount } = await import("../supabase/accounts.js");
      const { createSupabaseAdminClient } = await import("../supabase/adminClient.js");
      const initial = await resolveCurrentAdminSnapshotState({ state, env });
      if (!initial.current) return { applied: true, superseded: true };
      let accountToSync = initial.account;
      let synced;
      let current = initial;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        synced = await runBeforeDeadline({
          deadlineAt,
          task: (signal) => syncSupabaseTourneyAdminAccount({
            account: accountToSync,
            adminClient: createSupabaseAdminClient({ env, signal }),
            env,
          }),
        });
        current = await resolveCurrentAdminSnapshotState({
          state: {
            ...state,
            account: accountToSync,
            accountHash: (await import("./accountStore.js"))
              .getTourneyAdminAuthCanonicalHash(accountToSync),
          },
          env,
        });
        if (current.current) break;
        accountToSync = current.account;
      }
      if (!current.current) {
        throw Object.assign(new Error("Tourney administrator Auth state changed repeatedly."), {
          code: "tourney_admin_auth_state_changed",
        });
      }
      const principalId = synced.account?.principal_id || "";
      if (principalId && current.present) {
        const [{ executeTourneyCommand }, { appendTourneyAccountPrincipalSnapshot }] =
          await Promise.all([import("./store.js"), import("./accountStore.js")]);
        const username = String(state.account?.username || "").trim().toLowerCase();
        await executeTourneyCommand({
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
      }
      await queueSyncedDiscordDesiredState({ operation, synced, env });
      return synced;
    }
    case "sanity_account_projection": {
      const { projectTourneyAccountSnapshotToSanity } = await import("./accountStore.js");
      let desired = state;
      let snapshot = await resolveCurrentSanitySnapshotState({ state: desired, env });
      if (!snapshot.current) return { applied: true, superseded: true };
      let projected;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        projected = await runBeforeDeadline({
          deadlineAt,
          task: (signal) => projectTourneyAccountSnapshotToSanity({
            accountsJson: desired.accountsJson,
            actorUsername: desired.actorUsername,
            signal,
            env,
          }),
        });
        snapshot = await resolveCurrentSanitySnapshotState({ state: desired, env });
        if (snapshot.current) return projected;
        const accounts = Array.isArray(snapshot.latest?.accounts_json)
          ? snapshot.latest.accounts_json
          : snapshot.latest?.accounts_json?.accounts;
        if (!snapshot.latest || !Array.isArray(accounts)) break;
        desired = {
          accountsJson: JSON.stringify(accounts),
          actorUsername: "snapshot-reconciliation",
          snapshotId: snapshot.latest.snapshot_id,
          snapshotVersion: Number(snapshot.latest.version),
          snapshotHash: snapshot.latest.canonical_hash,
        };
      }
      throw Object.assign(new Error("Tourney Sanity snapshot changed repeatedly."), {
        code: "tourney_sanity_snapshot_changed",
      });
    }
    case "supabase_identity_unlink":
      return executeSupabaseIdentityUnlinkOperation({
        operation,
        state,
        env,
        deadlineAt,
      });
    case "discord_membership":
    case "discord_role_reconcile":
      return executeDiscordOperation({
        operation,
        state,
        env,
        context,
        deadlineAt,
      });
    default:
      throw Object.assign(new Error("Unsupported Tourney external operation."), {
        code: "TOURNEY_EXTERNAL_OPERATION_UNSUPPORTED",
      });
  }
};

const finishOperation = async ({
  operation,
  status,
  errorCode = "",
  retryAfterMs = 0,
  retireOlderDeadLetters = false,
  env,
}) => {
  const policy = resolveTourneyStorePolicy(env);
  const table = relation(policy.primaryBackend);
  const providerDelayMs = Math.max(0, Math.ceil(Number(retryAfterMs) || 0));
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
          next_attempt_at = case when ${status} = 'retry' then greatest(
            next_attempt_at,
            case when ${providerDelayMs} > 0
              then now() + ${providerDelayMs} * interval '1 millisecond'
              else now() + make_interval(secs => least(3600, 2 ^ least(attempt_count, 11)))
            end
          ) else next_attempt_at end,
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
      let supersededKeys = [];
      if (
        status === "applied" &&
        retireOlderDeadLetters === true &&
        REPLACEABLE_PROJECTION_KINDS.includes(operation.operation_kind) &&
        normalize(operation.serialization_key) &&
        operation.created_at
      ) {
        const superseded = await sql`
          update ${sql(table)} queued set
            status = 'applied', completed_at = coalesce(completed_at, now()),
            lease_id = null, lease_expires_at = null,
            last_error_code = 'superseded_by_applied_authoritative_projection',
            updated_at = now()
          where queued.serialization_key = ${operation.serialization_key}
            and queued.operation_key <> ${operation.operation_key}
            and queued.operation_kind in ${sql(REPLACEABLE_PROJECTION_KINDS)}
            and queued.status = 'dead_letter'
            and (queued.created_at, queued.operation_key) <
              (${operation.created_at}::timestamptz, ${operation.operation_key})
          returning queued.operation_key
        `;
        supersededKeys = superseded.map((row) => row.operation_key);
      }
      if (["applied", "dead_letter"].includes(status) && policy.primaryBackend === "supabase") {
        await sql`
          delete from tourney.external_operation_secrets
          where operation_key in ${sql([operation.operation_key, ...supersededKeys])}
        `;
      }
    },
  });
};

export const reconcileTourneyExternalOperations = async ({
  env = process.env,
  limit = 10,
  commandId = "",
  context = {},
  deadlineAt,
} = {}) => {
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return { claimed: 0, applied: 0, retried: 0, deadLettered: 0 };
  }
  assertBeforeDeadline(deadlineAt);
  await purgeExpiredTourneyExternalOperationSecrets({ env });
  const operations = await claimTourneyExternalOperations({
    env,
    limit,
    commandId,
  });
  let applied = 0;
  let retried = 0;
  let deadLettered = 0;
  for (const operation of operations) {
    try {
      assertBeforeDeadline(deadlineAt);
      const result = await executeOperation({ operation, env, context, deadlineAt });
      assertBeforeDeadline(deadlineAt);
      await finishOperation({
        operation,
        status: "applied",
        retireOlderDeadLetters: result?.superseded !== true,
        env,
      });
      applied += 1;
    } catch (error) {
      logSafeError("Tourney external operation failed", error);
      const deadlineExceeded =
        error?.code === "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED";
      const ambiguousProviderOutcome =
        deadlineExceeded || error?.code === "discord_request_timeout";
      if (ambiguousProviderOutcome) {
        if (deadlineExceeded) throw error;
        continue;
      }
      const providerDeferred = Number(error?.retryAfterMs || 0) > 0;
      const terminal = error?.nonRetryable === true || (
        !providerDeferred &&
        Number(operation.attempt_count) >= Number(operation.max_attempts || 12)
      );
      const errorCode = getSafeErrorCode(
        error,
        "tourney_external_operation_failed"
      ).slice(0, 128);
      if (error?.discordGlobalRateLimit && providerDeferred) {
        await deferDiscordOperationsForGlobalRateLimit({
          operation,
          retryAfterMs: error.retryAfterMs,
          env,
        }).catch(() => {});
      }
      if (error?.tourneyDiscordAssignment) {
        const { failTourneyDiscordDesiredState } = await import("./discordDesiredState.js");
        await failTourneyDiscordDesiredState({
          assignment: error.tourneyDiscordAssignment,
          status: terminal ? "dead_letter" : "retry",
          errorCode,
          commandId: operation.command_id,
          env,
        }).catch(() => {});
      }
      await finishOperation({
        operation,
        status: terminal ? "dead_letter" : "retry",
        errorCode,
        retryAfterMs: error?.retryAfterMs || 0,
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
