import crypto from "node:crypto";
import {
  getTourneySqlForBackend,
  isSupabaseTourneyDatabase,
  runTourneyTransaction,
} from "./sqlClient.js";

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
]);

export const TOURNEY_MIRROR_TABLES = Object.freeze({
  tourney_players: ["id"],
  tourney_player_tokens: ["id"],
  tourney_registration_config: ["id"],
  tourney_bracket_teams: ["id"],
  tourney_bracket_team_members: ["id"],
  tourney_bracket_meta: ["id"],
  tourney_bracket_entities: ["entity_type", "entity_id"],
  tourney_bracket_counters: ["entity_type"],
  tourney_bracket_audit: ["id"],
  tourney_bracket_lock: ["id"],
  tourney_appeals: ["id"],
  tourney_payouts: ["id"],
  email_dispatches: ["id"],
});

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

export const resolveTourneyStorePolicy = (env = process.env) => ({
  primaryBackend: isSupabaseTourneyDatabase(env) ? "supabase" : "legacy",
  mirrorEnabled: enabled(env.TOURNEY_MIRROR_ENABLED),
  writesPaused: enabled(env.TOURNEY_WRITES_PAUSED),
  generation: parseGeneration(env.TOURNEY_FAILOVER_GENERATION),
});

const controlRelation = (backend, table) =>
  backend === "supabase" ? `tourney.${table}` : `tourney_${table}`;
const businessRelation = (backend, table) =>
  backend === "supabase"
    ? `tourney.${table}`
    : table === "email_dispatches"
      ? "tourney_email_dispatches"
      : table;

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
  return normalizeCommandId(supplied);
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
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Tourney command callback is required.");
  }
  const policy = resolveTourneyStorePolicy(env);
  if (policy.writesPaused) {
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

  return runTourneyTransaction({
    env,
    lockKey: `roo-tourney-command:${id}`,
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
        if (receipt.status === "completed") {
          return {
            replayed: true,
            status: Number(receipt.result_status || 200),
            body: receipt.result_body || {},
          };
        }
      }

      const result = (await callback()) || {};
      const status = Number(result.status || 200);
      const body = result.body ?? result;
      await sql`
        update ${sql(receiptTable)}
        set status = 'completed', result_status = ${status},
            result_body = ${sql.json(body)}, completed_at = now(), updated_at = now()
        where command_id = ${id}
      `;
      return { replayed: false, status, body };
    },
  });
};

const keyHash = (recordKey) => sha256(stableJson(recordKey));
const targetWhere = (sql, keys, recordKey) => {
  const clauses = keys.map((key) => sql`${sql(key)} = ${recordKey[key]}`);
  return clauses.reduce((combined, clause) =>
    combined ? sql`${combined} and ${clause}` : clause
  , null);
};

