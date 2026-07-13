import { AsyncLocalStorage } from "node:async_hooks";
import { isEnabledTourneyFlag } from "./canonical.js";

const SQL_CLIENTS =
  globalThis.__rooTourneySharedSqlClients ||
  (globalThis.__rooTourneySharedSqlClients = new Map());
const SCHEMA_CHECKS =
  globalThis.__rooTourneySchemaChecks ||
  (globalThis.__rooTourneySchemaChecks = new Map());
const ACTIVE_TOURNEY_SQL =
  globalThis.__rooActiveTourneySql ||
  (globalThis.__rooActiveTourneySql = new AsyncLocalStorage());

export const REQUIRED_SUPABASE_TOURNEY_SCHEMA_VERSION = 3;
export const REQUIRED_HARDENED_TOURNEY_SCHEMA_VERSION = 4;

const normalize = (value) => String(value || "").trim();

export const isSupabaseTourneyDatabase = (env = process.env) =>
  normalize(env.TOURNEY_DATABASE_MODE).toLowerCase() === "supabase";

export const resolveTourneyDatabaseUrl = (env = process.env) =>
  isSupabaseTourneyDatabase(env)
    ? normalize(env.SUPABASE_DATABASE_URL)
    : normalize(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL);

const getBaseTourneySql = async (env = process.env) => {
  const databaseUrl = resolveTourneyDatabaseUrl(env);
  if (!databaseUrl) {
    throw new Error(
      isSupabaseTourneyDatabase(env)
        ? "SUPABASE_DATABASE_URL is not configured."
        : "TOURNEY_DATABASE_URL is not configured."
    );
  }

  const backend = isSupabaseTourneyDatabase(env) ? "supabase" : "legacy";
  const cacheKey = `${backend}:${databaseUrl}`;
  if (SQL_CLIENTS.has(cacheKey)) return SQL_CLIENTS.get(cacheKey);

  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, {
    max: backend === "supabase" ? 3 : 2,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: `roo-industries-tourney-${backend}`,
      search_path: backend === "supabase" ? "tourney,public" : "public",
    },
  });
  SQL_CLIENTS.set(cacheKey, sql);
  return sql;
};

export const getTourneySqlForBackend = ({ backend, env = process.env } = {}) => {
  if (!['legacy', 'supabase'].includes(backend)) {
    throw new Error('Unsupported Tourney database backend.');
  }
  return getBaseTourneySql({
    ...env,
    TOURNEY_DATABASE_MODE: backend,
  });
};

export const getTourneySql = async (env = process.env) => {
  const active = ACTIVE_TOURNEY_SQL.getStore();
  if (active) return active;
  return getBaseTourneySql(env);
};

export const runTourneyTransaction = async ({
  env = process.env,
  lockKey = "roo-tourney-transaction",
  waitForLock = false,
  callback,
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Tourney transaction callback is required.");
  }
  const active = ACTIVE_TOURNEY_SQL.getStore();
  if (active) return callback(active);

  await assertTourneySchemaVersion(env);
  const root = await getBaseTourneySql(env);
  return root.begin(async (sql) => {
    let locked = true;
    if (waitForLock) {
      await sql`
        select pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${String(lockKey)}, 0)
        )
      `;
    } else {
      const rows = await sql`
        select pg_catalog.pg_try_advisory_xact_lock(
          pg_catalog.hashtextextended(${String(lockKey)}, 0)
        ) as locked
      `;
      locked = rows?.[0]?.locked === true;
    }
    if (!locked) {
      const error = new Error("Tourney data is busy. Try again.");
      error.status = 409;
      error.code = "TOURNEY_TRANSACTION_BUSY";
      throw error;
    }
    return ACTIVE_TOURNEY_SQL.run(sql, () => callback(sql));
  });
};

export const runSupabaseTourneyTransaction = runTourneyTransaction;

export const assertSupabaseTourneySchemaVersion = async (
  env = process.env
) => {
  if (!isSupabaseTourneyDatabase(env)) return true;

  const databaseUrl = resolveTourneyDatabaseUrl(env);
  const required = isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED)
    ? REQUIRED_HARDENED_TOURNEY_SCHEMA_VERSION
    : REQUIRED_SUPABASE_TOURNEY_SCHEMA_VERSION;
  const cacheKey = `supabase:v${required}:${databaseUrl}`;
  if (SCHEMA_CHECKS.has(cacheKey)) return SCHEMA_CHECKS.get(cacheKey);

  const check = (async () => {
    try {
      const sql = await getTourneySql(env);
      const rows = await sql`
        select schema_version
        from tourney.schema_metadata
        where schema_name = 'tourney'
        limit 1
      `;
      const version = Number(rows?.[0]?.schema_version || 0);
      if (version < required) {
        throw new Error("Supabase Tourney schema is not ready.");
      }
      return true;
    } catch (cause) {
      const error = new Error(
        "The Supabase Tourney database migration is required before this mode can be enabled."
      );
      error.status = 503;
      error.code = "TOURNEY_SCHEMA_MIGRATION_REQUIRED";
      error.cause = cause;
      throw error;
    }
  })();

  SCHEMA_CHECKS.set(cacheKey, check);
  try {
    return await check;
  } catch (error) {
    SCHEMA_CHECKS.delete(cacheKey);
    throw error;
  }
};

export const assertTourneySchemaVersion = async (env = process.env) => {
  if (isSupabaseTourneyDatabase(env)) return assertSupabaseTourneySchemaVersion(env);
  if (env.TOURNEY_DATABASE_MODE === "memory" || env.NODE_ENV === "test") return true;
  const databaseUrl = resolveTourneyDatabaseUrl(env);
  const required = isEnabledTourneyFlag(env.TOURNEY_HARDENING_V4_ENABLED)
    ? REQUIRED_HARDENED_TOURNEY_SCHEMA_VERSION
    : REQUIRED_SUPABASE_TOURNEY_SCHEMA_VERSION;
  const cacheKey = `legacy:v${required}:${databaseUrl}`;
  if (SCHEMA_CHECKS.has(cacheKey)) return SCHEMA_CHECKS.get(cacheKey);
  const check = (async () => {
    try {
      const sql = await getTourneySql(env);
      const rows = await sql`
        select schema_version from tourney_schema_metadata
        where schema_name = 'tourney' limit 1
      `;
      if (Number(rows[0]?.schema_version || 0) < required) {
        throw new Error("Legacy Tourney schema is not ready.");
      }
      return true;
    } catch (cause) {
      const error = new Error("The legacy Tourney database migration is required.");
      error.status = 503;
      error.code = "TOURNEY_SCHEMA_MIGRATION_REQUIRED";
      error.cause = cause;
      throw error;
    }
  })();
  SCHEMA_CHECKS.set(cacheKey, check);
  try {
    return await check;
  } catch (error) {
    SCHEMA_CHECKS.delete(cacheKey);
    throw error;
  }
};

export const resetSupabaseTourneySchemaCheckForTests = () => {
  SCHEMA_CHECKS.clear();
};
