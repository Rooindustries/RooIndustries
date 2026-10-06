import envValue from "./envValue.cjs";
const { resolveStoreBackend, readEnvValue } = envValue;
const readBoolean = (env, key) => ["1", "true", "yes", "on"].includes(readEnvValue(env, key).toLowerCase());
const parseGeneration = value => {
  const normalized = String(value || "0").trim();
  if (!/^[0-9]+$/.test(normalized) || !Number.isSafeInteger(Number(normalized))) throw new Error("COMMERCE_FAILOVER_GENERATION must be a non-negative safe integer.");
  return Number(normalized);
};
export const resolveSupabaseRuntimePolicy = (env = process.env) => {
  const runtime = readEnvValue(env,"VERCEL_ENV").toLowerCase() || (readEnvValue(env,"NODE_ENV").toLowerCase() === "production" ? "production" : "development");
  const primaryBackend = resolveStoreBackend(env.DATA_PRIMARY_BACKEND);
  const commercePrimaryBackend = resolveStoreBackend(env.COMMERCE_PRIMARY_BACKEND);
  const cutoverEnabled = readBoolean(env,"SUPABASE_CUTOVER_ENABLED");
  const commerceCutoverEnabled = readBoolean(env,"COMMERCE_CUTOVER_ENABLED");
  if(runtime === "production" && !cutoverEnabled) throw new Error("Production Supabase cutover requires SUPABASE_CUTOVER_ENABLED=1.");
  if(runtime === "production" && !commerceCutoverEnabled) throw new Error("Production Supabase commerce cutover requires COMMERCE_CUTOVER_ENABLED=1.");
  return { runtime, primaryBackend, commercePrimaryBackend, cutoverEnabled, commerceCutoverEnabled, commerceStartsPaused: readBoolean(env,"COMMERCE_STARTS_PAUSED"), commerceFailoverGeneration: parseGeneration(readEnvValue(env,"COMMERCE_FAILOVER_GENERATION")) };
};
export const shouldUseSupabaseForAccount = ({ env = process.env } = {}) => {
  resolveSupabaseRuntimePolicy(env);
  return true;
};
