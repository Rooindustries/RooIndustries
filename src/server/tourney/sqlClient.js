const SQL_CLIENTS =
  globalThis.__rooTourneySharedSqlClients ||
  (globalThis.__rooTourneySharedSqlClients = new Map());

const normalize = (value) => String(value || "").trim();

export const isSupabaseTourneyDatabase = (env = process.env) =>
  normalize(env.TOURNEY_DATABASE_MODE).toLowerCase() === "supabase";

export const resolveTourneyDatabaseUrl = (env = process.env) =>
  isSupabaseTourneyDatabase(env)
    ? normalize(env.SUPABASE_DATABASE_URL)
    : normalize(env.TOURNEY_DATABASE_URL || env.POSTGRES_URL);

export const getTourneySql = async (env = process.env) => {
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
