import crypto from "node:crypto";
import {
  getTourneySqlForBackend,
  isSupabaseTourneyDatabase,
  runTourneyTransaction,
} from "./sqlClient.js";
import {
  TOURNEY_MIRROR_TABLES,
  buildTourneyMirrorKey,
  filterTourneyMirrorRow,
  getTourneyMirrorContract,
} from "./mirrorContract.js";
import { isEnabledTourneyFlag, stableTourneyJson } from "./canonical.js";

export const TOURNEY_STORE_DOMAINS = Object.freeze([
  "accounts",
  "players",
  "tokens",
  "registration",
  "brackets",
  "teams",
  "appeals",
  "payouts",
  "email",
  "discord",
  "identity",
]);

export { TOURNEY_MIRROR_TABLES } from "./mirrorContract.js";

const normalize = (value) => String(value || "").trim();
const assertTourneyWorkDeadline = (deadlineAt) => {
  const deadline = Number(deadlineAt);
  if (!Number.isFinite(deadline) || Date.now() < deadline) return;
  const error = new Error("Tournament reconciliation exceeded its runtime budget.");
  error.code = "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED";
  error.status = 503;
  throw error;
};
const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");
const hmacSha256 = (value, secret) =>
  crypto.createHmac("sha256", secret).update(String(value || "")).digest("hex");
const TEST_IDEMPOTENCY_SECRET = "roo-tourney-idempotency-test-only";
const resolveTourneyIdempotencySecret = (env) => {
  const configured = normalize(
    env.TOURNEY_IDEMPOTENCY_SECRET || env.TOURNEY_SESSION_SECRET
  );
  if (configured) return configured;
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return TEST_IDEMPOTENCY_SECRET;
  }
  const error = new Error("Tournament idempotency signing is not configured.");
  error.status = 503;
  error.code = "TOURNEY_IDEMPOTENCY_SECRET_REQUIRED";
  throw error;
};
const buildTourneyRequestHashes = ({ env, purpose, requestPayload }) => {
  const material = stableTourneyJson({ purpose, requestPayload });
  const legacyRequestHash = sha256(material);
  if (!isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED)) {
    return { requestHash: legacyRequestHash, legacyRequestHash };
  }
  return {
    requestHash: hmacSha256(material, resolveTourneyIdempotencySecret(env)),
    legacyRequestHash,
  };
};
const isMatchingTourneyRequestHash = ({ storedHash, requestHash, legacyRequestHash }) =>
  storedHash === requestHash || storedHash === legacyRequestHash;
const MEMORY_RECEIPTS =
  globalThis.__rooTourneyCommandReceipts ||
  (globalThis.__rooTourneyCommandReceipts = new Map());
const NON_NATURAL_COMMAND_PREFIXES = Object.freeze([
  "account-principal",
  "account-snapshot:seed",
  "discord-backfill",
  "discord-state-seed",
  "discord-state-normalize",
  "email",
  "fallback-bootstrap",
  "fixture",
  "mirror",
  "principal-seed",
  "schema-v4",
]);
const isNonNaturalCommandId = (commandId) =>
  NON_NATURAL_COMMAND_PREFIXES.some((prefix) =>
    commandId === prefix ||
    commandId.startsWith(`${prefix}:`) ||
    commandId.startsWith(`${prefix}_`) ||
    commandId.startsWith(`${prefix}-`)
  );

const parseGeneration = (value) => {
  const normalized = normalize(value || "0");
  if (!/^\d+$/.test(normalized)) {
    throw new Error("TOURNEY_FAILOVER_GENERATION must be a non-negative integer.");
  }
  const generation = Number(normalized);
  if (!Number.isSafeInteger(generation)) {
    throw new Error("TOURNEY_FAILOVER_GENERATION is too large.");
  }
  return generation;
};

export const isNaturalTourneyMirrorEvent = ({ event, sourceBackend } = {}) => {
  const commandId = normalize(event?.command_id);
  return sourceBackend === "supabase" &&
    Number(event?.generation) >= 1 &&
    Boolean(commandId) &&
    !["command_receipts", "external_operations", "email_dispatches"].includes(
      event?.table_name
    ) &&
    !isNonNaturalCommandId(commandId);
};

export const resolveTourneyStorePolicy = (env = process.env) => ({
  primaryBackend: isSupabaseTourneyDatabase(env) ? "supabase" : "legacy",
  mirrorEnabled: isEnabledTourneyFlag(env.TOURNEY_MIRROR_ENABLED),
  writesPaused: isEnabledTourneyFlag(env.TOURNEY_WRITES_PAUSED),
  generation: parseGeneration(env.TOURNEY_FAILOVER_GENERATION),
});

const controlRelation = (backend, table) =>
  backend === "supabase" ? `tourney.${table}` : `tourney_${table}`;
const businessRelation = (backend, table) =>
  getTourneyMirrorContract(table).relations[backend];

