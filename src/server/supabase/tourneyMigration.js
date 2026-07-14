import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";
import { stableJson } from "./shadowStore.js";
import { enqueueTourneyExternalOperation } from "../tourney/externalOperations.js";
import { executeTourneyCommand } from "../tourney/store.js";

const normalize = (value) => String(value || "").trim();

const deterministicUuid = (value) => {
  const bytes = crypto
    .createHash("sha256")
    .update(`roo-industries-auth:${normalize(value).toLowerCase()}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const playerAuthEmail = (username) =>
  `tourney-player+${crypto
    .createHash("sha256")
    .update(normalize(username).toLowerCase())
    .digest("hex")
    .slice(0, 24)}@auth.rooindustries.invalid`;

export const selectTourneyImportAuthUserId = ({ principal, authEmail } = {}) =>
  normalize(principal?.auth_user_id) || deterministicUuid(authEmail);

const jsonSafe = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, entry) =>
      typeof entry === "bigint" ? entry.toString() : entry
    )
  );

const requireRpcData = ({ data, error }, operation) => {
  if (error) {
    const failure = new Error(`Supabase ${operation} failed.`);
    failure.code = error.code || "SUPABASE_TOURNEY_MIGRATION_FAILED";
    throw failure;
  }
  return data;
};

export const readOptionalTourneyTable = async ({ table, load, sql }) => {
  try {
    const rows = sql
      ? await sql.savepoint((savepointSql) => load(savepointSql))
      : await load();
    return { table, rows, missing: false };
  } catch (error) {
    if (String(error?.code || "") === "42P01") {
      return { table, rows: [], missing: true };
    }
    throw error;
  }
};

export const readTourneySnapshot = async ({ env = process.env } = {}) => {
  const databaseUrl = normalize(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL);
  if (!databaseUrl) throw new Error("The legacy Tourney database is not configured.");
  const { default: postgres } = await import("postgres");
  const root = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  let tables;
  try {
    tables = await root.begin("isolation level repeatable read read only", async (sql) => {
      const existingRows = await sql`
        select name from unnest(array[
          'tourney_players','tourney_player_tokens','tourney_registration_config',
          'tourney_bracket_teams','tourney_bracket_team_members','tourney_bracket_meta',
          'tourney_bracket_entities','tourney_bracket_counters','tourney_bracket_audit',
          'tourney_bracket_lock','tourney_appeals','tourney_payouts'
        ]::text[]) name where to_regclass(name) is not null
      `;
      const existing = new Set(existingRows.map((row) => row.name));
      const definitions = [
        ["tourney_players", (querySql) => querySql`select * from tourney_players order by id`],
        ["tourney_player_tokens", (querySql) => querySql`select * from tourney_player_tokens order by id`],
        ["tourney_registration_config", (querySql) => querySql`select * from tourney_registration_config order by id`],
        ["tourney_bracket_teams", (querySql) => querySql`select * from tourney_bracket_teams order by id`],
        ["tourney_bracket_team_members", (querySql) => querySql`select * from tourney_bracket_team_members order by id`],
        ["tourney_bracket_meta", (querySql) => querySql`select * from tourney_bracket_meta order by id`],
        ["tourney_bracket_entities", (querySql) => querySql`select * from tourney_bracket_entities order by entity_type, entity_id`],
        ["tourney_bracket_counters", (querySql) => querySql`select * from tourney_bracket_counters order by entity_type`],
        ["tourney_bracket_audit", (querySql) => querySql`select * from tourney_bracket_audit order by created_at, id`],
        ["tourney_bracket_lock", (querySql) => querySql`select * from tourney_bracket_lock order by id`],
        ["tourney_appeals", (querySql) => querySql`select * from tourney_appeals order by id`],
        ["tourney_payouts", (querySql) => querySql`select * from tourney_payouts order by id`],
      ];
      const results = [];
      for (const [table, load] of definitions) {
        results.push(existing.has(table)
          ? await readOptionalTourneyTable({ table, load, sql })
          : { table, rows: [], missing: true });
      }
      return results;
    });
  } finally {
    await root.end({ timeout: 5 });
  }

  const snapshot = jsonSafe(
    Object.fromEntries(tables.map(({ table, rows }) => [table, rows]))
  );
  snapshot._counts = Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [table, rows.length])
  );
  const missingTables = tables
    .filter(({ missing }) => missing)
    .map(({ table }) => table)
    .sort();
  return {
    snapshot,
    missingTables,
    sourceHash: crypto
      .createHash("sha256")
      .update(stableJson(snapshot))
      .digest("hex"),
  };
};

export const assertCompleteTourneySnapshot = ({ missingTables = [] } = {}) => {
  if (!Array.isArray(missingTables) || missingTables.length === 0) return true;
  const error = new Error("The legacy Tourney snapshot is incomplete.");
  error.code = "TOURNEY_SNAPSHOT_INCOMPLETE";
  error.missingTableCount = missingTables.length;
  throw error;
};

const preflightPlayerAuth = async ({ player, client, claimedUserIds }) => {
  const passwordHash = normalize(player.password_hash);
  if (!/^\$2[aby]\$/.test(passwordHash)) {
    throw new Error("A Tourney player credential is not bcrypt.");
  }
  const username = normalize(player.username).toLowerCase();
  const authEmail = playerAuthEmail(username);
  const principal = requireRpcData(
    await client.rpc("roo_resolve_tourney_import_principal", {
      p_legacy_player_id: player.id,
      p_username: username,
      p_login_email: normalize(player.email).toLowerCase(),
    }),
    "Tourney principal resolution"
  );
  if (principal?.conflict) {
    const conflict = new Error("Tourney identity collision requires resolution.");
    conflict.code = "TOURNEY_IDENTITY_CONFLICT";
    throw conflict;
  }
  const userId = selectTourneyImportAuthUserId({ principal, authEmail });
  const existing = await client.auth.admin.getUserById(userId);
  if (existing.error && Number(existing.error.status || 0) !== 404) {
    throw new Error("Tourney Auth inventory failed.");
  }
  const existingLegacyId = normalize(
    existing.data?.user?.app_metadata?.legacy_player_id
  );
  if (existingLegacyId && existingLegacyId !== normalize(player.id)) {
    const conflict = new Error("Tourney Auth user belongs to another player.");
    conflict.code = "TOURNEY_IDENTITY_CONFLICT";
    throw conflict;
  }
  if (claimedUserIds.has(userId)) {
    const conflict = new Error("Two Tourney players resolve to one Auth user.");
    conflict.code = "TOURNEY_IDENTITY_CONFLICT";
    throw conflict;
  }
  claimedUserIds.add(userId);
  return { authEmail, userId };
};

export const verifyTourneyImportResult = ({ imported, snapshot } = {}) => {
  const sourceCounts = snapshot?._counts || {};
  const targetCounts = imported?.target_counts || {};
  const drift = Object.keys(sourceCounts).filter(
    (table) => Number(sourceCounts[table]) !== Number(targetCounts[table])
  );
  if (drift.length > 0) {
    throw new Error("Tourney shadow count verification failed.");
  }
  const sourceHashes = imported?.source_canonical_hashes || {};
  const targetHashes = imported?.target_canonical_hashes || {};
  const hashDrift = Object.keys(sourceCounts).filter(
    (table) => sourceHashes[table] !== targetHashes[table]
  );
  if (hashDrift.length > 0) {
    throw new Error("Tourney shadow canonical hash verification failed.");
  }
  const relationships = imported?.relationships || {};
  if (
    Number(relationships.orphan_team_members || 0) !== 0 ||
    Number(relationships.orphan_player_members || 0) !== 0
  ) {
    throw new Error("Tourney shadow relationship verification failed.");
  }
  const sourceStatusCounts = (snapshot?.tourney_players || []).reduce((counts, player) => {
    const status = normalize(player.status);
    counts[status] = Number(counts[status] || 0) + 1;
    return counts;
  }, {});
  const targetStatusCounts = imported?.status_counts || {};
  if (stableJson(sourceStatusCounts) !== stableJson(targetStatusCounts)) {
    throw new Error("Tourney shadow status verification failed.");
  }
  return { relationships, targetCounts, targetHashes, targetStatusCounts };
};

export const migrateTourneyShadow = async ({
  env = process.env,
  client = createSupabaseAdminClient({ env }),
} = {}) => {
  const { snapshot, sourceHash, missingTables } = await readTourneySnapshot({ env });
  assertCompleteTourneySnapshot({ missingTables });
  const claimedUserIds = new Set();
  const authTargets = new Map();
  for (const player of snapshot.tourney_players) {
    authTargets.set(
      player.id,
      await preflightPlayerAuth({ player, client, claimedUserIds })
    );
  }
  const preflight = requireRpcData(
    await client.rpc("roo_preflight_tourney_snapshot_v4", {
      p_snapshot: snapshot,
      p_source_hash: sourceHash,
      p_allow_tombstones: false,
    }),
    "Tourney snapshot preflight"
  );
  if (!normalize(preflight?.preflight_id)) {
    throw new Error("Tourney snapshot preflight token is missing.");
  }
  const imported = requireRpcData(
    await client.rpc("roo_import_tourney_snapshot_v4", {
      p_snapshot: snapshot,
      p_source_hash: sourceHash,
      p_allow_tombstones: false,
      p_preflight_id: preflight.preflight_id,
    }),
    "Tourney snapshot import"
  );
  if (imported?.status === "quarantined") {
    const error = new Error("Tourney import collisions require review.");
    error.code = "TOURNEY_IMPORT_QUARANTINED";
    error.collisionCount = Number(imported.collision_count || 0);
    throw error;
  }
  if (imported?.status !== "completed") {
    const error = new Error("Tourney import target changed after preflight.");
    error.code = "TOURNEY_IMPORT_TARGET_CHANGED";
    throw error;
  }

  const { relationships, targetCounts, targetHashes, targetStatusCounts } =
    verifyTourneyImportResult({ imported, snapshot });

  let authQueued = 0;
  for (const player of snapshot.tourney_players) {
    const playerHash = crypto.createHash("sha256").update(stableJson(player)).digest("hex");
    const commandId = `migration-player-auth:${player.id}:${playerHash.slice(0, 24)}`;
    await executeTourneyCommand({
      commandId,
      purpose: "identity:migration-player-auth",
      requestPayload: { playerId: player.id, sourceHash: playerHash },
      maintenanceWhilePaused: true,
      attemptExternalWork: false,
      env,
      callback: async () => ({
        body: await enqueueTourneyExternalOperation({
          commandId,
          operationKind: "supabase_player_auth",
          entityType: "player",
          entityId: player.id,
          desiredState: {
            authUserId: authTargets.get(player.id)?.userId || "",
            player,
            installPassword: true,
          },
          env,
        }),
      }),
    });
    authQueued += 1;
  }

  return {
    sourceHash,
    counts: targetCounts,
    authImported: 0,
    authQueued,
    missingTables,
    driftCount: 0,
    canonicalHashes: targetHashes,
    statusCounts: targetStatusCounts,
    relationships,
  };
};