const applyMirrorEvent = async ({ event, targetBackend, targetSql }) => {
  const keys = TOURNEY_MIRROR_TABLES[event.table_name];
  if (!keys) throw new Error("Unsupported Tourney mirror table.");
  const checkpointTable = controlRelation(targetBackend, "mirror_checkpoints");
  const tombstoneTable = controlRelation(targetBackend, "mirror_tombstones");
  const targetTable = businessRelation(targetBackend, event.table_name);
  const hash = keyHash(event.record_key);

  return targetSql.begin(async (sql) => {
    await sql`select set_config('roo.tourney_mirror_apply', '1', true)`;
    const checkpoints = await sql`
      select source_sequence from ${sql(checkpointTable)}
      where target_backend = ${targetBackend}
        and table_name = ${event.table_name}
        and record_key_hash = ${hash}
      for update
    `;
    if (Number(checkpoints[0]?.source_sequence || 0) >= Number(event.sequence)) {
      return { stale: true };
    }

    const where = targetWhere(sql, keys, event.record_key);
    if (event.operation === "delete") {
      await sql`delete from ${sql(targetTable)} where ${where}`;
      await sql`
        insert into ${sql(tombstoneTable)} (
          target_backend, table_name, record_key_hash, record_key,
          source_sequence, generation, deleted_at
        ) values (
          ${targetBackend}, ${event.table_name}, ${hash}, ${sql.json(event.record_key)},
          ${event.sequence}, ${event.generation}, ${event.occurred_at}
        )
        on conflict (target_backend, table_name, record_key_hash) do update
        set record_key = excluded.record_key,
            source_sequence = excluded.source_sequence,
            generation = excluded.generation,
            deleted_at = excluded.deleted_at
        where ${sql(tombstoneTable)}.source_sequence < excluded.source_sequence
      `;
    } else {
      const row = event.record_data || {};
      const columns = Object.keys(row);
      const updateColumns = columns.filter((column) => !keys.includes(column));
      await sql`
        insert into ${sql(targetTable)} ${sql(row, columns)}
        on conflict (${sql(keys)}) do update set ${sql(row, updateColumns)}
      `;
      await sql`
        delete from ${sql(tombstoneTable)}
        where target_backend = ${targetBackend}
          and table_name = ${event.table_name}
          and record_key_hash = ${hash}
          and source_sequence < ${event.sequence}
      `;
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
      where ${sql(checkpointTable)}.source_sequence < excluded.source_sequence
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
  const events = await sourceSql`
    select * from ${sourceSql(outboxTable)}
    where applied_at is null and available_at <= now()
    order by sequence
    limit ${Math.max(1, Math.min(250, Number(limit) || 50))}
  `;
  let applied = 0;
  let failed = 0;
  for (const event of events) {
    try {
      await applyMirrorEvent({ event, targetBackend, targetSql });
      await sourceSql`
        update ${sourceSql(outboxTable)}
        set applied_at = now(), last_error_code = null, last_error_at = null
        where sequence = ${event.sequence} and applied_at is null
      `;
      applied += 1;
    } catch (error) {
      await sourceSql`
        update ${sourceSql(outboxTable)}
        set attempt_count = attempt_count + 1,
            available_at = now() + make_interval(secs => least(300, 2 ^ least(attempt_count, 8))),
            last_error_code = ${normalize(error?.code || "TOURNEY_MIRROR_FAILED").slice(0, 128)},
            last_error_at = now()
        where sequence = ${event.sequence} and applied_at is null
      `;
      failed += 1;
    }
  }
  return { enabled: true, sourceBackend, targetBackend, applied, failed };
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
  for (const table of Object.keys(TOURNEY_MIRROR_TABLES)) {
    const sourceRows = normalizeRows(await sourceSql`select * from ${sourceSql(businessRelation(sourceBackend, table))}`);
    const targetRows = normalizeRows(await targetSql`select * from ${targetSql(businessRelation(targetBackend, table))}`);
    const sourceHash = sha256(stableJson(sourceRows));
    const targetHash = sha256(stableJson(targetRows));
    counts[table] = { source: sourceRows.length, target: targetRows.length };
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
  const parityTable = controlRelation(sourceBackend, "parity_runs");
  await sourceSql`
    insert into ${sourceSql(parityTable)} (
      source_backend, target_backend, generation, status, counts, drift, relationships
    ) values (
      ${sourceBackend}, ${targetBackend}, ${policy.generation}, ${status},
      ${sourceSql.json(counts)}, ${sourceSql.json(drift)}, ${sourceSql.json(relationships)}
    )
  `;
  return { sourceBackend, targetBackend, status, counts, drift, relationships };
};

const SHADOW_SAMPLE_TABLES = Object.freeze({
  players: ["tourney_players", "tourney_registration_config"],
  bracket: [
    "tourney_bracket_teams",
    "tourney_bracket_team_members",
    "tourney_bracket_meta",
    "tourney_bracket_entities",
    "tourney_bracket_counters",
  ],
  operations: ["tourney_appeals", "tourney_payouts"],
});

const readShadowSample = async ({ backend, tables, env }) => {
  const sql = await getTourneySqlForBackend({ backend, env });
  const result = {};
  for (const table of tables) {
    result[table] = normalizeRows(
      await sql`select * from ${sql(businessRelation(backend, table))}`
    );
  }
  return result;
};

export const runTourneyShadowReadSamples = async ({
  env = process.env,
  rounds = 10,
} = {}) => {
  const policy = resolveTourneyStorePolicy(env);
  const sourceBackend = policy.primaryBackend;
  const targetBackend = sourceBackend === "supabase" ? "legacy" : "supabase";
  const sourceSql = await getTourneySqlForBackend({ backend: sourceBackend, env });
  const observationTable = controlRelation(sourceBackend, "shadow_observations");
  const safeRounds = Math.max(1, Math.min(30, Number(rounds) || 1));
  const observations = [];

  for (let round = 0; round < safeRounds; round += 1) {
    for (const [route, tables] of Object.entries(SHADOW_SAMPLE_TABLES)) {
      const sourceStarted = Date.now();
      const source = await readShadowSample({ backend: sourceBackend, tables, env });
      const sourceLatency = Date.now() - sourceStarted;
      const targetStarted = Date.now();
      const target = await readShadowSample({ backend: targetBackend, tables, env });
      const targetLatency = Date.now() - targetStarted;
      const valueMatch = stableJson(source) === stableJson(target);
      await sourceSql`
        insert into ${sourceSql(observationTable)} (
          route, shape_match, value_match, ordering_match, error_match,
          primary_latency_ms, shadow_latency_ms
        ) values (
          ${route}, ${valueMatch}, ${valueMatch}, ${valueMatch}, true,
          ${sourceLatency}, ${targetLatency}
        )
      `;
      observations.push({ route, valueMatch, sourceLatency, targetLatency });
    }
  }

  return {
    sourceBackend,
    targetBackend,
    samples: observations.length,
    mismatches: observations.filter((item) => !item.valueMatch).length,
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