const normalizeCommandId = (value) => {
  const commandId = normalize(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(commandId)) {
    const error = new Error("A valid Idempotency-Key is required.");
    error.status = 400;
    error.code = "TOURNEY_IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  return commandId;
};

export const readTourneyCommandId = ({ request, derivedKey = "" } = {}) => {
  const supplied = request?.headers?.get?.("idempotency-key") || derivedKey;
  if (!supplied && process.env.NODE_ENV === "test") {
    return `test:${crypto.randomUUID()}`;
  }
  const commandId = normalizeCommandId(supplied);
  if (request && isNonNaturalCommandId(commandId)) {
    const error = new Error("Idempotency-Key uses a reserved prefix.");
    error.status = 400;
    error.code = "TOURNEY_IDEMPOTENCY_KEY_RESERVED";
    throw error;
  }
  return commandId;
};

const setCommandContext = async ({ sql, policy, commandId }) => {
  await sql`
    select
      set_config('roo.tourney_backend', ${policy.primaryBackend}, true),
      set_config('roo.tourney_mirror_enabled', ${policy.mirrorEnabled ? "1" : "0"}, true),
      set_config('roo.tourney_generation', ${String(policy.generation)}, true),
      set_config('roo.tourney_command_id', ${commandId}, true)
  `;
};

const writesPausedError = () => {
  const error = new Error("Tournament updates are briefly paused. Try again shortly.");
  error.status = 503;
  error.code = "TOURNEY_WRITES_PAUSED";
  error.retryAfter = 30;
  return error;
};

const assertTourneyCommandWritesAllowed = async ({
  sql,
  controlTable,
  policy,
  maintenanceWhilePaused,
}) => {
  const [control] = await sql`
    select primary_backend, generation, writes_paused
    from ${sql(controlTable)}
    where id = 'tourney'
    for share
  `;
  if (!control) {
    const error = new Error("Tourney cutover controls are unavailable.");
    error.status = 503;
    error.code = "TOURNEY_CONTROL_UNAVAILABLE";
    throw error;
  }
  if (
    String(control.primary_backend || "").toLowerCase() !== policy.primaryBackend ||
    Number(control.generation) !== policy.generation
  ) {
    const error = new Error("Tourney runtime authority does not match database controls.");
    error.status = 503;
    error.code = "TOURNEY_CONTROL_MISMATCH";
    throw error;
  }
  const paused = policy.writesPaused || control.writes_paused;
  if (paused && maintenanceWhilePaused !== true) throw writesPausedError();
};

export const executeTourneyCommand = async ({
  commandId,
  purpose,
  requestPayload = {},
  env = process.env,
  callback,
  postCommitContext = {},
  attemptExternalWork = true,
  maintenanceWhilePaused = false,
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Tourney command callback is required.");
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.writesPaused && maintenanceWhilePaused !== true) {
    throw writesPausedError();
  }
  const id = normalizeCommandId(commandId);
  const normalizedPurpose = normalize(purpose).toLowerCase();
  if (!TOURNEY_STORE_DOMAINS.includes(normalizedPurpose.split(":")[0])) {
    throw new Error("Unsupported Tourney command domain.");
  }
  const { requestHash, legacyRequestHash } = buildTourneyRequestHashes({
    env,
    purpose: normalizedPurpose,
    requestPayload,
  });
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const existing = MEMORY_RECEIPTS.get(id);
    if (existing) {
      if (
        !isMatchingTourneyRequestHash({
          storedHash: existing.requestHash,
          requestHash,
          legacyRequestHash,
        }) || existing.purpose !== normalizedPurpose
      ) {
        const conflict = new Error("Idempotency-Key was already used for another action.");
        conflict.status = 409;
        conflict.code = "TOURNEY_IDEMPOTENCY_CONFLICT";
        throw conflict;
      }
      return { ...existing.result, replayed: true };
    }
    const result = (await callback()) || {};
    const completed = {
      replayed: false,
      status: Number(result.status || 200),
      body: result.body ?? result,
    };
    MEMORY_RECEIPTS.set(id, {
      purpose: normalizedPurpose,
      requestHash,
      result: completed,
    });
    return completed;
  }
  const receiptTable = controlRelation(policy.primaryBackend, "command_receipts");
  const controlTable = controlRelation(policy.primaryBackend, "cutover_metadata");
  const transactionResult = await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-command:${id}`,
    waitForLock: true,
    callback: async (sql) => {
      await assertTourneyCommandWritesAllowed({
        sql,
        controlTable,
        policy,
        maintenanceWhilePaused,
      });
      await setCommandContext({ sql, policy, commandId: id });
      const inserted = await sql`
        insert into ${sql(receiptTable)} (
          command_id, purpose, request_hash, generation
        ) values (${id}, ${normalizedPurpose}, ${requestHash}, ${policy.generation})
        on conflict (command_id) do nothing
        returning command_id
      `;
      if (inserted.length === 0) {
        const receipts = await sql`
          select purpose, request_hash, status, result_status, result_body
          from ${sql(receiptTable)}
          where command_id = ${id}
          for update
        `;
        const receipt = receipts[0];
        if (
          !receipt ||
          !isMatchingTourneyRequestHash({
            storedHash: receipt.request_hash,
            requestHash,
            legacyRequestHash,
          }) ||
          receipt.purpose !== normalizedPurpose
        ) {
          const conflict = new Error("Idempotency-Key was already used for another action.");
          conflict.status = 409;
          conflict.code = "TOURNEY_IDEMPOTENCY_CONFLICT";
          throw conflict;
        }
        if (["committed", "completed", "failed"].includes(receipt.status)) {
          const storedStatus = Number(receipt.result_status);
          const hasStoredStatus = Number.isInteger(storedStatus) &&
            storedStatus >= 100 && storedStatus <= 599;
          return {
            replayed: true,
            status: hasStoredStatus
              ? storedStatus
              : receipt.status === "failed" ? 503 : 200,
            body: receipt.result_body ?? (receipt.status === "failed"
              ? {
                  ok: false,
                  error: "This committed operation could not be completed.",
                  code: "TOURNEY_COMMAND_TERMINAL_FAILURE",
                }
              : {}),
            receiptStatus: receipt.status,
          };
        }
      }

      const result = (await callback()) || {};
      const status = Number(result.status || 200);
      const body = result.body ?? result;
      await sql`
        update ${sql(receiptTable)}
        set status = 'committed', result_status = ${status},
            result_body = ${sql.json(body)}, committed_at = now(), updated_at = now()
        where command_id = ${id}
      `;
      return { replayed: false, status, body, receiptStatus: "committed" };
    },
  });

  if (["completed", "failed"].includes(transactionResult.receiptStatus)) {
    const body = transactionResult.replayed && transactionResult.body &&
      typeof transactionResult.body === "object" && !Array.isArray(transactionResult.body)
      ? {
          ...transactionResult.body,
          replayed: true,
          ...(transactionResult.receiptStatus === "failed"
            ? { syncPending: true }
            : {}),
        }
      : transactionResult.body;
    return {
      ...transactionResult,
      body,
      ...(transactionResult.receiptStatus === "failed"
        ? { syncPending: true }
        : {}),
    };
  }

  const postCommitDeadlineAt = Date.now() + 10_000;
  let syncPending = !attemptExternalWork;
  try {
    if (!attemptExternalWork) throw Object.assign(new Error("Deferred by command."), {
      code: "TOURNEY_EXTERNAL_WORK_DEFERRED",
    });
    const [{ reconcileTourneyExternalOperations, hasPendingTourneyExternalOperations }, email] =
      await Promise.all([
        import("./externalOperations.js"),
        import("./emailDispatch.js"),
      ]);
    for (let pass = 0; pass < 4 && Date.now() < postCommitDeadlineAt; pass += 1) {
      const external = await reconcileTourneyExternalOperations({
        env,
        limit: 25,
        commandId: id,
        context: postCommitContext,
        deadlineAt: postCommitDeadlineAt,
      });
      if (external.claimed === 0) break;
    }
    await email.reconcileTourneyEmailDispatches({
      env,
      limit: 25,
      commandId: id,
      deadlineAt: postCommitDeadlineAt,
    });
    if (policy.mirrorEnabled) {
      await reconcileTourneyMirror({
        env,
        limit: 100,
        deadlineAt: postCommitDeadlineAt,
      });
    }
    const [externalPending, emailPending] = await Promise.all([
      hasPendingTourneyExternalOperations({ commandId: id, env }),
      email.hasPendingTourneyEmailDispatches({ commandId: id, env }),
    ]);
    syncPending = externalPending || emailPending;
  } catch {
    syncPending = true;
  }

  if (!syncPending) {
    try {
      await runTourneyTransaction({
        env,
        lockKey: `roo-tourney-command-complete:${id}`,
        callback: async (sql) => {
          await setCommandContext({ sql, policy, commandId: id });
          await sql`
            update ${sql(receiptTable)}
            set status = 'completed', completed_at = coalesce(completed_at, now()),
                updated_at = now()
            where command_id = ${id} and status = 'committed'
          `;
        },
      });
    } catch {
      syncPending = true;
    }
  }
  const body = transactionResult.body && typeof transactionResult.body === "object" &&
    !Array.isArray(transactionResult.body)
    ? {
        ...transactionResult.body,
        ...(transactionResult.replayed ? { replayed: true } : {}),
        ...(syncPending ? { syncPending: true } : {}),
      }
    : transactionResult.body;
  return { ...transactionResult, body, syncPending };
};

export const completeRecoveredTourneyCommandReceipts = async ({
  env = process.env,
  limit = 100,
  deadlineAt,
} = {}) => {
  assertTourneyWorkDeadline(deadlineAt);
  const policy = resolveTourneyStorePolicy(env);
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    return { completed: 0, failed: 0 };
  }
  const receiptTable = controlRelation(policy.primaryBackend, "command_receipts");
  const externalTable = controlRelation(policy.primaryBackend, "external_operations");
  const emailTable = controlRelation(policy.primaryBackend, "email_dispatches");
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));

  return runTourneyTransaction({
    env,
    lockKey: "roo-tourney-complete-recovered-receipts",
    callback: async (sql) => {
      const terminalCandidates = await sql`
        select receipt.command_id
        from ${sql(receiptTable)} receipt
        where receipt.status = 'committed'
          and (
            exists (
              select 1 from ${sql(externalTable)} operation
              where operation.command_id = receipt.command_id
                and operation.status = 'dead_letter'
            )
            or exists (
              select 1 from ${sql(emailTable)} dispatch
              where dispatch.command_id = receipt.command_id
                and dispatch.status in ('failed','dead_letter')
            )
          )
        order by receipt.committed_at nulls first, receipt.created_at, receipt.command_id
        for update of receipt skip locked
        limit ${safeLimit}
      `;
      let failed = 0;
      for (const candidate of terminalCandidates) {
        assertTourneyWorkDeadline(deadlineAt);
        await setCommandContext({ sql, policy, commandId: candidate.command_id });
        const [evidence] = await sql`
          select jsonb_build_object(
            'externalOperations', coalesce((
              select jsonb_agg(operation.operation_key order by operation.operation_key)
              from ${sql(externalTable)} operation
              where operation.command_id = ${candidate.command_id}
                and operation.status = 'dead_letter'
            ), '[]'::jsonb),
            'emailDispatches', coalesce((
              select jsonb_agg(dispatch.id::text order by dispatch.id::text)
              from ${sql(emailTable)} dispatch
              where dispatch.command_id = ${candidate.command_id}
                and dispatch.status in ('failed','dead_letter')
            ), '[]'::jsonb)
          ) value
        `;
        const rows = await sql`
          update ${sql(receiptTable)} set
            status = 'failed', failed_at = coalesce(failed_at, now()),
            failure_code = 'side_effect_terminal',
            failure_evidence = ${sql.json(evidence?.value || {})},
            updated_at = now()
          where command_id = ${candidate.command_id}
            and status = 'committed'
          returning command_id
        `;
        failed += rows.length;
      }
      const candidates = await sql`
        select receipt.command_id, receipt.status, receipt.failure_evidence
        from ${sql(receiptTable)} receipt
        where receipt.status in ('committed','failed')
          and not exists (
            select 1
            from ${sql(externalTable)} operation
            where operation.command_id = receipt.command_id
              and operation.status <> 'applied'
          )
          and not exists (
            select 1
            from ${sql(emailTable)} dispatch
            where dispatch.command_id = receipt.command_id
              and dispatch.status not in ('sent', 'historical_unknown', 'expired')
          )
        order by receipt.committed_at nulls first, receipt.created_at, receipt.command_id
        for update of receipt skip locked
        limit ${safeLimit}
      `;
      let completed = 0;
      let recovered = 0;
      for (const candidate of candidates) {
        assertTourneyWorkDeadline(deadlineAt);
        if (candidate.status === 'failed') {
          const externalKeys = Array.isArray(candidate.failure_evidence?.externalOperations)
            ? candidate.failure_evidence.externalOperations.map(normalize).filter(Boolean)
            : [];
          const emailIds = Array.isArray(candidate.failure_evidence?.emailDispatches)
            ? candidate.failure_evidence.emailDispatches.map(normalize).filter(Boolean)
            : [];
          if (externalKeys.length + emailIds.length === 0) continue;
          const externalRows = externalKeys.length
            ? await sql`
                select operation_key, status from ${sql(externalTable)}
                where operation_key in ${sql(externalKeys)} for update
              `
            : [];
          const emailRows = emailIds.length
            ? await sql`
                select id::text id, status from ${sql(emailTable)}
                where id::text in ${sql(emailIds)} for update
              `
            : [];
          if (
            externalRows.length !== externalKeys.length ||
            externalRows.some((row) => row.status !== 'applied') ||
            emailRows.length !== emailIds.length ||
            emailRows.some((row) => !['sent','historical_unknown','expired'].includes(row.status))
          ) continue;
        }
        await setCommandContext({
          sql,
          policy,
          commandId: candidate.command_id,
        });
        const rows = await sql`
          update ${sql(receiptTable)} receipt
          set status = 'completed',
              completed_at = coalesce(receipt.completed_at, now()),
              recovered_at = case when receipt.status = 'failed'
                then coalesce(receipt.recovered_at, now()) else receipt.recovered_at end,
              recovery_evidence = case when receipt.status = 'failed'
                then jsonb_build_object(
                  'code','terminal_work_repaired',
                  'failureEvidence',receipt.failure_evidence,
                  'recoveredAt',now()
                ) else receipt.recovery_evidence end,
              updated_at = now()
          where receipt.command_id = ${candidate.command_id}
            and receipt.status in ('committed','failed')
            and not exists (
              select 1
              from ${sql(externalTable)} operation
              where operation.command_id = receipt.command_id
                and operation.status <> 'applied'
            )
            and not exists (
              select 1
              from ${sql(emailTable)} dispatch
              where dispatch.command_id = receipt.command_id
                and dispatch.status not in ('sent', 'historical_unknown', 'expired')
            )
          returning receipt.command_id, receipt.recovered_at
        `;
        completed += rows.length;
        recovered += rows.filter((row) => row.recovered_at).length;
      }
      return { completed, failed, recovered };
    },
  });
};

const keyHash = (recordKey) => sha256(stableTourneyJson(recordKey));
const targetWhere = (sql, keys, recordKey) => {
  const clauses = keys.map((key) => sql`${sql(key)} = ${recordKey[key]}`);
  return clauses.reduce((combined, clause) =>
    combined ? sql`${combined} and ${clause}` : clause
  , null);
};

const applyMirrorEvent = async ({ event, targetBackend, targetSql }) => {
  const contract = getTourneyMirrorContract(event.table_name);
  const keys = contract.keyColumns;
  const recordKey = Object.fromEntries(
    keys.map((key) => [key, event.record_key?.[key]])
  );
  if (keys.some((key) => recordKey[key] === null || recordKey[key] === undefined || recordKey[key] === "")) {
    const error = new Error("Tourney mirror event key is incomplete.");
    error.code = "TOURNEY_MIRROR_KEY_INCOMPLETE";
    throw error;
  }
  const checkpointTable = controlRelation(targetBackend, "mirror_checkpoints");
  const tombstoneTable = controlRelation(targetBackend, "mirror_tombstones");
  const targetTable = businessRelation(targetBackend, event.table_name);
  const hash = keyHash(recordKey);

  return targetSql.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply', '1', true)`;
    await sql`
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${`roo-tourney-mirror-target:${targetBackend}:${event.table_name}:${hash}`},
          0
        )
      )
    `;
    const checkpoints = await sql`
      select source_sequence, generation from ${sql(checkpointTable)}
      where target_backend = ${targetBackend}
        and table_name = ${event.table_name}
        and record_key_hash = ${hash}
      for update
    `;
    const checkpoint = checkpoints[0];
    if (checkpoint && (
      Number(checkpoint.generation) > Number(event.generation) ||
      (
        Number(checkpoint.generation) === Number(event.generation) &&
        Number(checkpoint.source_sequence) >= Number(event.sequence)
      )
    )) {
      return { stale: true };
    }

    const where = targetWhere(sql, keys, recordKey);
    if (event.operation === "delete") {
      await sql`delete from ${sql(targetTable)} where ${where}`;
      await sql`
        insert into ${sql(tombstoneTable)} (
          target_backend, table_name, record_key_hash, record_key,
          source_sequence, generation, deleted_at
        ) values (
          ${targetBackend}, ${event.table_name}, ${hash}, ${sql.json(recordKey)},
          ${event.sequence}, ${event.generation}, ${event.occurred_at}
        )
        on conflict (target_backend, table_name, record_key_hash) do update
        set record_key = excluded.record_key,
            source_sequence = excluded.source_sequence,
            generation = excluded.generation,
            deleted_at = excluded.deleted_at
        where (${sql(tombstoneTable)}.generation, ${sql(tombstoneTable)}.source_sequence)
          < (excluded.generation, excluded.source_sequence)
      `;
    } else {
      const row = filterTourneyMirrorRow(event.table_name, event.record_data || {});
      const updateColumns = Object.keys(row).filter((column) => !keys.includes(column));
      const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
      const conflictColumns = keys.map(quoteIdentifier).join(", ");
      const updateSet = updateColumns
        .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
        .join(", ");
      const upsertSql = [
        `insert into ${targetTable}`,
        `select * from jsonb_populate_record(null::${targetTable}, $1::jsonb)`,
        `on conflict (${conflictColumns})`,
        updateSet ? `do update set ${updateSet}` : "do nothing",
      ].join(" ");
      await sql.unsafe(upsertSql, [row]);
      await sql`
        delete from ${sql(tombstoneTable)}
        where target_backend = ${targetBackend}
          and table_name = ${event.table_name}
          and record_key_hash = ${hash}
          and (generation, source_sequence) < (${event.generation}, ${event.sequence})
      `;
      const targetRows = await sql`
        select to_jsonb(target_row) as record_data
        from ${sql(targetTable)} target_row where ${where} limit 1
      `;
      const targetRow = filterTourneyMirrorRow(
        event.table_name,
        targetRows[0]?.record_data || {}
      );
      const [targetHashRow] = targetBackend === "supabase"
        ? await sql`
            select encode(extensions.digest(
              convert_to(to_jsonb(target_row)::text, 'UTF8'), 'sha256'
            ), 'hex') as record_hash
            from ${sql(targetTable)} target_row where ${where} limit 1
          `
        : await sql`
            select encode(public.digest(
              convert_to(to_jsonb(target_row)::text, 'UTF8'), 'sha256'
            ), 'hex') as record_hash
            from ${sql(targetTable)} target_row where ${where} limit 1
          `;
      const hashMatches = event.record_hash
        ? targetHashRow?.record_hash === event.record_hash
        : sha256(stableTourneyJson(targetRow)) === sha256(stableTourneyJson(row));
      if (!hashMatches) {
        const error = new Error("Tourney mirror target hash verification failed.");
        error.code = "TOURNEY_MIRROR_HASH_MISMATCH";
        throw error;
      }
    }

    await sql`
      insert into ${sql(checkpointTable)} (
        target_backend, source_backend, table_name, record_key_hash,
        source_sequence, event_id, generation, applied_at
      ) values (
        ${targetBackend}, ${event.source_backend}, ${event.table_name}, ${hash},
        ${event.sequence}, ${event.event_id}, ${event.generation}, now()
      )
      on conflict (target_backend, table_name, record_key_hash) do update
      set source_backend = excluded.source_backend,
          source_sequence = excluded.source_sequence,
          event_id = excluded.event_id,
          generation = excluded.generation,
          applied_at = now()
      where (${sql(checkpointTable)}.generation, ${sql(checkpointTable)}.source_sequence)
        < (excluded.generation, excluded.source_sequence)
    `;
    return { stale: false };
  });
};

