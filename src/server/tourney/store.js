import crypto from "node:crypto";
import {
  getTourneySqlForBackend,
  isSupabaseTourneyDatabase,
  runTourneyTransaction,
} from "./sqlClient.js";
import {
  TOURNEY_MIRROR_TABLES,
  filterTourneyMirrorRow,
  getTourneyMirrorContract,
} from "./mirrorContract.js";

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

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const normalize = (value) => String(value || "").trim();
const enabled = (value) => TRUE_VALUES.has(normalize(value).toLowerCase());
const sha256 = (value) =>
  crypto.createHash("sha256").update(String(value || "")).digest("hex");
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
const MEMORY_RECEIPTS =
  globalThis.__rooTourneyCommandReceipts ||
  (globalThis.__rooTourneyCommandReceipts = new Map());
const NON_NATURAL_COMMAND_PREFIXES = Object.freeze([
  "account-snapshot:seed",
  "discord-backfill",
  "discord-state-seed",
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
  mirrorEnabled: enabled(env.TOURNEY_MIRROR_ENABLED),
  writesPaused: enabled(env.TOURNEY_WRITES_PAUSED),
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
    const error = new Error("Tournament updates are briefly paused. Try again shortly.");
    error.status = 503;
    error.code = "TOURNEY_WRITES_PAUSED";
    error.retryAfter = 30;
    throw error;
  }

  const id = normalizeCommandId(commandId);
  const normalizedPurpose = normalize(purpose).toLowerCase();
  if (!TOURNEY_STORE_DOMAINS.includes(normalizedPurpose.split(":")[0])) {
    throw new Error("Unsupported Tourney command domain.");
  }
  const requestHash = sha256(stableJson({ purpose: normalizedPurpose, requestPayload }));
  if (env.NODE_ENV === "test" || env.TOURNEY_DATABASE_MODE === "memory") {
    const existing = MEMORY_RECEIPTS.get(id);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.purpose !== normalizedPurpose) {
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
  const transactionResult = await runTourneyTransaction({
    env,
    lockKey: `roo-tourney-command:${id}`,
    waitForLock: true,
    callback: async (sql) => {
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
        if (!receipt || receipt.request_hash !== requestHash || receipt.purpose !== normalizedPurpose) {
          const conflict = new Error("Idempotency-Key was already used for another action.");
          conflict.status = 409;
          conflict.code = "TOURNEY_IDEMPOTENCY_CONFLICT";
          throw conflict;
        }
        if (["committed", "completed"].includes(receipt.status)) {
          return {
            replayed: true,
            status: Number(receipt.result_status || 200),
            body: receipt.result_body || {},
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

  if (transactionResult.receiptStatus === "completed") {
    const body = transactionResult.replayed && transactionResult.body &&
      typeof transactionResult.body === "object" && !Array.isArray(transactionResult.body)
      ? { ...transactionResult.body, replayed: true }
      : transactionResult.body;
    return { ...transactionResult, body };
  }

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
    await reconcileTourneyExternalOperations({
      env,
      limit: 25,
      commandId: id,
      context: postCommitContext,
    });
    await email.reconcileTourneyEmailDispatches({ env, limit: 25, commandId: id });
    if (policy.mirrorEnabled) await reconcileTourneyMirror({ env, limit: 100 });
    const [externalPending, emailPending] = await Promise.all([
      hasPendingTourneyExternalOperations({ commandId: id, env }),
      email.hasPendingTourneyEmailDispatches({ commandId: id, env }),
    ]);
    syncPending = externalPending || emailPending;
  } catch {
    syncPending = true;
  }

  if (!syncPending) {
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

const keyHash = (recordKey) => sha256(stableJson(recordKey));
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
        : sha256(stableJson(targetRow)) === sha256(stableJson(row));
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

export const reconcileTourneyMirror = async ({ env = process.env, limit = 50 } = {}) => {
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
      select * from ${sql(outboxTable)}
      where (
        status in ('pending', 'retry') and available_at <= now()
      ) or (
        status = 'processing' and lease_expires_at <= now()
      )
      order by generation, sequence
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
      await applyMirrorEvent({ event, targetBackend, targetSql });
      const completedRows = await sourceSql`
        update ${sourceSql(outboxTable)}
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
        await sourceSql.begin(async (sql) => {
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
        });
      }
      applied += 1;
    } catch (error) {
      const terminal = Number(event.attempt_count) >= Number(event.max_attempts || 12);
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
      failed += 1;
    }
  }
  return { enabled: true, sourceBackend, targetBackend, applied, failed };
};

export const refreshTourneyCutoverClock = async ({
  env = process.env,
  actor = "reconciliation-cron",
} = {}) => {
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

export const checkTourneyManualFailoverReadiness = async ({
  env = process.env,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const blockers = [];
  if (policy.primaryBackend !== "legacy") blockers.push("legacy_mode_not_selected");
  if (!policy.writesPaused) blockers.push("deployment_writes_not_paused");
  if (policy.generation < 1) blockers.push("failover_generation_not_advanced");
  const sql = await getTourneySqlForBackend({ backend: "legacy", env });
  const [state] = await sql`
    select
      (select writes_paused from tourney_cutover_metadata where id='tourney') database_writes_paused,
      (select count(*) from tourney_mirror_outbox where status in ('pending','retry','processing')) mirror_pending,
      (select count(*) from tourney_mirror_outbox where status='dead_letter') mirror_dead,
      (select count(*) from tourney_external_operations where status in ('pending','retry','processing','dead_letter')) external_pending,
      (select count(*) from tourney_email_dispatches where status in ('pending','sending','retry','failed','dead_letter')) email_pending,
      (select count(*) from tourney_import_quarantine where resolved_at is null) ambiguous_imports,
      (select max(generation) from tourney_mirror_checkpoints where target_backend='legacy') checkpoint_generation
  `;
  if (!state?.database_writes_paused) blockers.push("database_writes_not_paused");
  if (Number(state?.mirror_pending || 0) > 0) blockers.push("mirror_pending");
  if (Number(state?.mirror_dead || 0) > 0) blockers.push("mirror_dead_letter");
  if (Number(state?.external_pending || 0) > 0) blockers.push("external_operations_pending");
  if (Number(state?.email_pending || 0) > 0) blockers.push("email_pending");
  if (Number(state?.ambiguous_imports || 0) > 0) blockers.push("ambiguous_imports");
  if (Number(state?.checkpoint_generation || -1) < policy.generation) {
    blockers.push("fallback_checkpoint_stale");
  }
  return { ready: blockers.length === 0, blockers, state };
};

const normalizeRows = (rows) =>
  rows.map((row) => JSON.parse(JSON.stringify(row))).sort((left, right) =>
    stableJson(left).localeCompare(stableJson(right))
  );

export const runTourneyParity = async ({ env = process.env } = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const targetSql = await getTourneySqlForBackend({ backend: targetBackend, env });
  const counts = {};
  const drift = {};
  const canonicalHashes = {};
  for (const table of Object.keys(TOURNEY_MIRROR_TABLES)) {
    const sourceRows = normalizeRows(await sourceSql`select * from ${sourceSql(businessRelation(sourceBackend, table))}`);
    const targetRows = normalizeRows(await targetSql`select * from ${targetSql(businessRelation(targetBackend, table))}`);
    const sourceHash = sha256(stableJson(sourceRows));
    const targetHash = sha256(stableJson(targetRows));
    counts[table] = { source: sourceRows.length, target: targetRows.length };
    canonicalHashes[table] = { source: sourceHash, target: targetHash };
    if (sourceHash !== targetHash) drift[table] = { sourceHash, targetHash };
  }
  const playerStatusRows = await sourceSql`
    select status, count(*)::integer as count
    from ${sourceSql(businessRelation(sourceBackend, "tourney_players"))}
    group by status order by status
  `;
  counts.player_statuses = Object.fromEntries(
    playerStatusRows.map((row) => [row.status, Number(row.count)])
  );
  const targetPlayerStatusRows = await targetSql`
    select status, count(*)::integer as count
    from ${targetSql(businessRelation(targetBackend, "tourney_players"))}
    group by status order by status
  `;
  const targetPlayerStatuses = Object.fromEntries(
    targetPlayerStatusRows.map((row) => [row.status, Number(row.count)])
  );
  if (stableJson(counts.player_statuses) !== stableJson(targetPlayerStatuses)) {
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
    const [row] = await sql`
      select
        count(*) filter (where team.id is null)::integer as orphan_teams,
        count(*) filter (
          where member.player_id is not null and player.id is null
        )::integer as orphan_players
      from ${sql(members)} member
      left join ${sql(teams)} team on team.id = member.team_id
      left join ${sql(players)} player on player.id = member.player_id
    `;
    return {
      orphan_teams: Number(row?.orphan_teams || 0),
      orphan_players: Number(row?.orphan_players || 0),
    };
  };
  const relationships = {
    source: await readRelationships(sourceSql, sourceBackend),
    target: await readRelationships(targetSql, targetBackend),
  };
  if (
    stableJson(relationships.source) !== stableJson(relationships.target) ||
    Object.values(relationships.source).some((count) => count > 0) ||
    Object.values(relationships.target).some((count) => count > 0)
  ) {
    drift.relationships = relationships;
  }
  const status = Object.keys(drift).length === 0 ? "clean" : "drift";
  const shadowResults = Object.fromEntries(
    (await sourceSql`
      select distinct on (route) route,shape_match,value_match,ordering_match,
        error_match,primary_status,shadow_status,observed_at
      from ${sourceSql(controlRelation(sourceBackend, "shadow_observations"))}
      order by route,observed_at desc,id desc
    `).map((row) => [row.route, row])
  );
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
    const itemShapes = [...new Set(value.map((entry) => stableJson(shapeOf(entry))))].sort();
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
  ? value.map(unordered).sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, unordered(value[key])]))
    : value;

export const runTourneyShadowReadSamples = async ({
  env = process.env,
  rounds = 10,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const targetSql = await getTourneySqlForBackend({ backend: targetBackend, env });
  const observationTable = controlRelation(sourceBackend, "shadow_observations");
  const targetObservationTable = controlRelation(targetBackend, "shadow_observations");
  const safeRounds = Math.max(1, Math.min(30, Number(rounds) || 1));
  const observations = [];
  const { readTourneyService, TOURNEY_READ_SERVICES } = await import("./readService.js");

  for (let round = 0; round < safeRounds; round += 1) {
    for (const route of Object.keys(TOURNEY_READ_SERVICES)) {
      const [source, target] = await Promise.all([
        readTourneyService({
          route,
          env: { ...env, TOURNEY_DATABASE_MODE: sourceBackend },
        }),
        readTourneyService({
          route,
          env: { ...env, TOURNEY_DATABASE_MODE: targetBackend },
        }),
      ]);
      const shapeMatch = stableJson(shapeOf(source.body)) === stableJson(shapeOf(target.body));
      const valueMatch = stableJson(unordered(source.body)) === stableJson(unordered(target.body));
      const orderingMatch = stableJson(source.body) === stableJson(target.body);
      const errorMatch = source.status === target.status && source.errorCode === target.errorCode;
      const sourceHash = source.body === null ? null : sha256(stableJson(source.body));
      const targetHash = target.body === null ? null : sha256(stableJson(target.body));
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

  parity() {
    return runTourneyParity({ env: this.env });
  }
}

export const createTourneyStore = (env = process.env) => new TourneyStore(env);

export const resetMemoryTourneyControlForTests = () => {
  MEMORY_RECEIPTS.clear();
};
