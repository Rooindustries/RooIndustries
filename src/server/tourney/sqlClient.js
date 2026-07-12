import { AsyncLocalStorage } from "node:async_hooks";

const SQL_CLIENTS =
  globalThis.__rooTourneySharedSqlClients ||
  (globalThis.__rooTourneySharedSqlClients = new Map());
const SCHEMA_CHECKS =
  globalThis.__rooTourneySchemaChecks ||
  (globalThis.__rooTourneySchemaChecks = new Map());
const ACTIVE_SUPABASE_SQL =
  globalThis.__rooActiveSupabaseTourneySql ||
  (globalThis.__rooActiveSupabaseTourneySql = new AsyncLocalStorage());

export const REQUIRED_SUPABASE_TOURNEY_SCHEMA_VERSION = 2;

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

  if (backend === "supabase") {
    const { default: postgres } = await import("postgres");
    const sql = postgres(databaseUrl, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
      connection: {
        application_name: "roo-industries-tourney",
        search_path: "tourney,public",
      },
    });
    SQL_CLIENTS.set(cacheKey, sql);
    return sql;
  }

  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(databaseUrl);
  SQL_CLIENTS.set(cacheKey, sql);
  return sql;
};

export const getTourneySql = async (env = process.env) => {
  if (isSupabaseTourneyDatabase(env)) {
    const active = ACTIVE_SUPABASE_SQL.getStore();
    if (active) return active;
  }
  return getBaseTourneySql(env);
};

export const runSupabaseTourneyTransaction = async ({
  env = process.env,
  lockKey = "roo-tourney-transaction",
  callback,
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Supabase Tourney transaction callback is required.");
  }
  if (!isSupabaseTourneyDatabase(env)) return callback(await getTourneySql(env));

  const active = ACTIVE_SUPABASE_SQL.getStore();
  if (active) return callback(active);

  await assertSupabaseTourneySchemaVersion(env);
  const root = await getBaseTourneySql(env);
  return root.begin(async (sql) => {
    const rows = await sql`
      select pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended(${String(lockKey)}, 0)
      ) as locked
    `;
    if (rows?.[0]?.locked !== true) {
      const error = new Error("Tourney data is busy. Try again.");
      error.status = 409;
      error.code = "TOURNEY_TRANSACTION_BUSY";
      throw error;
    }
    return ACTIVE_SUPABASE_SQL.run(sql, () => callback(sql));
  });
};

export const assertSupabaseTourneySchemaVersion = async (
  env = process.env
) => {
  if (!isSupabaseTourneyDatabase(env)) return true;

  const databaseUrl = resolveTourneyDatabaseUrl(env);
  const cacheKey = `supabase:${databaseUrl}`;
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
      if (version < REQUIRED_SUPABASE_TOURNEY_SCHEMA_VERSION) {
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

export const resetSupabaseTourneySchemaCheckForTests = () => {
  SCHEMA_CHECKS.clear();
};