export const reconcileTourneyMirror = async ({
  env = process.env,
  limit = 50,
  deadlineAt,
} = {}) => {
  assertTourneyWorkDeadline(deadlineAt);
  const policy = resolveTourneyStorePolicy(env);
  if (!policy.mirrorEnabled) return { enabled: false, applied: 0, failed: 0 };
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const targetSql = await getTourneySqlForBackend({ backend: targetBackend, env });
  const outboxTable = controlRelation(sourceBackend, "mirror_outbox");
  const leaseId = crypto.randomUUID();
  const events = await sourceSql.begin(async (sql) => {
    const rows = await sql`
      select candidate.* from ${sql(outboxTable)} candidate
      where ((
        candidate.status in ('pending', 'retry') and candidate.available_at <= now()
      ) or (
        candidate.status = 'processing' and candidate.lease_expires_at <= now()
      ))
      and not (
        candidate.table_name in ('external_operations','email_dispatches')
        and candidate.operation <> 'delete'
        and exists (
          select 1 from ${sql(outboxTable)} prerequisite
          where prerequisite.command_id = candidate.command_id
            and prerequisite.table_name = 'command_receipts'
            and prerequisite.operation <> 'delete'
            and prerequisite.status <> 'applied'
            and (prerequisite.generation, prerequisite.sequence) <
              (candidate.generation, candidate.sequence)
        )
      )
      and not (
        candidate.table_name = 'command_receipts'
        and candidate.operation = 'delete'
        and exists (
          select 1 from ${sql(outboxTable)} prerequisite
          where prerequisite.command_id = candidate.command_id
            and prerequisite.table_name in ('external_operations','email_dispatches')
            and prerequisite.operation = 'delete'
            and prerequisite.status <> 'applied'
            and (prerequisite.generation, prerequisite.sequence) <
              (candidate.generation, candidate.sequence)
        )
      )
      order by candidate.generation, candidate.sequence
      for update skip locked
      limit ${Math.max(1, Math.min(250, Number(limit) || 50))}
    `;
    if (rows.length === 0) return [];
    const sequences = rows.map((row) => row.sequence);
    await sql`
      update ${sql(outboxTable)} set
        status = 'processing', lease_id = ${leaseId},
        lease_expires_at = now() + interval '5 minutes',
        attempt_count = attempt_count + 1
      where sequence in ${sql(sequences)}
    `;
    return rows.map((row) => ({
      ...row,
      lease_id: leaseId,
      attempt_count: Number(row.attempt_count || 0) + 1,
    }));
  });
  let applied = 0;
  let failed = 0;
  for (const event of events) {
    try {
      assertTourneyWorkDeadline(deadlineAt);
      await applyMirrorEvent({ event, targetBackend, targetSql });
      await sourceSql.begin(async (sql) => {
        const completedRows = await sql`
          update ${sql(outboxTable)}
          set status = 'applied', applied_at = now(), lease_id = null,
              lease_expires_at = null, last_error_code = null, last_error_at = null
          where sequence = ${event.sequence} and status = 'processing'
            and lease_id = ${event.lease_id}
          returning sequence
        `;
        if (completedRows.length !== 1) {
          const error = new Error("Tourney mirror event lease changed.");
          error.code = "TOURNEY_MIRROR_LEASE_MISMATCH";
          throw error;
        }
        if (isNaturalTourneyMirrorEvent({ event, sourceBackend })) {
          const updated = await sql`
            update tourney.cutover_metadata set
              natural_mutation_verified_at = coalesce(natural_mutation_verified_at, now()),
              updated_at = now()
            where id = 'tourney' and hardened_active
              and natural_mutation_verified_at is null
            returning generation,natural_mutation_verified_at
          `;
          if (updated.length === 1) {
            await sql`
              insert into tourney.cutover_gate_events(event_kind,generation,actor,evidence)
              values('natural_mirror_verified',${updated[0].generation},'mirror-worker',
                ${sql.json({ table: event.table_name, eventId: event.event_id })})
            `;
          }
        }
      });
      applied += 1;
    } catch (error) {
      const deadlineExceeded =
        error?.code === "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED";
      const terminal = !deadlineExceeded &&
        Number(event.attempt_count) >= Number(event.max_attempts || 12);
      await sourceSql`
        update ${sourceSql(outboxTable)}
        set status = ${terminal ? "dead_letter" : "retry"},
            available_at = now() + make_interval(secs => least(300, 2 ^ least(attempt_count, 8))),
            lease_id = null, lease_expires_at = null,
            dead_lettered_at = case when ${terminal} then now() else null end,
            last_error_code = ${normalize(error?.code || "TOURNEY_MIRROR_FAILED").slice(0, 128)},
            last_error_at = now()
        where sequence = ${event.sequence} and status = 'processing'
          and lease_id = ${event.lease_id}
      `;
      if (deadlineExceeded) throw error;
      failed += 1;
    }
  }
  return { enabled: true, sourceBackend, targetBackend, applied, failed };
};

