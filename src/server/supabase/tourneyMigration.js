import crypto from "node:crypto";
import { createSupabaseAdminClient } from "./adminClient.js";
import { stableJson } from "./shadowStore.js";

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

export const readOptionalTourneyTable = async ({ table, load }) => {
  try {
    return { table, rows: await load(), missing: false };
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
    tables = await root.begin("isolation level repeatable read read only", (sql) => Promise.all([
    readOptionalTourneyTable({
      table: "tourney_players",
      load: () => sql`select * from tourney_players order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_player_tokens",
      load: () => sql`select * from tourney_player_tokens order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_registration_config",
      load: () => sql`select * from tourney_registration_config order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_teams",
      load: () => sql`select * from tourney_bracket_teams order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_team_members",
      load: () => sql`select * from tourney_bracket_team_members order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_meta",
      load: () => sql`select * from tourney_bracket_meta order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_entities",
      load: () => sql`select * from tourney_bracket_entities order by entity_type, entity_id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_counters",
      load: () => sql`select * from tourney_bracket_counters order by entity_type`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_audit",
      load: () => sql`select * from tourney_bracket_audit order by created_at, id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_bracket_lock",
      load: () => sql`select * from tourney_bracket_lock order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_appeals",
      load: () => sql`select * from tourney_appeals order by id`,
    }),
    readOptionalTourneyTable({
      table: "tourney_payouts",
      load: () => sql`select * from tourney_payouts order by id`,
    }),
    ]));
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
      .update(stableJson({ snapshot, missingTables }))
      .digest("hex"),
  };
};

const importPlayerAuth = async ({ player, client }) => {
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
  const userId = normalize(principal?.principal_id) || deterministicUuid(authEmail);
  const authAttributes = {
    email: authEmail,
    email_confirm: true,
    password_hash: passwordHash,
    user_metadata: {
      display_name: normalize(player.display_name || player.discord || username),
    },
    app_metadata: {
      imported_from: "legacy-tourney-database",
      legacy_player_id: player.id,
      roles: ["tourney_player"],
    },
  };

  const existing = await client.auth.admin.getUserById(userId);
  if (existing.error && Number(existing.error.status || 0) !== 404) {
    throw new Error("Tourney Auth inventory failed.");
  }
  let createdThisPlayer = false;
  if (existing.data?.user) {
    const updated = await client.auth.admin.updateUserById(userId, authAttributes);
    if (updated.error) throw new Error("Tourney Auth synchronization failed.");
  } else {
    const created = await client.auth.admin.createUser({ id: userId, ...authAttributes });
    if (created.error) throw new Error("Tourney Auth import failed.");
    createdThisPlayer = true;
  }

  const sourceHash = crypto
    .createHash("sha256")
    .update(stableJson(player))
    .digest("hex");
  try {
    requireRpcData(
      await client.rpc("roo_import_tourney_player_account", {
        p_account: {
          user_id: userId,
          auth_email: authEmail,
          login_email: normalize(player.email).toLowerCase(),
          username,
          player_id: player.id,
          display_name: normalize(player.display_name || player.discord || username),
          status: player.status,
          credential_version: String(player.version || "1"),
          source_hash: sourceHash,
          legacy_payload: {
            status: player.status,
            discord_key: player.discord_key,
            registration_pool: player.registration_pool,
          },
        },
      }),
      "Tourney player account import"
    );
  } catch (error) {
    if (createdThisPlayer) {
      await client.auth.admin.deleteUser(userId).catch(() => {});
    }
    throw error;
  }
};

export const migrateTourneyShadow = async ({
  env = process.env,
  client = createSupabaseAdminClient({ env }),
} = {}) => {
  const { snapshot, sourceHash, missingTables } = await readTourneySnapshot({ env });
  const imported = requireRpcData(
    await client.rpc("roo_import_tourney_snapshot_v4", {
      p_snapshot: snapshot,
      p_source_hash: sourceHash,
      p_allow_tombstones: false,
    }),
    "Tourney snapshot import"
  );
  if (imported?.status === "quarantined") {
    const error = new Error("Tourney import collisions require review.");
    error.code = "TOURNEY_IMPORT_QUARANTINED";
    error.collisionCount = Number(imported.collision_count || 0);
    throw error;
  }

  let authImported = 0;
  for (const player of snapshot.tourney_players) {
    await importPlayerAuth({ player, client });
    authImported += 1;
  }

  const sourceCounts = snapshot._counts;
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

  return {
    sourceHash,
    counts: targetCounts,
    authImported,
    missingTables,
    driftCount: 0,
    canonicalHashes: targetHashes,
    statusCounts: imported?.status_counts || {},
    relationships: imported?.relationships || {},
  };
};
