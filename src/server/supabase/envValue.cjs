const readEnvValue = (env, key) => {
  const value = env?.[key];
  return value === undefined || value === null ? "" : String(value).trim();
};
const readFirstEnvValue = (env, keys = []) => {
  for (const key of keys) {
    const value = readEnvValue(env, key);
    if (value) return value;
  }
  return "";
};
const resolveStoreBackend = value => {
  if (value === undefined || value === null || value === "") return "supabase";
  if (typeof value === "string" && ["", "sanity", "supabase"].includes(value.trim().toLowerCase())) return "supabase";
  const error = new Error("The stored backend is unsupported.");
  error.code = "UNSUPPORTED_STORE_BACKEND";
  error.status = 503;
  throw error;
};
module.exports = { resolveStoreBackend, normalizeBackend: resolveStoreBackend, readEnvValue, readFirstEnvValue };