export const refreshTourneyCutoverClock = async ({
  env = process.env,
  actor = "reconciliation-cron",
  deadlineAt,
} = {}) => {
  assertTourneyWorkDeadline(deadlineAt);
  const policy = resolveTourneyStorePolicy(env);
  if (policy.primaryBackend !== "supabase") {
    return { clean_since: null, blocker: "supabase_primary_required" };
  }
  const sql = await getTourneySqlForBackend({ backend: "supabase", env });
  const [row] = await sql`
    select tourney.refresh_cutover_clock(${normalize(actor)}) as result
  `;
  return row?.result || { clean_since: null, blocker: "clock_unavailable" };
};

const readTourneyFallbackCheckpointCoverage = async ({
  supabaseSql,
  legacySql,
  generation,
}) => {
  const checkpointRows = await legacySql`
    select table_name, record_key_hash, applied_at
    from tourney_mirror_checkpoints
    where target_backend = 'legacy'
      and source_backend = 'supabase'
      and generation = ${generation}
  `;
  const checkpointHashes = new Map();
  let latestCheckpointAt = null;
  for (const checkpoint of checkpointRows) {
    const hashes = checkpointHashes.get(checkpoint.table_name) || new Set();
    hashes.add(checkpoint.record_key_hash);
    checkpointHashes.set(checkpoint.table_name, hashes);
    const appliedAt = new Date(checkpoint.applied_at);
    if (!Number.isNaN(appliedAt.getTime()) &&
        (!latestCheckpointAt || appliedAt > latestCheckpointAt)) {
      latestCheckpointAt = appliedAt;
    }
  }

  const missingByTable = {};
  const expectedByTable = {};
  for (const table of Object.keys(TOURNEY_MIRROR_TABLES)) {
    const rows = await supabaseSql`
      select to_jsonb(source_row) as record_data
      from ${supabaseSql(businessRelation("supabase", table))} source_row
    `;
    const expected = new Set(rows.map(({ record_data: recordData }) =>
      keyHash(buildTourneyMirrorKey(table, recordData))
    ));
    const covered = checkpointHashes.get(table) || new Set();
    const missing = [...expected].filter((hash) => !covered.has(hash)).length;
    expectedByTable[table] = expected.size;
    if (missing > 0) missingByTable[table] = missing;
  }
  return {
    complete: Object.keys(missingByTable).length === 0,
    expectedByTable,
    missingByTable,
    latestCheckpointAt,
  };
};

export const checkTourneyManualFailoverReadiness = async ({
  env = process.env,
  expectedControlPrimaryBackend = "",
  expectedControlGeneration = null,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const blockers = [];
  if (policy.primaryBackend !== "legacy") blockers.push("legacy_mode_not_selected");
  if (!policy.writesPaused) blockers.push("deployment_writes_not_paused");
  if (policy.generation < 2) blockers.push("failover_generation_not_advanced");
  const [legacySql, supabaseSql] = await Promise.all([
    getTourneySqlForBackend({ backend: "legacy", env }),
    getTourneySqlForBackend({ backend: "supabase", env }),
  ]);
  const [[legacyState], [supabaseState]] = await Promise.all([
    legacySql`
    select
      (select primary_backend from tourney_cutover_metadata where id='tourney') database_primary_backend,
      (select generation from tourney_cutover_metadata where id='tourney') database_generation,
      (select writes_paused from tourney_cutover_metadata where id='tourney') database_writes_paused,
      (select count(*) from tourney_mirror_outbox where status in ('pending','retry','processing')) mirror_pending,
      (select count(*) from tourney_mirror_outbox where status='dead_letter') mirror_dead,
      (select count(*) from tourney_external_operations where status in ('pending','retry','processing','dead_letter')) external_pending,
      (select count(*) from tourney_email_dispatches where status in ('pending','sending','retry','failed','dead_letter')) email_pending,
      (select count(*) from tourney_discord_role_assignments where status in ('pending','processing','retry','blocked','blocked_reauth','dead_letter')) discord_pending,
      (select count(*) from tourney_identity_conflicts where resolved_at is null) identity_conflicts,
      (select count(*) from tourney_import_quarantine where resolved_at is null) ambiguous_imports,
      (select count(*) from tourney_players where status='approved'
        and principal_id is null) player_principal_gaps,
      (select count(*) from tourney_account_snapshots) account_snapshot_count,
      (select count(*) from jsonb_array_elements(coalesce((
        select case
          when jsonb_typeof(accounts_json)='array' then accounts_json
          when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
          else '[]'::jsonb end
        from tourney_account_snapshots order by version desc limit 1
      ),'[]'::jsonb))) account_entry_count,
      (select count(*) from jsonb_array_elements(coalesce((
        select case
          when jsonb_typeof(accounts_json)='array' then accounts_json
          when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
          else '[]'::jsonb end
        from tourney_account_snapshots order by version desc limit 1
      ),'[]'::jsonb)) account where coalesce(account->>'principalId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') account_principal_gaps
    `,
    supabaseSql`
      select
        (select primary_backend from tourney.cutover_metadata where id='tourney') database_primary_backend,
        (select generation from tourney.cutover_metadata where id='tourney') database_generation,
        (select writes_paused from tourney.cutover_metadata where id='tourney') database_writes_paused,
        (select count(*) from tourney.mirror_outbox where status in ('pending','retry','processing')) mirror_pending,
        (select count(*) from tourney.mirror_outbox where status='dead_letter') mirror_dead,
        (select count(*) from tourney.external_operations where status in ('pending','retry','processing','dead_letter')) external_pending,
        (select count(*) from tourney.email_dispatches where status in ('pending','sending','retry','failed','dead_letter')) email_pending,
        (select count(*) from tourney.tourney_player_auth_operations where operation_status in ('pending','processing','auth_applied','retry')) auth_pending,
        (select count(*) from accounts.discord_role_assignments where status in ('pending','processing','retry','blocked','blocked_reauth','dead_letter')) discord_pending,
        (select count(*) from tourney.identity_conflicts where resolved_at is null) identity_conflicts,
        (select count(*) from migration.tourney_import_quarantine where resolved_at is null) ambiguous_imports,
        (select count(*) from tourney.tourney_players where status='approved'
          and principal_id is null) player_principal_gaps,
        (select count(*) from tourney.account_snapshots) account_snapshot_count,
        (select count(*) from jsonb_array_elements(coalesce((
          select case
            when jsonb_typeof(accounts_json)='array' then accounts_json
            when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
            else '[]'::jsonb end
          from tourney.account_snapshots order by version desc limit 1
        ),'[]'::jsonb))) account_entry_count,
        (select count(*) from jsonb_array_elements(coalesce((
          select case
            when jsonb_typeof(accounts_json)='array' then accounts_json
            when jsonb_typeof(accounts_json)='object' then coalesce(accounts_json->'accounts','[]'::jsonb)
            else '[]'::jsonb end
          from tourney.account_snapshots order by version desc limit 1
        ),'[]'::jsonb)) account where coalesce(account->>'principalId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') account_principal_gaps
    `,
  ]);
  const requiredCheckpointGeneration = Math.max(0, policy.generation - 1);
  const [[fallbackParity], fallbackCoverage] = await Promise.all([
    supabaseSql`
      select id, source_backend, target_backend, generation, status, created_at,
        created_at >= now() - interval '5 minutes' as fresh,
        created_at >= coalesce((
          select max(applied_at)
          from tourney.mirror_outbox
          where source_backend = 'supabase'
            and generation = ${requiredCheckpointGeneration}
        ), '-infinity'::timestamptz) as after_latest_mirror
      from tourney.parity_runs
      where source_backend = 'supabase'
        and target_backend = 'legacy'
        and generation = ${requiredCheckpointGeneration}
      order by created_at desc
      limit 1
    `,
    readTourneyFallbackCheckpointCoverage({
      supabaseSql,
      legacySql,
      generation: requiredCheckpointGeneration,
    }),
  ]);
  const expectedDatabasePrimary = normalize(expectedControlPrimaryBackend) || "legacy";
  const expectedDatabaseGeneration = Number.isSafeInteger(expectedControlGeneration)
    ? expectedControlGeneration
    : policy.generation;
  for (const state of [legacyState, supabaseState]) {
    if (!state?.database_writes_paused) blockers.push("database_writes_not_paused");
    if (state?.database_primary_backend !== expectedDatabasePrimary ||
        Number(state?.database_generation) !== expectedDatabaseGeneration) {
      blockers.push("database_control_mismatch");
    }
  }
  if (Number(legacyState?.mirror_pending || 0) > 0 ||
      Number(supabaseState?.mirror_pending || 0) > 0) blockers.push("mirror_pending");
  if (Number(legacyState?.mirror_dead || 0) > 0 ||
      Number(supabaseState?.mirror_dead || 0) > 0) blockers.push("mirror_dead_letter");
  if (Number(legacyState?.external_pending || 0) > 0 ||
      Number(supabaseState?.external_pending || 0) > 0) blockers.push("external_operations_pending");
  if (Number(legacyState?.email_pending || 0) > 0 ||
      Number(supabaseState?.email_pending || 0) > 0) blockers.push("email_pending");
  if (Number(supabaseState?.auth_pending || 0) > 0) blockers.push("auth_operations_pending");
  if (Number(legacyState?.discord_pending || 0) > 0 ||
      Number(supabaseState?.discord_pending || 0) > 0) blockers.push("discord_operations_pending");
  if (Number(legacyState?.identity_conflicts || 0) > 0 ||
      Number(supabaseState?.identity_conflicts || 0) > 0) blockers.push("identity_conflicts");
  if (Number(legacyState?.ambiguous_imports || 0) > 0 ||
      Number(supabaseState?.ambiguous_imports || 0) > 0) blockers.push("ambiguous_imports");
  if (Number(legacyState?.account_snapshot_count || 0) < 1 ||
      Number(supabaseState?.account_snapshot_count || 0) < 1) blockers.push("account_snapshot_missing");
  if (Number(legacyState?.account_entry_count || 0) < 1 ||
      Number(supabaseState?.account_entry_count || 0) < 1) blockers.push("account_snapshot_empty");
  if (Number(legacyState?.account_principal_gaps || 0) > 0 ||
      Number(supabaseState?.account_principal_gaps || 0) > 0) blockers.push("account_principal_gaps");
  if (Number(legacyState?.player_principal_gaps || 0) > 0 ||
      Number(supabaseState?.player_principal_gaps || 0) > 0) blockers.push("player_principal_gaps");
  if (!fallbackParity || fallbackParity.status !== "clean") {
    blockers.push("fallback_parity_not_clean");
  } else {
    if (!fallbackParity.fresh) blockers.push("fallback_parity_stale");
    const parityAt = new Date(fallbackParity.created_at);
    const afterLatestCheckpoint = !fallbackCoverage.latestCheckpointAt ||
      (!Number.isNaN(parityAt.getTime()) &&
        parityAt >= fallbackCoverage.latestCheckpointAt);
    if (!fallbackParity.after_latest_mirror || !afterLatestCheckpoint) {
      blockers.push("fallback_parity_precedes_mirror");
    }
  }
  if (!fallbackCoverage.complete) blockers.push("fallback_checkpoint_incomplete");
  return {
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    state: {
      legacy: legacyState,
      supabase: supabaseState,
      fallbackParity: fallbackParity || null,
      fallbackCoverage,
    },
  };
};

const normalizeRows = (rows) =>
  rows.map((row) => JSON.parse(JSON.stringify(row))).sort((left, right) =>
    stableTourneyJson(left).localeCompare(stableTourneyJson(right))
  );

const readTourneyMirrorWatermark = async ({ sql, backend }) => {
  const outbox = controlRelation(backend, "mirror_outbox");
  const [row] = await sql`
    select coalesce(max(sequence),0)::bigint sequence,
      count(*) filter (
        where status in ('pending','retry','processing')
      )::integer active
    from ${sql(outbox)}
  `;
  return {
    sequence: String(row?.sequence || "0"),
    active: Number(row?.active || 0),
  };
};

export const runTourneyParity = async ({
  env = process.env,
  deadlineAt = Number.POSITIVE_INFINITY,
} = {}) => {
  assertTourneyWorkDeadline(deadlineAt);
  const policy = resolveTourneyStorePolicy(env);
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const targetSql = await getTourneySqlForBackend({ backend: targetBackend, env });
  const startingWatermark = await readTourneyMirrorWatermark({
    sql: sourceSql,
    backend: sourceBackend,
  });
  if (startingWatermark.active > 0) {
    return {
      sourceBackend,
      targetBackend,
      status: "inconclusive",
      skipped: true,
      reason: "mirror_in_transit",
    };
  }
  const counts = {};
  const drift = {};
  const canonicalHashes = {};
  for (const table of Object.keys(TOURNEY_MIRROR_TABLES)) {
    assertTourneyWorkDeadline(deadlineAt);
    const sourceRows = normalizeRows(await sourceSql`select * from ${sourceSql(businessRelation(sourceBackend, table))}`);
    assertTourneyWorkDeadline(deadlineAt);
    const targetRows = normalizeRows(await targetSql`select * from ${targetSql(businessRelation(targetBackend, table))}`);
    const sourceHash = sha256(stableTourneyJson(sourceRows));
    const targetHash = sha256(stableTourneyJson(targetRows));
    counts[table] = { source: sourceRows.length, target: targetRows.length };
    canonicalHashes[table] = { source: sourceHash, target: targetHash };
    if (sourceHash !== targetHash) drift[table] = { sourceHash, targetHash };
  }
  assertTourneyWorkDeadline(deadlineAt);
  const playerStatusRows = await sourceSql`
    select status, count(*)::integer as count
    from ${sourceSql(businessRelation(sourceBackend, "tourney_players"))}
    group by status order by status
  `;
  counts.player_statuses = Object.fromEntries(
    playerStatusRows.map((row) => [row.status, Number(row.count)])
  );
  assertTourneyWorkDeadline(deadlineAt);
  const targetPlayerStatusRows = await targetSql`
    select status, count(*)::integer as count
    from ${targetSql(businessRelation(targetBackend, "tourney_players"))}
    group by status order by status
  `;
  const targetPlayerStatuses = Object.fromEntries(
    targetPlayerStatusRows.map((row) => [row.status, Number(row.count)])
  );
  if (stableTourneyJson(counts.player_statuses) !== stableTourneyJson(targetPlayerStatuses)) {
    drift.player_statuses = {
      source: counts.player_statuses,
      target: targetPlayerStatuses,
    };
  }
  const statusCounts = {
    source: counts.player_statuses,
    target: targetPlayerStatuses,
  };
  const readRelationships = async (sql, backend) => {
    const members = businessRelation(backend, "tourney_bracket_team_members");
    const teams = businessRelation(backend, "tourney_bracket_teams");
    const players = businessRelation(backend, "tourney_players");
    const appeals = businessRelation(backend, "tourney_appeals");
    const payouts = businessRelation(backend, "tourney_payouts");
    const [row] = await sql`
      select
        (select count(*) from ${sql(members)} member
          left join ${sql(teams)} team on team.id = member.team_id
          where team.id is null)::integer as orphan_teams,
        (select count(*) from ${sql(members)} member
          left join ${sql(players)} player on player.id = member.player_id
          where member.player_id is not null and player.id is null
        )::integer as orphan_players,
        (select count(*) from ${sql(appeals)} appeal
          left join ${sql(players)} player on player.id = appeal.submitter_player_id
          where appeal.submitter_player_id is not null and player.id is null
        )::integer as orphan_appeal_submitters,
        (select count(*) from ${sql(appeals)} appeal
          left join ${sql(players)} player on player.id = appeal.subject_player_id
          where appeal.subject_player_id is not null and player.id is null
        )::integer as orphan_appeal_subjects,
        (select count(*) from ${sql(payouts)} payout
          left join ${sql(players)} player on player.id = payout.player_id
          where player.id is null)::integer as orphan_payout_players
    `;
    return {
      orphan_teams: Number(row?.orphan_teams || 0),
      orphan_players: Number(row?.orphan_players || 0),
      orphan_appeal_submitters: Number(row?.orphan_appeal_submitters || 0),
      orphan_appeal_subjects: Number(row?.orphan_appeal_subjects || 0),
      orphan_payout_players: Number(row?.orphan_payout_players || 0),
    };
  };
  assertTourneyWorkDeadline(deadlineAt);
  const sourceRelationships = await readRelationships(sourceSql, sourceBackend);
  assertTourneyWorkDeadline(deadlineAt);
  const relationships = {
    source: sourceRelationships,
    target: await readRelationships(targetSql, targetBackend),
  };
  if (
    stableTourneyJson(relationships.source) !== stableTourneyJson(relationships.target) ||
    Object.values(relationships.source).some((count) => count > 0) ||
    Object.values(relationships.target).some((count) => count > 0)
  ) {
    drift.relationships = relationships;
  }
  const endingWatermark = await readTourneyMirrorWatermark({
    sql: sourceSql,
    backend: sourceBackend,
  });
  if (
    endingWatermark.active > 0 ||
    endingWatermark.sequence !== startingWatermark.sequence
  ) {
    return {
      sourceBackend,
      targetBackend,
      status: "inconclusive",
      skipped: true,
      reason: "source_changed_during_parity",
    };
  }
  const status = Object.keys(drift).length === 0 ? "clean" : "drift";
  assertTourneyWorkDeadline(deadlineAt);
  const shadowResults = Object.fromEntries(
    (await sourceSql`
      select distinct on (route) route,shape_match,value_match,ordering_match,
        error_match,primary_status,shadow_status,observed_at
      from ${sourceSql(controlRelation(sourceBackend, "shadow_observations"))}
      order by route,observed_at desc,id desc
    `).map((row) => [row.route, row])
  );
  assertTourneyWorkDeadline(deadlineAt);
  const parityTable = controlRelation(sourceBackend, "parity_runs");
  await sourceSql`
    insert into ${sourceSql(parityTable)} (
      source_backend, target_backend, generation, status, counts, drift,
      relationships, status_counts, canonical_hashes, shadow_results
    ) values (
      ${sourceBackend}, ${targetBackend}, ${policy.generation}, ${status},
      ${sourceSql.json(counts)}, ${sourceSql.json(drift)}, ${sourceSql.json(relationships)},
      ${sourceSql.json(statusCounts)}, ${sourceSql.json(canonicalHashes)},
      ${sourceSql.json(shadowResults)}
    )
  `;
  return {
    sourceBackend,
    targetBackend,
    status,
    counts,
    drift,
    relationships,
    statusCounts,
    canonicalHashes,
    shadowResults,
  };
};

const shapeOf = (value) => {
  if (Array.isArray(value)) {
    const itemShapes = [...new Set(value.map((entry) => stableTourneyJson(shapeOf(entry))))].sort();
    return { type: "array", items: itemShapes };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, shapeOf(value[key])])
    );
  }
  return value === null ? "null" : typeof value;
};
const unordered = (value) => Array.isArray(value)
  ? value.map(unordered).sort((left, right) =>
      stableTourneyJson(left).localeCompare(stableTourneyJson(right)))
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, unordered(value[key])]))
    : value;

export const runTourneyShadowReadSamples = async ({
  env = process.env,
  rounds = 10,
  deadlineAt = Number.POSITIVE_INFINITY,
} = {}) => {
  assertTourneyWorkDeadline(deadlineAt);
  const policy = resolveTourneyStorePolicy(env);
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const targetSql = await getTourneySqlForBackend({ backend: targetBackend, env });
  const observationTable = controlRelation(sourceBackend, "shadow_observations");
  const targetObservationTable = controlRelation(targetBackend, "shadow_observations");
  const safeRounds = Math.max(1, Math.min(30, Number(rounds) || 1));
  const observations = [];
  const startingWatermark = await readTourneyMirrorWatermark({
    sql: sourceSql,
    backend: sourceBackend,
  });
  if (startingWatermark.active > 0) {
    return {
      sourceBackend,
      targetBackend,
      skipped: true,
      reason: "mirror_in_transit",
      samples: 0,
      mismatches: 0,
    };
  }
  const { readTourneyService, TOURNEY_READ_SERVICES } = await import("./readService.js");
  const { getTourneyTwitchRosterMetadataSnapshot } = await import("./playerStore.js");
  const sourcePlayers = businessRelation(sourceBackend, "tourney_players");
  const targetPlayers = businessRelation(targetBackend, "tourney_players");
  const [sourceTwitchRows, targetTwitchRows] = await Promise.all([
    sourceSql`select twitch_username from ${sourceSql(sourcePlayers)} where status='approved'`,
    targetSql`select twitch_username from ${targetSql(targetPlayers)} where status='approved'`,
  ]);
  const twitchUsernames = [...new Set(
    [...sourceTwitchRows, ...targetTwitchRows]
      .map((row) => String(row.twitch_username || "").trim())
      .filter(Boolean)
  )];

  const inconclusive = (reason) => ({
    sourceBackend,
    targetBackend,
    skipped: true,
    reason,
    samples: observations.length,
    mismatches: observations.filter((item) =>
      !(item.shapeMatch && item.valueMatch && item.orderingMatch && item.errorMatch)
    ).length,
  });

  for (let round = 0; round < safeRounds; round += 1) {
    assertTourneyWorkDeadline(deadlineAt);
    for (const route of Object.keys(TOURNEY_READ_SERVICES)) {
      assertTourneyWorkDeadline(deadlineAt);
      const beforeSample = await readTourneyMirrorWatermark({
        sql: sourceSql,
        backend: sourceBackend,
      });
      if (
        beforeSample.active > 0 ||
        beforeSample.sequence !== startingWatermark.sequence
      ) {
        return inconclusive("source_changed_during_shadow_reads");
      }
      const externalStartedAt = performance.now();
      const twitchSnapshot = route === "public_roster"
        ? await getTourneyTwitchRosterMetadataSnapshot({
            usernames: twitchUsernames,
            env,
          })
        : undefined;
      const externalLatencyMs = route === "public_roster"
        ? Math.max(0, Math.round(performance.now() - externalStartedAt))
        : 0;
      const sourceEnv = twitchSnapshot === undefined
        ? { ...env, TOURNEY_DATABASE_MODE: sourceBackend }
        : {
            ...env,
            TOURNEY_DATABASE_MODE: sourceBackend,
            __TOURNEY_TWITCH_SHADOW_SNAPSHOT: twitchSnapshot,
          };
      const targetEnv = twitchSnapshot === undefined
        ? { ...env, TOURNEY_DATABASE_MODE: targetBackend }
        : {
            ...env,
            TOURNEY_DATABASE_MODE: targetBackend,
            __TOURNEY_TWITCH_SHADOW_SNAPSHOT: twitchSnapshot,
          };
      const [source, target] = await Promise.all([
        readTourneyService({ route, env: sourceEnv }),
        readTourneyService({ route, env: targetEnv }),
      ]);
      source.latencyMs += externalLatencyMs;
      target.latencyMs += externalLatencyMs;
      const afterSample = await readTourneyMirrorWatermark({
        sql: sourceSql,
        backend: sourceBackend,
      });
      if (
        afterSample.active > 0 ||
        afterSample.sequence !== startingWatermark.sequence
      ) {
        return inconclusive("source_changed_during_shadow_reads");
      }
      const shapeMatch = stableTourneyJson(shapeOf(source.body)) === stableTourneyJson(shapeOf(target.body));
      const valueMatch = stableTourneyJson(unordered(source.body)) === stableTourneyJson(unordered(target.body));
      const orderingMatch = stableTourneyJson(source.body) === stableTourneyJson(target.body);
      const sourceSucceeded = source.status >= 200 && source.status < 300;
      const targetSucceeded = target.status >= 200 && target.status < 300;
      const errorMatch = sourceSucceeded && targetSucceeded &&
        source.status === target.status &&
        source.errorCode === target.errorCode;
      const sourceHash = source.body === null ? null : sha256(stableTourneyJson(source.body));
      const targetHash = target.body === null ? null : sha256(stableTourneyJson(target.body));
      assertTourneyWorkDeadline(deadlineAt);
      await sourceSql`
        insert into ${sourceSql(observationTable)} (
          route, shape_match, value_match, ordering_match, error_match,
          primary_latency_ms, shadow_latency_ms, primary_status, shadow_status,
          primary_error_code, shadow_error_code, primary_hash, shadow_hash
        ) values (
          ${route}, ${shapeMatch}, ${valueMatch}, ${orderingMatch}, ${errorMatch},
          ${source.latencyMs}, ${target.latencyMs}, ${source.status}, ${target.status},
          ${source.errorCode || null}, ${target.errorCode || null},
          ${sourceHash}, ${targetHash}
        )
      `;
      assertTourneyWorkDeadline(deadlineAt);
      await targetSql`
        insert into ${targetSql(targetObservationTable)} (
          route, shape_match, value_match, ordering_match, error_match,
          primary_latency_ms, shadow_latency_ms, primary_status, shadow_status,
          primary_error_code, shadow_error_code, primary_hash, shadow_hash
        ) values (
          ${route}, ${shapeMatch}, ${valueMatch}, ${orderingMatch}, ${errorMatch},
          ${source.latencyMs}, ${target.latencyMs}, ${source.status}, ${target.status},
          ${source.errorCode || null}, ${target.errorCode || null},
          ${sourceHash}, ${targetHash}
        )
      `;
      observations.push({
        route,
        shapeMatch,
        valueMatch,
        orderingMatch,
        errorMatch,
        sourceLatency: source.latencyMs,
        targetLatency: target.latencyMs,
      });
    }
  }

  const endingWatermark = await readTourneyMirrorWatermark({
    sql: sourceSql,
    backend: sourceBackend,
  });
  if (
    endingWatermark.active > 0 ||
    endingWatermark.sequence !== startingWatermark.sequence
  ) {
    return inconclusive("source_changed_during_shadow_reads");
  }

  return {
    sourceBackend,
    targetBackend,
    samples: observations.length,
    mismatches: observations.filter((item) =>
      !(item.shapeMatch && item.valueMatch && item.orderingMatch && item.errorMatch)
    ).length,
  };
};

export class TourneyStore {
  constructor(env = process.env) {
    this.env = env;
    this.policy = resolveTourneyStorePolicy(env);
    this.domains = TOURNEY_STORE_DOMAINS;
  }

  execute(options) {
    return executeTourneyCommand({ ...options, env: this.env });
  }

  reconcileMirror(options = {}) {
    return reconcileTourneyMirror({ ...options, env: this.env });
  }

  parity(options = {}) {
    return runTourneyParity({ ...options, env: this.env });
  }
}

export const createTourneyStore = (env = process.env) => new TourneyStore(env);

export const resetMemoryTourneyControlForTests = () => {
  MEMORY_RECEIPTS.clear();
};
